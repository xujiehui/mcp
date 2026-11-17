# 样式基线

- `upstream-panel.json`：从参考项目固定提交 `0021b2b1f0813c252708b041166f77dbff92d851` 的 `test/fixtures/css-panel-baselines.json` 转换；原作者记录于 2026-09-14，包含 4 个设计文件、10 个图层的真实面板 CSS。保留原始期望值，不用当前解析器结果生成期望。在线验证需要对应文件权限，公开 ID 不代表授权访问；仓库不宣称这些文件已通过本项目的在线验收。
- `synthetic.json` / `synthetic-genome.json`：人工构造，单独覆盖字距、富文本分段、内阴影、多重填充和多描边；明确不作为真实 Moonvy 验证证据。

在线比对：先 `npm run build`，在本机配置 `MOONVY_TOKEN` 后运行 `npm run verify:baseline -- baselines/upstream-panel.json`。可按 schema 另建团队自己的基线，只填写浏览器面板实际核对过的字段，并记录来源、观察时间。

离线比对：`npm run verify:baseline -- baselines/synthetic.json --genome baselines/synthetic-genome.json`。离线模式仅支持一个设计文件，不需要令牌。修改任一期望字段应导致非零退出；禁止通过自动抄写解析器输出更新期望。

每个 sample 可比较 `css`、`values`（相对于 style 的点分路径）和 `canvasPosition`。数值默认容差 0.01；CSS 字符串严格比较。`canvasPosition` 沿父级累加平移，排除画板在画布上的偏移，并使用该画板的 CSS 比例；旋转/缩放祖先不适用这个简化基线，需建立对应的变换字段检查。

线上脚本通过官方 MCP 客户端读取，不修改在线设计、不下载素材，只打印节点 ID、检查数及脱敏后的差异。缺凭据、访问失败和断言不一致都以非零状态退出，不能算验证成功。

脚本会汇总全部文件；一个文件或节点失败后继续检查其余项目。仅遇到 `AUTH_EXPIRED` / `AUTH_REQUIRED` 时停止后续请求，并标记跳过。输出的 `checks` 是已比较的字段数，`expectedChecks` 是基线总字段数，`skippedChecks` 是尚未比较的字段数；`failures` 只统计已比较字段中的差异，读取失败单列在 `readFailures`。`designs` / `samples` 的 `verified` 计数表示已完成比较（可能存在差异），`failed` 表示读取失败，`skipped` 表示未尝试。只有全部比较完成才会 `complete: true`，全部无差异才会 `passed: true`；零检查或部分覆盖不能通过。
