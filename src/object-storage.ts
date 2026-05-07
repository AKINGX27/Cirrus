import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

export type StorageBackend = "r2" | "s3";

export interface StorageEnv {
  DRIVE_BUCKET?: R2Bucket;
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

  if (backend === "s3") {
    return new S3ObjectStorage(resolveS3Config(env));
  }

  if (!env.DRIVE_BUCKET) {
    throw new Error("DRIVE_BUCKET binding is missing. Use the R2 Wrangler config or set STORAGE_BACKEND=s3.");
  }

  return new R2ObjectStorage(env.DRIVE_BUCKET);
}

function resolveS3Config(env: StorageEnv): S3Config {
  const endpoint = optionalEnv(env.S3_ENDPOINT);
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
