# MCP 工具仓库

集中维护 MCP（Model Context Protocol）工具。每个工具放在 `servers/<工具名>/` 下，包含独立的源码、依赖、配置示例、文档和测试，可分别安装、运行与发布。

## 工具目录

| 工具 | 功能 | 连接方式 | 文档 |
| --- | --- | --- | --- |
| [Moonvy MCP](servers/moonvy/) | 读取月维设计稿、样式、变量、截图和素材，支持组件映射与版本差异 | stdio、Streamable HTTP | [安装与使用](servers/moonvy/README.md) |

## 目录结构

```text
.
├── README.md                 # 工具目录与仓库说明
├── CONTRIBUTING.md           # 添加工具和贡献约定
├── LICENSE
├── .github/workflows/        # 各工具的 CI
└── servers/
    └── moonvy/
        ├── README.md         # 安装、连接和使用
        ├── package.json
        ├── package-lock.json
        ├── .env.example
        ├── src/
        ├── tests/
        ├── scripts/
        ├── baselines/
        └── docs/
```

各工具独立管理依赖。请先进入目标工具目录，再按照其 README 安装；仓库根目录不需要执行 `npm install`。

## 使用 Moonvy MCP

要求 Node.js 22.12 或更高版本：

```bash
git clone https://github.com/xujiehui/mcp.git
cd mcp/servers/moonvy
npm ci
cp .env.example .env
# 在 .env 中配置 Moonvy Token
npm run build
npm start
```

客户端配置、HTTP 启动及完整工具说明见 [Moonvy MCP 文档](servers/moonvy/README.md)。

## 添加工具

在 `servers/` 下创建独立目录，提供运行说明、依赖配置和测试，并在上方工具目录中添加入口。具体约定见 [贡献说明](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)。第三方代码的来源与许可说明保留在对应工具目录中，例如 [Moonvy MCP 来源说明](servers/moonvy/THIRD_PARTY_NOTICES.md)。
