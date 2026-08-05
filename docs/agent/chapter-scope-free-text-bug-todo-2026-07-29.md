# 章节范围意见未触发真实范围解析与正文读取 BUG TODO

状态：待修复

记录日期：2026-07-29

优先级：P1

## 问题

执行中的“分析范围”问题允许用户输入自定义答案，例如：

> 当前章 + 上一章

当前实现会保存这段原文，但不会把它解析成章节范围，也不会读取上一章正文。Run 恢复后仍直接执行原计划中的 `rag.ask`，最终报告可能只基于当前编辑器正文、RAG chunk 或章节摘要。用户输入“可以选择附近章节”时也没有形成可审计的只读委托和自适应读取策略。

权威产品要求见 [Agent 章节读取范围与委托需求](./chapter-read-scope-delegation-requirements.md)。本文件只跟踪当前实现缺陷和修复入口。

## 当前链路

1. `_analysis_scope_checkpoint` 创建固定范围选项并允许自由输入。
2. `_pause_run_for_graph` 将旧检查点转换为结构化 `AgentUserInputRequest`。
3. 自定义答案提交后，兼容响应中 `selectedOptionIds` 为空，原文只进入 `freeText`。
4. `_invoke_tool(..., "rag.ask", ...)` 在没有选项 ID 时把 `analysisScope` 默认成 `current_chapter`。
5. `freeText` 仅作为“用户补充要求”拼入 RAG 问题，不会改变章节集合或工具序列。
6. `rag.ask` 的 `nearby_chapters` 也只扩大已有 RAG/章节摘要的过滤范围，不保证读取相邻章节正文。

## 根因

- 执行期范围答案使用了“选项 ID + 自由文本”的展示协议，没有对应的权威 `AgentChapterScope` 解析结果。
- 范围确认发生在 `rag.ask` 即将执行时；恢复检查点只继续同一工具，不会重新规划读取步骤。
- Runtime 没有把“上一章、前两章、当前章到第 N 章”等相对表达解析为稳定章节 ID。
- 当前范围模型没有区分分析目标、读取授权、实际读取范围和未来写入范围。
- 固定 AI 选项没有绑定可执行的范围指令，选择后不保证发生真实正文读取。
- 现有测试只验证 `freeText` 被拼入 `rag.ask.question`，没有验证范围发现和正文覆盖。

## 期望修复

1. 范围回答必须规范化为结构化范围，至少包含：
   - `kind`
   - `chapterIds`
   - `anchorChapterId`
   - `orderFingerprint`
2. “当前章 + 上一章”应基于整本小说的全局章节顺序解析出两个真实章节 ID；当前卷卷首必须能读取上一卷卷尾。
3. 如果客户端上下文没有足够的全局有序章节元数据，Runtime 先通过小说级目录或确定性的 `volume.list + chapter.list` 发现范围。
4. 正文读取使用一次权威 `chapter.scope_context.build`，或对范围内每章成功调用 `chapter.get`。
5. 正文覆盖完成前不得调用 `rag.ask` 生成范围结论。
6. `rag.ask` 只作为补充检索，不得替代明确多章范围的正文读取。
7. 无法解析、章节不存在或正文读取失败时，应停在可重试错误，不得静默回退到 `current_chapter`。
8. “可以选择附近章节”应建立当前任务内的只读委托，由 AI 根据证据缺口跨卷、自适应选择，不固定为同卷或前后 N 章。
9. 用户最新自定义答案覆盖 AI 选项；旧选项、旧范围和旧 evidence gate 不得继续生效。
10. 只读上下文章节可以用于生成修改计划，但不能自动进入草稿或写回范围。
11. “当前章”在答案提交时冻结为具体锚点；读取过程中切换编辑器章节不能改变已经提交的范围。
12. 范围授权题和依赖新范围正文的内容题必须分阶段，除非所有候选 evidence 已经实际读取并可查看。
13. 用户改变范围后，基于旧范围且尚未执行完的计划、报告和问题组必须变为 `stale`；已完成写入不自动回滚。
14. AI 内容选项的来源必须能打开读取时的版本化证据；来源已失效时禁止继续提交该选项。

## 建议实现方向

- 将执行期 `analysis_scope` 从兼容自由文本响应迁移到结构化章节范围选择。
- 对固定选项直接生成确定性范围；对自由文本运行受约束的范围解析器，输出章节引用而不是任意工具计划。
- 为 AI 范围选项增加可执行 `scopeDirective`，为内容选项增加真实且可查看的 evidence。
- 在恢复执行前增加 Runtime 范围覆盖门槛，并把解析后的范围写入 Run 的结构化用户决策。
- 对已经显式选择章节的任务复用 `chapter.scope_context.build`，避免重复实现多章装配。

## 验收条件

1. 当前卷卷首输入“当前章 + 上一章”，工具记录包含上一卷卷尾和当前章的权威正文读取。
2. 整本小说首章输入相同要求时，返回明确的范围错误或待确认修正，不静默只读当前章后继续完整分析。
3. 输入“当前章 + 前两章”“第 3 章到第 5 章”可以解析成有序且去重的章节 ID。
4. 任一目标章节读取失败时不生成完整范围报告，并展示失败章节与重试入口。
5. 最终 Artifact 的 coverage 与实际成功读取章节一致。
6. 自动化测试同时断言工具顺序：范围发现（按需） -> 正文读取 -> RAG 补充 -> 报告。
7. “可以选择附近章节”可以跨卷继续扩展读取，达到单批预算时分批继续而不是截断语义范围。
8. 用户自定义意见覆盖 AI 的 1/2/3 选项；AI 内容选项都有可打开的真实章节来源。
9. 只读会话可以生成修改计划，但没有单独确认的上下文章节不会进入草稿或写回目标。
10. 提交范围答案后切换当前编辑章节不会改变已冻结的锚点。
11. 未读取新范围正文前，系统不会展示依赖该范围内容的方向选项。
12. 用户改变范围后，旧问题组、报告和计划进入 `stale`，下一个写入副作用前必须暂停并重新验证。
13. AI 内容选项的 evidence 可以打开读取时的版本；来源不可查看或过期时，问题组失效且不能提交。

## 相关文件

- `agent_runtime/novel_agent_runtime/runtime.py`
- `apps/desktop/electron/ai/rag/evidence.ts`
- `apps/desktop/shared/agentChapterScope.ts`
- `apps/desktop/shared/agentChapterScopeSelection.ts`
- `docs/agent/structured-user-input-requirements.md`
- `docs/agent/multi-chapter-processing-requirements.md`
- `docs/agent/chapter-read-scope-delegation-requirements.md`
