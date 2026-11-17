# 工具与设计读取

## 工具与推荐流程

| 工具 | 功能 |
| --- | --- |
| `moonvy_parse_url` | 解析项目、目录、文件 ID，无需认证 |
| `moonvy_diagnose` | 运行版本、凭据配置状态、权限探测、调用编号和分阶段耗时 |
| `moonvy_list_pages` | 遍历项目/目录中的文件，限制结果数和 API 请求数 |
| `moonvy_get_metadata` | 不指定节点时列出画板；指定节点时返回轻量图层树 |
| `moonvy_search_nodes` | 按名称、文字、类型搜索，支持子树、直接父级筛选和分页 |
| `moonvy_get_design_context` | 返回样式树、Token、素材引用与实现指引 |
| `moonvy_get_node_style` | 返回单个节点的几何信息、详细样式和 CSS |
| `moonvy_get_node_styles` | 批量读取最多 100 个节点，逐项返回样式或错误 |
| `moonvy_get_variable_defs` | Token、共享样式、原生变量/集合/主题/别名/绑定，以及 CSS/JSON 导出 |
| `moonvy_get_screenshot` | 将已有节点快照或文件预览作为 MCP 图片内容返回 |
| `moonvy_download_assets` | 一次下载最多 20 个已有素材，逐项报告结果 |
| `moonvy_read_asset` | 按素材 ID 返回图片、SVG 文本或分段原始字节，兼容无法读取二进制资源的客户端 |
| `moonvy_cleanup_assets` | 清理过期素材、孤立文件和超配额的旧素材，返回剩余用量 |
| `moonvy_get_component_map` | 读取当前设计的本机组件映射 |
| `moonvy_set_component_map` | 保存或替换节点到已有组件的映射 |
| `moonvy_clear_cache` | 设计更新后清理设计数据缓存 |
| `moonvy_save_snapshot` | 持久保存当前设计版本，用于后续比较 |
| `moonvy_list_snapshots` | 列出当前设计仍保留的本机版本快照 |
| `moonvy_diff` | 对比快照与当前设计，分页返回变化及增量上下文 |

典型链接：`https://moonvy.com/project/<projectId>/<dirId>/<fileId>`。只有项目或目录链接时先调用 `moonvy_list_pages`，选择具体设计文件，再调用 `moonvy_get_metadata` 选择画板 ID。

设计上下文调用示例：

```json
{
  "url": "https://moonvy.com/project/PROJECT/DIRECTORY/FILE",
  "nodeId": "4:1224",
  "maxDepth": 4,
  "maxNodes": 500,
  "includeHidden": false,
  "cssUnit": "px",
  "format": "compact",
  "maxBytes": 262144
}
```

`moonvy_get_design_context`、`moonvy_get_metadata` 的子树模式及 `moonvy_get_variable_defs` 默认深度 4、节点数 500，上限分别为 50 和 10000。默认排除隐藏节点及其后代。节点 ID 优先精确匹配；分号分隔的实例 ID 仅在短 ID 唯一时兼容匹配，歧义时返回候选 ID。

同一深度内未读完时，将 `nextCursor` 原样传回同一查询，逐页读取；页面可能从子节点开始，使用 `parentId` 还原层级。达到深度或数量上限时还会返回 `truncated: true` 和 `continuationNodeIds`，可改用这些节点为根继续读取。继续读取列表最多 50 个 ID，`continuationCount` 表示本次发现的未返回入口数，不是所有后代总数。宽树可用 `moonvy_search_nodes` 的 `parentId` 分页列出直接子节点。

元数据、上下文、样式、Token 和搜索工具支持 `maxBytes`（默认 256 KiB，范围 4 KiB–1 MiB），按成功 MCP 工具结果的实际 UTF-8 JSON 大小限制，包含 `content` 与 `structuredContent`，不含 JSON-RPC 外壳。服务会缩小页大小；连一个结果都无法放入时返回 `RESPONSE_TOO_LARGE`。此限制不用于目录列表、图片和资源读取，后两者由各自二进制大小配置约束。

