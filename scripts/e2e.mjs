import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = resolve(new URL("..", import.meta.url).pathname);
const workerBundle = resolve(root, ".tmp/cirrus-worker-test.mjs");
const origin = "https://cirrus.test";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assertIncludes(haystack, needle, message) {
  assert.ok(String(haystack).includes(needle), message || `Expected response to include ${needle}`);
}

function cookieFrom(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "Expected Set-Cookie header");
  return header.split(";", 1)[0];
}

function escapeMultipartValue(value) {
  return String(value).replace(/[\r\n"]/g, "_");
}

function encodeMultipart(form) {
  const boundary = `----cirrus-e2e-${crypto.randomUUID()}`;
  const parts = [];

  for (const [name, value] of form.entries()) {
    parts.push(`--${boundary}\r\n`);
    if (typeof value === "string") {
      parts.push(`Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`);
      parts.push(value);
      parts.push("\r\n");
      continue;
    }

    const filename = value.name || "blob";
    const contentType = value.type || "application/octet-stream";
    parts.push(
      `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"; filename="${escapeMultipartValue(filename)}"\r\n`,
    );
    parts.push(`Content-Type: ${contentType}\r\n\r\n`);
    parts.push(value);
    parts.push("\r\n");
  }

  parts.push(`--${boundary}--\r\n`);
  return {
    body: new Blob(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function readBody(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return response.text();
}

async function expectJson(response, status, label) {
  const body = await readBody(response);
  assert.equal(
    response.status,
    status,
    `${label} expected ${status}, got ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
  assert.equal(typeof body, "object", `${label} expected JSON response`);
  assert.notEqual(body, null, `${label} expected JSON response`);
  return body;
}

async function expectText(response, status, label) {
  const body = await response.text();
  assert.equal(response.status, status, `${label} expected ${status}, got ${response.status}: ${body}`);
  return body;
}

async function buildWorker() {
  await mkdir(dirname(workerBundle), { recursive: true });
  await build({
    entryPoints: [resolve(root, "src/index.tsx")],
    outfile: workerBundle,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
    conditions: ["worker", "browser"],
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
}

async function createWorker(bindings = {}) {
  return new Miniflare({
    scriptPath: workerBundle,
    modules: true,
    compatibilityDate: "2026-05-03",
    bindings: {
      STORAGE_BACKEND: "r2",
      CSRF_SECRET: "test-secret",
      API_RATE_LIMIT_PER_MINUTE: "10000",
      AUTH_RATE_LIMIT_PER_MINUTE: "10000",
      AUTH_IDENTITY_RATE_LIMIT_PER_MINUTE: "10000",
      SHARE_VERIFY_RATE_LIMIT_PER_MINUTE: "10000",
      MAX_FILE_BYTES: "1048576",
      MAX_UPLOAD_BYTES: "4194304",
      MAX_FILES_PER_UPLOAD: "20",
      ...bindings,
    },
    r2Buckets: ["DRIVE_BUCKET"],
    d1Databases: ["DB"],
    r2Persist: false,
    d1Persist: false,
  });
}

function client(mf) {
  async function request(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("Sec-Fetch-Site", "same-origin");
    }
    if (options.csrf) headers.set("X-CSRF-Token", options.csrf);

    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    } else if (body instanceof FormData) {
      const encoded = encodeMultipart(body);
      body = encoded.body;
      if (!headers.has("Content-Type")) headers.set("Content-Type", encoded.contentType);
    }

    return mf.dispatchFetch(`${origin}${path}`, {
      method,
      headers,
      body,
    });
  }

  async function register(username, password) {
    const response = await request("/api/auth/register", {
      method: "POST",
      json: { username, password, confirmPassword: password },
    });
    const body = await expectJson(response, 201, `register ${username}`);
    return {
      user: body.user,
      csrf: body.csrfToken,
      cookie: cookieFrom(response),
    };
  }

  async function login(username, password) {
    const response = await request("/api/auth/login", {
      method: "POST",
      json: { username, password },
    });
    const body = await expectJson(response, 200, `login ${username}`);
    return {
      user: body.user,
      csrf: body.csrfToken,
      cookie: cookieFrom(response),
    };
  }

  async function api(path, session, options = {}, status = 200) {
    const response = await request(path, {
      ...options,
      cookie: session?.cookie,
      csrf: session?.csrf,
    });
    return expectJson(response, status, `${options.method || "GET"} ${path}`);
  }

  async function upload(session, files, fields = {}) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      form.append(name, value);
    }
    for (const file of files) {
      const blob = new Blob([file.content], { type: file.type || "application/octet-stream" });
      form.append("files", blob, file.name);
    }

    const response = await request("/api/files", {
      method: "POST",
      body: form,
      cookie: session.cookie,
      csrf: session.csrf,
    });
    return expectJson(response, 201, "upload files");
  }

  return { request, register, login, api, upload };
}

test("public auth shell and security headers", async () => {
  const mf = await createWorker({ AUTH_USERS: "seed:SeedPass123!:user" });
  try {
    const response = await mf.dispatchFetch(`${origin}/`);
    const html = await expectText(response, 401, "GET / unauthenticated");
    assertIncludes(html, 'id="auth-dialog"', "login/register dialog should be rendered");
    assertIncludes(html, "注册账号", "registration entry should be visible");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assertIncludes(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  } finally {
    await mf.dispose();
  }
});

test("existing D1 tables are automatically upgraded before registration", async () => {
  const mf = await createWorker();
  try {
    const db = await mf.getD1Database("DB");
    await db
      .prepare(
        `CREATE TABLE user_profiles (
        user TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE user_passwords (
        user TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE file_meta (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        uploaded_at TEXT NOT NULL
      )`,
      )
      .run();

    const app = client(mf);
    const admin = await app.register("legacy-admin", "AdminPass123!");
    assert.equal(admin.user.role, "admin");

    const profileInfo = await db.prepare("PRAGMA table_info(user_profiles)").all();
    const profileColumns = new Set((profileInfo.results || []).map((row) => row.name));
    for (const column of ["role", "visible_file_ids", "friends", "notifications"]) {
      assert.ok(profileColumns.has(column), `user_profiles should include ${column}`);
    }

    const fileInfo = await db.prepare("PRAGMA table_info(file_meta)").all();
    const fileColumns = new Set((fileInfo.results || []).map((row) => row.name));
    for (const column of ["description", "tags", "content_type", "download_count"]) {
      assert.ok(fileColumns.has(column), `file_meta should include ${column}`);
    }
  } finally {
    await mf.dispose();
  }
});

test("registered users, profile settings, permissions, files, sharing, friends, and notifications", async () => {
  const mf = await createWorker();
  try {
    const app = client(mf);

    const admin = await app.register("admin", "AdminPass123!");
    assert.equal(admin.user.role, "admin", "first registered user should be admin");
    const adminMe = await app.api("/api/me", admin);
    assert.equal(adminMe.user.role, "admin");

    const invalidUserName = await app.request("/api/auth/register", {
      method: "POST",
      json: {
        username: "bad user space",
        password: "Password123!",
        confirmPassword: "Password123!",
      },
    });
    await expectJson(invalidUserName, 400, "invalid username rejected before storage write");

    const user = await app.register("alice", "UserPass123!");
    assert.equal(user.user.role, "user", "second registered user should be normal user");
    const normalUser = await app.login("alice", "UserPass123!");
    assert.equal(normalUser.user.role, "user");
    const bob = await app.register("bob", "BobPass123!");
    assert.equal(bob.user.role, "user");

    const profile = await app.api(
      "/api/me/profile",
      normalUser,
      {
        method: "PATCH",
        json: {
          nickname: "Alice",
          status: "online",
          avatar: "data:image/png;base64,iVBORw0KGgo=",
        },
      },
      200,
    );
    assert.equal(profile.profile.nickname, "Alice");

    const changedPassword = await app.api(
      "/api/me/profile",
      normalUser,
      {
        method: "PATCH",
        json: {
          currentPassword: "UserPass123!",
          newPassword: "UserPass456!",
        },
      },
      200,
    );
    assert.equal(changedPassword.passwordChanged, true);

    const oldPasswordLogin = await app.request("/api/auth/login", {
      method: "POST",
      json: { username: "alice", password: "UserPass123!" },
    });
    await expectJson(oldPasswordLogin, 401, "old password rejected");
    const normalUserAfterPasswordChange = await app.login("alice", "UserPass456!");
    assert.equal(normalUserAfterPasswordChange.user.name, "alice");

    await app.api(
      "/api/me/profile",
      admin,
      {
        method: "PATCH",
        json: { nickname: "Root", status: "reviewing" },
      },
      200,
    );

    const duplicateNickname = await app.request("/api/me/profile", {
      method: "PATCH",
      json: { nickname: "Alice" },
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    await expectJson(duplicateNickname, 409, "duplicate nickname rejected");

    const adminUpload = await app.upload(
      admin,
      [{ name: "admin-note.txt", content: "admin only note", type: "text/plain" }],
      {
        description: "admin shared description",
        tags: "shared,admin-tag",
      },
    );
    const adminFile = adminUpload.files[0];
    assert.equal(adminFile.description, "admin shared description");
    assert.deepEqual(adminFile.tags, ["shared", "admin-tag"]);

    const userUpload = await app.upload(
      normalUser,
      [
        { name: "report.txt", content: "hello from alice", type: "text/plain" },
        { name: "diagram.md", content: "# network", type: "text/markdown" },
      ],
      {
        description: "batch fallback description",
        tags: "bulk",
        "description:0": "first file description",
        "tags:0": "alpha,report",
        "description:1": "second file description",
        "tags:1": "beta,diagram",
      },
    );
    assert.equal(userUpload.files.length, 2);
    const report = userUpload.files.find((file) => file.name === "report.txt");
    const diagram = userUpload.files.find((file) => file.name === "diagram.md");
    assert.ok(report, "report upload should exist");
    assert.ok(diagram, "diagram upload should exist");
    assert.equal(report.description, "first file description");
    assert.deepEqual(report.tags, ["alpha", "report"]);

    const searchByDescription = await app.api("/api/files?q=first", normalUser);
    assert.deepEqual(searchByDescription.files.map((file) => file.id), [report.id]);
    const searchByExtension = await app.api("/api/files?q=md", normalUser);
    assert.deepEqual(searchByExtension.files.map((file) => file.id), [diagram.id]);
    const tagFilter = await app.api("/api/files?tag=alpha", normalUser);
    assert.deepEqual(tagFilter.files.map((file) => file.id), [report.id]);

    const normalCannotAdmin = await app.request("/api/admin/overview", { cookie: normalUser.cookie });
    await expectJson(normalCannotAdmin, 403, "normal user cannot access admin overview");

    const normalInitialFiles = await app.api("/api/files", normalUser);
    assert.ok(normalInitialFiles.files.some((file) => file.id === report.id));
    assert.ok(!normalInitialFiles.files.some((file) => file.id === adminFile.id));

    const overview = await app.api("/api/admin/overview", admin);
    assert.ok(overview.users.some((item) => item.name === "alice"));
    assert.ok(overview.users.some((item) => item.name === "bob"));
    assert.ok(overview.files.some((file) => file.id === adminFile.id && file.owner === "admin"));

    const adminHtml = await app.request("/admin", { cookie: admin.cookie });
    assertIncludes(await expectText(adminHtml, 200, "GET /admin"), 'data-app="admin"');
    const adminPageForbidden = await app.request("/admin", { cookie: normalUserAfterPasswordChange.cookie });
    await expectJson(adminPageForbidden, 403, "normal user cannot access admin page");

    const permissions = await app.api("/api/admin/permissions", admin);
    assert.ok(permissions.users.includes("alice"));
    const patchedPermissions = await app.api(
      "/api/admin/permissions/alice",
      admin,
      { method: "PATCH", json: { tags: ["shared"] } },
      200,
    );
    assert.deepEqual(patchedPermissions.tags, ["shared"]);

    const promoted = await app.api(
      "/api/admin/users/batch",
      admin,
      {
        method: "POST",
        json: {
          users: ["bob"],
          role: "admin",
        },
      },
      200,
    );
    assert.equal(promoted.users.find((item) => item.name === "bob").role, "admin");
    const bobAdmin = await app.login("bob", "BobPass123!");
    assert.equal(bobAdmin.user.role, "admin");
    const demoted = await app.api(
      "/api/admin/users/batch",
      admin,
      {
        method: "POST",
        json: {
          users: ["bob"],
          role: "user",
        },
      },
      200,
    );
    assert.equal(demoted.users.find((item) => item.name === "bob").role, "user");

    const batch = await app.api(
      "/api/admin/users/batch",
      admin,
      {
        method: "POST",
        json: {
          users: ["alice"],
          tags: ["team-blue"],
          tagMode: "add",
          visibleTags: ["shared"],
          visibleTagMode: "replace",
          visibleFileIds: [adminFile.id],
          visibleFileMode: "add",
          notification: {
            title: "Policy",
            message: "Admin granted shared files",
          },
        },
      },
      200,
    );
    const aliceSummary = batch.users.find((item) => item.name === "alice");
    assert.ok(aliceSummary.tags.includes("team-blue"));
    assert.ok(batch.grants.alice.includes("shared"));

    const visibleShared = await app.api("/api/files?tag=shared", normalUser);
    assert.ok(visibleShared.files.some((file) => file.id === adminFile.id));

    const notifications = await app.api("/api/notifications", normalUser);
    assert.ok(notifications.notifications.some((item) => item.title === "Policy"));
    const readNotifications = await app.api(
      "/api/notifications/read",
      normalUser,
      { method: "PATCH", json: {} },
      200,
    );
    assert.ok(readNotifications.notifications.every((item) => item.readAt));

    const updatedDescription = await app.api(
      `/api/files/${report.id}/description`,
      normalUser,
      { method: "PATCH", json: { description: "updated report description" } },
      200,
    );
    assert.equal(updatedDescription.file.description, "updated report description");

    const updatedTags = await app.api(
      `/api/files/${report.id}/tags`,
      normalUser,
      { method: "PATCH", json: { tags: ["alpha", "final"] } },
      200,
    );
    assert.deepEqual(updatedTags.file.tags, ["alpha", "final"]);

    const renamed = await app.api(
      `/api/files/${report.id}`,
      normalUser,
      { method: "PATCH", json: { name: "final-report.txt" } },
      200,
    );
    assert.equal(renamed.file.name, "final-report.txt");

    const downloaded = await app.request(`/api/files/${report.id}/download`, {
      cookie: normalUser.cookie,
    });
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "hello from alice");

    const zipped = await app.request("/api/files/download", {
      method: "POST",
      json: { ids: [report.id, diagram.id] },
      cookie: normalUser.cookie,
      csrf: normalUser.csrf,
    });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get("content-type"), "application/zip");
    assert.ok((await zipped.arrayBuffer()).byteLength > 0, "zip response should contain bytes");

    const copied = await app.api(
      "/api/files/copy",
      normalUser,
      { method: "POST", json: { ids: [report.id] } },
      200,
    );
    assert.equal(copied.files.length, 1);
    assert.notEqual(copied.files[0].id, report.id);
    assert.equal(copied.files[0].name, "final-report - 副本.txt");

    const share = await app.api(
      "/api/shares",
      normalUser,
      {
        method: "POST",
        json: { fileIds: [report.id], code: "qa-share", password: "share-pass" },
      },
      200,
    );
    assert.equal(share.share.code, "qa-share");
    assert.equal(share.share.hasPassword, true);

    const shareHtml = await mf.dispatchFetch(`${origin}/s/qa-share`);
    const shareHtmlBody = await expectText(shareHtml, 200, "GET /s/:code");
    assertIncludes(shareHtmlBody, 'data-app="share"');
    assertIncludes(shareHtmlBody, "<h1>分享文件</h1>");
    assert.ok(!shareHtmlBody.includes("<h1>分享 qa-share</h1>"), "share page should not display share code in title");

    const lockedShare = await app.request("/api/shares/qa-share");
    const lockedBody = await expectJson(lockedShare, 200, "locked share read");
    assert.equal(lockedBody.locked, true);

    const wrongSharePassword = await app.request("/api/shares/qa-share/verify", {
      method: "POST",
      json: { password: "wrong" },
    });
    await expectJson(wrongSharePassword, 403, "wrong share password rejected");

    const verifiedShare = await app.request("/api/shares/qa-share/verify", {
      method: "POST",
      json: { password: "share-pass" },
    });
    const verifiedBody = await expectJson(verifiedShare, 200, "share verify");
    assert.equal(verifiedBody.locked, false);
    assert.deepEqual(verifiedBody.files.map((file) => file.id), [report.id]);

    const shareDownload = await app.request("/api/shares/qa-share/download", {
      method: "POST",
      json: { password: "share-pass", ids: [report.id] },
    });
    assert.equal(shareDownload.status, 200);
    assert.equal(await shareDownload.text(), "hello from alice");

    const searchUsers = await app.api("/api/users/search?q=Root", normalUser);
    assert.ok(searchUsers.users.some((item) => item.name === "admin"));

    const friend = await app.api("/api/friends/admin", normalUser, { method: "POST", json: {} }, 200);
    assert.equal(friend.friend.name, "admin");
    const friends = await app.api("/api/friends", normalUser);
    assert.ok(friends.friends.some((item) => item.name === "admin"));

    const message = await app.api(
      "/api/messages/admin",
      normalUser,
      {
        method: "POST",
        json: { message: "please review", fileIds: [report.id] },
      },
      201,
    );
    assert.equal(message.message.message, "please review");
    assert.deepEqual(message.message.files.map((file) => file.id), [report.id]);

    const conversation = await app.api("/api/messages/alice", admin);
    assert.ok(conversation.messages.some((item) => item.message === "please review"));

    await app.api("/api/friends/admin", normalUser, { method: "DELETE", json: {} }, 200);
    const friendsAfterDelete = await app.api("/api/friends", normalUser);
    assert.ok(!friendsAfterDelete.friends.some((item) => item.name === "admin"));

    const htmlResponse = await app.request("/", { cookie: normalUser.cookie });
    const html = await expectText(htmlResponse, 200, "GET / authenticated");
    assertIncludes(html, 'id="context-menu"');
    assertIncludes(html, 'id="context-menu" class="context-menu" hidden');
    assertIncludes(html, 'id="share-output" readonly');
    assertIncludes(html, 'id="copy-share-link-button" type="button" disabled');
    assertIncludes(html, "<span>描述</span>");
    assertIncludes(html, "<span>标签</span>");
    assertIncludes(html, "搜索文件名、标签、描述、扩展名");

    await app.api(
      "/api/files",
      normalUser,
      { method: "DELETE", json: { ids: [copied.files[0].id] } },
      200,
    );
    const afterDelete = await app.api("/api/files", normalUser);
    assert.ok(!afterDelete.files.some((file) => file.id === copied.files[0].id));

    const missingCsrf = await app.request(`/api/files/${report.id}/description`, {
      method: "PATCH",
      json: { description: "blocked" },
      cookie: normalUser.cookie,
    });
    await expectJson(missingCsrf, 403, "write without CSRF rejected");

    const crossSiteWrite = await app.request(`/api/files/${report.id}/description`, {
      method: "PATCH",
      json: { description: "blocked" },
      cookie: normalUser.cookie,
      csrf: normalUser.csrf,
      headers: { Origin: "https://evil.example" },
    });
    await expectJson(crossSiteWrite, 403, "cross-site write rejected");

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      cookie: normalUser.cookie,
    });
    await expectJson(logout, 200, "logout");
    assertIncludes(logout.headers.get("set-cookie"), "Max-Age=0");
  } finally {
    await mf.dispose();
  }
});

async function main() {
  await buildWorker();

  let failures = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error?.stack || error);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} e2e test(s) failed`);
  }
}

await main();
