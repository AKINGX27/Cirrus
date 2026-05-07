import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

export type StorageBackend = "r2" | "s3";

const META_PREFIX = "meta/";
const SHARE_PREFIX = "shares/";
const DIRECT_MESSAGES_PREFIX = "messages/";
const PERMISSIONS_KEY = "permissions/tag-grants.json";
const USER_PROFILES_KEY = "permissions/user-profiles.json";
const USER_PASSWORDS_KEY = "accounts/passwords.json";
const LEGACY_MIGRATION_NAME = "legacy-object-json-v1";

export interface StorageEnv {
  DRIVE_BUCKET?: R2Bucket;
  DB?: D1Database;
  STORAGE_BACKEND?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  S3_FORCE_PATH_STYLE?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export type ObjectStorageValue =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>;

export interface PutObjectOptions {
  contentType?: string;
}

export interface MultipartUploadHandle {
  key: string;
  uploadId: string;
}

export interface MultipartUploadPart {
  partNumber: number;
  etag: string;
}

export interface DirectUploadUrl {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface ObjectStorageListOptions {
  prefix: string;
  cursor?: string;
  limit?: number;
}

export interface ObjectStorageListResult {
  objects: Array<{ key: string }>;
  cursor?: string;
  truncated: boolean;
}

export interface ObjectStorage {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, value: ObjectStorageValue, options?: PutObjectOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: ObjectStorageListOptions): Promise<ObjectStorageListResult>;
  createMultipartUpload?(key: string, options?: PutObjectOptions): Promise<MultipartUploadHandle>;
  uploadMultipartPart?(
    upload: MultipartUploadHandle,
    partNumber: number,
    value: ObjectStorageValue,
  ): Promise<MultipartUploadPart>;
  completeMultipartUpload?(upload: MultipartUploadHandle, parts: MultipartUploadPart[]): Promise<void>;
  abortMultipartUpload?(upload: MultipartUploadHandle): Promise<void>;
  createDirectUploadUrl?(key: string, options?: PutObjectOptions): Promise<DirectUploadUrl>;
}

class R2StoredObject implements StoredObject {
  constructor(private object: R2ObjectBody) {}

  get body() {
    return this.object.body;
  }

  text() {
    return this.object.text();
  }
}

class R2ObjectStorage implements ObjectStorage {
  constructor(private bucket: R2Bucket) {}

  async get(key: string) {
    const object = await this.bucket.get(key);
    return object ? new R2StoredObject(object) : null;
  }

  async put(key: string, value: ObjectStorageValue, options?: PutObjectOptions) {
    await this.bucket.put(key, value, {
      httpMetadata: options?.contentType
        ? {
            contentType: options.contentType,
          }
        : undefined,
    });
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }

  async list(options: ObjectStorageListOptions) {
    const listed = await this.bucket.list({
      prefix: options.prefix,
      cursor: options.cursor,
      limit: options.limit,
    });

    return {
      objects: listed.objects.map((object) => ({ key: object.key })),
      cursor: listed.truncated ? listed.cursor : undefined,
      truncated: listed.truncated,
    };
  }

  async createMultipartUpload(key: string, options?: PutObjectOptions) {
    const upload = await this.bucket.createMultipartUpload(key, {
      httpMetadata: options?.contentType
        ? {
            contentType: options.contentType,
          }
        : undefined,
    });
    return { key: upload.key, uploadId: upload.uploadId };
  }

  async uploadMultipartPart(upload: MultipartUploadHandle, partNumber: number, value: ObjectStorageValue) {
    const resumed = this.bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    return resumed.uploadPart(partNumber, value as ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob);
  }

  async completeMultipartUpload(upload: MultipartUploadHandle, parts: MultipartUploadPart[]) {
    const resumed = this.bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    await resumed.complete(parts);
  }

  async abortMultipartUpload(upload: MultipartUploadHandle) {
    const resumed = this.bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    await resumed.abort();
  }
}

class ResponseStoredObject implements StoredObject {
  constructor(private response: Response) {}

