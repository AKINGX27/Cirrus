interface Env {
  DRIVE_BUCKET?: R2Bucket;
  STORAGE_BACKEND?: "r2" | "s3";
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