样式工具默认 `format: "full"`；`"compact"` 仅保留 CSS、单位和警告。`fields: ["css", "typography", "textRuns"]` 可按需选字段，`maxTextLength` 默认 2048，截断会明确标记。上下文还支持 `includeTokens: false` 和 `includeAssets: false`。先搜索、再批量取所需样式，通常能减少上下文占用。

设计响应携带 `revision` 或 `version.contentHash`，游标与内容版本和查询绑定。设计更新后传 `forceRefresh: true`，或调用 `moonvy_clear_cache`。旧版本游标返回 `STALE_CURSOR`，需从新版本首页开始。文档索引和 px/rpx 样式在缓存内复用；同文件并发读取合并请求，取消一个调用不会中断其他调用。

stdio 支持协议的单请求取消。无状态 HTTP 在连接关闭时取消该连接上的处理；独立 POST 之间的取消通知不关联请求，因为不同客户端可能使用相同的请求 ID。HTTP 客户端需要及时停止上游工作时应关闭对应连接，工具时限仍会生效。下载若有其他读者，则继续为其他读者提供结果。

Token 和素材引用只涵盖本次实际返回的节点，`coverage` 明确标识此范围。`spacing.source` 为 `inferred`，代表根据图层位置推断的间距。`sharedStyles` 列出范围内引用的共享填充、文字样式；原生变量位于变量工具的 `variables` 字段，保留源文件实际提供的结构。

可直接向 AI 提示：

> 读取这个 Moonvy 目录，找到登录页，获取目标画板的设计上下文和截图。展开被截断的节点，按当前项目组件和布局习惯实现页面，保留精确颜色、字号和圆角，需要时下载已有图标素材。

## 样式、截图与素材

- 源尺寸和几何数值保留为 px，CSS 默认 px。显式传入 `cssUnit: "rpx"` 时按所属画板宽度换算到 750rpx，例如 375px 画板的 `1px = 2rpx`。`style.units` 给出比例；不同请求互不影响。
- 行高区分 px、百分比和自动；`150%` 保持百分比，`auto` 生成 `normal`。渐变百分比也不参与长度缩放。
- CSS 中的绝对定位是设计参考几何，由 AI 按目标项目实现适当布局。渐变保留控制点，颜色和样式来自 Genome，不根据截图猜测。
- 富文本原始分段保存在 `richTextSegments`，`textRuns` 提供逐段样式、CSS、链接和装饰。汇总 CSS 使用首段；只有源数据提供有效范围时 `rangeKnown` 才为 true，不猜测分段与字符的对应关系。
- 字距区分 px、百分比、em/rem；例如 `10%` 转为 `0.1em`，不当作长度缩放。内阴影、多层颜色/渐变和简单实色多描边会组合为 CSS；无法准确表达的效果保留源数据并给出说明。
- 支持原生 `filterBlur` / `filterBackdropBlur` 和实色独立边框。未支持的渐变类型、渐变/图片描边及其他效果保留源参数并省略对应 CSS。非阴影效果不会计入阴影 Token。遮罩、混合模式、平滑圆角在 `compositing` 中注明实现边界。
- `geometry` 保留变换和旋转。有效的 `relativeTransform` 矩阵输出 CSS matrix；原生 `transform` 的 translate/rotate/scale/skew/origin 也会转换。旋转后的边界和视觉效果仍需对照设计验证。
- 截图只读取 Moonvy 已有快照。指定节点无快照时返回 `available: false` 和可用父级信息，不返回父级图片。调用方可显式改读父级，或省略 `nodeId` 获取文件预览；响应标注 `sourceNodeId` 和 `sourceType`。
- 不支持重新渲染任意节点或任意格式转换。`format` 是已有切图变体的键，如 `svg`、`base`、`max`；指定不存在的变体会失败。截图支持 PNG、JPEG、WebP 和 GIF，受内联图片大小限制。

