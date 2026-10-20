# CloudDream Novel Agent（云梦小说智能体）

面向长篇小说创作的桌面写作工具。将正文、大纲、情节、人物与世界观放在同一部作品中，让 AI 结合故事资料协助创作，并由作者审阅和确认修改。

[下载安装](https://github.com/XiongJL/Cloud-Dream-Novel-Agent/releases/latest) · [使用指南](USER_GUIDE.md) · [English Guide](USER_GUIDE_EN.md) · [开发指南](DEVELOPMENT.md)

## 产品演示

以《七夜》为例，约 82 秒了解写作、人物资料、叙事矩阵、Agent 协作，以及从一句话续写到原文审阅和作者确认的创作流程。

https://github.com/user-attachments/assets/32416dc3-ba8c-4fb8-9a71-1e5b34eb52d2

## 核心能力

- **专注写作**：富文本编辑、心流模式、卷章管理，以及小说导入与自动保存。
- **管理故事资料**：整理角色、关系、物品、世界观、地图和灵感，随时搜索与查阅。
- **梳理情节**：用故事线、情节点、章节锚点与叙事矩阵查看故事的发展和关联。
- **一句话交给 Agent**：描述续写、改写或审校任务，指定章节范围，结合大纲、情节与相关资料开展创作；支持作者、编辑、读者等工作视角。
- **文风与 Skill**：使用文风参考、内置 Skill 和文风包，辅助保持人物行为、叙事与表达风格的一致性。
- **审阅后再写回**：Agent 生成的正文修改先形成草稿，支持原文对照、差异查看与审核意见，再由作者确认写回。
- **导出与备份**：支持 TXT、DOCX 导出，可选择整本、章节范围或分批导出；支持加密备份与跨设备恢复。

## 下载与快速上手

从 [GitHub Releases](https://github.com/XiongJL/Cloud-Dream-Novel-Agent/releases/latest) 下载适合你设备的版本。具体功能、升级说明与已知问题以对应版本的发布说明为准。

| 平台 | 选择的安装包 |
| --- | --- |
| Windows x64 | 安装版 `setup-<version>.exe` 或便携版 `portable-<version>.exe` |
| macOS Intel | `mac-x64-<version>.dmg` |
| macOS Apple Silicon | `mac-arm64-<version>.dmg` |

以上为文件名后缀，完整名称以下载页为准。官方桌面包已内置所需的 Python 运行时，无需另行安装 Python。macOS 安装包目前未签名，首次启动可能需要在系统安全设置中允许。

1. 打开应用，新建作品或导入已有小说。
2. 整理章节、大纲、人物与故事设定，开始写作。
3. 如需使用 AI，在设置中配置兼容的模型服务，或连接 Codex、Claude Code 等本地 CLI。
4. 在 Agent 中描述任务，查看生成的草稿与建议，再确认需要写回的修改。

具体操作见[用户指南](USER_GUIDE.md)。

## AI 接入与数据说明

- 支持 OpenAI-compatible 模型服务的 Chat Completions 与 Responses API，也可通过 MCP CLI Provider 使用本地 CLI。
- 支持外部 MCP 客户端连接桌面应用；配置步骤见 [MCP 接入说明](docs/mcp-cli-setup.md)。
- 作品正文、设定与创作记录默认保存在本机。使用云端模型时，相关提示词、正文片段与资料会发送给你配置的模型服务。
- AI 密钥保存在当前设备，不随小说备份迁移。更换设备或恢复备份后，需要重新配置 AI 服务。

## 产品截图

<img width="1200" alt="云梦小说智能体界面示例一" src="https://github.com/user-attachments/assets/59b84682-74d5-4c29-b277-a04d07ad9a56" />

<img width="1200" alt="云梦小说智能体界面示例二" src="https://github.com/user-attachments/assets/4d01fd52-a3c0-4c73-b994-d546873c98c3" />

## 文档与反馈

- [用户指南](USER_GUIDE.md) · [User Guide](USER_GUIDE_EN.md)
- [MCP 接入说明](docs/mcp-cli-setup.md) · [MCP Setup (English)](docs/mcp-cli-setup-en.md)
- [开发指南](DEVELOPMENT.md)：环境搭建、架构、测试与打包发布。
- [问题与建议](https://github.com/XiongJL/Cloud-Dream-Novel-Agent/issues)：反馈时请附上应用版本、操作系统和复现步骤。

## License

本项目基于 [GNU AGPL v3](LICENSE) 发布。
