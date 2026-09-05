# OpenAI Secure MCP Tunnel

一个 Turborepo monorepo：`mcp-tunnel` 将本地 stdio MCP 服务通过 OpenAI Tunnel Client 暴露给工作区。核心工具与可选扩展均以 workspace package 提供，未来可新增独立的 `apps/mcp-*` 组合应用。

## 架构

```text
apps/mcp-tunnel                   当前 Tunnel 专用 MCP 应用和运行脚本
packages/mcp-tool-runtime         通用 tool 注册、配置与结果协议
packages/mcp-tools-core           read / write / edit / bash
packages/mcp-tools-extra          read_image / read_many / edit_many / notify
packages/mcp-image-adapter        图片读取和 sharp 转码（按需加载）
packages/pi-adapter               工作区文件、编辑、命令和路径安全适配
```

开发环境通过 `pnpm stub`（也在 `postinstall` 中执行）使用 `unbuild --stub`，不需要在每次修改 package 后手动 build。

## 当前 Tunnel 应用配置

所有运行时文件位于 `apps/mcp-tunnel/`：`.env.local`、Tunnel Client 二进制、日志和 `dist-tunnel-client/`。创建该 app 的 `.env.local`：

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-...
# 可选；相对路径以 apps/mcp-tunnel 为基准
TUNNEL_CLIENT_PATH=./tunnel-client.exe
MCP_WORKSPACE_ROOT=.
# 可选；逗号分隔的动态目录/glob 授权规则，主 root 自动包含
MCP_WORKSPACE_ALLOWED=../shared/*,D:/Workspace/game-dev/*
# 未配置时只启用 core；配置时仅启用列出的工具
TOOLS_ENABLED=read,write,edit,bash,read_image,read_many,edit_many,notify
```

https://platform.openai.com/settings/organization/tunnels
这里创建tunnel -> CONTROL_PLANE_TUNNEL_ID

https://platform.openai.com/settings/organization/api-keys
这里创建 api-key -> CONTROL_PLANE_API_KEY

https://chatgpt.com/plugins
本地启动后在这里添加plugins

`TOOLS_ENABLED` 未配置时只启用 `read`、`write`、`edit`、`bash`。配置为空时不暴露 tool；配置非空时仅暴露列出的 tool。扩展代码通过动态 import 加载，`read_image` 及其 `sharp` 依赖仅在显式启用时加载。

`MCP_WORKSPACE_ROOT` 是单一主工作区，决定相对路径和 bash 的初始目录。`MCP_WORKSPACE_ALLOWED` 是逗号分隔的动态目录/glob 授权规则，例如 `D:/Workspace/ai-projects/*,C:/Users/Maple/.codex-cc`；规则在每次请求时重新匹配，新建目录无需重启 Tunnel。主工作区自动包含在授权范围内。

`read_image` 支持 PNG、JPEG、GIF、WebP；相对路径受 workspace 边界约束，绝对路径保留读取本机图片的兼容行为。大图会自动缩放/转 WebP。`edit_many` 按顺序执行，非原子操作。

## 启动与部署

```powershell
pnpm start:mcp-tunnel
pnpm start:mcp-tunnel:pm2
pnpm stop:mcp-tunnel:pm2
pnpm build:mcp-tunnel
```

第一条命令前台启动 Tunnel。第二条命令使用全局安装的 PM2 托管该 app；第三条命令停止并移除其 PM2 记录；请先执行 `npm install --global pm2`。PM2 不属于项目依赖，也不被打入独立包。在 Windows 上，PM2 托管的 Tunnel Client 会隐藏其常驻控制台窗口；前台启动仍保留可见输出。

PM2 启动脚本会自动安装并配置 `pm2-logrotate`：日志每天轮转，单文件超过 10 MB 时轮转，保留最近 7 个轮转文件并压缩旧文件。因此日志最多保留约一周；首次使用 PM2 启动需要能访问 npm registry。

独立包生成在 `apps/mcp-tunnel/dist-tunnel-client/`，其中不包含 `.env.local`、Tunnel Client 二进制或 `node_modules`。将凭据和二进制放入该目录后，运行 `node start-cli.js`；若要运行 `node start-pm2.js`，宿主机同样需要全局 PM2。

macOS launchd 是可选兼容层：

```bash
pnpm --filter @workspace/mcp-tunnel install:macos-launchd
```

它只在登录时调用 PM2 驱动脚本，实际常驻与重启由 PM2 管理。

## 开发与验证

```powershell
pnpm stub
pnpm check
pnpm build
pnpm test
```

请勿提交 app 内的 `.env.local`、Tunnel 凭据或二进制文件。
