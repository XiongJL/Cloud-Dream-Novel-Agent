# CloudDream Novel Agent 化产品设计

本文档已拆分到 `docs/agent/` 目录，当前文件仅作为旧链接入口保留。

## 快速入口

- [Agent 设计文档总览](./agent/README.md)
- [产品方向](./agent/product-direction.md)
- [UI 与 Stitch 原型](./agent/ui-and-prototype.md)
- [总体架构](./agent/architecture.md)
- [路线图](./agent/roadmap.md)
- [设计决策记录](./agent/decisions.md)

## 核心结论

Agent 化后的 CloudDream Novel Agent 采用 `写作 / Agent` 双模式：

- 写作模式保留纯正的打字写小说场景。
- Agent 模式承载会话、创作专家团、执行计划和草稿审核。
- 编辑/读者/作者/世界观/考据 RAG 是 Agent 模式内的角色，不是一级模式。

后续产品设计请以 `docs/agent/` 下的模块化文档为准。
