# Cirrus Drive

基于 Cloudflare Workers、Hono + JSX 和 Cloudflare R2 的轻量网盘。

## 功能

- 打开首页直接显示当前用户可见的网盘文件列表
- 多文件上传，并可设置文件存留时间、描述、标签
- 单文件下载，多文件自动打包为无压缩 ZIP 下载
- 文件显示名称、描述、标签、上传时间、最后下载时间、下载次数
- 搜索支持文件名、标签、描述字段和扩展名
- 点击标签可筛选同标签文件
- 右键菜单支持改名、修改描述、修改标签、下载、选择、复制、剪切、分享
- 应用内登录和注册：未登录时显示登录弹窗，普通用户默认只看自己的文件
- 管理页面支持批量提权、恢复角色、添加用户标签、设置可见标签、设置可见文件和发送通知
- 用户可在账号设置中修改密码、唯一昵称、头像和状态，按用户名、昵称、用户标签搜索其他用户
- 好友之间可发送私信，也可把自己可见的文件发送给好友
- 内置安全加固：安全响应头、CSP、CSRF 防护、同源校验、上传大小限制、基础速率限制
- 左键可在列表空白处框选多个文件
- 分享支持免密码或密码分享、有效期、自定义或自动分享码
- 浅色/暗色跟随系统，自适应宽屏和手机屏幕

## Cloudflare Workers 配置和部署

本项目部署为 Cloudflare Worker。文件对象支持两种后端，结构化数据默认存入 Cloudflare D1：

- 默认：Cloudflare R2。无需手动创建 bucket，Wrangler 会自动创建并绑定。
- 可选：AWS S3。通过环境变量启用，部署时不会创建 R2，也不会绑定 `DRIVE_BUCKET`。
- 结构化数据：Cloudflare D1。无需手动创建数据库，部署命令会自动创建并绑定 `DB`。

部署前需要把项目推送到 GitHub 或 GitLab 仓库。Cloudflare Workers Builds 会从仓库读取 `package.json`、`wrangler.jsonc` / `wrangler.s3.jsonc` 和 `src/index.tsx`。

### 1. 选择存储后端

| 后端 | 什么时候用 | 部署命令 | 会创建 R2 吗 | 会创建 D1 吗 |
| --- | --- | --- | --- | --- |
| R2 + D1 | 默认部署，文件对象放 R2，结构化数据放 D1 | `npm run deploy` | 会，由 Wrangler 自动创建 | 会，由 Wrangler 自动创建 |
| S3 + D1 | 文件对象放 AWS S3 或兼容 S3，结构化数据放 D1 | `npm run deploy:s3` | 不会 | 会，由 Wrangler 自动创建 |

本地开发也有对应命令：

- R2：`npm run dev`
- S3：`npm run dev:s3`

S3 命令会使用 `wrangler.s3.jsonc`，这个配置文件没有 `r2_buckets`，所以不会 provision R2。两个配置文件都会绑定 D1 数据库 `DB`。

### 2. Workers Builds 页面怎么填

进入 Cloudflare Dashboard -> `Workers & Pages` -> `Create application` -> `Import a repository`，选择本项目仓库后，按下表填写。

| Cloudflare 页面输入框 | 应填写的值 | 说明 |
| --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | 必须和 `wrangler.jsonc` 里的 `name` 一致 |
| `Production branch` / `Branch` | `main` | 如果你的生产分支不是 `main`，填实际分支名 |
| `Root directory` | 留空或填 `/` | 仓库根目录包含 `package.json` 和 `wrangler.jsonc` 时这样填 |
| `Build command` | 留空 | 本项目没有单独的构建步骤 |
| `Deploy command` | R2 填 `npm run deploy`；S3 填 `npm run deploy:s3` | S3 命令不会创建 R2 |
| `Non-production branch deploy command` | 保持默认 | 默认通常是 `npx wrangler versions upload` |
| `Environment variables` | R2 可不填；S3 填 `S3_BUCKET`、`S3_REGION` | D1 不需要手动填环境变量 |
| `Secrets` | 填 `CSRF_SECRET`；可选填 `AUTH_USERS`；S3 另填访问密钥 | 不填 `AUTH_USERS` 时，第一个注册用户会成为管理员 |

如果项目放在 monorepo 子目录，`Root directory` 要填到包含 `package.json` 和 `wrangler.jsonc` 的目录，例如 `apps/cirrus`。

