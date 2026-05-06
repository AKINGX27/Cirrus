const OBJECT_PREFIX = "objects/";
const META_PREFIX = "meta/";
const SHARE_PREFIX = "shares/";

export interface DriveFileMeta {
  id: string;
  name: string;
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
    .trim();

  return cleaned || "untitled";
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

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

async function writeJson(bucket: R2Bucket, key: string, value: unknown) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
  });
}

export async function saveFileMeta(bucket: R2Bucket, meta: DriveFileMeta) {
  await writeJson(bucket, metaKey(meta.id), meta);
}

export async function deleteDriveFile(bucket: R2Bucket, id: string) {
  await Promise.all([bucket.delete(objectKey(id)), bucket.delete(metaKey(id))]);
}

async function readFileMeta(bucket: R2Bucket, id: string) {
  return readJson<DriveFileMeta>(bucket, metaKey(id));
}

export async function getActiveFileMeta(bucket: R2Bucket, id: string) {
  const meta = await readFileMeta(bucket, id);
  if (!meta) return null;

  if (isExpired(meta.expiresAt)) {
    await deleteDriveFile(bucket, id);
    return null;
  }

  return meta;
}

export async function listFiles(bucket: R2Bucket) {
  const files: DriveFileMeta[] = [];
  const expiredIds: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix: META_PREFIX,
      cursor,
      limit: 1000,
    });

    const batch = await Promise.all(
      listed.objects.map((object) => readJson<DriveFileMeta>(bucket, object.key)),
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
    await Promise.all(expiredIds.map((id) => deleteDriveFile(bucket, id)));
  }

  return files.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
}

export async function createFileFromUpload(
  bucket: R2Bucket,
  file: File,
  expiresAt: string | null,
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = cleanFileName(file.name);
  const contentType = file.type || "application/octet-stream";

  const meta: DriveFileMeta = {
    id,
    name,
    size: file.size,
    contentType,
    uploadedAt: now,
    expiresAt,
    lastDownloadedAt: null,
    downloadCount: 0,
  };

  await bucket.put(objectKey(id), file, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      name,
      uploadedAt: now,
      expiresAt: expiresAt ?? "",
    },
  });
  await saveFileMeta(bucket, meta);

  return meta;
}

export async function renameFile(bucket: R2Bucket, id: string, name: string) {
  const meta = await getActiveFileMeta(bucket, id);
  if (!meta) throw new AppError("文件不存在", 404);

  const next: DriveFileMeta = {
    ...meta,
    name: cleanFileName(name),
  };
  await saveFileMeta(bucket, next);
  return next;
}

export async function incrementDownload(bucket: R2Bucket, id: string) {
  const current = await getActiveFileMeta(bucket, id);
  if (!current) return null;

  const next: DriveFileMeta = {
    ...current,
    downloadCount: current.downloadCount + 1,
    lastDownloadedAt: new Date().toISOString(),
  };
  await saveFileMeta(bucket, next);
  return next;
}

function copyName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return `${name.slice(0, dot)} - 副本${name.slice(dot)}`;
  }
  return `${name} - 副本`;
}

export async function copyFiles(bucket: R2Bucket, ids: string[]) {
  const copied: DriveFileMeta[] = [];

  for (const id of ids) {
    const source = await getActiveFileMeta(bucket, id);
    if (!source) continue;

    const object = await bucket.get(objectKey(source.id));
    if (!object?.body) continue;

    const nextId = crypto.randomUUID();
    const uploadedAt = new Date().toISOString();
    const next: DriveFileMeta = {
      ...source,
      id: nextId,
      name: copyName(source.name),
      uploadedAt,
      lastDownloadedAt: null,
      downloadCount: 0,
    };

    await bucket.put(objectKey(nextId), object.body, {
      httpMetadata: {
        contentType: source.contentType,
      },
      customMetadata: {
        name: next.name,
        uploadedAt,
        expiresAt: next.expiresAt ?? "",
      },
    });
    await saveFileMeta(bucket, next);
    copied.push(next);
  }

  return copied;
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
  return sha256Hex(`${code}:${password}`);
}

export async function createShare(bucket: R2Bucket, input: CreateShareInput) {
  const fileIds = Array.from(new Set(input.fileIds.filter(Boolean)));
  if (!fileIds.length) throw new AppError("请选择要分享的文件");

  const activeFiles = (
    await Promise.all(fileIds.map((id) => getActiveFileMeta(bucket, id)))
  ).filter(Boolean) as DriveFileMeta[];
  if (!activeFiles.length) throw new AppError("可分享的文件不存在", 404);

  let code = input.code ? normalizeShareCode(input.code) : randomShareCode();
  if (input.code && (await readJson<ShareRecord>(bucket, shareKey(code)))) {
    throw new AppError("分享码已存在，请换一个");
  }

  while (!input.code && (await readJson<ShareRecord>(bucket, shareKey(code)))) {
    code = randomShareCode();
  }

  const password = input.password?.trim();
  const share: ShareRecord = {
    code,
    fileIds: activeFiles.map((file) => file.id),
    passwordHash: password ? await hashPassword(code, password) : null,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
  };

  await writeJson(bucket, shareKey(code), share);
  return share;
}

export async function getShare(bucket: R2Bucket, code: string) {
  const normalized = normalizeShareCode(code);
  const share = await readJson<ShareRecord>(bucket, shareKey(normalized));
  if (!share) return null;

  if (isExpired(share.expiresAt)) {
    await bucket.delete(shareKey(normalized));
    return null;
  }

  return share;
}

export async function verifySharePassword(share: ShareRecord, password: string | null | undefined) {
  if (!share.passwordHash) return true;
  if (!password) return false;
  return (await hashPassword(share.code, password)) === share.passwordHash;
}

export async function resolveShareFiles(bucket: R2Bucket, share: ShareRecord) {
  return (
    await Promise.all(share.fileIds.map((id) => getActiveFileMeta(bucket, id)))
  ).filter(Boolean) as DriveFileMeta[];
}
