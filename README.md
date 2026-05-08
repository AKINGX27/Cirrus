# Cirrus Drive

**Language:** English | [简体中文](README_zh_ch.md)

Cirrus Drive is a lightweight cloud drive built on Cloudflare Workers. It stores files in Cloudflare R2 by default, can use AWS S3 or S3-compatible storage, and stores structured data such as users, permissions, tags, shares, and messages in Cloudflare D1.

## Features

- Web login and registration. If no account exists, the first registered user becomes the administrator.
- Personal file space where normal users see their own files by default.
- Admin access to all files and a management page for roles, user tags, visible file tags, visible files, and notifications.
- Upload one or many files with per-file description and tags.
- File list with name, description, tags, upload time, last download time, and download count.
- Search by file name, description, tag, and extension.
- Click a tag to filter files by the same tag.
- Single-file download and multi-file ZIP download.
- Public share links with optional password, custom or automatic share code, and expiration time.
- Public share page with single-file download, download all, and right-click download menu.
- Rename files, edit descriptions, edit tags, copy, cut, select, download, and share from the file context menu.
- Account settings for password, avatar, unique nickname, and status.
- User search by username, nickname, and user tags.
- Friends, private messages, and file sharing to friends.
- Built-in security headers, CSP, CSRF protection, same-origin checks, rate limits, and upload size limits.
- Responsive UI with system light/dark mode.

## Advantages

- **Lightweight:** no VPS, Docker, Nginx, or long-running backend service is required.
- **Serverless:** the app runs as a Cloudflare Worker and scales on demand.
- **Low maintenance:** frontend, API, auth, sharing, and admin tools live in one Worker project.
- **Low cost:** files are stored in object storage, and structured metadata is small enough for D1.
- **Data control:** you control the Worker, storage bucket, database, users, and permissions.
- **Flexible storage:** choose R2 for the default Cloudflare-native setup or S3 for AWS and S3-compatible providers.
- **Fine-grained visibility:** normal users see their own files; admins can grant visibility by tag or by specific file.
- **Public-project friendly:** private domains, bucket names, database IDs, and secrets are not hardcoded in the repository.
- **Easy to customize:** the codebase is small compared with full private-cloud suites such as Nextcloud or Seafile.

## Deploy With Cloudflare Workers Builds

Deploy from the Cloudflare web dashboard when you want the simplest setup. Push this repository to GitHub or GitLab first.

### 1. Create The Worker From Git

1. Open Cloudflare Dashboard.
2. Go to `Workers & Pages`.
3. Click `Create application`.
4. Choose `Import a repository`.
5. Select the repository that contains this project.
6. Fill the build settings with the values below.

### 2. Choose R2 Or S3

| Storage | Files stored in | Structured data | Deploy command | R2 auto-created |
| --- | --- | --- | --- | --- |
| Default R2 | Cloudflare R2 | Cloudflare D1 | `npm run deploy` | Yes |
| S3 | AWS S3 or S3-compatible storage | Cloudflare D1 | `npm run deploy:s3` | No |

R2 is the default. It needs no S3 variables. The repository intentionally omits R2 bucket names and D1 database IDs, so Wrangler automatic provisioning can create and bind resources for each deployment.

### 3. Workers Builds Fields

| Dashboard field | R2 value | S3 value | Notes |
| --- | --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | `cirrus-drive` | Keep it the same as `name` in the Wrangler config. |
| `Production branch` | `main` | `main` | Use your real production branch if different. |
| `Root directory` | empty or `/` | empty or `/` | If this project is in a monorepo, choose the folder containing `package.json`. |
| `Build command` | empty | empty | There is no separate build command. |
| `Deploy command` | `npm run deploy` | `npm run deploy:s3` | S3 uses `wrangler.s3.jsonc` and does not provision R2. |
| `Non-production deploy command` | keep default | keep default | The default Worker preview upload is fine. |

### 4. Variables And Secrets

For R2, the minimal recommended setup is:

| Type | Name | Required | Example |
| --- | --- | --- | --- |
| Secret | `CSRF_SECRET` | Recommended | a random long string |
| Secret | `AUTH_USERS` | Optional | `admin:change-me:admin,alice:alice-password:user` |

For S3, add these in addition to `CSRF_SECRET`:

| Type | Name | Required | Example |
| --- | --- | --- | --- |
| Variable | `S3_BUCKET` | Yes | `my-drive-bucket` |
| Variable | `S3_REGION` | Recommended | `us-east-1` |
| Secret | `S3_ACCESS_KEY_ID` | Yes | your access key |
| Secret | `S3_SECRET_ACCESS_KEY` | Yes | your secret key |
| Variable | `S3_ENDPOINT` | Optional | `https://s3.example.com` |
| Variable | `S3_FORCE_PATH_STYLE` | Optional | `true` |
| Secret | `S3_SESSION_TOKEN` | Optional | temporary session token |

`AUTH_USERS` format:

```text
username:password:role,username:password:role
```

Role must be `admin` or `user`. You may omit `AUTH_USERS`; when no configured or registered users exist, the first registered account becomes the administrator.

### 5. Deploy

After saving the Workers Builds configuration, trigger a production deploy from the dashboard or push to the production branch.

R2 deploy uses `wrangler.jsonc`:

```text
npm run deploy
```

S3 deploy uses `wrangler.s3.jsonc`:

```text
npm run deploy:s3
```

## Notes

- Do not put private domains, bucket names, database IDs, API tokens, or secrets into the public repository.
- `wrangler.jsonc` is for R2 and includes the `DRIVE_BUCKET` binding. `wrangler.s3.jsonc` is for S3 and does not include an R2 binding.
- D1 is used for structured data in both R2 and S3 modes.
- R2 and D1 resources are automatically provisioned by Wrangler when using the R2 config with the deploy command.
- S3 buckets are not created by this project. Create the bucket yourself and give the Worker credentials with the required permissions.
- `S3_REGION` should match the bucket region. If omitted, the app defaults to `us-east-1`, which can cause signing errors for buckets in other regions and may increase latency.
- Cloudflare Orange Cloud / HTTPS can protect the domain in front of the Worker. The app also sends security headers and enforces CSRF and same-origin checks.
- Keep `CSRF_SECRET` stable. Changing it invalidates existing sessions and CSRF tokens.
- The first registered user is only automatically promoted when there are no configured or registered users.
- Large files are stored in object storage. Multi-file downloads are streamed as ZIP files without compression.
- Public share download links use short-lived tickets generated by the Worker.