### 3. 默认 R2 配置

`wrangler.jsonc` 用于 R2 部署：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cirrus-drive",
  "main": "src/index.tsx",
  "compatibility_date": "2026-05-03",
  "keep_vars": true,
  "observability": {
    "enabled": true
  },
  "vars": {
    "STORAGE_BACKEND": "r2"
  },
  "r2_buckets": [
    {
      "binding": "DRIVE_BUCKET"
    }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "migrations_dir": "migrations"
    }
  ]
}
```

R2 配置说明：

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `name` | `cirrus-drive` | Worker 名称；Dashboard 里的项目名必须和它一致 |
| `main` | `src/index.tsx` | Worker 入口文件 |
| `compatibility_date` | `2026-05-03` | Workers 运行时兼容日期 |
| `keep_vars` | `true` | 保留 Cloudflare Dashboard 中配置的变量和 Secrets |
| `observability.enabled` | `true` | 开启 Cloudflare 观测日志和指标 |
| `vars.STORAGE_BACKEND` | `r2` | 使用 R2 后端 |
| `r2_buckets[0].binding` | `DRIVE_BUCKET` | 注入到 Worker 里的 R2 绑定变量名 |
| `d1_databases[0].binding` | `DB` | 注入到 Worker 里的 D1 数据库绑定变量名 |
| `d1_databases[0].migrations_dir` | `migrations` | D1 表结构迁移目录 |

这里故意没有写 `bucket_name`：

```jsonc
"r2_buckets": [
  {
    "binding": "DRIVE_BUCKET"
  }
]
```

这样 Wrangler 会启用 automatic provisioning。第一次执行 `npm run deploy` 时，Cloudflare 会自动创建一个 R2 bucket，并把它绑定到 Worker 的 `DRIVE_BUCKET`。

D1 配置也没有写 `database_id`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "migrations_dir": "migrations"
  }
]
```

部署命令里已经带有 `--experimental-provision`，因此 Cloudflare 会自动创建 D1 数据库并绑定到 Worker 的 `DB`。应用启动后会确保 D1 表结构存在；仓库中的 `migrations/0001_create_structured_data.sql` 是同一套结构，便于你在 Dashboard 或 Wrangler 中查看和管理。

通过 Dashboard 的 Git 部署触发自动创建时，Cloudflare 会在后台保存这个自动创建的资源；资源 ID 不会写回你的 Git 仓库，这是正常现象。

### 4. 登录和权限配置

项目使用应用内登录弹窗和安全 Cookie 会话，不依赖浏览器原生 Basic Auth 弹窗。建议在 Cloudflare Dashboard 的 Worker `Settings` -> `Variables and Secrets` 里把 `CSRF_SECRET` 设置为 Secret；如果要预置账号，也可以把 `AUTH_USERS` 设置为 Secret：

```text
admin:change-me:admin,alice:alice-password:user,bob:bob-password:user
```

格式是：

```text
用户名:密码:角色,用户名:密码:角色
```

角色只能是：

| 角色 | 权限 |
| --- | --- |
| `admin` | 最高权限，可看所有文件，可修改所有文件，可进入权限管理 |
| `user` | 默认只能看自己上传的文件；管理员授权后，也能看到匹配授权标签的其他文件 |

`AUTH_USERS` 用于预置初始账号。也可以不预置账号，直接在未登录弹窗中注册；当系统里还没有任何预置账号或注册账号时，第一个注册成功的用户会自动成为 `admin`，拥有全部管理权限。之后注册的账号默认是 `user` 角色，密码哈希会写入 D1。

如果不配置 `AUTH_USERS` 且还没有注册账号，公网访问会显示登录/注册弹窗；第一个完成注册的人会成为管理员。只有 `localhost` 本地开发会自动启用未配置管理员模式。如确实需要临时开放未配置管理员模式，可设置 `ALLOW_UNCONFIGURED_AUTH=true`，但不建议用于公网。

`CSRF_SECRET` 用于生成每个登录用户的 CSRF token，应设置为随机长字符串。它不会暴露给前端，前端只会拿到派生后的 token。

最少需要配置的 Secret：

| Secret | 示例 | 说明 |
| --- | --- | --- |
| `AUTH_USERS` | `admin:change-me:admin,alice:alice-password:user` | 可选，预置登录账号、密码和初始角色 |
| `CSRF_SECRET` | `openssl rand -base64 32` 生成的随机值 | 写操作 CSRF 防护 |