  get body() {
    if (!this.response.body) {
      throw new Error("S3 object response did not include a body");
    }
    return this.response.body;
  }

  text() {
    return this.response.text();
  }
}

class TextStoredObject implements StoredObject {
  constructor(private value: string) {}

  get body() {
    const body = new Response(this.value).body;
    if (!body) throw new Error("Stored text object did not include a body");
    return body;
  }

  text() {
    return Promise.resolve(this.value);
  }
}

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
}

class S3ObjectStorage implements ObjectStorage {
  private client: AwsClient;
  private parser = new XMLParser();

  constructor(private config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      service: "s3",
      region: config.region,
    });
  }

  async get(key: string) {
    const response = await this.client.fetch(this.objectUrl(key), {
      method: "GET",
    });

    if (response.status === 404) return null;
    await this.assertOk(response, `get ${key}`);
    return new ResponseStoredObject(response);
  }

  async put(key: string, value: ObjectStorageValue, options?: PutObjectOptions) {
    const headers: HeadersInit = options?.contentType
      ? {
          "Content-Type": options.contentType,
        }
      : {};

    const response = await this.client.fetch(this.objectUrl(key), {
      method: "PUT",
      headers,
      body: value as BodyInit,
    });
    await this.assertOk(response, `put ${key}`);
  }

  async delete(key: string) {
    const response = await this.client.fetch(this.objectUrl(key), {
      method: "DELETE",
    });

    if (response.status === 404) return;
    await this.assertOk(response, `delete ${key}`);
  }

  async list(options: ObjectStorageListOptions) {
    const url = this.bucketUrl();
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", options.prefix);
    url.searchParams.set("max-keys", String(Math.min(options.limit ?? 1000, 1000)));
    if (options.cursor) {
      url.searchParams.set("continuation-token", options.cursor);
    }

    const response = await this.client.fetch(url, {
      method: "GET",
    });
    await this.assertOk(response, `list ${options.prefix}`);

    const parsed = this.parser.parse(await response.text());
    const root = parsed?.ListBucketResult ?? parsed;
    const contents = toArray(root?.Contents);

    return {
      objects: contents
        .map((entry) => ({ key: String(entry?.Key ?? "") }))
        .filter((entry) => entry.key.length > 0),
      cursor: root?.NextContinuationToken ? String(root.NextContinuationToken) : undefined,
      truncated: String(root?.IsTruncated ?? "false") === "true",
    };
  }

  async createMultipartUpload(key: string, options?: PutObjectOptions) {
    const url = this.objectUrl(key);
    url.search = "?uploads";
    const headers: HeadersInit = options?.contentType
      ? {
          "Content-Type": options.contentType,
        }
      : {};
    const response = await this.client.fetch(url, {
      method: "POST",
      headers,
    });
    await this.assertOk(response, `create multipart upload ${key}`);

    const parsed = this.parser.parse(await response.text());
    const root = parsed?.InitiateMultipartUploadResult ?? parsed;
    const uploadId = String(root?.UploadId ?? "");
    if (!uploadId) throw new Error("S3 create multipart upload did not return UploadId");
    return { key, uploadId };
  }

  async uploadMultipartPart(upload: MultipartUploadHandle, partNumber: number, value: ObjectStorageValue) {
    const url = this.objectUrl(upload.key);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", upload.uploadId);
    const response = await this.client.fetch(url, {
      method: "PUT",
      headers: {
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
      },
      body: value as BodyInit,
    });
    await this.assertOk(response, `upload part ${partNumber} for ${upload.key}`);

    const etag = response.headers.get("ETag")?.replace(/^"|"$/g, "") || "";
    if (!etag) throw new Error("S3 upload part did not return ETag");
    return { partNumber, etag };
  }

  async completeMultipartUpload(upload: MultipartUploadHandle, parts: MultipartUploadPart[]) {
    const url = this.objectUrl(upload.key);
    url.searchParams.set("uploadId", upload.uploadId);
    const body =
      "<CompleteMultipartUpload>" +
      parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const response = await this.client.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
      },
      body,
    });
    await this.assertOk(response, `complete multipart upload ${upload.key}`);
  }

  async abortMultipartUpload(upload: MultipartUploadHandle) {
    const url = this.objectUrl(upload.key);
    url.searchParams.set("uploadId", upload.uploadId);
    const response = await this.client.fetch(url, {
      method: "DELETE",
    });
    if (response.status === 404) return;
    await this.assertOk(response, `abort multipart upload ${upload.key}`);
  }

  async createDirectUploadUrl(key: string, options?: PutObjectOptions) {
    const headers: Record<string, string> = options?.contentType
      ? {
          "Content-Type": options.contentType,
        }
      : {};
    const signed = await this.client.sign(this.objectUrl(key), {
      method: "PUT",
      headers,
      aws: {
        signQuery: true,
      },
    });
    return {
      url: signed.url,
      method: "PUT" as const,
      headers,
    };
  }

  private bucketUrl() {
    if (this.config.endpoint) {
      const base = new URL(this.config.endpoint);

      if (this.config.forcePathStyle) {
        base.pathname = joinPath(base.pathname, this.config.bucket);
      } else {
        base.host = `${this.config.bucket}.${base.host}`;
      }

      return base;
    }

    if (this.config.forcePathStyle) {
      return new URL(`https://s3.${this.config.region}.amazonaws.com/${encodeURIComponent(this.config.bucket)}`);
    }

    return new URL(`https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com`);
  }

  private objectUrl(key: string) {
    const base = this.bucketUrl().toString().replace(/\/$/, "");
    return new URL(`${base}/${encodeKey(key)}`);
  }

  private async assertOk(response: Response, operation: string) {
    if (response.ok) return;

    const detail = await response.text().catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
    throw new Error(`S3 ${operation} failed with ${response.status}${suffix}`);
  }
}