批量下载示例：

```json
{
  "url": "https://moonvy.com/project/PROJECT/DIRECTORY/FILE",
  "assets": [
    { "nodeId": "4:1224", "type": "slice", "format": "svg" },
    { "nodeId": "4:1300", "type": "image" },
    { "type": "snapshot" }
  ]
}
```

`type` 为 `slice`、`snapshot`、`image`、`file`；省略时针对节点依次选择已有切图、快照或图片填充。`file` 或文件预览不指定 `nodeId`。上下文素材清单的 `images[]` 为每个可见图片填充提供 `referenceId`、原始 `fillIndex`、裁剪、平铺和变换。传 `{"nodeId":"节点 ID","type":"image","fillIndex":2}` 下载指定填充；索引计入隐藏和非图片填充，不会重新编号。省略索引时兼容选择首个可见图片。原始字节下载不会烘焙裁剪或转换格式。

素材按 SHA256 内容摘要保存到 `MOONVY_ASSET_DIR`，相同内容复用磁盘文件，不接受任意输出路径。结果提供保存路径、素材 `id` 及 `moonvy://assets/<id>` MCP `resource_link`。HTTP 的保存路径指向服务端机器。

资源默认使用文本模式：小型 UTF-8 SVG 返回原文，其他文件返回 JSON 素材信息和读取工具参数，避免客户端在 `resources/read` 的 `blob` 转换中报错。查看图片可调用 `moonvy_read_asset`，参数为 `{"assetId":"下载结果中的 id"}`；图片通过 MCP `image` 内容返回，SVG 使用文本。自动预览受 `MOONVY_MAX_IMAGE_BYTES` 限制，不转换格式。

需要精确原文件字节时调用 `moonvy_read_asset`，传 `format: "base64"`、`offset: 0` 和可选 `length`（默认且最多 65536 字节）。对每段 `data` 分别进行 Base64 解码，再按顺序拼接；以返回的 `nextOffset` 继续，直到为 null。偏移和长度单位都是原文件字节。此方式也支持大文件和无预览的格式，不接受任意服务端路径。

已确认支持二进制资源的客户端可显式配置 `MOONVY_RESOURCE_MODE=blob`，恢复旧版 `resources/read` 的原文件 Base64 `blob` 响应；默认 `text` 模式不会输出该字段。

资源索引保存在素材目录的 `.index/`，重启后 ID 仍有效；默认有效期 7 天，磁盘总配额 512 MiB，最多 2048 条资源记录。下载时和调用 `moonvy_cleanup_assets` 时清理过期项、无引用文件，并在超配额时淘汰最近最少使用的内容；读取会校验文件摘要。每次下载仍会请求上游，磁盘去重不等于网络缓存。上游签名 URL 返回 401/403 时最多刷新一次设计数据。清理设计缓存不删除素材或组件映射。

## 布局建议与组件复用

Moonvy 原生布局由 `nativeLayout` 提供，读取 `autoLayout` 的方向、Hug/Fixed、grow/Fill、换行、主轴与交叉轴 gap、padding、对齐及定位模式。自动适配旧版 Genome 的 padding 顺序。`sourceConstraints` 保留原始约束和 `autoLayout`。

默认 CSS 保留几何；`responsiveCss` 是使用原生布局的替代 CSS。显式传 `cssLayout: "auto"` 时将该结果作为 `css`，原始 CSS 移至 `geometryCss`，原始数值仍在 `layout`。流式子项移除绝对坐标，Hug 使用 fit-content，grow 子项使用 flexGrow/flexBasis；源文件的 absolute 子项继续绝对定位。未知方向（包括尚未适配的原生 Grid）保留参数和警告。父容器和流式子项应一致选用此模式。

完整样式的 `layoutHints` 提供额外建议；原生布局优先使用 `nativeLayout`。推断结果标记 `source: "inferred"`、中等置信度和依据，不自动应用。

