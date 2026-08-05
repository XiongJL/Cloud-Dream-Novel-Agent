# Agent 多章节读取、统一超时与工具活动流需求

版本：v1.1
日期：2026-07-28
状态：已实施
适用范围：Agent 聊天与计划前探索、章节范围、只读工具、模型总结、请求取消、活动记录和超时恢复。

## 1. 背景与目标

聊天链路目前可能丢失 Renderer 中已选择的多章节范围，随后让模型通过 `chapter.list` 重新猜测目标；同时 Runtime 没有完整透传目录参数，可能把章节正文意外装入上下文。模型调用、Automation 和 Python HTTP 客户端还分别使用独立超时，导致仍在生成的有效结果被提前放弃，并与强制汇总请求重叠。

本需求统一解决以下问题：

- 多章节选择在会话、重启和单次消息中保持稳定。
- 首轮意图识别只接收章节范围元数据；正文只在直接回答、证据型澄清或正式执行时按需读取。
- 显式章节范围的实际读取使用权威范围，不交给模型重新发现、扩大或重排。
- 所有调用共享一个父 deadline，并能取消准确的上游调用。
- 正文已读取但总结超时时，可以只重试总结。
- 模型思考与工具调用以完整生命周期实时展示并持久化。

普通聊天默认总 deadline 为 5 分钟；长计划 Run 继续使用现有 10 分钟上限。

## 2. 章节范围与确定性读取

- `AgentConversationRecord` 保存可选 `chapterScope`，SQLite 使用可空 `chapterScopeJson`。用户改变范围后立即持久化；旧会话缺失时依次从活动计划、Run 和当前章回退，不做历史回填。
- 每次发送创建不可变 `chapterScopeSnapshot`，同时进入 Runtime 请求和用户消息元数据。发送后切换编辑器章节不得改变该请求的范围。
- 文字明确引用“两章/三章”等数量但快照数量不符时，在任何模型或工具调用前返回 `SCOPE_CONFLICT`，Renderer 重新打开章节选择器。
- 首次 `agent.generate_chat` 只携带用户请求、角色、历史摘要和范围 ID，不携带 `CurrentEditorContent`、章节正文或预置 ToolObservation。
- 明确进入计划的请求在计划批准或低成本只读策略执行前必须保持零次正文读取。
- 直接回答或证据型澄清需要显式多章正文时，复用 `chapter.scope_context.build` 一次装配权威范围；当前编辑器未保存正文优先于数据库正文。
- 按需读取失败不输出推测分析，也不得调用 `novel.list`、`volume.list` 或 `chapter.list` 猜测显式目标。
- 同一正文在一次模型请求中只能存在于一个工具观察 section，不得同时作为当前编辑器正文和工具结果重复注入。
- `chapter.list` 仅用于没有显式章节 ID 的目录发现，完整透传 `volumeId`、`offset`、`limit`、`includeContent`，并保留显式 `false`。目录发现默认 `includeContent:false`。

## 3. 统一 deadline、调用标识与取消

- 整轮聊天使用 `requestId`；每个模型或工具调用使用唯一 `callId`，并携带 `parentRequestId`。
- 请求入口生成 `deadlineAt`。Python Runtime、Automation、Provider 和本地 HTTP 客户端均按剩余时间裁剪 timeout，不再维护互相冲突的固定窗口。
- Provider timeout 小于 Automation timeout，Automation timeout 小于父请求剩余时间；外层 Runtime HTTP 请求使用父 deadline 加传输宽限。
- `asyncio.TimeoutError`、Automation 超时和用户取消必须取消当前 `callId` 并等待确认。未确认取消前不得启动替代模型请求。
- Automation 超时必须触发 `AbortController`，不能只使用 `Promise.race` 返回错误。相同信号必须传到 Provider。
- 已终止调用的迟到结果按 `callId` 丢弃，不写入消息、Artifact 或上下文。
- 正文读取完成后只启动一个专用总结调用；删除取消完整回答后再提交相同大上下文的重叠强制汇总流程。
- 总 deadline 到达时返回结构化失败，不再把模型总结超时描述为正文读取超时。

## 4. 证据快照与仅重试总结

正文读取完成后保存不可变 `AgentEvidenceSnapshot`，至少包含：

- `evidenceSnapshotId`、父请求和会话 ID。
- 章节范围、正文快照、章节版本和内容哈希。
- 已完成的读取记录、覆盖率和上下文诊断。
- 创建时间和原始用户目标。

