# OpenAI Secure MCP Tunnel

一个 Turborepo monorepo：`mcp-tunnel` 将本地 stdio MCP 服务通过 OpenAI Tunnel Client 暴露给工作区。核心工具与可选扩展均以 workspace package 提供，未来可新增独立的 `apps/mcp-*` 组合应用。

ChatGPT plugin 通过 MCP `tools/list` 获取返回契约：`read`、`write`、`edit`、`bash`、`read_many`、`edit_many`、`read_image` 和 `notify` 声明各自业务对象的 `outputSchema`，成功结果在 `structuredContent` 中提供匹配的字段。图片 schema 描述元数据，图片本身通过 `content` 传输。Brain cognition 工具和 `brain_step` 直接通过 `content` 返回文本；`brain_step` 的第一段内容返回任务 Markdown 或 State 正文，第二段返回本轮 `turnId`。失败使用 `isError: true` 和错误文本，无需伪造成功对象。

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

`TOOLS_ENABLED` 未配置时只启用 `read`、`write`、`edit`、`bash`。配置为空时不暴露 tool；配置非空时仅暴露列出的 tool。扩展代码通过动态 import 加载，`read_image` 及其 `sharp` 依赖仅在显式启用时加载。

`BRAIN_ENABLED=true` 会把 Brain cognition 绑定到单一主工作区 `MCP_WORKSPACE_ROOT`；`MCP_WORKSPACE_ALLOWED` 不会切换 Brain project。`BRAIN_ACCESS` 默认为 `read`，暴露读取工具和只返回固定提示词的 `brain_step`；设为 `write` 后额外开放 cognition 写入、编辑、移动、删除和 feedback 工具。

每条新用户消息先由 MCP 初始指引提供 Step 1，模型按提示调用 `brain_step` 的 `start`、`ready`、`review`。这三个动作分别返回固定的 Step 2、Step 3、Step 4 Markdown，无需消息、轮次 ID 或成果提交参数。Step 4 发现还可以改进时再次调用 `ready`，否则向用户汇报。

Brain Step 已不再建立单轮 State 文件或控制工作阶段。长期 Brain 记忆和 Git 历史维护仍属于独立的 Brain 功能；显式 MCP 的 `start` 保留原有的维护入口。详情见 [Brain Step](vendor/ai-toolkit/code/brain/step/README.md)。普通 cognition 工具使用配置的主工作区。

Step 需要提供固定提示词与三个动作的新版 Brain。本地源码开发更新使用 `pnpm init:brain` 选择并 stub Brain，再运行 `pnpm stub` 生成各 workspace 的源码入口，最后 `pnpm restart:mcp-tunnel:pm2` 重启已安装服务。`BRAIN_SOURCE_ROOT` 指向本地 checkout 时不更新 vendor submodule。服务更新后，在 ChatGPT 刷新连接的工具定义并开启新会话。

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

使用独立包且在 `TOOLS_ENABLED` 中启用了 `read_image` 时，在目标机器的 `dist-tunnel-client` 父目录安装 sharp。当前锁定版本为 0.35.3，可在该父目录运行 `npm install --save-exact --include=optional sharp@0.35.3`。安装后再启动独立包。sharp 随目标平台选择原生依赖。

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

初始化会验证 Brain 入口、生成可运行的开发 stub 并安装两边依赖。当前处于快速迭代阶段，每次使用默认 submodule 来源执行初始化时都会跟进配置分支的最新提交。默认的 `vendor/ai-toolkit` 必须包含新版 `brain/step` 入口；如子模块尚未包含该实现，先将 Brain 的改动提交并更新子模块引用，或通过 `BRAIN_SOURCE_ROOT` 指向已有新版实现的本地 Brain 源码。当前本地 `.brain-source` 链接只对该机器的开发运行生效，不会自动更新 Git 子模块。

```powershell
pnpm stub
pnpm check
pnpm build
pnpm test
```

请勿提交 app 内的 `.env.local`、Tunnel 凭据或二进制文件。
