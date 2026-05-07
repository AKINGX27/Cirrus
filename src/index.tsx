import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { createObjectStorage, storageLabel, type ObjectStorage, type StorageEnv } from "./object-storage";
import {
  AppError,
  copyFiles,
  createFileFromUpload,
  createShare,
  deleteDriveFile,
  getActiveFileMeta,
  getShare,
  incrementDownload,
  listFiles,
  objectKey,
  cleanDescription,
  parseOptionalDate,
  renameFile,
  resolveShareFiles,
  verifySharePassword,
  type CreateShareInput,
  type DriveFileMeta,
} from "./storage";
import { createStoredZipStream } from "./zip";

type Bindings = StorageEnv;

const app = new Hono<{ Bindings: Bindings }>();

function jsonError(error: unknown) {
  if (error instanceof AppError) {
    return {
      message: error.message,
      status: error.status,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      status: 500,
    };
  }

  return {
    message: "服务暂时不可用",
    status: 500,
  };
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function isUploadedFile(value: unknown): value is File {
  return value instanceof File && value.size > 0;
}

function attachmentName(name: string) {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function jsonBody<T>(request: Request) {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("请求体不是有效 JSON");
  }
}

function idsFromValue(value: unknown) {
  if (!Array.isArray(value)) throw new AppError("请选择文件");
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!ids.length) throw new AppError("请选择文件");
  return Array.from(new Set(ids));
}

async function zipResponse(storage: ObjectStorage, files: DriveFileMeta[], archiveName: string) {
  if (!files.length) throw new AppError("文件不存在", 404);

  const sources = [];
  for (const file of files) {
    const object = await storage.get(objectKey(file.id));
    if (!object?.body) continue;
    sources.push({
      name: file.name,
      size: file.size,
      uploadedAt: file.uploadedAt,
      body: object.body,
    });
  }

  if (!sources.length) throw new AppError("文件不存在", 404);

  await Promise.all(files.map((file) => incrementDownload(storage, file.id)));

  return new Response(createStoredZipStream(sources), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentName(archiveName),
      "Cache-Control": "no-store",
    },
  });
}

async function singleFileResponse(storage: ObjectStorage, file: DriveFileMeta) {
  const object = await storage.get(objectKey(file.id));
  if (!object?.body) throw new AppError("文件不存在", 404);

  await incrementDownload(storage, file.id);

  return new Response(object.body, {
    headers: {
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": attachmentName(file.name),
      "Cache-Control": "no-store",
    },
  });
}

app.use(
  jsxRenderer(({ children }) => {
    return (
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Cirrus Drive</title>
          <style dangerouslySetInnerHTML={{ __html: styles }} />
        </head>
        <body>{children}</body>
      </html>
    );
  }),
);

app.get("/", (c) => c.render(<DriveApp storageName={storageLabel(c.env)} />));

app.get("/s/:code", (c) => {
  const code = c.req.param("code");
  return c.render(<ShareApp code={code} />);
});

app.get("/api/files", async (c) => {
  const storage = createObjectStorage(c.env);
  const files = await listFiles(storage);
  return c.json({ files });
});

