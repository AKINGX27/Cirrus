import type { ObjectStorage } from "./object-storage";

const OBJECT_PREFIX = "objects/";
const META_PREFIX = "meta/";
const SHARE_PREFIX = "shares/";
const PERMISSIONS_KEY = "permissions/tag-grants.json";

export interface DriveFileMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  owner: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  expiresAt: string | null;
  lastDownloadedAt: string | null;
  downloadCount: number;
}

export interface ShareRecord {
  code: string;
  fileIds: string[];
  passwordHash: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface CreateShareInput {
  fileIds: string[];
  code?: string;
  password?: string;
  expiresAt?: string | null;
}

export interface SetUserVisibleTagsOptions {
  allowedUsers?: string[];
}

export type UserTagGrants = Record<string, string[]>;

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function objectKey(id: string) {
  return `${OBJECT_PREFIX}${id}`;
}

function metaKey(id: string) {
  return `${META_PREFIX}${id}.json`;
}

function shareKey(code: string) {
  return `${SHARE_PREFIX}${code}.json`;
}

export function cleanFileName(name: string) {
  const cleaned = name
    .replace(/[\/\\]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  if (!cleaned || cleaned === "." || cleaned === "..") return "untitled";
  return cleaned;
}

export function cleanDescription(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function cleanTags(value: unknown) {
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，\n]+/)
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const raw of rawTags) {
    if (typeof raw !== "string") continue;
    const tag = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 32);
    if (!tag) continue;

    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 20) break;
  }

  return tags;
}

function cleanOwner(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f:,\s]+/g, "").trim().slice(0, 64);
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()) {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now;
}

export function parseOptionalDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("时间格式无效");
  }
  return date.toISOString();
}

function cleanContentType(value: unknown) {
  if (typeof value !== "string") return "application/octet-stream";
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/.test(normalized)) {
    return "application/octet-stream";
  }
  if (normalized === "text/html" || normalized === "application/xhtml+xml" || normalized === "image/svg+xml") {
    return "application/octet-stream";
  }
  return normalized.slice(0, 120);
}

