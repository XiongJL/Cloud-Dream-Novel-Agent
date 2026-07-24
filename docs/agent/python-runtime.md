# Python Agent Runtime

## 当前代码

| 项 | 路径 |
| --- | --- |
| Python 工程 | `agent_runtime/` |
| 包名 | `novel_agent_runtime` |
| 入口 | `python -m novel_agent_runtime` |
| 依赖声明 | `agent_runtime/pyproject.toml` |
| Electron 客户端 | `apps/desktop/electron/agent/PythonRuntimeClient.ts` |

## 开发环境

当前已安装：

- 虚拟环境：`agent_runtime/.venv`
- Python：3.11.14
- 安装方式：`pip install -e "agent_runtime[dev]"`

不使用默认 Python 3.14 作为运行环境，原因是 Agent 依赖链包含 `sqlite-vec`、`orjson`、`cryptography`、`pywin32` 等原生扩展包，Python 3.11 在 Windows 上轮子更稳定。

## FastAPI Control API

当前 API：

```text
GET /health
POST /invoke
```

当前方法：

- `agent.roles`
- `agent.chat`
- `agent.plan`
- `agent.revise_plan`
- `agent.execute_plan`
- `agent.run_status`
- `agent.cancel`
- `agent.submit_approval`

SSE endpoint：

```text
GET /events/{runId}?afterSequence=0
```

当前 `/invoke` envelope：

```json
{
  "requestId": "uuid",
  "method": "agent.plan",
  "params": {},
  "context": {
    "novelId": "novel_id",
    "chapterId": "chapter_id",
    "locale": "zh-CN",
    "origin": "desktop-ui"
  }
}
```

## 当前实现边界

已实现：

- 通过 Electron AiService provider 生成真实对话回复和结构化 Supervisor Plan。
- 本地 `agent_state.db` 保存 plan、run、conversation 最小状态。
- 后台 run 执行，`agent.execute_plan` 立即返回 `runId`。
- `AgentEventBus` + SQLite event replay。
- `/events/{runId}` SSE 事件流。
- 轻量 `agent.run_status`。
- `agent.cancel` 主动取消当前 Run task，并通过 Automation requestId 中止上游 AI 请求。
- `agent.submit_approval` 恢复执行中用户决策断点。
- `agent.revise_plan` 结构化修订未执行计划，保留 `planId` / `threadId` 和可复用步骤 ID。
- `agent.execute_plan` 必须显式批准并校验 `approvedStepIds`，只执行批准步骤。
- `approval_required` 用于 `rag.ask` 前的分析范围确认，选择会映射为真实 RAG 参数。
- RAG 结果为低置信度、包含警告或空证据时，触发 `evidence_quality` 决策断点；可谨慎继续或只保留报告。
- 首次草稿工具前调用 `agent.detect_creative_direction`；只有存在互斥方向时触发确认，选择结果进入真实草稿参数。
- Runtime 启动时保留带有效 LangGraph checkpoint 的 `waiting_approval` run，用户提交后可跨进程恢复；无法安全重放的 `running` / `cancelling` run 仍标记为 `failed`。
- `AgentArtifact` 产物契约：成功 Run 必须包含报告 artifact，生成型 Run 必须额外包含计划声明的草稿 artifact；批准步骤漏掉生成工具或运行结束缺少产物时 fail closed。
- `artifact_created` 通过现有 SSE 发布；报告保存有界正文，草稿保存 DraftSession 引用。Electron Main 将其持久化到独立 `AgentArtifact` 表，Renderer Inspector 可恢复展示。
- Automation HTTP adapter。
- FastMCP tool adapter 默认承接白名单项目工具，Automation HTTP 作为其 Electron 上游；可通过 `--tool-transport http` 回退。
- 调用现有 `chapter.get`、`rag.ask`、`chapter.generate_draft`、`creative_assets.generate_draft`。
- Python Runtime 会校验模型计划中的 Agent 名称和工具白名单，拒绝 `chapter.save` 等未授权工具。
- `roles.py` 统一注册团队、作者、编辑、读者、世界观和研究角色，并通过 `agent.roles` 向 Renderer 提供本地化说明、工具范围、Skill 与预置任务；Planner 从同一注册表读取合法角色集合。
- 对话/规划阶段只发送用户消息、有限会话历史、角色和可用工具，不发送正文或直接读取小说库。

尚未完成：

