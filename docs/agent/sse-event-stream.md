# SSE 事件流设计 v1

## 目标

`agent.execute_plan` 已从同步执行改为后台 run + SSE 事件流，让 Agent 模式具备 Codex-like 的实时执行反馈。

核心原则：

- SSE 流的是 Agent 执行事件，不是正文直接写回。
- 正文、章节和设定生成结果仍必须进入 DraftSession。
- Renderer 不直接连接 Python Runtime；SSE 由 Electron Main 代理。
- `run_status` 保留为断线恢复、页面刷新和调试兜底。
- Renderer 刷新后可用本地会话表中的 `runId` 与最后 `sequence` 续订 SSE。
- Python Runtime 重启后可保留 LangGraph `waiting_approval` checkpoint 并在用户提交后恢复；`running` / `cancelling` 仍标记为 `run_failed`，避免重放未确认是否完成的副作用工具。

## 总体链路

```text
Renderer AgentWorkspace
  -> window.agent.executePlan(payload)
  <- { runId, status: "running" }

Renderer
  -> window.agent.subscribeRun(runId)

Electron Main
  -> PythonRuntimeClient.subscribeRunEvents(runId)
  -> GET Python /events/{runId}
  -> win.webContents.send("agent:run-event", event)

Python Runtime
  -> agent.execute_plan 创建后台 run
  -> AgentEventBus append event
  -> SQLite 持久化 event
  -> SSE 推送 event
```

## Python API

```text
POST /invoke
  method: agent.execute_plan
  return: AgentRun

GET /events/{runId}
  Authorization: Bearer <token>
  query:
    afterSequence?: number
    afterEventId?: string
  response:
    text/event-stream
```

`agent.execute_plan` 新行为：

1. 校验 `planId`、`threadId` 与用户 approval。
2. 创建 run，状态为 `running`。
3. 写入 `run_started` 与 `plan_approved` 事件。
4. 启动后台任务执行 plan。
5. 立即返回 `AgentRun`，不等待所有步骤完成。

第一版不新增独立 `approve_plan(runId)`。当前产品流是：

```text
agent.plan -> UI 展示计划 -> 用户确认 -> agent.execute_plan
```

`approval_required` 用于执行中用户决策断点：当 Agent 遇到范围不清、证据冲突或创作方向分歧时，run 暂停为 `waiting_approval`，等待用户提交答案后继续执行。

## 事件模型

```ts
type AgentRunEvent = {
  eventId: string
  sequence: number
  runId: string
  planId?: string
  threadId?: string
  stepId?: string
  type:
    | 'run_started'
    | 'plan_pending'
    | 'plan_approved'
    | 'plan_rejected'
    | 'message'
    | 'step_started'
    | 'step_completed'
    | 'step_failed'
    | 'tool_call'
    | 'tool_result'
    | 'draft_created'
    | 'artifact_created'
    | 'approval_required'
    | 'error'
    | 'run_completed'
    | 'run_failed'
    | 'run_cancelled'
  agent?: AgentName
  toolName?: string
  status?: string
  payload: Record<string, unknown>
  createdAt: string
}
```

`approval_required` payload 第一版结构：

```ts
type AgentApprovalRequiredPayload = {
  checkpointId: string
  checkpointType?: string
  title: string
  question: string
  reason?: string
  options: Array<{ id: string; label: string; description?: string }>
  allowFreeText: boolean
  stepId?: string
}
```

`artifact_created` payload 使用完整但有界的结构化产物记录：

```ts
type AgentArtifactCreatedPayload = {
  artifact: {
    artifactId: string
    runId: string
    planId: string
    type: 'report' | 'chapter_draft' | 'creative_assets_draft'
    title: string
    status: 'ready' | 'committed' | 'discarded' | 'failed'
    summary?: string
    content?: string
    reference: { draftSessionId?: string }
    metadata: Record<string, unknown>
    createdAt: string
  }
}
```

报告产物可以携带有界正文；草稿产物只携带 DraftSession 引用。Electron Main 将事件投影到独立 `AgentArtifact` 表，SSE 重放只负责增量同步，不是产物的唯一持久化来源。

当前 checkpoint type：

- `analysis_scope`：RAG 调用前选择分析范围，可附加自由文本要求。
- `evidence_quality`：RAG 低置信度、警告或空证据时决定是否继续生成草稿，不允许自由文本绕过选项。
- `creative_direction`：草稿生成前存在互斥创作方向时由用户选择；选项结果必须进入后续草稿生成参数。

