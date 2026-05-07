interface Env {
  DRIVE_BUCKET?: R2Bucket;
  STORAGE_BACKEND?: "r2" | "s3";
  AUTH_USERS?: string;
  ALLOW_UNCONFIGURED_AUTH?: string;
  CSRF_SECRET?: string;
  API_RATE_LIMIT_PER_MINUTE?: string;
  AUTH_RATE_LIMIT_PER_MINUTE?: string;
  SHARE_VERIFY_RATE_LIMIT_PER_MINUTE?: string;
  MAX_FILE_BYTES?: string;
  MAX_UPLOAD_BYTES?: string;
  MAX_FILES_PER_UPLOAD?: string;
  MAX_JSON_BYTES?: string;
  MAX_SELECTED_FILES?: string;
  MAX_SHARE_FILES?: string;
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