app.post("/api/files", async (c) => {
  try {
    const form = await c.req.formData();
    const expiresAt = parseOptionalDate(form.get("expiresAt"));
    const description = cleanDescription(form.get("description"));
    const files = (form.getAll("files") as unknown[]).filter(isUploadedFile);

    if (!files.length) {
      throw new AppError("请选择要上传的文件");
    }

    const storage = createObjectStorage(c.env);
    const uploaded = await Promise.all(files.map((file) => createFileFromUpload(storage, file, expiresAt, description)));

    return c.json({ files: uploaded }, 201);
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.patch("/api/files/:id", async (c) => {
  try {
    const body = await jsonBody<{ name?: unknown }>(c.req.raw);
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new AppError("请输入文件名");
    }
    const storage = createObjectStorage(c.env);
    const file = await renameFile(storage, c.req.param("id"), body.name);
    return c.json({ file });
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.delete("/api/files", async (c) => {
  try {
    const body = await jsonBody<{ ids?: unknown }>(c.req.raw);
    const ids = idsFromValue(body.ids);
    const storage = createObjectStorage(c.env);
    await Promise.all(ids.map((id) => deleteDriveFile(storage, id)));
    return c.json({ ok: true });
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.post("/api/files/copy", async (c) => {
  try {
    const body = await jsonBody<{ ids?: unknown }>(c.req.raw);
    const ids = idsFromValue(body.ids);
    const storage = createObjectStorage(c.env);
    const files = await copyFiles(storage, ids);
    return c.json({ files });
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.get("/api/files/:id/download", async (c) => {
  try {
    const storage = createObjectStorage(c.env);
    const file = await getActiveFileMeta(storage, c.req.param("id"));
    if (!file) throw new AppError("文件不存在", 404);
    return singleFileResponse(storage, file);
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.post("/api/files/download", async (c) => {
  try {
    const body = await jsonBody<{ ids?: unknown }>(c.req.raw);
    const ids = idsFromValue(body.ids);
    const storage = createObjectStorage(c.env);
    const files = (
      await Promise.all(ids.map((id) => getActiveFileMeta(storage, id)))
    ).filter(Boolean) as DriveFileMeta[];

    if (files.length === 1) {
      return singleFileResponse(storage, files[0]);
    }

    return zipResponse(storage, files, `Cirrus-${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.post("/api/shares", async (c) => {
  try {
    const body = await jsonBody<{
      fileIds?: unknown;
      code?: unknown;
      password?: unknown;
      expiresAt?: unknown;
    }>(c.req.raw);

    const input: CreateShareInput = {
      fileIds: idsFromValue(body.fileIds),
      code: typeof body.code === "string" && body.code.trim() ? body.code : undefined,
      password: typeof body.password === "string" && body.password.trim() ? body.password : undefined,
      expiresAt: parseOptionalDate(body.expiresAt),
    };

    const storage = createObjectStorage(c.env);
    const share = await createShare(storage, input);
    return c.json({
      share: {
        code: share.code,
        fileIds: share.fileIds,
        expiresAt: share.expiresAt,
        hasPassword: Boolean(share.passwordHash),
        url: new URL(`/s/${share.code}`, c.req.url).toString(),
      },
    });
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.get("/api/shares/:code", async (c) => {
  try {
    const storage = createObjectStorage(c.env);
    const share = await getShare(storage, c.req.param("code"));
    if (!share) throw new AppError("分享不存在或已过期", 404);

    const password = c.req.query("password");
    const verified = await verifySharePassword(share, password);
    if (!verified) {
      return c.json({
        locked: true,
        code: share.code,
        expiresAt: share.expiresAt,
      });
    }

    const files = await resolveShareFiles(storage, share);
    return c.json({
      locked: false,
      code: share.code,
      expiresAt: share.expiresAt,
      files,
    });
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

app.post("/api/shares/:code/download", async (c) => {
  try {
    const body = await jsonBody<{ password?: unknown; ids?: unknown }>(c.req.raw);
    const storage = createObjectStorage(c.env);
    const share = await getShare(storage, c.req.param("code"));
    if (!share) throw new AppError("分享不存在或已过期", 404);

    const password = typeof body.password === "string" ? body.password : undefined;
    const verified = await verifySharePassword(share, password);
    if (!verified) throw new AppError("密码不正确", 403);

    const allFiles = await resolveShareFiles(storage, share);
    const requestedIds = body.ids ? new Set(idsFromValue(body.ids)) : null;
    const files = requestedIds ? allFiles.filter((file) => requestedIds.has(file.id)) : allFiles;

    if (files.length === 1) {
      return singleFileResponse(storage, files[0]);
    }

    return zipResponse(storage, files, `Cirrus-share-${share.code}.zip`);
  } catch (error) {
    const { message, status } = jsonError(error);
    return errorResponse(message, status);
  }
});

function DriveApp({ storageName }: { storageName: string }) {
  return (
    <main class="app-shell" data-app="drive">
      <aside class="side-rail">
        <a class="brand" href="/" aria-label="Cirrus Drive">
          <span class="brand-mark">C</span>
          <span>
            <strong>Cirrus</strong>
            <small>Cloud Drive</small>
          </span>
        </a>
        <nav class="nav-stack" aria-label="主导航">
          <button class="nav-item active" type="button" data-view="files">
            <span>云端文件</span>
          </button>
          <button class="nav-item" type="button" data-action="refresh">
            <span>刷新列表</span>
          </button>
          <button class="nav-item" type="button" data-action="paste" disabled>
            <span>粘贴</span>
          </button>
        </nav>
        <div class="storage-card">
          <span>{storageName}</span>
          <strong id="storage-count">0 个文件</strong>
        </div>
      </aside>

      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">Personal Cloud</p>
            <h1>文件</h1>
          </div>
          <form class="upload-card" id="upload-form">
            <label class="upload-button">
              <input id="file-input" name="files" type="file" multiple />
              <span>上传</span>
            </label>
            <select id="retention-select" aria-label="存留时间">
              <option value="">永久保存</option>
              <option value="1">保留 1 天</option>
              <option value="7">保留 7 天</option>
              <option value="30">保留 30 天</option>
              <option value="custom">自定义</option>
            </select>
            <input id="upload-description" name="description" maxLength={500} placeholder="描述" aria-label="文件描述" />
            <input id="custom-expiry" type="datetime-local" aria-label="自定义存留到期时间" hidden />
          </form>
        </header>

        <div class="command-bar" role="toolbar" aria-label="文件操作">
          <button type="button" data-action="download-selected" disabled>下载</button>
          <button type="button" data-action="share-selected" disabled>分享</button>
          <button type="button" data-action="copy-selected" disabled>复制</button>
          <button type="button" data-action="cut-selected" disabled>剪切</button>
          <button type="button" data-action="rename-selected" disabled>改名</button>
          <button type="button" data-action="delete-selected" disabled>删除</button>
          <span id="selection-summary">未选择文件</span>
        </div>

        <section class="file-surface" id="file-surface" aria-label="文件列表">
          <div class="table-head" aria-hidden="true">
            <span>名称</span>
            <span>描述</span>
            <span>上传时间</span>
            <span>最后下载</span>
            <span>下载次数</span>
          </div>
          <div id="file-list" class="file-list"></div>
          <div id="empty-state" class="empty-state" hidden>
            <strong>还没有文件</strong>
            <span>上传后会直接出现在这里。</span>
          </div>
          <div id="selection-box" class="selection-box" hidden></div>
        </section>
      </section>

      <div id="context-menu" class="context-menu" hidden>
        <button type="button" data-menu-action="rename">改名</button>
        <button type="button" data-menu-action="download">下载</button>
        <button type="button" data-menu-action="select">选择</button>
        <button type="button" data-menu-action="copy">复制</button>
        <button type="button" data-menu-action="cut">剪切</button>
        <button type="button" data-menu-action="share">分享</button>
      </div>

      <dialog id="share-dialog" class="modal">
        <form method="dialog" class="modal-panel" id="share-form">
          <header>
            <h2>创建分享</h2>
            <button value="cancel" aria-label="关闭">×</button>
          </header>
          <label>
            <span>分享码</span>
            <input id="share-code" placeholder="留空自动生成" autocomplete="off" />
          </label>
          <label>
            <span>密码</span>
            <input id="share-password" placeholder="留空免密码" autocomplete="new-password" />
          </label>
          <label>
            <span>有效期</span>
            <input id="share-expiry" type="datetime-local" />
          </label>
          <output id="share-output"></output>
          <footer>
            <button value="cancel">取消</button>
            <button id="create-share-button" value="default">生成分享</button>
          </footer>
        </form>
      </dialog>

      <script dangerouslySetInnerHTML={{ __html: clientScript }} />
    </main>
  );
}

function ShareApp({ code }: { code: string }) {
  return (
    <main class="share-shell" data-app="share" data-share-code={code}>
      <section class="share-panel">
        <a class="brand" href="/" aria-label="Cirrus Drive">
          <span class="brand-mark">C</span>
          <span>
            <strong>Cirrus</strong>
            <small>Shared files</small>
          </span>
        </a>
        <div class="share-heading">
          <p class="eyebrow">Share Link</p>
          <h1>分享 {code}</h1>
          <span id="share-expiry-note"></span>
        </div>
        <form id="share-password-form" class="password-card" hidden>
          <input id="share-password-input" type="password" placeholder="输入分享密码" autocomplete="current-password" />
          <button>解锁</button>
        </form>
        <div class="command-bar">
          <button type="button" data-action="share-download-all" disabled>下载全部</button>
          <span id="share-status">正在读取分享...</span>
        </div>
        <div id="share-file-list" class="file-list shared"></div>
      </section>
      <script dangerouslySetInnerHTML={{ __html: shareClientScript }} />
    </main>
  );
}

const styles = String.raw`
:root {
  color-scheme: light dark;
  --bg: #eef4f7;
  --bg-2: #f8fbfb;
  --text: #172326;
  --muted: #627174;
  --line: rgba(49, 74, 79, 0.18);
  --glass: rgba(255, 255, 255, 0.58);
  --glass-strong: rgba(255, 255, 255, 0.76);
  --accent: #067a88;
  --accent-2: #b9572a;
  --danger: #b42318;
  --shadow: 0 24px 70px rgba(28, 54, 61, 0.18);
  --radius: 8px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #071111;
    --bg-2: #101b1c;
    --text: #edf6f5;
    --muted: #a4b4b4;
    --line: rgba(214, 239, 239, 0.16);
    --glass: rgba(19, 31, 33, 0.62);
    --glass-strong: rgba(26, 42, 45, 0.78);
    --accent: #46c3c8;
    --accent-2: #f08b57;
    --danger: #ff8d80;
    --shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
  }
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

body {
  min-height: 100vh;
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(circle at 18% 12%, rgba(6, 122, 136, 0.18), transparent 34%),
    radial-gradient(circle at 82% 18%, rgba(185, 87, 42, 0.16), transparent 28%),
    linear-gradient(135deg, var(--bg), var(--bg-2));
  letter-spacing: 0;
}

button,
input,
select {
  font: inherit;
}

button {
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--glass-strong);
  cursor: pointer;
  backdrop-filter: blur(18px) saturate(1.3);
  transition:
    transform 160ms ease,
    border-color 160ms ease,
    background 160ms ease;
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent), var(--line) 35%);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

input,
select {
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--glass);
  padding: 0 12px;
  outline: none;
  backdrop-filter: blur(18px) saturate(1.3);
}

input:focus,
select:focus {
  border-color: var(--accent);
}

.app-shell {
  display: grid;
  min-height: 100vh;
  grid-template-columns: 252px minmax(0, 1fr);
}

.side-rail {
  position: sticky;
  top: 0;
  display: flex;
  height: 100vh;
  flex-direction: column;
  gap: 22px;
  padding: 22px;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--glass), transparent 10%);
  backdrop-filter: blur(28px) saturate(1.35);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: inherit;
  text-decoration: none;
}

.brand-mark {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent), var(--line) 42%);
  border-radius: 8px;
  color: white;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  font-weight: 800;
  box-shadow: 0 16px 32px rgba(6, 122, 136, 0.22);
}

.brand strong,
.brand small {
  display: block;
}

.brand small {
  color: var(--muted);
}

.nav-stack {
  display: grid;
  gap: 8px;
}

.nav-item {
  justify-content: flex-start;
  width: 100%;
  padding: 0 12px;
  text-align: left;
}

.nav-item.active {
  color: white;
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent), #0f2f35 32%));
}

.storage-card {
  margin-top: auto;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--glass);
  box-shadow: var(--shadow);
}

.storage-card span,
.storage-card strong {
  display: block;
}

.storage-card span,
.eyebrow,
.table-head,
#selection-summary,
#share-status,
#share-expiry-note {
  color: var(--muted);
  font-size: 0.86rem;
}

.workspace {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding: 24px clamp(16px, 3vw, 38px);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.eyebrow {
  margin: 0 0 3px;
  text-transform: uppercase;
}

h1,
h2 {
  margin: 0;
  line-height: 1.05;
  letter-spacing: 0;
}

h1 {
  font-size: clamp(2rem, 4vw, 3.7rem);
}

h2 {
  font-size: 1.2rem;
}

.upload-card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: min(100%, 720px);
  justify-content: flex-end;
}

.upload-button {
  display: inline-grid;
  min-height: 38px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: white;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  cursor: pointer;
  padding: 0 16px;
  box-shadow: 0 18px 40px rgba(6, 122, 136, 0.18);
}

.upload-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.command-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 54px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--glass);
  box-shadow: var(--shadow);
  backdrop-filter: blur(24px) saturate(1.4);
  overflow-x: auto;
}

.command-bar button {
  flex: 0 0 auto;
  padding: 0 12px;
}

.command-bar span {
  margin-left: auto;
  white-space: nowrap;
}

.file-surface {
  position: relative;
  min-height: 420px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--glass), transparent 8%);
  box-shadow: var(--shadow);
  backdrop-filter: blur(30px) saturate(1.35);
}

.table-head,
.file-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(180px, 0.78fr) minmax(150px, 0.45fr) minmax(150px, 0.45fr) 112px;
  align-items: center;
  gap: 12px;
}

.table-head {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 46px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--glass-strong), transparent 3%);
  backdrop-filter: blur(24px) saturate(1.35);
}

.file-list {
  display: grid;
  align-content: start;
  max-height: calc(100vh - 214px);
  overflow: auto;
}

.file-row {
  position: relative;
  min-height: 58px;
  padding: 0 18px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--line), transparent 35%);
  border-radius: 0;
  background: transparent;
  text-align: left;
  transform: none;
}