提交答案：

```ts
window.agent.submitApproval({
  runId,
  checkpointId,
  selectedOptionIds,
  freeText,
})
```

状态流：

```text
running -> waiting_approval -> running -> completed
```

`sequence` 是递增整数，用于排序和去重。

`message` 不等于默认展示到会话。Renderer 仅将以下事件投影成助手气泡：

- `payload.kind === 'final_report'`
- `payload.visibility === 'conversation'`

未声明可见性的步骤说明以及 `approval_submitted` 仍属于 Run 审计事件，只显示在折叠活动流中。步骤标题使用 `step_started.payload.title`，工具过程使用 `tool_call` / `tool_result`，禁止为了展示进度额外发送普通 `message`。

终止顺序必须是：先持久化 `run_completed` / `run_failed` / `run_cancelled`，再把 Run 状态保存为最终状态。这样 `run_status` 一旦返回终态，`lastSequence` 必然已经覆盖对应终止事件。

```text
if event.sequence <= lastReceivedSequence:
  ignore
else:
  append
```

## SQLite 事件持久化

```sql
CREATE TABLE IF NOT EXISTS run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence
  ON run_events(run_id, sequence);
```

说明：

- `sequence` 全局递增。
- 前端按 run 维度使用 `sequence` 去重。
- `event_payload` 保存完整 JSON。

## AgentEventBus

职责：

- `append(event)`：写入 SQLite、分配 `sequence`、通知订阅者。
- `subscribe(runId, afterSequence?)`：先 replay 历史事件，再持续 yield 新事件。
- `close(runId)`：run 结束后清理订阅列表。

并发要求：

- 订阅列表用 `asyncio.Lock` 保护。
- 每个 run 支持多个订阅者。
- 每个订阅者使用独立 `asyncio.Queue`。
- SQLite 写入使用短事务。

## 轻量 run_status

`run_status` 不返回完整事件列表，只返回轻量状态：

```json
{
  "runId": "run_123",
  "planId": "plan_123",
  "threadId": "thread_123",
  "status": "running",
  "currentStepId": "step_3",
  "currentStepTitle": "生成修改草稿",
  "totalSteps": 3,
  "completedSteps": 2,
  "lastSequence": 12,
  "lastEventAt": "2026-07-08T10:01:00.000Z",
  "draftSessionId": "draft_abc"
}
```

完整历史事件通过 `/events/{runId}?afterSequence=0` replay。

## 页面刷新与进程重启恢复

Renderer 恢复规则：

1. `AgentWorkspace` 从 SQLite `AgentConversation` / `AgentRun` / `AgentRunEvent` 加载当前会话。
2. 如果 run 状态是 `running` / `cancelling` / `waiting_approval`，计算本地最后 `sequence`。
3. 调用 `window.agent.subscribeRun(runId, { afterSequence })` 续订事件流。
4. 如果 SSE 断开，先调用 `agent.run_status` 获取轻量状态，再按 `afterSequence` 重连。
   即使状态已经终止，只要 Runtime 的 `lastSequence` 大于本地 sequence，也必须先 replay 缺失事件再结束订阅。
5. `pendingApproval` 和 `approvalResponses` 会随 `AgentRun` 持久化，页面刷新后“需要你确认”卡片可恢复。

Python Runtime 恢复边界：

- 第一阶段后台 run 由内存 `asyncio.create_task` 驱动。
- 如果只是 Renderer 刷新，Python 任务仍在，SSE 可以续订。
- 如果 Electron/Python Runtime 整体重启，内存中的 asyncio task 会丢失，但 LangGraph checkpoint 保留。
- `waiting_approval` 且存在有效 checkpoint 时继续显示确认卡；提交后使用 `Command(resume=...)` 从原节点恢复。
- `running` / `cancelling` 重启后仍追加 `run_failed`。若持久化调用账本存在悬空副作用调用，先转为 `unknown` 并返回 `SIDE_EFFECT_UNKNOWN` 与脱敏调用引用；未知写结果不得自动重放。其余运行中节点返回 `RUNTIME_INTERRUPTED`。

## Electron Main 代理

新增 IPC：

```text
agent:subscribe-run
agent:unsubscribe-run
agent:run-event
```

