# Intent 优先与正文按需读取 Bugfix

版本：v1.0
日期：2026-07-28
状态：已实施
适用范围：Agent 聊天意图识别、计划前探索、稳定 Toolchain 计划、只读任务确认策略、章节证据快照和 Renderer 任务时间线。

## 1. 问题

显式选择多个章节后，聊天入口会在 IntentService 得出最终路由前无条件读取全部正文。模型随后只返回工作说明并生成计划；用户实施计划后，章节范围 Toolchain 再次装配同一正文并调用执行模型。

这会造成：

- 明确计划任务在批准前已经把正文送入聊天模型，执行时再次消耗正文输入 Token。
- 寒暄、只讨论、待审批提示等不需要项目事实的请求也可能触发多章读取。
- 当前编辑器正文可能同时以 `current-editor-content` 和工具观察进入同一聊天 Prompt。
- 已由 IntentDecision 匹配稳定 Toolchain 的任务仍先调用模型 Planner，随后确定性路由又替换模型步骤。
- 问题不局限于读者视角；作者、编辑、世界观、研究和团队的多章节链共享相同入口。

## 2. 根因

1. `IntentService.preflight` 只形成权限、入口和会话约束，不产生足以决定是否探索的候选路由。
2. `selected_chapters/chapter_range` 的 eager prefetch 只检查范围类型，不检查最终 `respond/clarify/plan`。
3. `agent.generate_chat` 同时承担语义识别、项目探索、用户可见说明和结构化提问，首轮上下文没有区分路由资料与执行资料。
4. 所有 Operation 当前都进入形式化计划；稳定 Toolchain 也依赖一次模型 Plan 作为外壳。
5. `requiresApproval` 尚未表达可信的低成本只读自动执行策略。

## 3. 目标时序

```text
用户请求
  -> IntentPreflight
  -> agent.generate_chat（用户请求、角色、历史摘要、范围元数据；无正文）
  -> IntentService.finalize
       -> respond/clarify 且需要项目证据：按需只读探索，再次总结
       -> plan 且稳定 Toolchain：确定性构造内部 Plan
  -> 只读成本策略
       -> 低成本：策略批准，直接启动 Run
       -> 高成本：展示现有 PlanCard，等待用户确认
  -> Toolchain 执行时装配正文一次
```

计划路由必须在批准或策略执行前保持零次正文读取。直接回答和基于材料的结构化提问可以读取正文，但读取必须由语义结果明确触发。

## 4. 成本与确认策略

低成本只读任务必须同时满足：

- 只有一个 Intent Operation 和一个已启用的稳定只读 Toolchain。
- 不是团队/Supervisor 多专家任务。
- 范围为当前章，或显式 `selected_chapters/chapter_range` 1 至 3 章。
- `processingMode=detailed`。
- Toolchain 声明 `approvalPolicy=auto_small_scope`。

以下情况始终确认：整卷、整本、4 章以上、`batched`、多个 Operation、研究考据、情节线长分析、团队审计、动态 Planner 回退，以及所有草稿或写入任务。

低成本任务仍创建 Plan/Run 以复用取消、恢复、Artifact 和活动流，但 Plan 设置 `requiresApproval=false`，时间线不展示形式化 PlanCard。执行器必须重新校验策略，不能信任 Renderer 或模型提供的免审批标志。

## 5. 角色影响

| 视角 | 典型稳定链 | 新行为 |
| --- | --- | --- |
| 作者 | `writer.range_revision_plan` | 1–3 章只读报告直接执行；批量改写仍确认 |
| 编辑 | `chapter.consistency_review`、`editor.range_review` | 小范围直接执行 |
| 读者 | `reader.journey_review` | 1–3 章直接执行并逐章盲读 |
| 世界观 | `worldbuilding.range_consistency` | 小范围直接执行 |
| 研究 | `research.range_fact_check` | 始终确认 |
| 团队 | `novel.scope_audit` | 始终确认，执行内继续共享一次范围装配 |

## 6. 证据与兼容边界

- 当前编辑器未保存正文只在按需 `chapter.get` 或范围装配结果中覆盖数据库版本，不再作为独立重复 Prompt section。
- 证据快照从实际成功的单章结果或 `ChapterScopeBundle` 创建，继续支持仅重试总结。
- 基于正文推荐选项的结构化问答仍须先满足证据覆盖；与项目材料无关的用户偏好问题不得触发章节预读。
- 旧 Plan 默认继续要求批准；旧消息、活动、Run 和 SQLite JSON 不迁移。
- 外部注册计划不得设置免审批；策略自动执行只适用于 Runtime 自己生成并可重新验证的只读计划。

## 7. 验收与回归

1. 读者视角选择两章发送“感受下这两章”：首轮聊天 Prompt 无正文，零次 `agent.generate_plan`，不显示 PlanCard；执行只装配一次范围并调用两次逐章评估。
2. 相同任务选择四章：计划前零次章节读取，显示 PlanCard；批准后只装配一次范围。
3. 稳定单链和稳定复合链跳过模型 Planner；未知能力继续走 Planner 回退。
4. 项目事实回答或证据型澄清按需读取；普通偏好澄清、寒暄、`chat_only` 和待审批提示零次读取。
5. 当前编辑器正文优先且在单次模型 Prompt 中只出现一次。
6. Runtime 拒绝伪造免审批、副作用步骤、超出 3 章、批处理、研究和团队任务。
7. 六种 AI 工作视角、总结重试、取消、失败恢复、活动流和历史数据恢复通过自动化回归。

## 8. 实施结果

- 聊天入口已移除显式多章 eager prefetch；首轮模型只接收范围元数据。当前章正文通过 `chapter.get` 的编辑器快照结果进入模型，显式多章通过 Runtime 覆盖参数后的 `chapter.scope_context.build` 一次装配。
- 单章与 `ChapterScopeBundle` 都可在实际探索完成后生成证据快照；总结重试继续只消费快照，不重新读取来源。
- 稳定 Toolchain 由 IntentDecision 直接构造 Plan。`auto_small_scope` 只对约定的稳定只读链开放；动态 Planner、研究、团队、长范围、批处理、多 Operation 和副作用计划继续确认。
- 执行器会重新验证免确认计划并在 `plan_approved` 记录 `approvalSource=policy`；外部注册的免确认计划继续被拒绝。
- Renderer 会直接执行 `requiresApproval=false` 的 Plan，不追加计划草稿通知、不渲染 PlanCard；活动流、Run、Artifact、失败恢复和历史计划沿用现有结构。
- 2026-07-28 验证：Python Runtime 全量 `184 passed`；目标 Runtime/Intent/Toolchain 测试 `73 passed`；TypeScript `tsc --noEmit` 通过；Renderer 契约、活动投影、时间线和完整 `test:agent-recovery` 脚本通过。Python 仅保留现有 Starlette/httpx2 弃用警告。
