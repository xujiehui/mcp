# 验证 Moonvy MCP

## 自动化验证

进入仓库的 `servers/moonvy/` 目录后运行：

```bash
npm ci
npm run check
npm test
npm run build
node dist/cli.js --help
node dist/cli.js --version
npm run verify:baseline -- baselines/synthetic.json --genome baselines/synthetic-genome.json
npm pack --dry-run --ignore-scripts
```

测试覆盖 URL、JSON/gzip/deflate、体积上限、权限/凭据失效/超时、缓存与刷新、节点匹配、坐标和样式、px/rpx、隐藏子树、截断和分页、变量/模式/别名、组件映射、持久快照/版本差异、素材生命周期及多图片填充。官方 MCP SDK 客户端验证 stdio 和本机 HTTP 的工具发现、业务结果、图片、文本资源和字节读取，也验证取消和并发读取隔离。

这些测试不使用真实项目。合成样式回归不能证明所有 Moonvy 私有格式、字体渲染或复杂视觉效果都已兼容。GitHub Actions 在 Node.js 22 和 24 上执行相同检查，不需要仓库密钥。

## 真实项目验收

在本机 `.env` 配置 `MOONVY_TOKEN`，可设置 `MOONVY_VERIFY_URL` 作为默认链接。仅使用当前账号有权访问的项目。

```bash
npm run build
npm run verify:live -- 'https://moonvy.com/project/PROJECT/DIRECTORY/FILE'
# 同时保存并读取一个已有素材
npm run verify:live -- 'https://moonvy.com/project/PROJECT/DIRECTORY/FILE' --download
```

目录链接会先选择可读文件，再检查画板、上下文、样式、变量、截图。缺少源截图或素材会明确报告，不能算对应内容已经验证。

客户端协议检查：

```bash
# 默认 stdio
npm run verify:client -- --url 'https://moonvy.com/project/PROJECT/DIRECTORY/FILE' --cancel
# 在另一个终端运行 npm start -- --transport http 后
npm run verify:client -- --transport http --endpoint http://127.0.0.1:3333/mcp --url 'https://moonvy.com/project/PROJECT/DIRECTORY/FILE' --cancel
```

报告包含运行版本、工具数、上下文字节数、图片和资源结果、精确字节分段与校验摘要。取消探测观测客户端取消；服务端停止和读者隔离通过 Mock 测试检查。官方 SDK 通过不等于每个应用客户端界面都已验证。

## 独立样式基线

先从 Moonvy 浏览器面板独立记录预期，再运行解析器比较。不得用解析器当前输出来自动生成预期值。基线格式、公共来源和统计字段见 [基线说明](../baselines/README.md)。私人 Genome、截图和基线保存在被忽略的 `.moonvy/` 中，不提交到仓库。

```bash
# 人工合成输入，无需令牌
npm run verify:baseline -- baselines/synthetic.json --genome baselines/synthetic-genome.json
# 公共参考仓库的面板预期，需要相应设计文件权限
npm run verify:baseline -- baselines/upstream-panel.json
# 自己从实际面板记录的独立预期
npm run verify:baseline -- .moonvy/baselines/panel.json --genome .moonvy/baselines/genome.json
```

验证不修改线上设计或预期文件。差异、读取失败和缺少令牌均以非零状态退出；只有全部字段完成比较且无差异才算通过。坐标比较必须区分父级相对坐标与画板坐标；简化的画板位置累加不适用于有旋转/缩放的祖先。

## 性能与发布包

`npm run benchmark` 使用 2 万节点合成文档，比较索引与线性扫描、样式首次解析与缓存读取，以及上下文 JSON 体积。它衡量本机 CPU，不代表真实 Moonvy 网络性能。

`npm pack --dry-run --ignore-scripts` 可检查发布文件；应包含构建产物、文档、公共基线、验收脚本和许可，不包含 `.env`、本机素材/快照或测试凭据。`npm pack` 会通过 prepack 自动构建。本仓库提供源码安装流程，运行打包命令不会发布到 npm。