- Plan review 卡本身迁移为 LangGraph interrupt；当前仍由产品层在启动 Run 前显式审批。
- `running` Run 的自动续跑。副作用工具已经有持久化调用键、requestId 和提交账本，但结果未知时按设计禁止自动重放；只恢复明确停在 interrupt 的 `waiting_approval`。
- 真实多分歧检测，目前 `approval_required` 是最小闭环示例。

## LangGraph 接入定位

LangGraph 后续不作为新的产品入口，也不等价于 Codex App 的“计划模式”。它用于替换当前手写运行时状态机：

| 当前 MVP | LangGraph 后续映射 |
| --- | --- |
| `agent.plan` AiService planner | Planner node / plan-and-execute graph |
| 计划草稿卡 `忽略 / 提交 / 实施此计划` | Plan review interrupt |
| `agent.execute_plan` 后台 run | Graph invocation + checkpoint |
| `approval_required` 用户决策断点 | Runtime interrupt |
| `agent.submit_approval` | `Command(resume=...)` 恢复图执行 |
| `agent_state.db` | LangGraph SQLite Checkpointer 或分层共存 |

迁移原则：

- UI 的工作模式和计划审核语义保持不变。
- LangGraph 只承接编排、暂停、恢复和 checkpoint。
- `AgentRunEvent` 继续作为 Renderer 的统一事件协议，LangGraph 节点事件需要映射到现有 SSE 事件。

## Phase 2 主动探索图

聊天阶段已接入第一条 LangGraph 主图：

```text
START -> agent -> tools -> agent -> ... -> END
```

- `agent` 节点通过 Electron AiService 选择只读工具或形成回答。
- `tools` 节点再次校验 `READ_ONLY_AGENT_TOOLS`，执行 Automation 调用并把观察结果回灌模型。
- 每轮最多选择 3 个工具。普通任务软限制 4 轮/8 次工具，长附件任务软限制 6 轮；有有效进展时最多扩展到 8 轮/12 次工具，并始终保留无工具最终总结轮。
- 聊天探索总预算 165 秒，其中最后 45 秒预留给强制总结；达到硬限制或时间预算后不再静默截断。
- Checkpoint 按 Runtime conversationId 写入 `agent_graph.db`，与现有 `agent_state.db` 业务状态分层保存。
- `chat_only` 不暴露工具；`review_required` 允许只读探索，但不暴露草稿、写回或数据修改工具。
- Renderer 在助手回复中显示本次 `contextReads` 标签，便于确认模型实际读取了哪些来源。

后台 `execute_plan` 已迁移到原子推进 Executor graph：每次只推进开始步骤、执行一个工具、完成步骤或生成最终报告。分析范围、证据质量和创作方向审批使用 LangGraph `interrupt` 暂停，`agent.submit_approval` 通过 `Command(resume=...)` 恢复，不再保留 `asyncio.sleep` 轮询任务。图 checkpoint 与聊天探索共同存放在独立 `agent_graph.db`，业务 Run、Plan 和事件继续由 `agent_state.db` 保存。

## 当前执行链路

```text
Renderer AgentWorkspace
  -> window.agent.plan / window.agent.executePlan / window.agent.submitApproval
  -> Electron IPC agent:invoke
  -> PythonRuntimeClient
  -> Python FastAPI /invoke
  -> Automation HTTP /invoke
  -> AutomationService
  -> AiService / DraftSessionStore
```

执行事件流：

```text
agent.execute_plan
  -> Python 创建 run
  -> Renderer subscribeRun
  -> Python /events/{runId}
  -> Main agent:run-event
  -> AgentWorkspace 更新计划、工具、草稿、用户确认卡
```

恢复边界：

```text
Renderer 刷新
  -> 从本地 AgentRunEvent 取最后 sequence
  -> subscribeRun(runId, afterSequence)
  -> replay 缺失事件并继续接收

Python Runtime 重启
  -> waiting_approval + 有效 checkpoint：保留等待状态
  -> 用户提交审批后 Command(resume) 从原工具位置继续
  -> running / cancelling：当前仍标记为 failed，避免重复副作用
```

## 后续演进

第二阶段：

- LangGraph 主动探索图与 Executor graph（已完成）。
- LangGraph SQLite Checkpointer 与审批跨进程恢复（已完成 waiting_approval）。
- 将模板化节点替换为 Supervisor / Writer / Editor / Reader 节点。
