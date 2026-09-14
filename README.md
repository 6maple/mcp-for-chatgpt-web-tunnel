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

所有运行时文件位于 `apps/mcp-tunnel/`：`.env.local`、Tunnel Client 二进制、日志和 `dist-tunnel-client/`。可先复制 `apps/mcp-tunnel/.env.example` 为 `.env.local`：

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-...
# 可选；相对路径以 apps/mcp-tunnel 为基准
TUNNEL_CLIENT_PATH=./tunnel-client.exe
MCP_WORKSPACE_ROOT=.
# 可选；逗号分隔的动态目录/glob 授权规则，主 root 自动包含
MCP_WORKSPACE_ALLOWED=../shared/*,D:/Workspace/game-dev/*
# 可选；把共享工作协议加入 MCP initialize instructions，支持 ~/...
MCP_INSTRUCTIONS_FILE=./instructions.md
# 可选；标准 external MCP 清单路径，修改后需重启 Tunnel
MCP_EXTERNAL_MCP_FILE=./external-mcp.json
# 未配置时启用 core，并自动加入 external MCP 发现的工具；配置时仅启用列出的工具
TOOLS_ENABLED=read,write,edit,bash,read_image,read_many,edit_many,notify
# 可选；启用 Brain，默认只暴露恢复和读取工具
BRAIN_ENABLED=true
# read / write；write 额外开放 cognition mutation tools
BRAIN_ACCESS=read
```

https://platform.openai.com/settings/organization/tunnels
这里创建tunnel -> CONTROL_PLANE_TUNNEL_ID

https://platform.openai.com/settings/organization/api-keys
这里创建 api-key -> CONTROL_PLANE_API_KEY

https://chatgpt.com/plugins
本地启动后在这里添加plugins

`TOOLS_ENABLED` 未配置时启用 `read`、`write`、`edit`、`bash`，并自动加入已配置 external MCP Server 发现的 Tool。配置为空时不暴露 Tool；配置非空时仅暴露列出的 built-in 或 external Tool。扩展代码通过动态 import 加载，`read_image` 及其 `sharp` 依赖仅在显式启用时加载。

### External MCP Gateway

Tunnel 可以通过 `MCP_EXTERNAL_MCP_FILE` 连接普通 MCP Server，并把下游 `tools/list` / `tools/call` 原样代理给上游客户端。清单使用通用的 `mcpServers` 结构，不包含项目或业务私有字段。第一版支持 stdio 和 Streamable HTTP：

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["./tools/server.mjs"],
      "cwd": ".",
      "env": { "EXAMPLE_MODE": "1" }
    },
    "remote-tools": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

启动时 Tunnel 会完成下游 MCP 初始化与 Tool discovery。显式配置的 Server 如果无法连接、清单非法、下游 Tool 重名，或 Tool 名与 Tunnel/Brain 已暴露的 Tool 冲突，Tunnel 会 fail closed，而不是静默缺失能力。调用结果和 Tool descriptor 保持标准 MCP 结构；上游取消会传递到下游，Tunnel 退出时也会关闭下游连接和 stdio 子进程。修改清单后需要重启 Tunnel 才会重新 discovery。

`MCP_INSTRUCTIONS_FILE` 可选，用于把一个本地文本/Markdown 工作协议追加到 MCP Server 的 initialize instructions；支持绝对路径、相对路径和 `~/...`。这只是通用的 instructions 注入机制，Tunnel 不解释文件内容。启用 `notify` 时，通知规则会继续追加在同一 instructions 中。

`BRAIN_ENABLED=true` 会把 Brain 绑定到单一主工作区 `MCP_WORKSPACE_ROOT`。Brain session 优先使用 Tunnel 请求 `_meta["openai/session"]` 的 SHA-256 摘要生成 `chatgpt-web-<hash>`；该字段缺失或为空时回退到 `chatgpt-web-mcp-tunnel`。原始 `openai/session` 不会写入 Brain 路径或诊断日志。`MCP_WORKSPACE_ALLOWED` 不会切换 Brain project。`BRAIN_ACCESS` 默认为 `read`，暴露 `brain_think` 和 Brain 读取工具；设为 `write` 后额外开放 cognition 写入、编辑、移动、删除和 feedback 工具。

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

首次使用先初始化 Brain。脚本会读取 `apps/mcp-tunnel/.env.local`。未配置本地路径时会将
`vendor/ai-toolkit` 更新到 `.gitmodules` 配置分支（当前为 `main`）的最新提交；配置
`BRAIN_SOURCE_ROOT` 时直接使用指定的 Brain package 目录，不更新 submodule：

```powershell
# 默认使用 submodule
pnpm init:brain

# 本地联调时先在 apps/mcp-tunnel/.env.local 中配置：
# BRAIN_SOURCE_ROOT=D:/Workspace/ai-projects/ai-toolkit/code/brain
pnpm init:brain
```

初始化会验证 Brain 入口、生成可运行的开发 stub 并安装两边依赖。当前处于快速迭代阶段，
每次使用默认 submodule 来源执行初始化时都会跟进配置分支的最新提交。

```powershell
pnpm stub
pnpm check
pnpm build
pnpm test
```

请勿提交 app 内的 `.env.local`、Tunnel 凭据或二进制文件。
