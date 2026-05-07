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
- Basic Auth 权限管理：普通用户默认只看自己的文件，管理员可看全部文件并为普通用户授权可见标签
- 左键可在列表空白处框选多个文件
- 分享支持免密码或密码分享、有效期、自定义或自动分享码
- 浅色/暗色跟随系统，自适应宽屏和手机屏幕

## Cloudflare Workers 配置和部署

本项目部署为 Cloudflare Worker，文件存储支持两种后端：

- 默认：Cloudflare R2。无需手动创建 bucket，Wrangler 会自动创建并绑定。
- 可选：AWS S3。通过环境变量启用，部署时不会创建 R2，也不会绑定 `DRIVE_BUCKET`。

部署前需要把项目推送到 GitHub 或 GitLab 仓库。Cloudflare Workers Builds 会从仓库读取 `package.json`、`wrangler.jsonc` / `wrangler.s3.jsonc` 和 `src/index.tsx`。

### 1. 选择存储后端

| 后端 | 什么时候用 | 部署命令 | 会创建 R2 吗 |
| --- | --- | --- | --- |
| R2 | 默认部署，数据放在 Cloudflare R2 | `npm run deploy` | 会，由 Wrangler 自动创建 |
| S3 | 数据放在 AWS S3 或兼容 S3 的对象存储 | `npm run deploy:s3` | 不会 |

本地开发也有对应命令：

- R2：`npm run dev`
- S3：`npm run dev:s3`

S3 命令会使用 `wrangler.s3.jsonc`，这个配置文件没有 `r2_buckets`，所以不会 provision R2。

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
| `Environment variables` | R2 可不填；S3 填 `S3_BUCKET`、`S3_REGION` | S3 bucket 名称和 region |
| `Secrets` | 填 `AUTH_USERS`；S3 另填访问密钥 | 不要把账号密码或 S3 密钥写进仓库 |

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

这里故意没有写 `bucket_name`：

```jsonc
"r2_buckets": [
  {
    "binding": "DRIVE_BUCKET"
  }
]
```

这样 Wrangler 会启用 automatic provisioning。第一次执行 `npx wrangler deploy` 时，Cloudflare 会自动创建一个 R2 bucket，并把它绑定到 Worker 的 `DRIVE_BUCKET`。

通过 Dashboard 的 Git 部署触发自动创建时，Cloudflare 会在后台保存这个自动创建的资源；资源 ID 不会写回你的 Git 仓库，这是正常现象。

### 4. 登录和权限配置

项目使用 Workers 原生 Basic Auth，不需要额外数据库。建议在 Cloudflare Dashboard 的 Worker `Settings` -> `Variables and Secrets` 里把 `AUTH_USERS` 设置为 Secret：

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

如果不配置 `AUTH_USERS`，项目会以未配置状态运行，并自动视为 `admin` 用户。这适合首次试用，但公开部署时应配置真实账号。

管理员登录后，左侧会显示 `权限管理`。在弹窗里选择普通用户，填写该用户可见的标签，例如：

```text
合同, 发票, public
```

保存后，该普通用户除了自己的文件外，还能看到其他用户或管理员上传且带有这些标签的文件。普通用户只能管理自己拥有的文件；被标签授权看到的文件可以下载和分享，但不能改名、修改描述、修改标签或删除。

历史版本上传的旧文件没有 `owner` 字段，会只对管理员可见。需要让普通用户看到旧文件时，管理员可以重新上传或复制并设置标签和 owner。

### 5. AWS S3 配置

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
  }
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

### 6. 部署后怎么检查

部署完成后，Cloudflare 会显示一个 `workers.dev` 地址，通常类似：

```text
https://cirrus-drive.<你的-workers-子域>.workers.dev
```

打开这个地址应能看到网盘首页。然后进入 Worker 的 `Settings` -> `Bindings` 检查：

| 后端 | 应看到什么 |
| --- | --- |
| R2 | 有 `DRIVE_BUCKET` R2 bucket 绑定，并有 `STORAGE_BACKEND=r2` |
| S3 | 没有 `DRIVE_BUCKET` R2 bucket 绑定，有 `STORAGE_BACKEND=s3`、`S3_BUCKET` 和 S3 Secrets |

后续只要向生产分支推送代码，Workers Builds 会自动重新部署。

### 7. 常见问题

如果构建失败并提示 Worker 名称不匹配，确认 Dashboard 的 `Project name` / `Worker name` 和 `wrangler.jsonc` 的 `name` 都是 `cirrus-drive`。

如果 R2 自动创建失败，确认 Cloudflare 账号拥有 Workers 和 R2 权限，并且仓库安装的 Wrangler 是 4.x。本项目已经在 `package.json` 中声明了 `wrangler` 4.x。

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
- AWS S3 API：<https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html>

## 项目结构

- `src/index.tsx`：Hono 路由、JSX 页面、前端交互脚本
- `src/storage.ts`：文件元数据、复制、分享、过期清理
- `src/object-storage.ts`：R2 / S3 对象存储适配器
- `src/zip.ts`：Workers 端无压缩 ZIP 流式打包
- `wrangler.jsonc`：Cloudflare Worker 与 R2 binding 配置
- `wrangler.s3.jsonc`：Cloudflare Worker 与 S3 环境变量配置
- `.env.example`：S3 环境变量示例

## 说明

当前版本是单 bucket 实现：文件对象存放在 `objects/`，文件元数据存放在 `meta/`，分享记录存放在 `shares/`，用户标签授权存放在 `permissions/tag-grants.json`。选择 R2 或 S3 只会影响这些对象存放在哪个对象存储后端。文件过期会在列表读取和文件读取时自动清理。
