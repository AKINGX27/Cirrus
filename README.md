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

## Cloudflare Workers 部署

本项目部署到 Cloudflare Workers，文件数据存储在 Cloudflare R2。部署脚本会自动读取 `wrangler.jsonc` 中的 `r2_buckets` 配置并创建 R2 bucket；bucket 已存在时会跳过创建并继续部署，不需要在 Cloudflare 控制台手动绑定。

### 1. 准备账号和本地环境

1. 注册并登录 Cloudflare 账号。
2. 确认本机已安装 Node.js 20 或更高版本。
3. 在项目目录安装依赖：

```bash
npm install
```

4. 登录 Wrangler：

```bash
npx wrangler login
```

命令会打开浏览器完成 Cloudflare 授权。如果账号下有多个 Cloudflare Account，后续创建 R2 bucket 或部署时按提示选择目标账号。

### 2. 检查部署配置

部署配置位于 `wrangler.jsonc`：

```jsonc
{
  "name": "cirrus-drive",
  "main": "src/index.tsx",
  "compatibility_date": "2026-05-03",
  "r2_buckets": [
    {
      "binding": "DRIVE_BUCKET",
      "bucket_name": "cirrus-drive"
    }
  ]
}
```

字段说明：

- `name`：部署后的 Worker 名称。
- `main`：Worker 入口文件。
- `binding`：代码中使用的 R2 绑定名，当前代码使用 `DRIVE_BUCKET`，不要随意改名。
- `bucket_name`：要创建并绑定的 R2 bucket 名称。

如需换 bucket 名称，只修改 `bucket_name` 即可。R2 bucket 名称建议使用小写字母、数字和短横线，长度保持在 3-63 个字符。

### 3. 本地预览

```bash
npm run dev
```

开发服务通常会启动在：

```text
http://localhost:8787
```

Wrangler 默认本地开发模式会把 R2 数据写入本地模拟存储，不会写入生产环境 bucket。你可以在页面中测试上传、下载、分享和批量 ZIP 下载。

### 4. 首次部署

```bash
npm run deploy
```

这个命令会依次执行：

1. `predeploy`：运行 `scripts/ensure-r2-bucket.mjs`。
2. 脚本读取 `wrangler.jsonc` 中的 `r2_buckets`。
3. 自动执行 `wrangler r2 bucket create cirrus-drive`。
4. 如果 bucket 已存在，脚本输出已存在并继续。
5. 执行 `wrangler deploy`，将 Worker 部署到 Cloudflare。
6. Wrangler 输出部署后的访问地址，通常是 `https://cirrus-drive.<你的子域>.workers.dev`。

部署完成后，打开 Wrangler 输出的 URL。首页应直接显示网盘文件列表。

### 5. 验证 R2 bucket 和部署状态

查看当前账号下的 R2 bucket：

```bash
npx wrangler r2 bucket list
```

确认 Worker 已部署：

```bash
npx wrangler deployments list
```

也可以在 Cloudflare Dashboard 中进入 `Workers & Pages`，找到 `cirrus-drive`，查看部署记录和访问地址。

### 6. 后续更新部署

修改代码后重复执行：

```bash
npm run typecheck
npm run deploy
```

`npm run deploy` 每次都会先确认 R2 bucket 是否存在。已存在时不会清空文件，也不会重建 bucket。

### 7. 常见问题

如果 `wrangler login` 无法打开浏览器，可以在终端输出的链接中手动复制到浏览器打开。

如果部署时提示没有权限，请确认当前登录的 Cloudflare 账号拥有 Workers 和 R2 权限，或使用有权限的 API Token/账号重新登录。

如果提示 bucket 名称无效，请把 `wrangler.jsonc` 的 `bucket_name` 改成只包含小写字母、数字和短横线的名称。

如果 `workers.dev` 地址无法访问，请在 Cloudflare Dashboard 中确认账号已启用 Workers 子域，或为 Worker 绑定自定义域名。

官方参考：

- Cloudflare Workers Wrangler：<https://developers.cloudflare.com/workers/wrangler/>
- Wrangler deploy：<https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy>
- R2 bucket 创建：<https://developers.cloudflare.com/r2/buckets/create-buckets/>
- Workers 使用 R2：<https://developers.cloudflare.com/r2/api/workers/workers-api-usage/>

## 项目结构

- `src/index.tsx`：Hono 路由、JSX 页面、前端交互脚本
- `src/storage.ts`：R2 文件元数据、复制、分享、过期清理
- `src/zip.ts`：Workers 端无压缩 ZIP 流式打包
- `wrangler.jsonc`：Cloudflare Worker 与 R2 binding 配置

## 说明

当前版本是单 bucket 实现：文件对象存放在 `objects/`，文件元数据存放在 `meta/`，分享记录存放在 `shares/`。文件过期会在列表读取和文件读取时自动清理。