用户名称只支持字母、数字、下划线、短横线和点号。写在 `AUTH_USERS` 中的初始密码不要包含英文逗号或冒号，因为 `AUTH_USERS` 使用逗号和冒号分隔。

管理员登录后，左侧会显示 `权限管理`，进入 `/admin` 后可以批量管理用户：

| 能力 | 说明 |
| --- | --- |
| 批量提权 | 将所选用户设置为 `admin` 或 `user`，也可以恢复 `AUTH_USERS` 中写死的角色 |
| 用户标签 | 给用户自身添加管理标签，便于后台归类用户；不会直接影响文件可见性 |
| 可见标签 | 允许用户看到带有指定标签的其他用户文件 |
| 可见文件 | 允许用户看到被指定的单个文件，适合临时授权少量文件 |
| 发送通知 | 给所选用户发送站内通知；用户首页左侧 `通知` 中可查看和标为已读 |

`AUTH_USERS` 是预置账号来源；注册用户和用户修改后的密码哈希会保存到 D1 的 `user_passwords` 表。管理页面不会删除账号；管理页面写入的提权、用户标签、可见文件和通知会保存到 D1 的 `user_profiles` 表。可见标签授权会保存到 D1 的 `user_tag_grants` 表。

在管理页面里设置 `可见标签`，例如：

```text
合同, 发票, public
```

保存后，该普通用户除了自己的文件外，还能看到其他用户或管理员上传且带有这些标签的文件。普通用户只能管理自己拥有的文件；被标签授权看到的文件可以下载和分享，但不能改名、修改描述、修改标签或删除。

历史版本上传的旧文件没有 `owner` 字段，会只对管理员可见。需要让普通用户看到旧文件时，管理员可以重新上传或复制并设置标签和 owner。

### 5. 用户资料、好友和私信

登录后，用户左侧会显示 `账号设置` 和 `好友私信`：

| 功能 | 说明 |
| --- | --- |
| 修改密码 | 输入当前密码和新密码后保存；新密码会覆盖 `AUTH_USERS` 中的初始密码 |
| 昵称 | 用户自己设置，系统会拒绝重复昵称 |
| 头像 | 用户自己上传小头像；头像以 data URL 存在用户资料里，建议使用压缩后的图片 |
| 状态 | 用户自己设置，好友列表会显示状态 |
| 搜索用户 | 支持按用户名、昵称、管理员设置的用户标签搜索 |
| 添加好友 | 搜索到用户后可添加好友；当前实现是双向好友关系 |
| 私信 | 只能给好友发送私信 |
| 分享文件给好友 | 在好友私信中附带自己可见的文件；发送后对方会获得该文件的指定可见权限 |

好友、昵称、头像、状态、指定可见文件和通知都存放在 D1 的 `user_profiles` 表。注册用户和修改后的密码哈希存放在 D1 的 `user_passwords` 表；`AUTH_USERS` 仍然是预置账号和初始密码来源。私信记录存放在 D1 的 `direct_messages` 表。文件对象本身不会复制，好友收到的是对原文件的可见授权。

### 6. 安全防护配置

项目默认启用这些防护：

| 防护 | 说明 |
| --- | --- |
| 基础安全头 | `X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy` 等；HTTPS/HSTS 建议由 Cloudflare 橙云统一处理，避免代理环境兼容问题 |
| CSP | 使用 nonce 限制脚本来源，禁止外站脚本、插件对象、跨站嵌入 |
| CSRF | 所有登录后的写操作都必须携带同源页面生成的 `X-CSRF-Token` |
| 同源校验 | 写操作会校验 `Origin` / `Referer`，并拒绝跨站 Fetch Metadata 子请求 |
| 上传限制 | 默认单文件 4 GiB；网页上传会对大文件自动分片，不限制单次上传总大小和文件数量 |
| API 限流 | Worker 实例内置每分钟请求上限，建议同时配合 Cloudflare WAF / Rate Limiting |
| 登录防爆破 | 登录和注册同时按客户端与用户名组合限速，降低撞库和枚举风险 |
| 分享密码 | 新分享链接密码使用 PBKDF2-SHA256 加盐哈希，旧 SHA-256 分享仍兼容验证 |
| 下载防嗅探 | 下载响应设置 `nosniff`，并以附件形式返回 |

可按需在 Dashboard 中配置这些变量：

