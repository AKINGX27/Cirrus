# Cirrus Drive

基于 Cloudflare Workers、Hono + JSX 和 Cloudflare R2 的轻量网盘。

## 功能

- 打开首页直接显示 R2 网盘文件列表
- 多文件上传，并可设置文件存留时间
- 单文件下载，多文件自动打包为无压缩 ZIP 下载
- 文件显示名称、上传时间、最后下载时间、下载次数
- 右键菜单支持改名、下载、选择、复制、剪切、分享
- 左键可在列表空白处框选多个文件
- 分享支持免密码或密码分享、有效期、自定义或自动分享码
- 浅色/暗色跟随系统，自适应宽屏和手机屏幕

## Cloudflare Workers 配置和部署

本项目部署为 Cloudflare Worker，文件存储使用 Cloudflare R2。不要创建 Pages 项目，也不需要提前手动创建 R2 bucket；`wrangler deploy` 会根据 `wrangler.jsonc` 自动创建并绑定 R2。

部署前需要把项目推送到 GitHub 或 GitLab 仓库。Cloudflare Workers Builds 会从仓库读取 `package.json`、`wrangler.jsonc` 和 `src/index.tsx`。

### 1. Workers Builds 页面怎么填

进入 Cloudflare Dashboard -> `Workers & Pages` -> `Create application` -> `Import a repository`，选择本项目仓库后，按下表填写。

| Cloudflare 页面输入框 | 应填写的值 | 说明 |
| --- | --- | --- |
| `Project name` / `Worker name` | `cirrus-drive` | 必须和 `wrangler.jsonc` 里的 `name` 一致 |
| `Production branch` / `Branch` | `main` | 如果你的生产分支不是 `main`，填实际分支名 |
| `Root directory` | 留空或填 `/` | 仓库根目录包含 `package.json` 和 `wrangler.jsonc` 时这样填 |
| `Build command` | 留空 | 本项目没有单独的构建步骤 |
| `Deploy command` | `npx wrangler deploy` | 由 Wrangler 读取配置、创建 R2、部署 Worker |
| `Non-production branch deploy command` | 保持默认 | 默认通常是 `npx wrangler versions upload` |
| `Environment variables` | 不填写 | 本项目没有运行时环境变量 |
| `Secrets` | 不填写 | 本项目没有需要配置的密钥 |

如果项目放在 monorepo 子目录，`Root directory` 要填到包含 `package.json` 和 `wrangler.jsonc` 的目录，例如 `apps/cirrus`。

### 2. `wrangler.jsonc` 配置说明

当前配置如下：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cirrus-drive",
  "main": "src/index.tsx",
  "compatibility_date": "2026-05-03",
  "observability": {
    "enabled": true
  },
  "r2_buckets": [
    {
      "binding": "DRIVE_BUCKET"
    }
  ]
}
```

每一项的作用：

| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `name` | `cirrus-drive` | Worker 名称；Dashboard 里的项目名必须和它一致 |
| `main` | `src/index.tsx` | Worker 入口文件 |
| `compatibility_date` | `2026-05-03` | Workers 运行时兼容日期 |
| `observability.enabled` | `true` | 开启 Cloudflare 观测日志和指标 |
| `r2_buckets[0].binding` | `DRIVE_BUCKET` | 注入到 Worker 里的 R2 绑定变量名 |

代码中通过 `c.env.DRIVE_BUCKET` 访问 R2，所以 `binding` 必须保持为 `DRIVE_BUCKET`。如果改成其他名字，代码也要同步修改。

### 3. R2 自动创建规则

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

不要在 Cloudflare Dashboard 里提前手动创建 R2 bucket，也不要在 `wrangler.jsonc` 里补 `bucket_name`，除非你明确想绑定一个已有 bucket。

### 4. 部署后怎么检查

部署完成后，Cloudflare 会显示一个 `workers.dev` 地址，通常类似：

```text
https://cirrus-drive.<你的-workers-子域>.workers.dev
```

打开这个地址应能看到网盘首页。然后进入 Worker 的 `Settings` -> `Bindings`，确认有一条 R2 绑定：

| 检查项 | 正确值 |
| --- | --- |
| `Type` | `R2 bucket` |
| `Variable name` / `Binding name` | `DRIVE_BUCKET` |
| `Bucket` | Wrangler 自动创建的 bucket |
| `Environment` | `Production` |

后续只要向生产分支推送代码，Workers Builds 会自动重新部署。

### 5. 常见问题

如果构建失败并提示 Worker 名称不匹配，确认 Dashboard 的 `Project name` / `Worker name` 和 `wrangler.jsonc` 的 `name` 都是 `cirrus-drive`。

如果 R2 自动创建失败，确认 Cloudflare 账号拥有 Workers 和 R2 权限，并且仓库安装的 Wrangler 是 4.x。本项目已经在 `package.json` 中声明了 `wrangler` 4.x。

如果页面能打开但文件列表或上传失败，检查 Worker 的 `Settings` -> `Bindings` 里是否存在 `DRIVE_BUCKET`。没有的话，重新触发一次部署，并确认 `Deploy command` 是 `npx wrangler deploy`。

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

## 项目结构

- `src/index.tsx`：Hono 路由、JSX 页面、前端交互脚本
- `src/storage.ts`：R2 文件元数据、复制、分享、过期清理
- `src/zip.ts`：Workers 端无压缩 ZIP 流式打包
- `wrangler.jsonc`：Cloudflare Worker 与 R2 binding 配置

## 说明

当前版本是单 bucket 实现：文件对象存放在 `objects/`，文件元数据存放在 `meta/`，分享记录存放在 `shares/`。文件过期会在列表读取和文件读取时自动清理。