async function readJson<T>(storage: ObjectStorage, key: string): Promise<T | null> {
  const object = await storage.get(key);
  if (!object) return null;

  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(storage: ObjectStorage, key: string, value: unknown) {
  await storage.put(key, JSON.stringify(value), {
    contentType: "application/json; charset=utf-8",
  });
}

function normalizeFileMeta(meta: Partial<DriveFileMeta> | null) {
  if (!meta || typeof meta.id !== "string" || typeof meta.name !== "string") return null;

  return {
    id: meta.id,
    name: cleanFileName(meta.name),
    description: cleanDescription(meta.description),
    tags: cleanTags(meta.tags),
    owner: cleanOwner(meta.owner),
    size: typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : 0,
    contentType: cleanContentType(meta.contentType),
    uploadedAt: typeof meta.uploadedAt === "string" ? meta.uploadedAt : new Date(0).toISOString(),
    expiresAt: typeof meta.expiresAt === "string" ? meta.expiresAt : null,
    lastDownloadedAt: typeof meta.lastDownloadedAt === "string" ? meta.lastDownloadedAt : null,
    downloadCount:
      typeof meta.downloadCount === "number" && Number.isFinite(meta.downloadCount) ? meta.downloadCount : 0,
  } satisfies DriveFileMeta;
}

export async function saveFileMeta(storage: ObjectStorage, meta: DriveFileMeta) {
  await writeJson(storage, metaKey(meta.id), meta);
}

export async function deleteDriveFile(storage: ObjectStorage, id: string) {
  await Promise.all([storage.delete(objectKey(id)), storage.delete(metaKey(id))]);
}

async function readFileMeta(storage: ObjectStorage, id: string) {
  return normalizeFileMeta(await readJson<Partial<DriveFileMeta>>(storage, metaKey(id)));
}

export async function getActiveFileMeta(storage: ObjectStorage, id: string) {
  const meta = await readFileMeta(storage, id);
  if (!meta) return null;

  if (isExpired(meta.expiresAt)) {
    await deleteDriveFile(storage, id);
    return null;
  }

  return meta;
}

export async function listFiles(storage: ObjectStorage) {
  const files: DriveFileMeta[] = [];
  const expiredIds: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await storage.list({
      prefix: META_PREFIX,
      cursor,
      limit: 1000,
    });

    const batch = await Promise.all(
      listed.objects.map(async (object) => normalizeFileMeta(await readJson<Partial<DriveFileMeta>>(storage, object.key))),
    );

    for (const meta of batch) {
      if (!meta) continue;
      if (isExpired(meta.expiresAt)) {
        expiredIds.push(meta.id);
      } else {
        files.push(meta);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (expiredIds.length) {
    await Promise.all(expiredIds.map((id) => deleteDriveFile(storage, id)));
  }

  return files.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
}

export async function createFileFromUpload(
  storage: ObjectStorage,
  file: File,
  expiresAt: string | null,
  description: string,
  tags: string[],
  owner: string,
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = cleanFileName(file.name);
  const contentType = cleanContentType(file.type);

  const meta: DriveFileMeta = {
    id,
    name,
    description: cleanDescription(description),
    tags: cleanTags(tags),
    owner: cleanOwner(owner),
    size: file.size,
    contentType,
    uploadedAt: now,
    expiresAt,
    lastDownloadedAt: null,
    downloadCount: 0,
  };

  await storage.put(objectKey(id), file, {
    contentType,
  });
  await saveFileMeta(storage, meta);

  return meta;
}

export async function renameFile(storage: ObjectStorage, id: string, name: string) {
  const meta = await getActiveFileMeta(storage, id);
  if (!meta) throw new AppError("文件不存在", 404);

  const next: DriveFileMeta = {
    ...meta,
    name: cleanFileName(name),
  };
  await saveFileMeta(storage, next);
  return next;
}

export async function updateFileDescription(storage: ObjectStorage, id: string, description: string) {
  const meta = await getActiveFileMeta(storage, id);
  if (!meta) throw new AppError("文件不存在", 404);

  const next: DriveFileMeta = {
    ...meta,
    description: cleanDescription(description),
  };
  await saveFileMeta(storage, next);
  return next;
}

export async function updateFileTags(storage: ObjectStorage, id: string, tags: string[]) {
  const meta = await getActiveFileMeta(storage, id);
  if (!meta) throw new AppError("文件不存在", 404);

  const next: DriveFileMeta = {
    ...meta,
    tags: cleanTags(tags),
  };
  await saveFileMeta(storage, next);
  return next;
}

export async function incrementDownload(storage: ObjectStorage, id: string) {
  const current = await getActiveFileMeta(storage, id);
  if (!current) return null;

  const next: DriveFileMeta = {
    ...current,
    downloadCount: current.downloadCount + 1,
    lastDownloadedAt: new Date().toISOString(),
  };
  await saveFileMeta(storage, next);
  return next;
}

function copyName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return `${name.slice(0, dot)} - 副本${name.slice(dot)}`;
  }
  return `${name} - 副本`;
}

export async function copyFiles(storage: ObjectStorage, ids: string[], owner?: string) {
  const copied: DriveFileMeta[] = [];

  for (const id of ids) {
    const source = await getActiveFileMeta(storage, id);
    if (!source) continue;

    const object = await storage.get(objectKey(source.id));
    if (!object?.body) continue;

    const nextId = crypto.randomUUID();
    const uploadedAt = new Date().toISOString();
    const next: DriveFileMeta = {
      ...source,
      id: nextId,
      name: copyName(source.name),
      owner: owner ? cleanOwner(owner) : source.owner,
      uploadedAt,
      lastDownloadedAt: null,
      downloadCount: 0,
    };

    await storage.put(objectKey(nextId), object.body, {
      contentType: source.contentType,
    });
    await saveFileMeta(storage, next);
    copied.push(next);
  }

  return copied;
}

function normalizeUserTagGrants(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const grants: UserTagGrants = {};
  for (const [user, tags] of Object.entries(value)) {
    const normalizedUser = cleanOwner(user);
    if (!normalizedUser) continue;
    grants[normalizedUser] = cleanTags(tags);
  }

  return grants;
}

export async function getUserTagGrants(storage: ObjectStorage) {
  return normalizeUserTagGrants(await readJson<UserTagGrants>(storage, PERMISSIONS_KEY));
}

export async function setUserVisibleTags(
  storage: ObjectStorage,
  user: string,
  tags: string[],
  options: SetUserVisibleTagsOptions = {},
) {
  const normalizedUser = cleanOwner(user);
  if (!normalizedUser) throw new AppError("用户无效");
  if (options.allowedUsers && !options.allowedUsers.includes(normalizedUser)) {
    throw new AppError("只能为已配置的普通用户设置权限", 400);
  }

  const grants = await getUserTagGrants(storage);
  grants[normalizedUser] = cleanTags(tags);
  await writeJson(storage, PERMISSIONS_KEY, grants);
  return grants[normalizedUser];
}

function normalizeShareCode(value: string) {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
    throw new AppError("分享码只能包含字母、数字、下划线和短横线，长度 4-64 位");
  }
  return code;
}

