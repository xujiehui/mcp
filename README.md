# Moonvy MCP

让支持 [Model Context Protocol](https://modelcontextprotocol.io/) 的 AI 编程客户端读取 Moonvy（月维）设计稿，获取结构化图层、CSS、设计变量、已有截图和素材。使用 TypeScript 与官方 MCP SDK，支持 **stdio** 和**本机 Streamable HTTP**。

服务提供设计数据和实现指引，由调用方 AI 结合业务项目生成页面。支持 px/rpx、原生自动布局、组件语义、版本快照与差异读取。

## 安装

要求 Node.js **22.12 或更高版本**。

```bash
git clone https://github.com/xujiehui/mcp.git moonvy-mcp
cd moonvy-mcp
npm ci
cp .env.example .env
# 在 .env 中填写 MOONVY_TOKEN
npm run build
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。

在浏览器登录 Moonvy，打开有权访问的项目，在开发者工具 Console 执行：

```js
copy(window.app?.api?.$options?.token)
```

将结果写入本机 `.env` 的 `MOONVY_TOKEN`。令牌只保存在本机，不要发到聊天、Issue 或提交到 Git。环境变量优先于 `.env`；令牌过期后需重新获取。

## 连接客户端

### stdio

在支持以下配置格式的 MCP 客户端中添加，并将路径替换为项目的绝对路径：

```json
{
  "mcpServers": {
    "moonvy": {
      "command": "node",
      "args": ["/absolute/path/moonvy-mcp/dist/cli.js"],
      "env": {
        "DOTENV_CONFIG_PATH": "/absolute/path/moonvy-mcp/.env"
      }
    }
  }
}
```

在 `.env` 中为 `MOONVY_ASSET_DIR`、`MOONVY_COMPONENT_MAP` 和 `MOONVY_SNAPSHOT_DIR` 配置绝对路径，避免客户端工作目录变化影响本机数据位置。Windows 路径可使用 `C:/work/moonvy-mcp/dist/cli.js`。

也可在项目目录运行 `npm start`；默认等待 stdio 协议输入，普通日志写入 stderr。

### 本机 HTTP

```bash
npm start -- --transport http
```

在客户端选择 **Streamable HTTP**，地址为 `http://127.0.0.1:3333/mcp`：

```json
{
  "mcpServers": {
    "moonvy": { "url": "http://127.0.0.1:3333/mcp" }
  }
}
```

HTTP 固定监听本机，使用无状态 JSON 响应，验证 Host 与浏览器 Origin，不提供旧式 SSE 端点。stdio 和 HTTP 均使用服务进程配置的 Moonvy Token。

## 工具

| 工具 | 用途 |
| --- | --- |
| `moonvy_parse_url` | 解析项目、目录、文件 ID，无需登录 |
| `moonvy_list_pages` | 有界遍历目录与设计文件 |
| `moonvy_get_metadata` | 列出画板或读取轻量图层树 |
| `moonvy_search_nodes` | 按名称、文字、类型及父级搜索 |
| `moonvy_get_design_context` | 获取样式树、Token、素材和组件语义 |
| `moonvy_get_node_style` | 获取单节点样式与 CSS |
| `moonvy_get_node_styles` | 批量读取节点样式，逐项返回结果 |
| `moonvy_get_variable_defs` | 共享样式、变量、主题、别名和 CSS/JSON 导出 |
| `moonvy_get_screenshot` | 将已有快照或文件预览作为 MCP 图片返回 |
| `moonvy_download_assets` | 批量下载已有切图、快照与图片填充 |
| `moonvy_read_asset` | 按素材 ID 返回图片、SVG 或分段原始字节 |
| `moonvy_cleanup_assets` | 清理过期、孤立及超配额素材 |
| `moonvy_get_component_map` | 读取节点到代码组件的本机映射 |
| `moonvy_set_component_map` | 保存或替换本机组件映射 |
| `moonvy_save_snapshot` | 持久保存设计版本以便比较 |
| `moonvy_list_snapshots` | 列出当前设计的本机快照 |
| `moonvy_diff` | 分页读取版本变化与增量上下文 |
| `moonvy_diagnose` | 检查运行版本、凭据状态及失败阶段 |
| `moonvy_clear_cache` | 清理设计数据和派生缓存 |

## 读取设计

推荐顺序：**目录 → 文件 → 画板 → 设计上下文 → 截图与素材**。典型链接为 `https://moonvy.com/project/PROJECT/DIRECTORY/FILE`。目录链接先用 `moonvy_list_pages` 选文件，再用 `moonvy_get_metadata` 选画板。

调用 `moonvy_get_design_context`：

```json
{
  "url": "https://moonvy.com/project/PROJECT/DIRECTORY/FILE",
  "nodeId": "4:1224",
  "format": "compact",
  "cssUnit": "px",
  "maxDepth": 4,
  "maxNodes": 500,
  "maxBytes": 262144
}
```

可直接向 AI 提示：

> 读取这个 Moonvy 目录，找到登录页，获取目标画板的设计上下文与截图。继续展开被截断的节点，按当前项目组件和布局习惯实现页面，需要时下载已有图标素材。

- `nextCursor` 继续同一查询；`continuationNodeIds` 用于展开更深图层。设计更新后传 `forceRefresh: true`，旧版本游标会明确报错。
- CSS 默认 px。显式选择 rpx 时按所属画板宽度换算到 750rpx，保留源值和比例；百分比行高与渐变色标不缩放。
- `cssLayout: "auto"` 使用源文件提供的自动布局，保留 `geometryCss` 和原始几何；推断的布局建议有明确标记。
- 截图和素材只使用 Moonvy 已提供的内容。目标无快照时会报告不可用及可用父级，不替换成父级图片。
- 资源默认返回 SVG 文本或 JSON 素材信息；用 `moonvy_read_asset` 查看图片或读取字节，兼容无法处理二进制资源的客户端。

完整参数、分页与样式边界见 [使用说明](docs/usage.md)，环境变量见 [配置说明](docs/configuration.md)。

## 开发与验证

```bash
npm run check
npm test
npm run build
node dist/cli.js --version
node dist/cli.js --help
npm run verify:baseline -- baselines/synthetic.json --genome baselines/synthetic-genome.json
```

自动化测试使用合成数据、Mock API 和官方 MCP 客户端，不需要真实令牌。可在本机配置有效 Token 后运行 `npm run verify:live -- <Moonvy链接> --download`；客户端检查使用 `npm run verify:client -- --url <Moonvy链接> --cancel`。

[验证说明](docs/verification.md)介绍各命令、真实验收与独立样式基线；[贡献说明](CONTRIBUTING.md)介绍代码结构。

## 支持范围

Moonvy 使用非公开 API 和 Genome 格式，兼容逻辑集中在适配层。服务只读取当前账号有权访问的项目，不包含在线设计编辑、任意节点重新渲染、格式转换或服务端代码生成。未知样式、遮罩及无法准确转换的约束保留源参数并返回说明；复杂视觉效果仍应结合截图核对。

本项目为独立实现。解析器参考 [Cc-Zzh1/moonvy-ui-mcp](https://github.com/Cc-Zzh1/moonvy-ui-mcp) 的固定提交 `0021b2b1`，设计读取流程参考 [Figma MCP 文档](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)。许可为 [MIT](LICENSE)，来源及改动见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
