# Cirrus Drive

**语言：** [English](README.md) | 简体中文

Cirrus Drive 是一个基于 Cloudflare Workers 的轻量网盘。默认使用 Cloudflare R2 存储文件，也可以切换到 AWS S3 或兼容 S3 的对象存储；用户、权限、标签、分享、私信等结构化数据存放在 Cloudflare D1。

## 功能介绍

- 网页登录和注册；如果系统里没有任何账号，第一个注册用户会自动成为管理员。
- 普通用户默认只能看到自己的文件。
- 管理员可以看到所有文件，并通过管理页面控制角色、用户标签、可见文件标签、可见文件和通知。
- 支持单文件和多文件上传，上传时可为每个文件填写描述和标签。
- 文件列表显示名称、描述、标签、上传时间、最后下载时间和下载次数。
- 支持搜索文件名、描述、标签和扩展名。
- 点击标签可筛选同标签文件。
- 支持单文件下载，多文件自动打包为 ZIP 下载。
- 支持公开分享链接，可设置密码、自定义或自动分享码、有效期。
- 分享页支持单文件下载、全部下载和文件右键下载。
- 文件右键菜单支持改名、修改描述、修改标签、复制、剪切、选择、下载和分享。
- 账号设置支持修改密码、头像、唯一昵称和状态。
- 支持按用户名、昵称、用户标签搜索用户。
- 支持添加好友、私信和向好友分享文件。
- 内置安全响应头、CSP、CSRF 防护、同源校验、速率限制和上传大小限制。
- 响应式界面，支持跟随系统浅色/暗色模式。

## 网盘优点

- **轻量：** 不需要 VPS、Docker、Nginx 或常驻后端服务。
- **无服务器：** 核心运行在 Cloudflare Workers 上，按请求运行，维护成本低。
- **前后端一体：** 页面、API、鉴权、分享、管理功能都在同一个 Worker 项目里。
- **成本可控：** 文件放对象存储，结构化数据量小，适合 D1。
- **数据自控：** Worker、对象存储、数据库、用户和权限都由部署者掌控。
- **存储灵活：** 默认 R2，也支持 AWS S3 和兼容 S3 的服务。
- **权限细：** 普通用户看自己的文件，管理员可以按标签或指定文件授权可见范围。
- **适合公开项目：** 仓库里不写私人域名、bucket 名、database id 或密钥。
- **易改造：** 相比 Nextcloud、Seafile 等完整私有云，代码更小，更适合按个人需求继续定制。

## 网页 Workers 部署方式

推荐使用 Cloudflare Dashboard 的 Workers Builds 从 Git 仓库部署。先把项目推送到 GitHub 或 GitLab。

### 1. 从 Git 创建 Worker

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 点击 `Create application`。
4. 选择 `Import a repository`。
5. 选择本项目所在仓库。
6. 按下面表格填写部署配置。

### 2. 选择 R2 或 S3

| 存储方式 | 文件存放位置 | 结构化数据 | 部署命令 | 是否自动创建 R2 |
| --- | --- | --- | --- | --- |
| 默认 R2 | Cloudflare R2 | Cloudflare D1 | `npm run deploy` | 是 |
| S3 | AWS S3 或兼容 S3 的对象存储 | Cloudflare D1 | `npm run deploy:s3` | 否 |

R2 是默认方式，不需要填写 S3 变量。仓库里故意不写 R2 bucket 名和 D1 database id，方便 Wrangler automatic provisioning 在部署时自动创建和绑定资源。

### 3. Workers Builds 页面怎么填

| 页面输入框 | R2 填什么 | S3 填什么 | 注意 |
| --- | --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | `cirrus-drive` | 应和 Wrangler 配置里的 `name` 一致。 |
| `Production branch` | `main` | `main` | 如果你的生产分支不是 `main`，填实际分支。 |
| `Root directory` | 留空或 `/` | 留空或 `/` | 如果在 monorepo 子目录，填包含 `package.json` 的目录。 |
| `Build command` | 留空 | 留空 | 本项目没有单独构建命令。 |
| `Deploy command` | `npm run deploy` | `npm run deploy:s3` | S3 会使用 `wrangler.s3.jsonc`，不会创建 R2。 |
| `Non-production deploy command` | 保持默认 | 保持默认 | 默认 Worker preview upload 即可。 |

### 4. 环境变量和 Secret

R2 部署最少建议配置：

| 类型 | 名称 | 是否必须 | 示例 |
| --- | --- | --- | --- |
| Secret | `CSRF_SECRET` | 建议填写 | 随机长字符串 |
| Secret | `AUTH_USERS` | 可选 | `admin:change-me:admin,alice:alice-password:user` |

S3 部署除 `CSRF_SECRET` 外，还需要：

| 类型 | 名称 | 是否必须 | 示例 |
| --- | --- | --- | --- |
| Variable | `S3_BUCKET` | 是 | `my-drive-bucket` |
| Variable | `S3_REGION` | 建议填写 | `us-east-1` |
| Secret | `S3_ACCESS_KEY_ID` | 是 | 你的 access key |
| Secret | `S3_SECRET_ACCESS_KEY` | 是 | 你的 secret key |
| Variable | `S3_ENDPOINT` | 可选 | `https://s3.example.com` |
| Variable | `S3_FORCE_PATH_STYLE` | 可选 | `true` |
| Secret | `S3_SESSION_TOKEN` | 可选 | 临时凭证 token |

`AUTH_USERS` 格式：

```text
用户名:密码:角色,用户名:密码:角色
```

角色只能是 `admin` 或 `user`。也可以不填写 `AUTH_USERS`；当系统里没有预置账号和注册账号时，第一个注册成功的用户会自动成为管理员。

### 5. 开始部署

保存 Workers Builds 配置后，可以在 Dashboard 手动触发生产部署，也可以 push 到生产分支自动部署。

R2 部署使用 `wrangler.jsonc`：

```text
npm run deploy
```

S3 部署使用 `wrangler.s3.jsonc`：

```text
npm run deploy:s3
```

## 注意点

- 不要把私人域名、bucket 名、database id、API token 或 Secret 写进公开仓库。
- `wrangler.jsonc` 用于 R2，包含 `DRIVE_BUCKET` 绑定；`wrangler.s3.jsonc` 用于 S3，不包含 R2 绑定。
- R2 和 S3 两种模式都会使用 D1 存放结构化数据。
- 使用 R2 配置和部署命令时，Wrangler 会自动创建并绑定 R2 和 D1。
- S3 bucket 不会由本项目创建，需要你自己创建，并给 Worker 配置有权限的访问密钥。
- `S3_REGION` 应该和 bucket 所在区域一致。如果省略，会默认 `us-east-1`，其他区域可能出现签名错误，也可能增加访问延迟。
- Cloudflare 橙云和 HTTPS 可以放在 Worker 前面保护域名；应用本身也会发送安全响应头，并启用 CSRF 和同源校验。
- `CSRF_SECRET` 应保持稳定。修改它会让已有登录会话和 CSRF token 失效。
- 只有系统里没有任何预置账号或注册账号时，第一个注册用户才会自动成为管理员。
- 大文件存放在对象存储中；多文件下载会流式打包为无压缩 ZIP。
- 公开分享下载链接使用 Worker 生成的短时票据。