function randomShareCode(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(code: string, password: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = 120_000;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${code}:${password}`), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    key,
    256,
  );

  return `pbkdf2-sha256:${iterations}:${base64Url(salt)}:${base64Url(new Uint8Array(bits))}`;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function timingSafeBytesEqual(a: Uint8Array, b: Uint8Array) {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] || 0) ^ (b[index] || 0);
  }
  return diff === 0;
}

export async function createShare(storage: ObjectStorage, input: CreateShareInput) {
  const fileIds = Array.from(new Set(input.fileIds.filter(Boolean)));
  if (!fileIds.length) throw new AppError("请选择要分享的文件");

  const activeFiles = (
    await Promise.all(fileIds.map((id) => getActiveFileMeta(storage, id)))
  ).filter(Boolean) as DriveFileMeta[];
  if (!activeFiles.length) throw new AppError("可分享的文件不存在", 404);

  let code = input.code ? normalizeShareCode(input.code) : randomShareCode();
  if (input.code && (await readJson<ShareRecord>(storage, shareKey(code)))) {
    throw new AppError("分享码已存在，请换一个");
  }

  while (!input.code && (await readJson<ShareRecord>(storage, shareKey(code)))) {
    code = randomShareCode();
  }

  const password = input.password?.trim().slice(0, 256);
  const share: ShareRecord = {
    code,
    fileIds: activeFiles.map((file) => file.id),
    passwordHash: password ? await hashPassword(code, password) : null,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
  };

  await writeJson(storage, shareKey(code), share);
  return share;
}

export async function getShare(storage: ObjectStorage, code: string) {
  const normalized = normalizeShareCode(code);
  const share = await readJson<ShareRecord>(storage, shareKey(normalized));
  if (!share) return null;

  if (isExpired(share.expiresAt)) {
    await storage.delete(shareKey(normalized));
    return null;
  }

  return share;
}

export async function verifySharePassword(share: ShareRecord, password: string | null | undefined) {
  if (!share.passwordHash) return true;
  if (!password) return false;

  if (!share.passwordHash.startsWith("pbkdf2-sha256:")) {
    return (await sha256Hex(`${share.code}:${password}`)) === share.passwordHash;
  }

  const [, iterationsValue, saltValue, hashValue] = share.passwordHash.split(":");
  const iterations = Number(iterationsValue);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || !saltValue || !hashValue) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(`${share.code}:${password}`), "PBKDF2", false, [
    "deriveBits",
  ]);
  const expected = base64UrlToBytes(hashValue);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(saltValue),
      iterations,
    },
    key,
    expected.length * 8,
  );

  return timingSafeBytesEqual(new Uint8Array(bits), expected);
}

export async function resolveShareFiles(storage: ObjectStorage, share: ShareRecord) {
  return (
    await Promise.all(share.fileIds.map((id) => getActiveFileMeta(storage, id)))
  ).filter(Boolean) as DriveFileMeta[];
}
