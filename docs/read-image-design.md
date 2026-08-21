# `read_image` 最小实现设计

## 背景

当前 MCP Server 只提供文本型 `read`、`read_many`、`write`、`edit`、`edit_many`、`bash` 和 `notify`。`read` 使用 UTF-8 解码文件，`server.ts` 又会把普通工具结果统一包装为 `type: "text"`，因此本地图片无法以真正的 MCP 图片内容返回给 ChatGPT。

本次只做一个最小探针：新增 `read_image`，验证“本地 workspace 图片 → MCP `ImageContent` → tunnel-client → ChatGPT Web”这条链路是否成立。

## 目标

`read_image` 接收 workspace 内的单个图片路径，读取原始二进制，识别真实图片格式，然后直接返回 MCP 图片内容块：

```json
{
  "content": [
    {
      "type": "image",
      "data": "<base64>",
      "mimeType": "image/png"
    }
  ]
}
```

其中 Base64 只是 MCP/JSON-RPC 的传输编码，不能经过现有 `compactResult()` 变成普通文本。

## 非目标

第一版不做以下能力：

- 不调用 VLM，不新增 `vision_describe`。
- 不做 OCR、ground、detect、crop、pixel diff。
- 不处理 ChatGPT 会话附件向本地的反向传输。
- 不做图片压缩、缩放或格式转换。
- 不修改现有文本工具的输入输出契约。
- 不依赖文件扩展名来判断图片格式。

## 工具契约

### 输入

```json
{
  "path": "relative/path/to/image.png"
}
```

`path` 与现有 `read` 使用相同的 workspace 路径边界：

- 不能为空。
- 解析后的路径必须位于 `MCP_WORKSPACE_ROOT` 内。
- 已存在路径会解析真实路径，拒绝通过 symlink 逃逸 workspace。

### 输出

成功时只返回一个 MCP `ImageContent`：

```ts
{
  content: [
    {
      type: 'image',
      data: string,
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
    },
  ]
}
```

失败时沿用当前 MCP Server 的错误形式：

```ts
{
  isError: true,
  content: [{ type: 'text', text: '<error message>' }]
}
```

## 图片格式识别

不能相信扩展名。第一版按文件头魔数识别以下格式：

| 格式 | MIME         | 魔数                      |
| ---- | ------------ | ------------------------- |
| PNG  | `image/png`  | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `image/jpeg` | `FF D8 FF`                |
| GIF  | `image/gif`  | `GIF87a` / `GIF89a`       |
| WebP | `image/webp` | `RIFF....WEBP`            |

无法识别时直接报错，不把任意二进制伪装成图片发送。

## 大小限制

这个工具的目的只是验证链路，不应允许无界 Base64 返回。第一版设置固定上限：**20 MiB 原始图片**。

原因：

- Base64 会带来约 33% 的传输膨胀。
- 超大图片不适合作为最小 probe。
- 后续正式视觉层会增加 downscale / max-pixels，而不是继续提高这个硬上限。

超过限制时返回明确错误，提示后续使用压缩/缩放能力。

## 代码结构

本次只改三层：

```text
packages/types/src/index.ts
  └─ ReadImageInput / ReadImageResult

packages/pi-adapter/src/index.ts
  └─ readImage(): path sandbox + binary read + magic-byte MIME detection

apps/mcp-server/src/server.ts
  └─ registerTool('read_image') + 专用 ImageContent result
```

不新建通用 vision runtime，避免在 probe 阶段提前抽象。

## 为什么不能复用 `compactResult()`

当前 `compactResult()` 会把返回值 `JSON.stringify` 后放进：

```json
{
  "type": "text",
  "text": "..."
}
```

如果图片 Base64 经过这条路径，模型会收到一大段普通文本，既失去图片语义，又会造成严重的文本上下文浪费。

因此 `read_image` 必须直接构造 MCP `ImageContent`，绕过 `compactResult()`。

## 测试与验收

### 单元/集成验收

1. `listTools()` 中出现 `read_image`。
2. PNG fixture 返回 `content[0].type === "image"`。
3. MIME 由魔数确定，而不是由扩展名确定。
4. 返回的 Base64 解码后与原始 bytes 完全一致。
5. 非图片文件返回 `isError: true`。
6. workspace 外路径和 symlink 逃逸仍被拒绝。
7. 超过 20 MiB 的图片被拒绝。
8. 现有工具测试全部继续通过。
9. `pnpm check` / `pnpm test` 通过。

### Tunnel 端到端验收

代码和本地 MCP 集成测试通过后，重启实际 tunnel MCP server，使 `read_image` 出现在 ChatGPT 工具表中。然后让 ChatGPT 调用一个 workspace 内的 PNG：

```text
read_image({ path: "..." })
```

若 ChatGPT 模型能够直接理解该图像内容，则证明：

```text
local bytes
→ base64 MCP ImageContent
→ tunnel-client
→ ChatGPT host
→ multimodal model image input
```

整条链路成立。

## 后续演进

Probe 成功后再进入视觉运行时阶段：

1. 增加图片元数据与自动 downscale。
2. 抽象 `VisionProvider`。
3. 实现 `vision_describe`，让纯文本 Agent 也能通过 Tunnel 间接识图。
4. 再迁移 cache、deadline、fallback、circuit breaker。
5. 最后补 ground / detect / crop / pixel diff / OCR。

## 第二阶段优化（2026-08-19）

最小 probe 已验证 MCP `ImageContent` 链路可用。当前实现进一步加入三项优化：

1. **绝对路径直接读取**：相对路径仍按 workspace 沙箱处理并拒绝 symlink 逃逸；显式绝对路径由 `realpath()` 解析后直接读取，不再需要先通过 `bash` 复制进 workspace。该放开只作用于 `read_image`，`read` / `write` / `edit` 的既有边界不变。
2. **大图自动优化**：图片任一边超过 2048 px，或原始文件超过 1 MiB 时，通过 `sharp` 自动旋转、等比缩放到 2048 px 内，并转为 WebP（quality 85 / effort 2）。若仅由文件大小触发且 WebP 反而更大，则保留原图。输入安全上限提高到 100 MiB，最终 MCP 传输仍限制为 20 MiB。
3. **性能埋点**：记录 `resolveMs`、`readMs`、`inspectMs`、`transformMs`、`base64Ms`、`totalMs`，并连同原始/输出字节数、宽高、是否压缩一起作为第二个 MCP text content block 返回。这些耗时只覆盖本地 MCP 处理，不包含 Tunnel 网络传输和模型视觉推理；因此可用“用户体感总耗时 - `totalMs`”粗略定位链路外耗时。

典型调用现在可直接使用跨项目绝对路径：

```text
read_image({ path: "/Users/.../other-project/design.png" })
```

返回内容为“图片块 + 元数据块”，无需额外 `bash -> cp -> read_image` 往返。
