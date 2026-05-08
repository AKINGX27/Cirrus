# Cirrus Drive

**Language:** English | [简体中文](README_zh_ch.md)

Cirrus Drive is a lightweight, self-hosted cloud drive for Cloudflare Workers. It keeps the application layer serverless, stores files in R2 or S3-compatible object storage, and uses Cloudflare D1 for structured data such as users, permissions, tags, shares, and messages.

`Cloudflare Workers` · `R2 / S3` · `D1` · `Hono` · `Serverless file sharing`

## Feature Overview

| Area | Capabilities |
| --- | --- |
| Files | Multi-file upload, per-file description and tags, rename, copy, cut, delete, single-file download, streamed ZIP download for multiple files |
| File list | Name, description, tags, upload time, last download time, download count, search by name / description / tag / extension, tag click filtering |
| Sharing | Public share links, optional password, custom or generated share code, expiration time, single-file download, download all, right-click download on the share page |
| Accounts | Built-in login and registration, password changes, avatar, unique nickname, status text |
| Permissions | Normal users see their own files by default; admins can view all files and grant visibility by tag or by specific file |
| Administration | Admin page for role changes, user tags, visible tags, visible files, and user notifications |
| Social | User search by username, nickname, and user tags; friends, private messages, and file sharing to friends |
| Security | Security headers, CSP, CSRF protection, same-origin checks, rate limits, upload limits, short-lived public download tickets |
| Interface | Responsive layout with system light/dark mode |

If no configured or registered account exists, the first user who registers becomes the administrator. Later registrations become normal users by default.

## Why Cirrus Drive

| Advantage | What it means |
| --- | --- |
| Lightweight | No VPS, Docker, Nginx, or always-on backend process is required. |
| Serverless | The app runs on Cloudflare Workers and scales with requests. |
| Low maintenance | UI, API, auth, sharing, and administration live in one Worker project. |
| Cost conscious | File data goes to object storage; structured metadata stays small and fits D1 well. |
| Data ownership | You control the Worker, storage bucket, database, users, and permission rules. |
| Storage flexibility | Use R2 for the default Cloudflare-native setup, or S3 for AWS and S3-compatible providers. |
| Practical permissions | Admins can expose files by tag or by exact file without giving full account access. |
| Public-repo friendly | Private domains, bucket names, database IDs, API tokens, and secrets are not hardcoded. |
| Easy to adapt | Smaller and more focused than full private-cloud suites such as Nextcloud or Seafile. |

## Deploy With Cloudflare Workers Builds

The recommended deployment path is Cloudflare Dashboard + Workers Builds. Push this repository to GitHub or GitLab first, then import it from the Cloudflare dashboard.

### 1. Create The Worker

1. Open Cloudflare Dashboard.
2. Go to `Workers & Pages`.
3. Click `Create application`.
4. Choose `Import a repository`.
5. Select the repository that contains Cirrus Drive.
6. Fill in the build settings below.

### 2. Choose A Storage Mode

| Mode | File storage | Structured data | Deploy command | R2 provisioning |
| --- | --- | --- | --- | --- |
| Default R2 | Cloudflare R2 | Cloudflare D1 | `npm run deploy` | Automatic |
| S3 | AWS S3 or S3-compatible storage | Cloudflare D1 | `npm run deploy:s3` | Not used |

R2 is the default mode. The R2 config intentionally omits bucket names and D1 database IDs so Wrangler automatic provisioning can create and bind resources during deployment.

S3 mode uses `wrangler.s3.jsonc`; it does not declare an R2 binding and will not create an R2 bucket.

### 3. Fill Workers Builds Fields

| Cloudflare field | R2 deployment | S3 deployment | Notes |
| --- | --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | `cirrus-drive` | Keep this aligned with the Wrangler `name`. |
| `Production branch` | `main` | `main` | Use your actual production branch if different. |
| `Root directory` | empty or `/` | empty or `/` | For monorepos, choose the folder containing `package.json`. |
| `Build command` | empty | empty | The Worker is bundled by Wrangler during deploy. |
| `Deploy command` | `npm run deploy` | `npm run deploy:s3` | This is the important backend selector. |
| `Non-production deploy command` | keep default | keep default | The default Worker preview command is fine. |

### 4. Configure Variables And Secrets

Minimal R2 deployment:

| Type | Name | Required | Example / value |
| --- | --- | --- | --- |
| Secret | `CSRF_SECRET` | Recommended | a stable random long string |
| Secret | `AUTH_USERS` | Optional | `admin:change-me:admin,alice:alice-password:user` |

S3 deployment also requires:

| Type | Name | Required | Example / value |
| --- | --- | --- | --- |
| Variable | `S3_BUCKET` | Yes | `my-drive-bucket` |
| Variable | `S3_REGION` | Recommended | `us-east-1` |
| Secret | `S3_ACCESS_KEY_ID` | Yes | your access key |
| Secret | `S3_SECRET_ACCESS_KEY` | Yes | your secret key |
| Variable | `S3_ENDPOINT` | Optional | `https://s3.example.com` |
| Variable | `S3_FORCE_PATH_STYLE` | Optional | `true` |
| Secret | `S3_SESSION_TOKEN` | Optional | temporary session token |

`AUTH_USERS` uses this format:

```text
username:password:role,username:password:role
```

Valid roles are `admin` and `user`. `AUTH_USERS` is optional; if it is not set and no registered account exists yet, the first registered user becomes the administrator.

### 5. Deploy

After saving the Workers Builds configuration, trigger a production deployment in the dashboard or push to the production branch.

R2 deployment:

```text
npm run deploy
```

S3 deployment:

```text
npm run deploy:s3
```

## Notes

- Do not commit private domains, bucket names, database IDs, API tokens, or secrets.
- `wrangler.jsonc` is for R2 and includes the `DRIVE_BUCKET` binding.
- `wrangler.s3.jsonc` is for S3 and intentionally has no R2 binding.
- D1 is used for structured data in both R2 and S3 modes.
- R2 and D1 can be automatically provisioned by Wrangler when deploying with the R2 config.
- S3 buckets are not created by Cirrus Drive. Create the bucket yourself and provide credentials with the required permissions.
- `S3_REGION` should match the bucket region. If omitted, the app defaults to `us-east-1`, which may cause signing errors for buckets in other regions and can increase latency.
- Keep `CSRF_SECRET` stable. Rotating it invalidates existing sessions and CSRF tokens.
- The first-user-admin rule only applies when there are no configured or registered users.
- Large files stay in object storage. Multi-file downloads are streamed as uncompressed ZIP archives.
- Public share downloads use short-lived tickets generated by the Worker.
- Cloudflare Orange Cloud and HTTPS can sit in front of the Worker; the app also applies its own security headers, CSRF checks, and same-origin validation.