模型总结超时时返回 `MODEL_SUMMARY_TIMEOUT`、`evidenceSnapshotId` 和读取覆盖率。UI 显示“已读取 N/N 章，但模型总结超时”，并提供：

- `仅重试总结`：调用 `agent.retry_chat_summary`，只读取证据快照，禁止重新调用章节、附件、RAG 或目录工具。
- `重新读取并分析`：按当前范围创建一轮新请求。

来源后来变化时，“仅重试总结”仍使用请求时快照并明确提示。快照缺失返回 `EVIDENCE_SNAPSHOT_MISSING`，不得静默重新读取。

失败代码至少包含：

- `SCOPE_CONFLICT`
- `CONTEXT_READ_TIMEOUT`
- `CONTEXT_READ_FAILED`
- `MODEL_SUMMARY_TIMEOUT`
- `REQUEST_DEADLINE_EXCEEDED`
- `EVIDENCE_SNAPSHOT_MISSING`
- `CANCELLED`

## 5. 工具和模型活动生命周期

聊天继续使用 `/progress/{requestId}` 与 Electron IPC，不新增聊天 SSE。统一活动事件为：

```ts
type AgentChatActivityEvent = {
  eventId: string;
  sequence: number;
  requestId: string;
  callId?: string;
  type:
    | 'request_started'
    | 'model_started'
    | 'model_completed'
    | 'tool_started'
    | 'tool_completed'
    | 'tool_failed'
    | 'finalization_started'
    | 'request_completed'
    | 'request_failed'
    | 'request_cancelled';
  stage: 'scope_validation' | 'context_read' | 'analysis' | 'finalization';
  toolName?: string;
  displayName: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  elapsedMs?: number;
  details?: Record<string, unknown>;
  createdAt: string;
};
```

- 每个工具产生共享同一 `callId` 的 `tool_started` 与 `tool_completed/tool_failed`；取消使用 `cancelled` 终态。
- Renderer 显示人类可读文案，例如“正在读取《雨夜来电》”“正在检索项目资料”“正在生成读者反馈”，不再把章节和 RAG 工具显示为“思考中”。
- 活动卡执行时实时展开，完成后折叠保存到助手消息 `metadataJson`，重启后仍可查看。
- 活动事件属于工作流记录，不进入模型聊天历史。
- `contextReads` 保存 `callId`、来源标题、状态、耗时和错误码；技术参数仅在展开详情中脱敏展示。
- 请求失败时保留已经完成的工具记录，明确区分读取失败与总结失败。

## 6. 公共接口与持久化

- `AgentConversationRecord.chapterScope?: AgentChapterScopeSelection`。
- 用户消息元数据增加 `chapterScopeSnapshot`；助手消息元数据增加 `activities`、结构化 `failure` 和 `evidenceSnapshotId`。
- Automation 调用增加 `callId`、`parentRequestId`、`deadlineAt`；取消接口以 `callId` 为目标。
- `AgentChatResponse` 增加 `status`、`activities`、可选 `failure` 和 `evidenceSnapshotId`。
- 新增 `agent.retry_chat_summary` 及 IPC/preload 方法。
- `AgentEvidenceSnapshot` 由 Runtime 持久化并随会话清理，不复制到普通聊天历史。
- 旧会话与旧消息保持可读，不迁移旧范围和旧活动记录。

## 7. 验收标准

1. 选择两章并重启后，选择器、消息快照和 Runtime 收到的章节 ID 仍为原两章。
2. 章节数量冲突在任何模型和工具调用前返回 `SCOPE_CONFLICT`。
3. 显式两章计划任务在计划前不调用章节读取；执行时只调用一次范围装配，并保留作品顺序和当前编辑器内容。
4. `chapter.list` 的分页与 `includeContent:false` 完整到达 Electron，返回值不含正文。
5. 工具事件具有唯一 `callId`、递增 sequence 和完整开始/终止配对；活动卡完成后可在重启后展开。
6. 超时和取消会终止准确的 Provider 请求，不产生重叠汇总，迟到结果不会形成消息。
7. 总结超时显示准确覆盖率；“仅重试总结”复用快照且产生零次读取工具调用。
8. Python Runtime、Automation/Provider、Renderer、SQLite 恢复、TypeScript 和生产构建测试通过。

本次 Intent 优先修订的完整根因、成本策略和角色回归矩阵见 [Intent 优先与正文按需读取 Bugfix](./intent-first-retrieval-bugfix-2026-07-28.md)。