`PythonRuntimeClient` 新增：

```ts
subscribeRunEvents(
  runId: string,
  options: { afterSequence?: number },
  onEvent: (event: AgentRunEvent) => void
): () => void
```

要求：

- 使用 Node HTTP 连接 Python `/events/{runId}`。
- 解析 SSE frame。
- 收到事件后写开发日志并转发 Renderer。
- 收到 `run_completed` / `run_failed` / `run_cancelled` 后关闭订阅。
- 连接异常时通知 Renderer，Renderer 用 `run_status` + 重新订阅恢复。
- 不暴露 Python port/token 给 Renderer。

## Renderer API

preload 新增：

```ts
window.agent.subscribeRun(runId: string, options?: { afterSequence?: number }): Promise<void>
window.agent.unsubscribeRun(runId: string): Promise<void>
window.agent.onRunEvent(callback: (event: AgentRunEvent) => void): () => void
window.agent.onRunDisconnected(callback: (payload: { runId: string; message: string }) => void): () => void
```

UI 更新规则：

- `message` -> 会话流。
- `step_started/completed/failed` -> 执行计划。
- `tool_call/tool_result` -> 工具调用记录。
- `draft_created` -> 草稿审核中心。
- `error/run_failed` -> 错误状态。

Phase 2 增加折叠式实时活动投影：

当前状态（2026-07-14）：以下 Run 事件投影已在 `agentActivityProjection.ts` 和 `AgentWorkspace` 落地，并有纯函数回归测试；聊天探索事件尚未进入 SSE。

- Renderer 从既有事件序列派生一个 `activitySummary`，同一 Run 内原位更新，不把每个事件变成新的聊天消息。
- `step_started` / LangGraph node start -> “正在{步骤标题}”。
- `tool_call` -> “正在调用 {toolName}”或工具 manifest 中的用户可读动作。
- `tool_result` -> 记录明细结果与耗时，并推进到下一活动摘要；失败时保留错误摘要。
- `approval_required` -> “需要你确认：{title}”。
- `draft_created` -> “已生成可审核草稿”。
- `message(kind=final_report)` -> “正在整理最终回答”之后进入完成摘要。
- `run_completed/run_failed/run_cancelled` -> 固定终态摘要，不再显示进行中动画。
- 展开明细直接使用持久化事件和 artifact 引用；摘要是纯投影，可由 replay 确定性重建，禁止另存一份可能漂移的自由文本状态。

后续命令执行事件需要扩展统一事件字段，但继续沿用 `AgentRunEvent`：命令文本、cwd、退出码、stdout/stderr 摘要、开始/结束时间和脱敏标记进入 payload。任何 token、API key、Authorization header 或用户隐私路径都必须在持久化与推送前完成脱敏。

## 取消逻辑

取消流程：

```text
Renderer -> window.agent.cancel({ runId })
Electron -> Python agent.cancel
Python:
  - run.cancelRequested = true
  - 取消当前 asyncio Run task
  - 使用当前 Automation requestId 调用 Electron `/cancel`
Electron AutomationServer:
  - AbortController 中止当前请求
  - HTTP provider 取消 fetch；MCP CLI provider 终止子进程
Python:
  - emit run_cancelled
```

UI 文案：

- `正在取消...`
- `已取消`
- `无法取消，请稍后重试`

取消结果使用稳定错误码 `CANCELLED`，不计为 `run_failed`。取消发生在 DraftSession 创建前时，不得产生迟到草稿。

## 第一版不做

- 不做 token 级文本流。
- 不让 Renderer 直连 Python SSE。
- 不把 SSE 作为正文写回通道。
- 不做多客户端订阅仲裁。
- SSE 传输层不负责模型请求或任务重试；它只负责带 `afterSequence` 的有界重连。请求退避、熔断和 Run 恢复统一遵循 [Agent 网络重试、熔断、切换与任务恢复设计](./retry-failover-resilience-requirements.md)。
- 不做独立 `approve_plan` 接口。

## 落地顺序