type StructuredKey =
  | { type: "fileMeta"; id: string }
  | { type: "share"; code: string }
  | { type: "tagGrants" }
  | { type: "userProfiles" }
  | { type: "userPasswords" }
  | { type: "directMessages"; conversationId: string };

interface FileMetaRow {
  id: string;
  name: string;
  description: string;
  tags: string | null;
  owner: string;
  size: number;
  content_type: string;
  uploaded_at: string;
  expires_at: string | null;
  last_downloaded_at: string | null;
  download_count: number;
}

interface ShareRow {
  code: string;
  file_ids: string | null;
  password_hash: string | null;
  created_at: string;
  expires_at: string | null;
}

interface UserTagGrantRow {
  user: string;
  tags: string | null;
}

interface UserProfileRow {
  user: string;
  nickname: string;
  avatar: string;
  status: string;
  role: string | null;
  tags: string | null;
  visible_file_ids: string | null;
  friends: string | null;
  notifications: string | null;
  updated_at: string;
}

interface UserPasswordRow {
  user: string;
  password_hash: string;
  updated_at: string;
}

interface DirectMessageRow {
  id: string;
  conversation_id: string;
  from_user: string;
  to_user: string;
  message: string;
  file_ids: string | null;
  created_at: string;
}

const D1_TABLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS file_meta (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    owner TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploaded_at TEXT NOT NULL,
    expires_at TEXT,
    last_downloaded_at TEXT,
    download_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    code TEXT PRIMARY KEY,
    file_ids TEXT NOT NULL DEFAULT '[]',
    password_hash TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS user_tag_grants (
    user TEXT PRIMARY KEY,
    tags TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_profiles (
    user TEXT PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    role TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    visible_file_ids TEXT NOT NULL DEFAULT '[]',
    friends TEXT NOT NULL DEFAULT '[]',
    notifications TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_passwords (
    user TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    file_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS structured_migrations (
    name TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL
  )`,
];

const D1_INDEX_SCHEMA = [
  "CREATE INDEX IF NOT EXISTS idx_file_meta_uploaded_at ON file_meta(uploaded_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_file_meta_owner ON file_meta(owner)",
  "CREATE INDEX IF NOT EXISTS idx_file_meta_expires_at ON file_meta(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_user_profiles_nickname ON user_profiles(nickname)",
  "CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation ON direct_messages(conversation_id, created_at)",
];

const D1_COLUMN_SCHEMA = {
  file_meta: [
    "name TEXT NOT NULL DEFAULT ''",
    "description TEXT NOT NULL DEFAULT ''",
    "tags TEXT NOT NULL DEFAULT '[]'",
    "owner TEXT NOT NULL DEFAULT ''",
    "size INTEGER NOT NULL DEFAULT 0",
    "content_type TEXT NOT NULL DEFAULT 'application/octet-stream'",
    "uploaded_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    "expires_at TEXT",
    "last_downloaded_at TEXT",
    "download_count INTEGER NOT NULL DEFAULT 0",
  ],
  shares: [
    "file_ids TEXT NOT NULL DEFAULT '[]'",
    "password_hash TEXT",
    "created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    "expires_at TEXT",
  ],
  user_tag_grants: ["tags TEXT NOT NULL DEFAULT '[]'", "updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
  user_profiles: [
    "nickname TEXT NOT NULL DEFAULT ''",
    "avatar TEXT NOT NULL DEFAULT ''",
    "status TEXT NOT NULL DEFAULT ''",
    "role TEXT",
    "tags TEXT NOT NULL DEFAULT '[]'",
    "visible_file_ids TEXT NOT NULL DEFAULT '[]'",
    "friends TEXT NOT NULL DEFAULT '[]'",
    "notifications TEXT NOT NULL DEFAULT '[]'",
    "updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  ],
  user_passwords: [
    "password_hash TEXT NOT NULL DEFAULT ''",
    "updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  ],
  direct_messages: [
    "conversation_id TEXT NOT NULL DEFAULT ''",
    "from_user TEXT NOT NULL DEFAULT ''",
    "to_user TEXT NOT NULL DEFAULT ''",
    "message TEXT NOT NULL DEFAULT ''",
    "file_ids TEXT NOT NULL DEFAULT '[]'",
    "created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  ],
} as const;

class D1StructuredStorage implements ObjectStorage {
  private schemaReady?: Promise<void>;
  private legacyReady?: Promise<void>;

  constructor(
    private db: D1Database,
    private objects: ObjectStorage,
  ) {}

  async get(key: string) {
    const structured = structuredKey(key);
    if (!structured) return this.objects.get(key);

    await this.ensureReady();
    const value = await this.readStructured(structured);
    if (value !== null) return jsonObject(value);

    const legacy = await this.objects.get(key);
    if (!legacy) return null;

    const parsed = parseJson(await legacy.text());
    if (parsed !== null) await this.writeStructured(structured, parsed);
    return jsonObject(parsed);
  }

  async put(key: string, value: ObjectStorageValue, options?: PutObjectOptions) {
    const structured = structuredKey(key);
    if (!structured) {
      await this.objects.put(key, value, options);
      return;
    }

    await this.ensureReady();
    await this.writeStructured(structured, parseJson(await valueToText(value)));
  }

  async delete(key: string) {
    const structured = structuredKey(key);
    if (!structured) {
      await this.objects.delete(key);
      return;
    }

    await this.ensureReady();
    await this.deleteStructured(structured);
  }

  async list(options: ObjectStorageListOptions) {
    if (options.prefix !== META_PREFIX) return this.objects.list(options);

    await this.ensureReady();
    const limit = Math.min(options.limit ?? 1000, 1000);
    const offset = parseCursor(options.cursor);
    const result = await this.db
      .prepare("SELECT id FROM file_meta ORDER BY uploaded_at DESC LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all<{ id: string }>();

    return {
      objects: (result.results || []).map((row) => ({ key: metaKey(row.id) })),
      cursor: (result.results || []).length === limit ? String(offset + limit) : undefined,
      truncated: (result.results || []).length === limit,
    };
  }

  async createMultipartUpload(key: string, options?: PutObjectOptions) {
    if (structuredKey(key) || !this.objects.createMultipartUpload) {
      throw new Error("multipart uploads are only supported for object data");
    }
    return this.objects.createMultipartUpload(key, options);
  }

  async uploadMultipartPart(upload: MultipartUploadHandle, partNumber: number, value: ObjectStorageValue) {
    if (!this.objects.uploadMultipartPart) {
      throw new Error("multipart uploads are not supported by this storage backend");
    }
    return this.objects.uploadMultipartPart(upload, partNumber, value);
  }

  async completeMultipartUpload(upload: MultipartUploadHandle, parts: MultipartUploadPart[]) {
    if (!this.objects.completeMultipartUpload) {
      throw new Error("multipart uploads are not supported by this storage backend");
    }
    return this.objects.completeMultipartUpload(upload, parts);
  }

  async abortMultipartUpload(upload: MultipartUploadHandle) {
    if (!this.objects.abortMultipartUpload) return;
    await this.objects.abortMultipartUpload(upload);
  }

  async createDirectUploadUrl(key: string, options?: PutObjectOptions) {
    if (structuredKey(key) || !this.objects.createDirectUploadUrl) {
      throw new Error("direct uploads are only supported for object data");
    }
    return this.objects.createDirectUploadUrl(key, options);
  }

  private async ensureReady() {
    await this.ensureSchema();
    await this.migrateLegacyObjectJson();
  }

  private async ensureSchema() {
    this.schemaReady ??= this.ensureSchemaReady();
    await this.schemaReady;
  }

  private async ensureSchemaReady() {
    await this.db.batch(D1_TABLE_SCHEMA.map((statement) => this.db.prepare(statement)));
    await this.ensureSchemaColumns();
    await this.db.batch(D1_INDEX_SCHEMA.map((statement) => this.db.prepare(statement)));
  }

  private async ensureSchemaColumns() {
    for (const [table, columns] of Object.entries(D1_COLUMN_SCHEMA)) {
      const result = await this.db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const existing = new Set((result.results || []).map((column) => column.name));
      const missing = columns.filter((definition) => !existing.has(definition.split(/\s+/, 1)[0]));
      if (!missing.length) continue;

      await this.db.batch(missing.map((definition) => this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`)));
    }
  }

  private async migrateLegacyObjectJson() {
    this.legacyReady ??= this.migrateLegacyObjectJsonOnce();
    await this.legacyReady;
  }

  private async migrateLegacyObjectJsonOnce() {
    const marker = await this.db
      .prepare("SELECT name FROM structured_migrations WHERE name = ?")
      .bind(LEGACY_MIGRATION_NAME)
      .first<{ name: string }>();
    if (marker) return;

    await this.importLegacyJson(PERMISSIONS_KEY);
    await this.importLegacyJson(USER_PROFILES_KEY);
    await this.importLegacyJson(USER_PASSWORDS_KEY);
    await this.importLegacyPrefix(META_PREFIX);
    await this.importLegacyPrefix(SHARE_PREFIX);
    await this.importLegacyPrefix(DIRECT_MESSAGES_PREFIX);

    await this.db
      .prepare("INSERT OR REPLACE INTO structured_migrations (name, completed_at) VALUES (?, ?)")
      .bind(LEGACY_MIGRATION_NAME, new Date().toISOString())
      .run();
  }

  private async importLegacyPrefix(prefix: string) {
    let cursor: string | undefined;
    do {
      const listed = await this.objects.list({ prefix, cursor, limit: 1000 });
      for (const object of listed.objects) {
        await this.importLegacyJson(object.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  private async importLegacyJson(key: string) {
    const structured = structuredKey(key);
    if (!structured) return;

    const object = await this.objects.get(key);
    if (!object) return;

    const parsed = parseJson(await object.text());
    if (parsed !== null) await this.writeStructured(structured, parsed);
  }

  private async readStructured(key: StructuredKey) {
    if (key.type === "fileMeta") {
      const row = await this.db.prepare("SELECT * FROM file_meta WHERE id = ?").bind(key.id).first<FileMetaRow>();
      return row ? fileMetaFromRow(row) : null;
    }

    if (key.type === "share") {
      const row = await this.db.prepare("SELECT * FROM shares WHERE code = ?").bind(key.code).first<ShareRow>();
      return row ? shareFromRow(row) : null;
    }

    if (key.type === "tagGrants") {
      const result = await this.db.prepare("SELECT user, tags FROM user_tag_grants ORDER BY user").all<UserTagGrantRow>();
      const grants: Record<string, unknown> = {};
      for (const row of result.results || []) {
        grants[row.user] = parseJsonField(row.tags, []);
      }
      return grants;
    }

    if (key.type === "userProfiles") {
      const result = await this.db.prepare("SELECT * FROM user_profiles ORDER BY user").all<UserProfileRow>();
      const profiles: Record<string, unknown> = {};
      for (const row of result.results || []) {
        profiles[row.user] = userProfileFromRow(row);
      }
      return profiles;
    }

    if (key.type === "userPasswords") {
      const result = await this.db.prepare("SELECT * FROM user_passwords ORDER BY user").all<UserPasswordRow>();
      const credentials: Record<string, unknown> = {};
      for (const row of result.results || []) {
        credentials[row.user] = {
          passwordHash: row.password_hash,
          updatedAt: row.updated_at,
        };
      }
      return credentials;
    }

    const result = await this.db
      .prepare("SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500")
      .bind(key.conversationId)
      .all<DirectMessageRow>();
    return (result.results || []).map(directMessageFromRow);
  }

  private async writeStructured(key: StructuredKey, value: unknown) {
    if (key.type === "fileMeta") {
      const meta = asRecord(value);
      const id = typeof meta.id === "string" ? meta.id : key.id;
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO file_meta
            (id, name, description, tags, owner, size, content_type, uploaded_at, expires_at, last_downloaded_at, download_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          stringValue(meta.name),
          stringValue(meta.description),
          jsonField(meta.tags),
          stringValue(meta.owner),
          numberValue(meta.size),
          stringValue(meta.contentType, "application/octet-stream"),
          stringValue(meta.uploadedAt, new Date(0).toISOString()),
          nullableString(meta.expiresAt),
          nullableString(meta.lastDownloadedAt),
          numberValue(meta.downloadCount),
        )
        .run();
      return;
    }

    if (key.type === "share") {
      const share = asRecord(value);
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO shares (code, file_ids, password_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          stringValue(share.code, key.code),
          jsonField(share.fileIds),
          nullableString(share.passwordHash),
          stringValue(share.createdAt, new Date().toISOString()),
          nullableString(share.expiresAt),
        )
        .run();
      return;
    }

    if (key.type === "tagGrants") {
      const grants = asRecord(value);
      const statements = [this.db.prepare("DELETE FROM user_tag_grants")];
      const now = new Date().toISOString();
      for (const [user, tags] of Object.entries(grants)) {
        statements.push(
          this.db
            .prepare("INSERT OR REPLACE INTO user_tag_grants (user, tags, updated_at) VALUES (?, ?, ?)")
            .bind(user, jsonField(tags), now),
        );
      }
      await this.db.batch(statements);
      return;
    }

    if (key.type === "userProfiles") {
      const profiles = asRecord(value);
      const statements = [this.db.prepare("DELETE FROM user_profiles")];
      for (const [user, profileValue] of Object.entries(profiles)) {
        const profile = asRecord(profileValue);
        statements.push(
          this.db
            .prepare(
              `INSERT OR REPLACE INTO user_profiles
                (user, nickname, avatar, status, role, tags, visible_file_ids, friends, notifications, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              user,
              stringValue(profile.nickname),
              stringValue(profile.avatar),
              stringValue(profile.status),
              nullableString(profile.role),
              jsonField(profile.tags),
              jsonField(profile.visibleFileIds),
              jsonField(profile.friends),
              jsonField(profile.notifications),
              stringValue(profile.updatedAt, new Date().toISOString()),
            ),
        );
      }
      await this.db.batch(statements);
      return;
    }

    if (key.type === "userPasswords") {
      const credentials = asRecord(value);
      const statements = [this.db.prepare("DELETE FROM user_passwords")];
      for (const [user, credentialValue] of Object.entries(credentials)) {
        const credential = asRecord(credentialValue);
        statements.push(
          this.db
            .prepare("INSERT OR REPLACE INTO user_passwords (user, password_hash, updated_at) VALUES (?, ?, ?)")
            .bind(user, stringValue(credential.passwordHash), stringValue(credential.updatedAt, new Date().toISOString())),
        );
      }
      await this.db.batch(statements);
      return;
    }

    const messages = Array.isArray(value) ? value.slice(-500) : [];
    const statements = [this.db.prepare("DELETE FROM direct_messages WHERE conversation_id = ?").bind(key.conversationId)];
    for (const messageValue of messages) {
      const message = asRecord(messageValue);
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO direct_messages
              (id, conversation_id, from_user, to_user, message, file_ids, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            stringValue(message.id, crypto.randomUUID()),
            key.conversationId,
            stringValue(message.from),
            stringValue(message.to),
            stringValue(message.message),
            jsonField(message.fileIds),
            stringValue(message.createdAt, new Date().toISOString()),
          ),
      );
    }
    await this.db.batch(statements);
  }

  private async deleteStructured(key: StructuredKey) {
    if (key.type === "fileMeta") {
      await this.db.prepare("DELETE FROM file_meta WHERE id = ?").bind(key.id).run();
    } else if (key.type === "share") {
      await this.db.prepare("DELETE FROM shares WHERE code = ?").bind(key.code).run();
    } else if (key.type === "tagGrants") {
      await this.db.prepare("DELETE FROM user_tag_grants").run();
    } else if (key.type === "userProfiles") {
      await this.db.prepare("DELETE FROM user_profiles").run();
    } else if (key.type === "userPasswords") {
      await this.db.prepare("DELETE FROM user_passwords").run();
    } else {
      await this.db.prepare("DELETE FROM direct_messages WHERE conversation_id = ?").bind(key.conversationId).run();
    }
  }
}

export function storageBackend(env: StorageEnv): StorageBackend {
  const backend = env.STORAGE_BACKEND?.trim().toLowerCase();
  if (!backend) return "r2";
  if (backend === "r2" || backend === "s3") return backend;
  throw new Error("STORAGE_BACKEND must be either r2 or s3");
}

export function storageLabel(env: StorageEnv) {
  return storageBackend(env) === "s3" ? "AWS S3" : "Cloudflare R2";
}

export function createObjectStorage(env: StorageEnv): ObjectStorage {
  const backend = storageBackend(env);
  let storage: ObjectStorage;

  if (backend === "s3") {
    storage = new S3ObjectStorage(resolveS3Config(env));
  } else if (!env.DRIVE_BUCKET) {
    throw new Error("DRIVE_BUCKET binding is missing. Use the R2 Wrangler config or set STORAGE_BACKEND=s3.");
  } else {
    storage = new R2ObjectStorage(env.DRIVE_BUCKET);
  }

  return env.DB ? new D1StructuredStorage(env.DB, storage) : storage;
}

function resolveS3Config(env: StorageEnv): S3Config {
  const endpoint = resolveS3Endpoint(optionalEnv(env.S3_ENDPOINT));
  const region = optionalEnv(env.S3_REGION) ?? optionalEnv(env.AWS_REGION) ?? optionalEnv(env.AWS_DEFAULT_REGION) ?? "us-east-1";

  return {
    bucket: requiredEnv(env.S3_BUCKET, "S3_BUCKET"),
    region,
    endpoint,
    accessKeyId: requiredEnv(optionalEnv(env.S3_ACCESS_KEY_ID) ?? optionalEnv(env.AWS_ACCESS_KEY_ID), "S3_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv(
      optionalEnv(env.S3_SECRET_ACCESS_KEY) ?? optionalEnv(env.AWS_SECRET_ACCESS_KEY),
      "S3_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    ),
    sessionToken: optionalEnv(env.S3_SESSION_TOKEN) ?? optionalEnv(env.AWS_SESSION_TOKEN),
    forcePathStyle: parseBoolean(env.S3_FORCE_PATH_STYLE) ?? Boolean(endpoint),
  };
}

function resolveS3Endpoint(value: string | undefined) {
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("S3_ENDPOINT must be a valid URL");
  }

  if (url.username || url.password) {
    throw new Error("S3_ENDPOINT must not include credentials");
  }

  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("S3_ENDPOINT must use https unless it points to localhost");
  }

  if (url.search || url.hash) {
    throw new Error("S3_ENDPOINT must not include query string or hash");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function requiredEnv(value: string | undefined, name: string) {
  const normalized = optionalEnv(value);
  if (!normalized) {
    throw new Error(`${name} is required when STORAGE_BACKEND=s3`);
  }
  return normalized;
}

function optionalEnv(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseBoolean(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function encodeKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function joinPath(basePath: string, next: string) {
  const base = basePath.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(next)}`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => {
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "&") return "&amp;";
    if (character === "'") return "&apos;";
    return "&quot;";
  });
}

function metaKey(id: string) {
  return `${META_PREFIX}${id}.json`;
}

function structuredKey(key: string): StructuredKey | null {
  if (key.startsWith(META_PREFIX) && key.endsWith(".json")) {
    const id = key.slice(META_PREFIX.length, -".json".length);
    return id ? { type: "fileMeta", id } : null;
  }

  if (key.startsWith(SHARE_PREFIX) && key.endsWith(".json")) {
    const code = key.slice(SHARE_PREFIX.length, -".json".length);
    return code ? { type: "share", code } : null;
  }

  if (key === PERMISSIONS_KEY) return { type: "tagGrants" };
  if (key === USER_PROFILES_KEY) return { type: "userProfiles" };
  if (key === USER_PASSWORDS_KEY) return { type: "userPasswords" };

  if (key.startsWith(DIRECT_MESSAGES_PREFIX) && key.endsWith(".json")) {
    const conversationId = key.slice(DIRECT_MESSAGES_PREFIX.length, -".json".length);
    return conversationId ? { type: "directMessages", conversationId } : null;
  }

  return null;
}

function jsonObject(value: unknown) {
  return new TextStoredObject(JSON.stringify(value ?? null));
}

function parseCursor(value: string | undefined) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonField(value: string | null | undefined, fallback: unknown) {
  if (!value) return fallback;
  const parsed = parseJson(value);
  return parsed ?? fallback;
}

function jsonField(value: unknown) {
  return JSON.stringify(value ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function valueToText(value: ObjectStorageValue) {
  if (typeof value === "string") return value;
  if (value instanceof Blob) return value.text();
  if (value instanceof ReadableStream) return new Response(value).text();
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);

  return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

function fileMetaFromRow(row: FileMetaRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: parseJsonField(row.tags, []),
    owner: row.owner,
    size: Number(row.size) || 0,
    contentType: row.content_type,
    uploadedAt: row.uploaded_at,
    expiresAt: row.expires_at,
    lastDownloadedAt: row.last_downloaded_at,
    downloadCount: Number(row.download_count) || 0,
  };
}

function shareFromRow(row: ShareRow) {
  return {
    code: row.code,
    fileIds: parseJsonField(row.file_ids, []),
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function userProfileFromRow(row: UserProfileRow) {
  return {
    nickname: row.nickname,
    avatar: row.avatar,
    status: row.status,
    role: row.role,
    tags: parseJsonField(row.tags, []),
    visibleFileIds: parseJsonField(row.visible_file_ids, []),
    friends: parseJsonField(row.friends, []),
    notifications: parseJsonField(row.notifications, []),
    updatedAt: row.updated_at,
  };
}

function directMessageFromRow(row: DirectMessageRow) {
  return {
    id: row.id,
    from: row.from_user,
    to: row.to_user,
    message: row.message,
    fileIds: parseJsonField(row.file_ids, []),
    createdAt: row.created_at,
  };
}