| 类型 | 名称 | 默认值 | 说明 |
| --- | --- | --- | --- |
| Secret | `CSRF_SECRET` | 无 | 随机长字符串，用于 CSRF token 派生 |
| Environment variable | `MAX_FILE_BYTES` | `4294967296` | 单文件最大字节数，默认 4 GiB |
| Environment variable | `UPLOAD_CHUNK_BYTES` | `16777216` | 网页大文件分片大小，默认 16 MiB，最大 64 MiB |
| Environment variable | `MAX_JSON_BYTES` | `65536` | JSON 请求体最大字节数 |
| Environment variable | `MAX_SELECTED_FILES` | `500` | 批量下载、删除、复制最多文件数 |
| Environment variable | `MAX_SHARE_FILES` | `100` | 单个分享最多文件数 |
| Environment variable | `API_RATE_LIMIT_PER_MINUTE` | `300` | 单个客户端每分钟 API 请求数 |
| Environment variable | `AUTH_RATE_LIMIT_PER_MINUTE` | `60` | 单个客户端每分钟认证请求数 |
| Environment variable | `AUTH_IDENTITY_RATE_LIMIT_PER_MINUTE` | `20` | 单个客户端对同一用户名每分钟登录/注册尝试数 |
| Environment variable | `SHARE_VERIFY_RATE_LIMIT_PER_MINUTE` | `30` | 单个客户端每分钟分享密码验证次数 |
| Environment variable | `ALLOW_UNCONFIGURED_AUTH` | `false` | 仅本地开发建议使用，不要在公网开启 |

网页端会把大文件拆成多个小请求上传到 Worker，再由 Worker 使用 R2/S3 multipart 合并成一个对象，避免单个 HTTP 请求体超过 Cloudflare 边缘限制。`MAX_FILE_BYTES` 仍然控制最终单文件大小。

### 7. AWS S3 配置

`wrangler.s3.jsonc` 用于 S3 部署，注意它没有 `r2_buckets`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cirrus-drive",
  "main": "src/index.tsx",
  "compatibility_date": "2026-05-03",
  "keep_vars": true,
  "observability": {
    "enabled": true
  },
  "vars": {
    "STORAGE_BACKEND": "s3"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "migrations_dir": "migrations"
    }
  ]
}
```

使用 S3 时，建议在 Cloudflare Dashboard 的 Worker 环境变量和 Secrets 中填写 4 个值：

| 类型 | 名称 | 示例 | 说明 |
| --- | --- | --- | --- |
| Environment variable | `S3_BUCKET` | `my-drive-bucket` | S3 bucket 名称 |
| Environment variable | `S3_REGION` | `ap-northeast-1` | bucket 所在 region |
| Secret | `S3_ACCESS_KEY_ID` | `AKIA...` | S3 access key |
| Secret | `S3_SECRET_ACCESS_KEY` | `...` | S3 secret key |

`STORAGE_BACKEND=s3` 已经写在 `wrangler.s3.jsonc` 里，不需要在 Dashboard 里再填。`S3_REGION` 如果不填会兜底为 `us-east-1`，但建议始终填写为 bucket 的真实 region，避免签名区域不匹配、重定向或额外延迟。

如果使用 MinIO、Backblaze、其他兼容 S3 的服务，再按需添加高级选项：

| 类型 | 名称 | 示例 | 说明 |
| --- | --- | --- | --- |
| Environment variable | `S3_ENDPOINT` | `https://s3.example.com` | 兼容 S3 服务的 endpoint |
| Environment variable | `S3_FORCE_PATH_STYLE` | `true` | path-style 访问，兼容 S3 服务常用 |
| Secret | `S3_SESSION_TOKEN` | `...` | 临时凭证才需要 |

仓库提供了 [.env.example](./.env.example) 作为填写参考。Cloudflare Dashboard 里只填表中实际需要的变量即可，不要把真实密钥提交到 Git。

S3 部署时，Workers Builds 仍然填写 `Deploy command` 为：

```bash
npm run deploy:s3
```

### 8. 部署后怎么检查

部署完成后，Cloudflare 会显示一个 `workers.dev` 地址，通常类似：

```text
https://cirrus-drive.<你的-workers-子域>.workers.dev
```

打开这个地址应能看到网盘首页。然后进入 Worker 的 `Settings` -> `Bindings` 检查：

