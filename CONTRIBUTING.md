# 贡献 MCP 工具

## 工具目录

每个 MCP 服务放在 `servers/<工具名>/` 下，使用简短、稳定的小写目录名，例如 `servers/moonvy/`。源码、测试、文档、依赖锁文件和配置示例随工具一起维护；源码结构按所用语言的习惯组织。

各工具应能独立安装、构建和运行，依赖在各自目录管理。新工具不需要沿用 Moonvy 的技术栈。

## 添加工具

1. 在 `servers/` 下创建工具目录，提供 README、依赖及锁文件、源码、配置示例和测试。
2. README 说明运行环境、安装步骤、stdio/HTTP 等连接方式、工具接口与限制；所有命令注明执行目录。
3. 保留工具及第三方代码的许可。单独打包时应包含所需的 LICENSE 和来源说明。
4. 在仓库首页的工具目录表中添加链接。
5. 在 `.github/workflows/` 中添加对应工具的 CI，限定工作目录、依赖缓存路径及触发文件范围，参考 [Moonvy CI](.github/workflows/moonvy.yml)。

本机凭据和运行数据不提交到仓库。配置示例只使用空值或占位符；日志、问题报告和测试输入应脱敏。

## 修改已有工具

进入目标工具目录，按照该工具的贡献说明执行检查。Moonvy MCP 的说明见 [servers/moonvy/CONTRIBUTING.md](servers/moonvy/CONTRIBUTING.md)：

```bash
cd servers/moonvy
npm ci
npm run check
npm test
npm run build
```

目录或接口变化需同步更新安装路径、客户端配置、文档链接和 CI。提交到本仓库的贡献按 MIT 许可提供。
