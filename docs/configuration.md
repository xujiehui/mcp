# 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MOONVY_TOKEN` | 空 | 本机 Moonvy 登录令牌；链接解析不需要 |
| `MOONVY_ASSET_DIR` | `.moonvy/assets` | 素材目录，相对进程工作目录解析 |
| `MOONVY_PORT` | `3333` | HTTP 监听端口 |
| `MOONVY_TIMEOUT_MS` | `30000` | 整次工具调用及单次上游请求（含重试、读取响应体）的时限 |
| `MOONVY_CACHE_TTL_MS` | `300000` | 设计缓存有效期 |
| `MOONVY_CACHE_MAX_ENTRIES` | `20` | 最大设计缓存项数 |
| `MOONVY_CACHE_MAX_BYTES` | `134217728` | 设计缓存估算内存上限，非进程实际堆内存硬上限 |
| `MOONVY_MAX_RETRIES` | `2` | 429、5xx、网络失败的最大额外重试数，范围 0–5 |
| `MOONVY_RETRY_BASE_MS` | `200` | 指数退避初始等待；429/5xx 优先遵守 Retry-After，受时限约束 |
| `MOONVY_MAX_GENOME_BYTES` | `52428800` | Genome 下载和解压后的字节上限 |
| `MOONVY_MAX_ASSET_BYTES` | `20971520` | 单个素材下载字节上限 |
| `MOONVY_MAX_IMAGE_BYTES` | `5242880` | 单张 MCP 内联截图字节上限 |
| `MOONVY_RESOURCE_MODE` | `text` | `text` 返回 SVG 文本/素材信息；`blob` 返回原文件二进制资源，需客户端支持 |
| `MOONVY_ASSET_TTL_MS` | `604800000` | 已下载资源的有效期 |
| `MOONVY_ASSET_MAX_BYTES` | `536870912` | 受管理素材文件的磁盘总配额，不含索引及无关文件 |
| `MOONVY_COMPONENT_MAP` | `.moonvy/components.json` | 本机组件映射文件 |
| `MOONVY_SNAPSHOT_DIR` | `.moonvy/snapshots` | 本机版本快照目录 |
| `MOONVY_SNAPSHOT_TTL_MS` | `2592000000` | 快照保留时间（30 天） |
| `MOONVY_SNAPSHOT_MAX_BYTES` | `134217728` | 快照压缩文件总配额 |
| `MOONVY_SNAPSHOT_MAX_ENTRIES` | `20` | 保留快照数上限 |

数据读取链路为 `Moonvy URL → anynode/get → files.genome.url → 下载并解压 → 样式与图层解析`。目录遍历使用 `anynode/list`。这些是 Moonvy Web 非公开接口，可能随版本变化；适配集中在 `src/client.ts` 和 Genome 解析模块。

只读取当前登录用户有权访问的项目，不支持在线设计编辑或服务端生成框架代码。令牌只发给固定 Moonvy API；下载端点不附带认证头；输出隐藏令牌和 URL 查询签名。上游资源必须使用 HTTPS；为避免认证转发及跳转问题，资源重定向会被拒绝。
