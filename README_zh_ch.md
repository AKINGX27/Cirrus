# Cirrus Drive

**语言：** [English](README.md) | 简体中文

Cirrus Drive 是一个面向 Cloudflare Workers 的轻量自托管网盘。应用层保持无服务器，文件存放在 R2 或兼容 S3 的对象存储中，用户、权限、标签、分享、私信等结构化数据存放在 Cloudflare D1。

`Cloudflare Workers` · `R2 / S3` · `D1` · `Hono` · `Serverless file sharing`

## 功能介绍

| 模块 | 能力 |
| --- | --- |
| 文件 | 多文件上传、单文件描述和标签、改名、复制、剪切、删除、单文件下载、多文件流式 ZIP 下载 |
| 文件列表 | 名称、描述、标签、上传时间、最后下载时间、下载次数，支持按名称 / 描述 / 标签 / 扩展名搜索，点击标签筛选 |
| 分享 | 公开分享链接、可选密码、自定义或自动分享码、有效期、单文件下载、全部下载、分享页右键下载 |
| 账号 | 内置登录注册、修改密码、头像、唯一昵称、状态 |
| 权限 | 普通用户默认只看自己的文件；管理员可查看全部文件，并按标签或指定文件授权可见范围 |
| 管理 | 管理页面支持角色调整、用户标签、可见标签、可见文件和站内通知 |
| 社交 | 按用户名、昵称、用户标签搜索用户，支持好友、私信和向好友分享文件 |
| 安全 | 安全响应头、CSP、CSRF 防护、同源校验、速率限制、上传限制、短时公开下载票据 |
| 界面 | 响应式布局，跟随系统浅色 / 暗色模式 |

如果系统中没有任何预置账号或注册账号，第一个注册成功的用户会自动成为管理员。之后注册的用户默认是普通用户。

## 网盘优点

| 优点 | 说明 |
| --- | --- |
| 轻量 | 不需要 VPS、Docker、Nginx 或常驻后端进程。 |
| 无服务器 | 核心运行在 Cloudflare Workers 上，按请求运行并自动扩展。 |
| 维护简单 | 页面、API、鉴权、分享和管理功能都在同一个 Worker 项目里。 |
| 成本可控 | 文件进入对象存储，结构化元数据体量小，适合 D1。 |
| 数据自控 | Worker、存储桶、数据库、用户和权限规则都由部署者掌控。 |
| 存储灵活 | 默认使用 R2，也可以切换到 AWS S3 或兼容 S3 的服务。 |
| 权限实用 | 管理员可按标签或指定文件授权，不需要给用户完整账号权限。 |
| 适合公开项目 | 仓库不硬编码私人域名、bucket 名、database ID、API token 或 Secret。 |
| 易于改造 | 相比 Nextcloud、Seafile 等完整私有云，项目更聚焦、更容易按需求定制。 |

## 网页 Workers 部署方式

推荐使用 Cloudflare Dashboard + Workers Builds 部署。先将本仓库推送到 GitHub 或 GitLab，然后在 Cloudflare Dashboard 中导入仓库。

### 1. 创建 Worker

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 点击 `Create application`。
4. 选择 `Import a repository`。
5. 选择 Cirrus Drive 所在仓库。
6. 按下面表格填写构建和部署配置。

### 2. 选择存储模式

| 模式 | 文件存储 | 结构化数据 | 部署命令 | R2 创建方式 |
| --- | --- | --- | --- | --- |
| 默认 R2 | Cloudflare R2 | Cloudflare D1 | `npm run deploy` | 自动创建 |
| S3 | AWS S3 或兼容 S3 的对象存储 | Cloudflare D1 | `npm run deploy:s3` | 不使用 R2 |

R2 是默认模式。R2 配置中故意不写 bucket 名和 D1 database ID，方便 Wrangler automatic provisioning 在部署时自动创建并绑定资源。

S3 模式使用 `wrangler.s3.jsonc`；该配置不声明 R2 绑定，因此不会创建 R2 bucket。

### 3. 填写 Workers Builds 配置

| Cloudflare 页面字段 | R2 部署 | S3 部署 | 说明 |
| --- | --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | `cirrus-drive` | 和 Wrangler 配置中的 `name` 保持一致。 |
| `Production branch` | `main` | `main` | 如果生产分支不同，填写实际分支。 |
| `Root directory` | 留空或 `/` | 留空或 `/` | monorepo 中需选择包含 `package.json` 的目录。 |
| `Build command` | 留空 | 留空 | Worker 会在部署时由 Wrangler 打包。 |
| `Deploy command` | `npm run deploy` | `npm run deploy:s3` | 这是选择后端的关键配置。 |
| `Non-production deploy command` | 保持默认 | 保持默认 | 默认 Worker preview 命令即可。 |

### 4. 配置变量和 Secret

R2 部署的最小推荐配置：

| 类型 | 名称 | 是否必须 | 示例 / 值 |
| --- | --- | --- | --- |
| Secret | `CSRF_SECRET` | 建议 | 稳定的随机长字符串 |
| Secret | `AUTH_USERS` | 可选 | `admin:change-me:admin,alice:alice-password:user` |

S3 部署还需要：

| 类型 | 名称 | 是否必须 | 示例 / 值 |
| --- | --- | --- | --- |
| Variable | `S3_BUCKET` | 是 | `my-drive-bucket` |
| Variable | `S3_REGION` | 建议 | `us-east-1` |
| Secret | `S3_ACCESS_KEY_ID` | 是 | 你的 access key |
| Secret | `S3_SECRET_ACCESS_KEY` | 是 | 你的 secret key |
| Variable | `S3_ENDPOINT` | 可选 | `https://s3.example.com` |
| Variable | `S3_FORCE_PATH_STYLE` | 可选 | `true` |
| Secret | `S3_SESSION_TOKEN` | 可选 | 临时凭证 token |

`AUTH_USERS` 格式：

```text
用户名:密码:角色,用户名:密码:角色
```

角色只能是 `admin` 或 `user`。`AUTH_USERS` 可以不配置；如果没有任何预置账号或注册账号，第一个注册用户会成为管理员。

### 5. 部署

保存 Workers Builds 配置后，可以在 Dashboard 手动触发生产部署，也可以 push 到生产分支自动部署。

R2 部署：

```text
npm run deploy
```

S3 部署：

```text
npm run deploy:s3
```

## 注意点

- 不要提交私人域名、bucket 名、database ID、API token 或 Secret。
- `wrangler.jsonc` 用于 R2，包含 `DRIVE_BUCKET` 绑定。
- `wrangler.s3.jsonc` 用于 S3，故意不包含 R2 绑定。
- R2 和 S3 两种模式都会使用 D1 存放结构化数据。
- 使用 R2 配置部署时，Wrangler 可以自动创建并绑定 R2 和 D1。
- S3 bucket 不会由 Cirrus Drive 创建，需要你自己创建，并为 Worker 提供具备相应权限的凭证。
- `S3_REGION` 应与 bucket 区域一致。如果省略，应用默认使用 `us-east-1`，其他区域可能出现签名错误，也可能增加延迟。
- `CSRF_SECRET` 应保持稳定。更换它会使已有登录会话和 CSRF token 失效。
- 第一个用户自动成为管理员的规则只在系统没有任何预置账号或注册账号时生效。
- 大文件保留在对象存储中；多文件下载会流式生成无压缩 ZIP。
- 公开分享下载使用 Worker 生成的短时票据。
- Cloudflare 橙云和 HTTPS 可以放在 Worker 前面；应用本身也会启用安全响应头、CSRF 检查和同源校验。