.file-row:hover,
.file-row.selected {
  background: color-mix(in srgb, var(--accent), transparent 87%);
}

.file-row.cut {
  opacity: 0.52;
}

.file-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.file-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  color: white;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  font-size: 0.78rem;
  font-weight: 800;
}

.file-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  display: block;
  color: var(--muted);
  font-size: 0.82rem;
}

.file-description {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state {
  display: grid;
  min-height: 320px;
  place-content: center;
  gap: 8px;
  color: var(--muted);
  text-align: center;
}

.empty-state strong {
  color: var(--text);
  font-size: 1.15rem;
}

.selection-box {
  position: fixed;
  z-index: 10;
  border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent), transparent 80%);
  pointer-events: none;
}

.context-menu {
  position: fixed;
  z-index: 30;
  display: grid;
  min-width: 180px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--glass-strong);
  box-shadow: var(--shadow);
  backdrop-filter: blur(30px) saturate(1.4);
}

.context-menu button {
  min-height: 40px;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
  padding: 0 14px;
}

.modal {
  width: min(460px, calc(100vw - 28px));
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  background: var(--glass-strong);
  box-shadow: var(--shadow);
  backdrop-filter: blur(32px) saturate(1.45);
}

.modal::backdrop {
  background: rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(8px);
}