| 后端 | 应看到什么 |
| --- | --- |
| R2 | 有 `DRIVE_BUCKET` R2 bucket 绑定、有 `DB` D1 database 绑定，并有 `STORAGE_BACKEND=r2` |
| S3 | 没有 `DRIVE_BUCKET` R2 bucket 绑定，有 `DB` D1 database 绑定、`STORAGE_BACKEND=s3`、`S3_BUCKET` 和 S3 Secrets |

后续只要向生产分支推送代码，Workers Builds 会自动重新部署。

如果要绑定自己的域名，请在 Cloudflare Dashboard 的 Worker `Settings` -> `Triggers` -> `Custom Domains` 中添加，或使用不提交到公开仓库的私有 Wrangler 配置。不要把个人域名写进公开项目的 `wrangler.jsonc` / `wrangler.s3.jsonc`；当前仓库只保留通用的 `workers.dev` 入口。

### 9. 常见问题

如果构建失败并提示 Worker 名称不匹配，确认 Dashboard 的 `Project name` / `Worker name` 和 `wrangler.jsonc` 的 `name` 都是 `cirrus-drive`。

如果 R2 或 D1 自动创建失败，确认 Cloudflare 账号拥有 Workers、R2 和 D1 权限，并且部署命令包含 `--experimental-provision`。本项目已经在 `package.json` 中声明了 `wrangler` 4.x。

如果部署后页面提示 D1 表不存在，先重新部署一次；应用启动时也会自动创建表。需要手动查看结构时，可以在 Cloudflare Dashboard 的 D1 页面打开自动创建的数据库，表名包括 `file_meta`、`shares`、`user_profiles`、`user_tag_grants`、`user_passwords` 和 `direct_messages`。

如果选择 S3 后仍然看到 R2 被创建，说明部署时没有使用 S3 配置。检查 `Deploy command` 是否是 `npm run deploy:s3`。

如果页面能打开但文件列表或上传失败，先看页面左侧存储名：显示 `Cloudflare R2` 表示正在使用 R2，显示 `AWS S3` 表示正在使用 S3。然后检查对应绑定或环境变量是否完整。

如果浏览器反复弹登录框，检查 `AUTH_USERS` 的格式是否是 `用户名:密码:角色`，多个用户用英文逗号分隔。密码里不要包含英文逗号或冒号。

如果普通用户看不到管理员授权的文件，确认文件本身已经设置了对应标签，并且管理员在 `权限管理` 中给该用户保存了完全相同的标签名。

如果你想绑定已有 R2 bucket，可以在 `r2_buckets` 中加回 `bucket_name`，例如：

```jsonc
"r2_buckets": [
  {
    "binding": "DRIVE_BUCKET",
    "bucket_name": "你的-bucket-name"
  }
]
```

这种模式下需要你自己先创建对应的 R2 bucket。

官方参考：

- Workers Builds：<https://developers.cloudflare.com/workers/ci-cd/builds/>
- Workers Builds 配置：<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>
- Wrangler 自动创建资源：<https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning>
- Workers 使用 R2 绑定：<https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#create-a-binding>
- D1 数据库：<https://developers.cloudflare.com/d1/>
- AWS S3 API：<https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html>

## 项目结构

- `src/index.tsx`：Hono 路由、JSX 页面、前端交互脚本
- `src/storage.ts`：文件元数据、复制、分享、权限和账号数据的业务逻辑
- `src/object-storage.ts`：R2 / S3 对象存储适配器，以及结构化数据到 D1 的兼容层
- `src/zip.ts`：Workers 端无压缩 ZIP 流式打包
- `migrations/`：D1 表结构迁移
- `wrangler.jsonc`：Cloudflare Worker、R2 binding 和 D1 binding 配置
- `wrangler.s3.jsonc`：Cloudflare Worker、S3 环境变量和 D1 binding 配置
- `.env.example`：S3 环境变量示例

## 说明

当前版本是“对象存储 + D1”实现：文件二进制对象存放在 `objects/`，后端可以选择 R2 或 S3；结构化数据存放在 D1。D1 表包括 `file_meta`、`shares`、`user_tag_grants`、`user_profiles`、`user_passwords` 和 `direct_messages`。从旧版本升级时，如果对象存储里已有 `meta/`、`shares/`、`messages/`、`accounts/passwords.json`、`permissions/tag-grants.json` 或 `permissions/user-profiles.json`，应用会在首次读取时自动导入 D1。文件过期会在列表读取和文件读取时自动清理。