推断使用与节点样式相同的父级相对坐标。`nodeOrder` 给出建议的视觉顺序；原图层顺序可能是绘制顺序，调用方应结合内容语义决定 DOM 顺序。

可将团队已有组件绑定到设计节点，存入配置的本机 JSON 文件；上下文随后会返回匹配的 `componentMappings`。映射只作为代码生成参考，路径不被执行。实例支持 `masterId` 和 `common` 中的源组件 ID，以及兼容的 mainComponentId/componentId/componentKey。`components` 返回主组件元信息、组件集、`varsProps` 变体及源数据实际提供的实例属性/覆盖。缺失主组件、覆盖列表不会被虚构为已解析。

```json
{
  "url": "https://moonvy.com/project/PROJECT/DIRECTORY/FILE",
  "mappings": [
    { "nodeId": "4:1300", "componentName": "Button", "importPath": "@/components/Button", "framework": "react" }
  ],
  "replace": false
}
```

将以上参数传给 `moonvy_set_component_map`。`replace: true` 替换当前设计的映射，空数组可清空；其他设计不受影响。单文件最多 1000 条映射、1 MiB。

## 原生变量与版本差异

`moonvy_get_variable_defs` 读取 `variables.all/collections`、各模式 valuesByMode、变量别名及节点 varBind；主题选择继承祖先的 `_resolvedVariableModes`，调用方可传 `modes: {"集合 ID":"模式 ID"}` 覆盖。默认只返回当前页面节点的变量和全部模式的别名依赖；`includeUnbound: true` 包含文件中未绑定的变量。循环、缺失变量和缺失模式有明确状态，回退到默认模式会标记 `fallback`。

传 `exportFormat: "css"` 或 `"json"` 获取可保存的 `export.text`。CSS 变量名使用 ID 摘要以避免同名冲突，集合中的 `modeSelectors` 指明对应的 `data-moonvy-mode` 选择值；别名保留 `var(...)`。数值变量默认无单位，长度用法从绑定路径和长度 Token 判断。源色值/别名保留在定义中，导出不依赖截图推断。

先调用 `moonvy_save_snapshot`（`url`、可选 `label`），保留返回的 `id`。编辑设计后调用 `moonvy_diff`：

```json
{
  "url": "https://moonvy.com/project/PROJECT/DIRECTORY/FILE",
  "snapshotId": "保存时返回的 UUID",
  "forceRefresh": true,
  "format": "compact",
  "limit": 100,
  "includeContext": true
}
```

变化包含 added/deleted、父级/顺序/几何移动、样式、文本、组件、素材及可见性，变量定义变化单独标记。可以用 `nodeId` 限定子树；分页的 `nextCursor` 同时绑定基线与当前版本。`context` 只附带当前变化节点，删除节点返回记录。快照是本机私有 gzip 数据，不编辑线上文件；按文件绑定、不接受任意路径。默认保存 30 天、20 份、128 MiB，超限淘汰最早快照。相同版本复用快照；缓存清理保留快照。

## 调用失败诊断

先调用 `moonvy_diagnose`（无需参数）核对正在运行的版本、凭据是否配置、传输和资源模式。传 `url` 会进行一次新的只读权限探测；目录可读不会被当作文件权限已通过。失败工具结果包含 `requestId`、`stage`、`retryable` 和 `suggestedAction`，可用 `moonvy_diagnose({"requestId":"调用编号"})` 查本进程记录。最多保留 100 次完成调用、每次 64 个阶段；重启会清空记录，不记录输入、凭据和签名 URL。

若出现 `ReadMcpResourceSuccess.blob ... invalid uint32: undefined`，确认运行服务为最新版本且 `MOONVY_RESOURCE_MODE=text`，重新连接客户端以刷新工具列表，再使用 `moonvy_read_asset`。此错误来自客户端的二进制资源转换；官方 SDK 的通过结果不代表该客户端已验证。`--version` 和诊断工具用于核对运行版本。
