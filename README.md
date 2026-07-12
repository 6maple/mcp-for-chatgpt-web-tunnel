# OpenAI Secure MCP Tunnel

一个基于 TypeScript 的 MCP 文件工具服务，通过 OpenAI Tunnel Client 将本地 stdio MCP 服务安全暴露给工作区。

## 功能

- `read`：读取工作区内的文本文件
- `write`：创建或覆盖工作区内的文本文件
- `edit`：精确替换文件内容
- `bash`：在工作区内执行 PowerShell 命令

文件工具会限制路径必须位于工作区目录内。

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
```

`TUNNEL_CLIENT_PATH` 和 `MCP_WORKSPACE_ROOT` 均可选；未配置时分别默认使用当前工作目录下的 `tunnel-client.exe` 和当前工作目录。相对路径以当前工作目录为基准解析。

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