| 阶段 | 任务 | 产出 |
| --- | --- | --- |
| 1 | Python：事件持久化 + `AgentEventBus` | 事件能落地、能 replay |
| 2 | Python：`execute_plan` 改后台执行 | 立即返回 runId |
| 3 | Python：`/events/{runId}` SSE + 轻量 `run_status` | 事件流与状态查询 |
| 4 | Electron：`PythonRuntimeClient.subscribeRunEvents` | Main 可订阅 Python SSE |
| 5 | Electron：IPC `agent:subscribe-run` / `agent:run-event` | Main -> Renderer 事件推送 |
| 6 | Preload：`subscribeRun` / `onRunEvent` | Renderer 可消费事件 |
| 7 | UI：`AgentWorkspace` 改事件驱动 | 实时执行进度 |
| 8 | Python + UI：取消逻辑与取消中提示 | 可取消后续步骤 |
| 9 | `approval_required` + `submitApproval` | 执行中用户决策断点 |

## 当前落实状态（2026-07-11）

已完成：

- Python：
  - 新增 `agent_runtime/novel_agent_runtime/events.py`。
  - 新增 `AgentEventBus`。
  - 新增 `GET /events/{runId}` SSE endpoint。
  - `agent.execute_plan` 改为后台任务执行，立即返回 `runId`。
  - `run_events` SQLite 表用于事件持久化与 replay。
  - `AgentRunEvent` 增加 `sequence`、`planId`、`threadId`、`stepId`。
  - `run_status` 改为轻量状态返回。
  - `agent.cancel` 支持 `cancelling` 与 `cancelRequested`。
  - `agent.submit_approval` 已接入，用于提交执行中用户决策断点。
  - `approval_required` 第一版已可让 run 暂停到 `waiting_approval`，提交后恢复 `running`。
- Electron：
  - `PythonRuntimeClient.subscribeRunEvents` 可连接 Python SSE。
  - 新增 IPC：`agent:subscribe-run`、`agent:unsubscribe-run`。
- Main 进程转发 `agent:run-event` / `agent:run-disconnected`。
- `AgentRun` 本地表新增 `pendingApprovalJson` / `approvalResponsesJson`，用于刷新后恢复用户决策断点。
- `AgentRunEvent` 在 Electron SQLite 中按 `eventId` 增量 upsert，不再由前端截断后的数组覆盖历史。
- 会话加载返回全部历史 run，并以最新 run 兼容当前 UI 的活跃执行字段。
- Renderer：
  - `window.agent.subscribeRun`
  - `window.agent.unsubscribeRun`
  - `window.agent.onRunEvent`
  - `window.agent.onRunDisconnected`
  - `window.agent.submitApproval`
  - `AgentWorkspace` 改为事件驱动更新计划状态、工具记录和草稿状态。
  - `AgentWorkspace` 支持 `需要你确认` 卡片。
  - 计划草稿卡支持 `忽略` / `提交` / `实施此计划`。
  - `AgentWorkspace` 会在页面刷新、切换会话后对活跃 run 自动续订 SSE。
  - Runtime 重启后遗留的活跃 run 会被标记为 `run_failed`，避免假运行状态。

当前验证：

- Python Runtime `pytest` 13 项通过，覆盖工具参数映射、`/events/{runId}` 鉴权、`afterSequence` 回放和终态关闭。
- Electron 共享 SSE 协议测试通过，覆盖 CRLF、分块 frame、keepalive、终态和 sequence 去重。
- Node HTTP SSE 客户端真实 socket 测试通过，覆盖强制断开、单次断线通知、按 sequence 重连和终态正常关闭。
- Renderer Run 投影测试通过，覆盖审批恢复、草稿引用、终态和序列化后的刷新快照。
- DraftSession 真实文件存储测试通过，覆盖审核编辑、重载、版本冲突与提交状态。
- Main AgentConversationStore 真实 SQLite 测试通过，覆盖增量事件、数据库重连、终态/草稿引用/审批响应恢复与删除清理。
- `python -m compileall agent_runtime` 通过。
- `pnpm --filter novel-editor-desktop exec tsc --noEmit` 通过。
- `pnpm --filter novel-editor-desktop exec vite build --mode development` 通过。

后续仍需补齐：

- 对 SSE + `approval_required` 执行链路做真实长任务端到端手工测试。
- UI 断线恢复已有自动续订和底层真实 socket 回归测试，仍需在完整 UI 长任务中验证视觉状态与 DraftSession 恢复。
- 主动取消链路已覆盖 AutomationServer、HTTP provider 与 MCP CLI provider，并有“取消后无草稿”回归测试。
- 后续接入 LangGraph 主图时，需要把 LangGraph 节点事件映射到当前 `AgentRunEvent`。