.modal-panel {
  display: grid;
  gap: 14px;
}

.modal-panel header,
.modal-panel footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.modal-panel label {
  display: grid;
  gap: 6px;
  color: var(--muted);
}

.modal-panel input {
  width: 100%;
}

.modal-panel output {
  min-height: 22px;
  color: var(--accent);
  word-break: break-all;
}

.share-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.share-panel {
  display: grid;
  width: min(920px, 100%);
  gap: 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--glass);
  padding: clamp(18px, 4vw, 34px);
  box-shadow: var(--shadow);
  backdrop-filter: blur(30px) saturate(1.4);
}

.share-heading {
  display: grid;
  gap: 6px;
}

.password-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

.file-list.shared {
  max-height: 54vh;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

@media (max-width: 860px) {
  .app-shell {
    display: block;
  }

  .side-rail {
    position: static;
    height: auto;
    flex-direction: row;
    align-items: center;
    padding: 14px;
    overflow-x: auto;
  }

  .nav-stack {
    display: flex;
    min-width: max-content;
  }

  .storage-card {
    margin: 0 0 0 auto;
    min-width: 140px;
  }

  .workspace {
    padding: 16px;
  }

  .topbar,
  .upload-card {
    align-items: stretch;
    flex-direction: column;
  }

  .upload-card {
    min-width: 0;
  }

  .table-head {
    display: none;
  }

  .file-list {
    max-height: none;
  }

  .file-row {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "name count"
      "description description"
      "uploaded uploaded"
      "downloaded downloaded";
    gap: 4px 12px;
    min-height: 104px;
    padding: 12px;
  }

  .file-row > :nth-child(1) {
    grid-area: name;
  }

  .file-row > :nth-child(2) {
    grid-area: description;
  }

  .file-row > :nth-child(3) {
    grid-area: uploaded;
  }

  .file-row > :nth-child(4) {
    grid-area: downloaded;
  }

  .file-row > :nth-child(5) {
    grid-area: count;
    text-align: right;
  }
}

@media (max-width: 560px) {
  .side-rail {
    display: grid;
    grid-template-columns: 1fr;
  }

  .brand {
    width: 100%;
  }

  .storage-card {
    margin: 0;
  }

  .command-bar {
    align-items: stretch;
  }

  .command-bar span {
    margin-left: 0;
  }

  .password-card {
    grid-template-columns: 1fr;
  }
}
`;

const clientScript = String.raw`
(() => {
  const state = {
    files: [],
    selected: new Set(),
    clipboard: null,
    contextId: null,
    dragging: null
  };

  const list = document.getElementById("file-list");
  const surface = document.getElementById("file-surface");
  const empty = document.getElementById("empty-state");
  const menu = document.getElementById("context-menu");
  const summary = document.getElementById("selection-summary");
  const storageCount = document.getElementById("storage-count");
  const shareDialog = document.getElementById("share-dialog");
  const shareForm = document.getElementById("share-form");
  const selectionBox = document.getElementById("selection-box");

  const buttons = {
    download: document.querySelector('[data-action="download-selected"]'),
    share: document.querySelector('[data-action="share-selected"]'),
    copy: document.querySelector('[data-action="copy-selected"]'),
    cut: document.querySelector('[data-action="cut-selected"]'),
    rename: document.querySelector('[data-action="rename-selected"]'),
    delete: document.querySelector('[data-action="delete-selected"]'),
    paste: document.querySelector('[data-action="paste"]')
  };

  function notify(message, tone = "info") {
    summary.textContent = message;
    summary.dataset.tone = tone;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      let message = "请求失败";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {}
      throw new Error(message);
    }

    return response.json();
  }

  function formatDate(value) {
    if (!value) return "从未";
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return size.toFixed(size >= 10 || unit === 0 ? 0 : 1) + " " + units[unit];
  }

  function ext(name) {
    const match = name.match(/\\.([^.]+)$/);
    return match ? match[1].slice(0, 4).toUpperCase() : "FILE";
  }

  function selectedFiles() {
    return state.files.filter((file) => state.selected.has(file.id));
  }

  function updateButtons() {
    const count = state.selected.size;
    for (const key of ["download", "share", "copy", "cut", "delete"]) {
      buttons[key].disabled = count === 0;
    }
    buttons.rename.disabled = count !== 1;
    buttons.paste.disabled = !state.clipboard;
    summary.textContent = count ? "已选择 " + count + " 个文件" : "未选择文件";
    storageCount.textContent = state.files.length + " 个文件";
  }

  function render() {
    list.innerHTML = "";
    for (const file of state.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-row";
      row.dataset.id = file.id;
      row.classList.toggle("selected", state.selected.has(file.id));
      row.classList.toggle(
        "cut",
        state.clipboard?.mode === "cut" && state.clipboard.ids.includes(file.id)
      );

      row.innerHTML =
        '<span class="file-name">' +
          '<span class="file-icon">' + ext(file.name) + '</span>' +
          '<span>' +
            '<strong class="file-title"></strong>' +
            '<small class="file-size">' + formatSize(file.size) + '</small>' +
          '</span>' +
        '</span>' +
        '<span class="file-description"></span>' +
        '<span>' + formatDate(file.uploadedAt) + '</span>' +
        '<span>' + formatDate(file.lastDownloadedAt) + '</span>' +
        '<span>' + file.downloadCount + '</span>';
      row.querySelector(".file-title").textContent = file.name;
      row.querySelector(".file-description").textContent = file.description || "无描述";

      row.addEventListener("click", (event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
          toggle(file.id);
        } else {
          state.selected.clear();
          state.selected.add(file.id);
        }
        hideMenu();
        render();
      });

      row.addEventListener("dblclick", () => downloadIds([file.id]));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!state.selected.has(file.id)) {
          state.selected.clear();
          state.selected.add(file.id);
          render();
        }
        state.contextId = file.id;
        showMenu(event.clientX, event.clientY);
      });

      list.append(row);
    }

    empty.hidden = state.files.length !== 0;
    updateButtons();
  }

  function toggle(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  }

  function hideMenu() {
    menu.hidden = true;
  }

  function showMenu(x, y) {
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 10) + "px";
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 10) + "px";
  }

  async function loadFiles() {
    notify("正在读取文件...");
    const data = await api("/api/files");
    state.files = data.files || [];
    state.selected.clear();
    render();
  }

  function getExpiryValue() {
    const select = document.getElementById("retention-select");
    const custom = document.getElementById("custom-expiry");
    if (!select.value) return "";
    if (select.value === "custom") return custom.value ? new Date(custom.value).toISOString() : "";
    const date = new Date();
    date.setDate(date.getDate() + Number(select.value));
    return date.toISOString();
  }

  async function uploadSelected() {
    const input = document.getElementById("file-input");
    const files = Array.from(input.files || []);
    if (!files.length) return;

    const form = new FormData();
    for (const file of files) form.append("files", file);
    form.append("description", document.getElementById("upload-description").value);
    form.append("expiresAt", getExpiryValue());

    notify("正在上传 " + files.length + " 个文件...");
    await api("/api/files", {
      method: "POST",
      body: form
    });
    input.value = "";
    document.getElementById("upload-description").value = "";
    await loadFiles();
    notify("上传完成");
  }

  function triggerBlobDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function downloadIds(ids) {
    if (!ids.length) return;
    if (ids.length === 1) {
      window.location.href = "/api/files/" + encodeURIComponent(ids[0]) + "/download";
      setTimeout(loadFiles, 1200);
      return;
    }

    notify("正在打包 " + ids.length + " 个文件...");
    const response = await fetch("/api/files/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "下载失败");
    }
    triggerBlobDownload(await response.blob(), "Cirrus-" + new Date().toISOString().slice(0, 10) + ".zip");
    setTimeout(loadFiles, 1200);
  }

  async function renameSelected() {
    const file = selectedFiles()[0];
    if (!file || state.selected.size !== 1) return;
    const name = prompt("输入新的文件名", file.name);
    if (!name || name === file.name) return;
    await api("/api/files/" + encodeURIComponent(file.id), {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
    await loadFiles();
  }

  async function deleteSelected() {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    if (!confirm("删除 " + ids.length + " 个文件？")) return;
    await api("/api/files", {
      method: "DELETE",
      body: JSON.stringify({ ids })
    });
    await loadFiles();
  }

  async function copySelectedNow() {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    await api("/api/files/copy", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    await loadFiles();
    notify("已复制为副本");
  }

  function setClipboard(mode) {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    state.clipboard = { mode, ids };
    render();
    notify(mode === "cut" ? "已剪切，当前网盘没有文件夹时粘贴会保留原位置" : "已复制，可用左侧粘贴生成副本");
  }

  async function pasteClipboard() {
    if (!state.clipboard) return;
    if (state.clipboard.mode === "copy") {
      await api("/api/files/copy", {
        method: "POST",
        body: JSON.stringify({ ids: state.clipboard.ids })
      });
      state.clipboard = null;
      await loadFiles();
      notify("已粘贴副本");
      return;
    }
    state.clipboard = null;
    render();
    notify("已清除剪切状态");
  }

  function openShareDialog() {
    if (!state.selected.size) return;
    document.getElementById("share-code").value = "";
    document.getElementById("share-password").value = "";
    document.getElementById("share-expiry").value = "";
    document.getElementById("share-output").value = "";
    shareDialog.showModal();
  }

  async function createShareFromDialog(event) {
    event.preventDefault();
    const code = document.getElementById("share-code").value;
    const password = document.getElementById("share-password").value;
    const expiry = document.getElementById("share-expiry").value;
    const data = await api("/api/shares", {
      method: "POST",
      body: JSON.stringify({
        fileIds: Array.from(state.selected),
        code,
        password,
        expiresAt: expiry ? new Date(expiry).toISOString() : ""
      })
    });
    const output = document.getElementById("share-output");
    output.value = data.share.url;
    await navigator.clipboard?.writeText(data.share.url).catch(() => {});
    notify("分享链接已生成");
  }

  function updateSelectionBox(start, current) {
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(start.x - current.x);
    const height = Math.abs(start.y - current.y);
    Object.assign(selectionBox.style, {
      left: left + "px",
      top: top + "px",
      width: width + "px",
      height: height + "px"
    });

    const box = { left, top, right: left + width, bottom: top + height };
    for (const row of list.querySelectorAll(".file-row")) {
      const rect = row.getBoundingClientRect();
      const hit = rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
      const id = row.dataset.id;
      if (hit) state.selected.add(id);
      else if (!state.dragging.additive) state.selected.delete(id);
    }
    render();
    selectionBox.hidden = false;
  }

  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".file-row, button, input, select, a")) return;
    hideMenu();
    state.dragging = {
      start: { x: event.clientX, y: event.clientY },
      additive: event.ctrlKey || event.metaKey || event.shiftKey
    };
    if (!state.dragging.additive) state.selected.clear();
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    updateSelectionBox(state.dragging.start, { x: event.clientX, y: event.clientY });
  });

  surface.addEventListener("pointerup", (event) => {
    if (!state.dragging) return;
    state.dragging = null;
    selectionBox.hidden = true;
    surface.releasePointerCapture(event.pointerId);
    render();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".context-menu")) hideMenu();
  });

  document.getElementById("retention-select").addEventListener("change", (event) => {
    document.getElementById("custom-expiry").hidden = event.target.value !== "custom";
  });
  document.getElementById("file-input").addEventListener("change", () => uploadSelected().catch((error) => notify(error.message, "error")));
  document.querySelector('[data-action="refresh"]').addEventListener("click", () => loadFiles().catch((error) => notify(error.message, "error")));
  buttons.download.addEventListener("click", () => downloadIds(Array.from(state.selected)).catch((error) => notify(error.message, "error")));
  buttons.share.addEventListener("click", openShareDialog);
  buttons.copy.addEventListener("click", () => setClipboard("copy"));
  buttons.cut.addEventListener("click", () => setClipboard("cut"));
  buttons.rename.addEventListener("click", () => renameSelected().catch((error) => notify(error.message, "error")));
  buttons.delete.addEventListener("click", () => deleteSelected().catch((error) => notify(error.message, "error")));
  buttons.paste.addEventListener("click", () => pasteClipboard().catch((error) => notify(error.message, "error")));
  shareForm.addEventListener("submit", (event) => createShareFromDialog(event).catch((error) => notify(error.message, "error")));

  menu.addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.menuAction;
    if (!action) return;
    hideMenu();
    if (action === "rename") renameSelected().catch((error) => notify(error.message, "error"));
    if (action === "download") downloadIds(Array.from(state.selected)).catch((error) => notify(error.message, "error"));
    if (action === "select") render();
    if (action === "copy") setClipboard("copy");
    if (action === "cut") setClipboard("cut");
    if (action === "share") openShareDialog();
  });

  loadFiles().catch((error) => notify(error.message, "error"));
})();
`;

const shareClientScript = String.raw`
(() => {
  const code = document.querySelector("[data-share-code]").dataset.shareCode;
  const list = document.getElementById("share-file-list");
  const status = document.getElementById("share-status");
  const form = document.getElementById("share-password-form");
  const input = document.getElementById("share-password-input");
  const expiryNote = document.getElementById("share-expiry-note");
  const allButton = document.querySelector('[data-action="share-download-all"]');
  const state = { files: [], password: "" };

  async function fetchShare() {
    status.textContent = "正在读取分享...";
    const url = new URL("/api/shares/" + encodeURIComponent(code), location.origin);
    if (state.password) url.searchParams.set("password", state.password);
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "分享读取失败");

    if (data.expiresAt) {
      expiryNote.textContent = "有效期至 " + new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.expiresAt));
    }

    if (data.locked) {
      form.hidden = false;
      status.textContent = "该分享需要密码";
      return;
    }

    form.hidden = true;
    state.files = data.files || [];
    render();
  }

  function formatDate(value) {
    if (!value) return "从未";
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes || 0;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return size.toFixed(size >= 10 || unit === 0 ? 0 : 1) + " " + units[unit];
  }

  function render() {
    list.innerHTML = "";
    for (const file of state.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-row";
      row.innerHTML =
        '<span class="file-name">' +
          '<span class="file-icon">FILE</span>' +
          '<span>' +
            '<strong class="file-title"></strong>' +
            '<small class="file-size">' + formatSize(file.size) + '</small>' +
          '</span>' +
        '</span>' +
        '<span class="file-description"></span>' +
        '<span>' + formatDate(file.uploadedAt) + '</span>' +
        '<span>' + formatDate(file.lastDownloadedAt) + '</span>' +
        '<span>' + file.downloadCount + '</span>';
      row.querySelector(".file-title").textContent = file.name;
      row.querySelector(".file-description").textContent = file.description || "无描述";
      row.addEventListener("click", () => download([file.id]));
      list.append(row);
    }
    status.textContent = state.files.length ? state.files.length + " 个文件" : "分享中没有可下载文件";
    allButton.disabled = state.files.length === 0;
  }

  function triggerBlobDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function download(ids) {
    const response = await fetch("/api/shares/" + encodeURIComponent(code) + "/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: state.password, ids })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "下载失败");
    }
    const single = ids.length === 1 ? state.files.find((file) => file.id === ids[0]) : null;
    triggerBlobDownload(await response.blob(), single?.name || "Cirrus-share-" + code + ".zip");
    setTimeout(fetchShare, 1200);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.password = input.value;
    fetchShare().catch((error) => {
      status.textContent = error.message;
    });
  });

  allButton.addEventListener("click", () => download(state.files.map((file) => file.id)).catch((error) => {
    status.textContent = error.message;
  }));

  fetchShare().catch((error) => {
    status.textContent = error.message;
  });
})();
`;

export default app;
