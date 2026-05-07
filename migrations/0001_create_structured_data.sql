CREATE TABLE IF NOT EXISTS file_meta (
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
);

CREATE INDEX IF NOT EXISTS idx_file_meta_uploaded_at ON file_meta(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_meta_owner ON file_meta(owner);
CREATE INDEX IF NOT EXISTS idx_file_meta_expires_at ON file_meta(expires_at);

CREATE TABLE IF NOT EXISTS shares (
  code TEXT PRIMARY KEY,
  file_ids TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at);

CREATE TABLE IF NOT EXISTS user_tag_grants (
  user TEXT PRIMARY KEY,
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
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
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_nickname ON user_profiles(nickname);

CREATE TABLE IF NOT EXISTS user_passwords (
  user TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  file_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation ON direct_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS structured_migrations (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
