# Agent 运行时兼容逻辑清理

日期：2026-10-15。

本版本及后续版本统一支持多 Skill、文风包和可见范围，不再维护“新界面配旧后台”的功能降级路径。扫描覆盖 desktop 的 src、electron、shared 与 Python Runtime；实际清理集中于 Agent、Skill 和工具调用链，未修改生成代码、数据库迁移或真实用户内容。

## 已清理

| 位置 | 原逻辑及问题 | 处理 |
| --- | --- | --- |
| `AgentWorkspace.tsx` 多 Skill 发送 | 根据 `skillMultiSelect` 标记拦截；标记丢失会误报不支持 | 前一轮已删除，当前统一按服务可用状态发送 |
| `AgentWorkspace.tsx` 文风包目录 | 根据健康状态的 `capabilities`、preload 方法是否存在决定是否读取 Pack 和默认设置；可能静默返回空列表 | 直接并发读取三个当前接口；部分失败仍明确显示错误，并允许成功列表继续使用 |
| `AgentWorkspace.tsx` 方法管理与保存范围 | 根据 `skillVisibilityEnabled` 隐藏菜单、三个点和保存范围 | 入口直接展示，操作失败由现有错误界面呈现 |
| `SkillDraftReviewCard.tsx` | 每张草稿先请求 health，失败静默隐藏可见范围和 Pack 使用入口 | 删除探测和方法存在判断；小说列表读取失败显示错误 |
| `runtime.py` 默认文风包 | `skillPacksEnabled` 或 UI 曾经访问过默认接口才读取；同一小说可能因入口不同产生不同结果 | 有小说且未显式禁用/选择独立 Skill 时，直接读取本书默认；删除进程内 opt-in 集合 |
| `runtime.py` 默认文风包异常 | 吞掉 METHOD_NOT_FOUND / UNKNOWN_METHOD / NOT_IMPLEMENTED 后继续执行 | 原样进入任务失败链路，不静默换成其他写法 |
| `runtime.py` 与 `schemas.py` 可见范围 | 客户端或旧计划开关为真才核验，缺省可跳过 | 删除开关；启动使用已发布用户 Skill 的任务时一律核验并冻结范围快照；已启动任务的冻结版本机制保持 |
| `runtime.py` 三处调用包装 | 捕获带 unexpected keyword argument 的 TypeError，去掉 deadline / parent context 再调用 | 直接遵循当前协议，真实类型错误向上传递，不进行隐式第二次调用 |
| `tool_adapter.py` HTTP / FastMCP 两处桥接 | 同样通过 TypeError 猜测旧签名、删参数重调 | 删除旧签名回退，统一传递请求标识、父请求与 deadline；网络重试、取消、幂等仍由原机制管理 |
| `AgentWorkspace.tsx` 旧组件 | 三个 Legacy 卡片仅通过 `void` 引用防止 unused 报错，从未参与实际渲染 | 删除三个组件及专用辅助类型/函数，共 311 行；历史消息仍由现有卡片读取 |

测试替身已同步接受当前请求上下文，并为非 Skill 专项测试提供“未设置默认文风包”的元数据响应；不以生产代码的旧协议回退来满足过时测试签名。

## 保留的兼容与校验

| 项目 | 位置 | 保留原因 |
| --- | --- | --- |
| 已发布 Pack schema v1、旧成员 slot 和绑定迁移 | `AgentSkillStore.ts`、Pack UI | 已有真实产物使用原绑定与不可变内容哈希；删除会改变旧包行为或造成无法打开。需要另做有预览的迁移，不能当运行时功能开关删除 |
| 原始引文、来源画像与提炼版本选择 | `style_fidelity.py`、内置 Skill registry | 冻结方法版本决定对应执行语义，旧提炼结果不能自动声称获得新证据或新能力 |
| 旧输入省略 publicationScope 的序列化 | `toolchains/schemas.py` | 保持历史检查点指纹，避免恢复时被当成新请求重复调用模型 |
| 单项 Skill entryHint 与多项数组输入 | `agentSkillComposer.ts`、`intent/schemas.py` | 两者都仍是当前公开接口的有效输入，单项不是降级路径 |
| 旧检查点、未知结果核对与原请求复用 | `runtime.py`、`style_quality.py`、状态存储 | 保护已完成分析、草稿及已付费请求，防止恢复时丢失或重复执行 |
| 用户问答到图恢复的转换 | `runtime.py` 的 `compatibility_response` | 变量名带 compatibility，但仍被当前图恢复与决策记录实际消费，不是闲置旧组件 |
| 会话摘要旧记录与数据库加列迁移 | `AgentConversationStore.ts`、DatabaseMigrations 等 | 用于读取真实历史数据及升级数据库，不决定新后台是否“支持某功能” |
| 备份版本、字段与文件领域校验 | `BackupArchive.ts`、`BackupEngine.ts` | 防止把不认识的数据恢复进业务库；属于恢复格式完整性校验，不能按“以后都支持”移除 |
| 模型输出上限、上下文预算、Operation/Role、范围/CAS/内容哈希 | 模型服务、Skill resolver/store | 外部模型能力、任务适用性与并发一致性校验，不是桌面版本兼容。错误仍需显示，不能绕过 |
| 内置 Skill / 角色在服务读取失败时的本地可用性 | `runtime.py`、`AgentWorkspace.tsx` | 明确的故障容错；不是旧协议探测，本次不改变其产品行为 |

## 验证

- 验证无客户端开关、无先前目录请求时也应用本书默认 Pack。
- 验证默认接口缺失报错，不再静默跳过。
- 验证客户端传旧 `skillVisibilityEnabled=false` 也不能跳过启动前范围核验，拒绝与不完整核验均不创建 Run。
- 验证 HTTP、FastMCP、聊天调用和任务调用遇到内部 TypeError 时只调用一次，且保留完整请求上下文。
- Python 最终两组无交集回归均通过，共 268 项：章节/审核/草稿/取消/检查点等 138 项（79.49 秒），Skill、多选、范围核验、方法消费、工具桥接、网络重试与文风恢复等 130 项（40.00 秒）。现有 FastAPI TestClient 的 httpx 弃用提示保留，未为此更改依赖。
- Desktop 的 Skill 草稿审核、目录缓存、多选、Runtime Renderer、重试 Renderer、会话连续性与 Runtime Client 恢复测试均通过；新增草稿入口断言确认没有 health 结果时也展示保存范围和 Pack 操作。
- Renderer 与 Electron TypeScript 检查、变更文件的 `git diff --check` 通过。
- 不修改真实 Skill、文风包、草稿、默认设置，不调用付费模型，不新增依赖或数据库迁移。

生效说明：前端由开发模式更新；Python Runtime 不热加载源代码，需要重启一次执行服务才能使用新的默认包读取、范围核验及调用协议。重启只是加载代码，不再是任何功能兼容检查的前置条件。
