# 贡献 Moonvy MCP

要求 Node.js 22.12 或更高版本。安装依赖后，提交前运行类型检查、测试和构建：

```bash
npm ci
npm run check
npm test
npm run build
```

## 代码结构

| 位置 | 职责 |
| --- | --- |
| `src/client.ts` | Moonvy 私有 API、压缩下载、缓存、重试与取消 |
| `src/genome.ts`、`src/vendor/genome.js` | 图层索引、精确样式、坐标、分页和 Token |
| `src/native-layout.ts`、`src/complex-style.ts` | 原生布局与复杂样式适配 |
| `src/variables.ts`、`src/components.ts` | 原生变量、主题、组件语义与本机映射 |
| `src/assets.ts`、`src/image-fills.ts`、`src/storage.ts` | 已有素材、图片填充与有界持久存储 |
| `src/snapshots.ts` | 设计快照与增量差异 |
| `src/server.ts`、`src/http.ts`、`src/cli.ts` | MCP 工具、资源与传输 |
| `tests/` | 合成输入、Mock API 与官方客户端回归 |
| `scripts/`、`baselines/` | 验收脚本、性能检查与公共样式基线 |

适配私有格式时保留源字段，无法准确转换的情况应给出说明。回归测试应验证使用者能观察到的行为；可复现的格式差异优先用不含真实项目内容的最小输入覆盖。

提交 Issue 时说明 Node.js、服务版本、传输方式、工具名及脱敏后的错误编号/失败阶段。请勿附带 Token、签名 URL、私人 Genome、截图或素材。真实项目调试数据放在本机 `.moonvy/`，仓库使用占位链接和合成测试数据。

修改参考解析器时保留 MIT 许可和 [来源说明](THIRD_PARTY_NOTICES.md)。提交到本项目的贡献按 MIT 许可提供。
