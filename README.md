# OpenAI Secure MCP Tunnel

一个基于 TypeScript 的 MCP 文件工具服务，通过 OpenAI Tunnel Client 将本地 stdio MCP 服务安全暴露给工作区。

## 功能

- `read`：读取工作区内的文本文件，支持通过起始行、行数和字符数限制返回内容
- `read_image`：读取 PNG/JPEG/GIF/WebP；相对路径仍限制在 workspace，绝对路径可直接读取本机图片；大图会自动缩放/转 WebP，并返回处理耗时
- `read_many`：一次读取多个文本文件，减少远程工具调用次数
- `write`：创建或覆盖工作区内的文本文件
- `edit`：精确替换文件内容
- `edit_many`：一次执行多个精确替换
- `notify`：任务完成后发送本地桌面通知，支持 macOS 和 Windows
- `bash`：在工作区内执行 PowerShell 命令或 Bash 命令，支持限制返回输出大小

除 `read_image` 的绝对路径模式外，文件工具仍限制路径必须位于工作区目录内。`read_image` 的相对路径继续执行 realpath + workspace 边界检查，因此不能通过 workspace 内的 symlink 逃逸；若显式传入绝对路径，则直接读取该本机文件。`write` / `edit` 不受此放开影响。`read` 和 `bash` 默认最多返回 50,000 个字符，也可以在单次调用中调整，上限为 1,000,000 个字符。

`read_image` 在图片任一边超过 2048 px，或原图超过 1 MiB 时自动优化：保持长宽比缩到 2048 px 内，并转换为 WebP（quality 85）。原始输入设 100 MiB 安全上限，优化后仍需小于 20 MiB 才会通过 MCP 传输。工具会在图片内容块后追加一段紧凑元数据，包含原始/发送尺寸、是否压缩，以及 resolve/read/inspect/transform/base64/total 各阶段本地耗时；这些指标不包含 Tunnel 网络传输和模型视觉推理。

`notify` 在 macOS 上使用系统 `osascript` 通知，在 Windows 上优先使用 Windows Toast，并以托盘气泡通知兜底。由于 MCP 不会收到网页版回复渲染完成事件，该功能通过服务器指令要求模型在任务完成后将 `notify` 作为最后一次工具调用，属于尽力保证。

## 技术栈

- Node.js 24+
- pnpm 11
- TypeScript
- pnpm workspace + Turborepo
- Vite Plus（Oxfmt、Oxlint、类型检查）

## 目录结构

```text
apps/mcp-server          MCP 服务入口
packages/pi-adapter      文件和命令工具适配层
packages/types           共享类型
scripts/tunnel-client       Tunnel Client 启动脚本和配置
```

## 快速开始

安装依赖：

```powershell
vp install
```

## 首次配置

1. 打开 [Tunnels 管理页面](https://platform.openai.com/settings/organization/tunnels)，创建 Tunnel，将生成的 Tunnel ID 填入 `CONTROL_PLANE_TUNNEL_ID`。
2. 打开 [API Keys 页面](https://platform.openai.com/settings/organization/api-keys)，创建 API Key，将生成的 Key 填入 `CONTROL_PLANE_API_KEY`。
3. 在项目根目录创建 `.env.local`：

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-...
TUNNEL_CLIENT_PATH=./tunnel-client.exe
MCP_WORKSPACE_ROOT=.
TOOLS_ENABLED=read,write,edit,bash,read_image,read_many,edit_many,notify
```

`TUNNEL_CLIENT_PATH`、`MCP_WORKSPACE_ROOT` 和 `TOOLS_ENABLED` 均可选；前两者未配置时分别默认使用当前工作目录下的 `tunnel-client.exe` 和当前工作目录。相对路径以当前工作目录为基准解析。`TOOLS_ENABLED` 是逗号分隔的工具白名单，例如 `read,write,edit,bash,read_image`；未配置时启用全部工具，配置为空值时不启用任何工具。可用名称为 `read`、`read_image`、`read_many`、`write`、`edit`、`edit_many`、`notify`、`bash`。如果包含未知名称，MCP Server 会在启动时直接报错，避免配置拼写错误被忽略。

## 下载 Tunnel Client

请从 OpenAI 控制台的 [Tunnels 管理页面](https://platform.openai.com/settings/organization/tunnels) 下载与你的系统匹配的 `tunnel-client`，并将 Windows 可执行文件放到：

```text
./tunnel-client.exe
```

也可以查看 [OpenAI tunnel-client 仓库](https://github.com/openai/tunnel-client) 获取文档和源码。下载后可先检查配置：

```powershell
.\tunnel-client.exe doctor `
  --config .\scripts\tunnel-client\tunnel-client.yaml `
  --explain
```

启用 Vite Plus 提交前检查：

```powershell
pnpm setup:hooks
```

启动 Tunnel：

```powershell
pnpm start-tunnel
```

### macOS launchd 常驻启动

仓库只保存 [launchd plist 模板](scripts/tunnel-client/com.openai.mcp-tunnel.plist.template)，不会提交包含本机路径的实际 plist。确认项目根目录的 `.env.local` 已配置后，在 macOS 上执行：

```bash
pnpm install-macos-launchd
```

该命令会根据当前 Node 路径、项目目录和用户目录生成实际配置到 `~/Library/LaunchAgents/com.openai.mcp-tunnel.plist`，并重新加载对应的 launchd 服务。`HTTP_PROXY`、`HTTPS_PROXY` 及其小写形式如果存在于当前环境或 `.env.local`，也会写入生成的本地配置；API Key 和 Tunnel 凭据仍由 `.env.local` 在启动时读取，不会写入模板。

停止并移除本机服务：

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.openai.mcp-tunnel.plist"
rm "$HOME/Library/LaunchAgents/com.openai.mcp-tunnel.plist"
```

构建独立 Tunnel Client 启动目录：

```powershell
pnpm build-tunnel
```

该命令生成 `dist-tunnel-client`，不复制 `tunnel-client.exe`，也不会自动复制 `.env.local`。首次使用时请自行将 `.env.local` 复制到该目录，并将 exe 放入该目录，或在其中配置 `TUNNEL_CLIENT_PATH`。重复构建时会保留已有的 `dist-tunnel-client/.env.local`。

从项目根目录快速启动打包版本。请先将 `.env.local` 和 `tunnel-client.exe` 放入 `dist-tunnel-client`，并在其中的 `.env.local` 配置：

```dotenv
MCP_WORKSPACE_ROOT=..
```

然后在终端中执行：

```text
cd dist-tunnel-client
node start-cli.js
```

上述命令适用于 Windows、macOS 和 Linux；退出 Tunnel Client 后可执行 `cd ..` 返回项目根目录。

Tunnel Client 的本地运维地址：

- 健康检查：<http://127.0.0.1:9810/healthz>
- 就绪检查：<http://127.0.0.1:9810/readyz>
- 指标：<http://127.0.0.1:9810/metrics>
- 管理界面：<http://127.0.0.1:9810/ui>

本地 Tunnel 启动后，打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，在其中添加对应的 Plugin。

## 开发命令

```powershell
pnpm format        # 格式化代码
pnpm lint          # 静态检查
pnpm quality       # 格式化、lint 和类型检查
pnpm check         # workspace 类型检查
pnpm build         # 构建全部 workspace
pnpm ci            # CI 全量检查
```

也可以单独启动 MCP 服务：

```powershell
pnpm start-mcp-server
```

请勿将 `.env.local`、API Key 或 Tunnel 凭据提交到 Git。
