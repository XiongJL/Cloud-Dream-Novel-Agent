# 完整章节修复复查（2026-09-06）

更新（2026-09-07）：用户授权直接修复后，下述 R1、R2 均已修复并补充回归；另修复了空白首章的上下文守卫，以及 Agent 对话/规划阶段的隐藏输出上限。真实章节已生成并保留，自动审校曾因额度截断失败，后续单独重试审校成功。当前验收进展见 [修复与真实复测记录](chapter-writing-retest-2026-09-07.md)。下文保留最初复查时的缺陷证据，不能视作当前未修复状态。

## 已验证的改进

- 明确的 Responses 输出截断、Chat Completions 长度终止已有独立处理，附带部分文本与服务提供的用量。
- 素材 JSON 解析失败后生成随机占位数据的成功兜底已移除。
- 新增任务预算、一次增额恢复，以及基于生成草稿的编辑审校和高严重度问题修订分支。
- 旧配置缺少预算模式时保持手动模式，避免静默提高用户上限。

以上不等同于全部验收项通过；特别是流提前结束和较高手动额度，现有测试未覆盖下面的失败场景。

## R1 / P1：缺少成功终止事件时仍返回成功正文

位置：[responsesStream.ts](../../apps/desktop/electron/ai/providers/responsesStream.ts) 的最终返回分支（复查时第 222—229 行）。

复现：将当前 TypeScript 源码转译后，直接调用真实 `consumeResponsesStream`。输入只有一个 `response.output_text.delta`，正文为“第一段未完成的正文”，随后 HTTP 响应体结束；没有 `response.completed`。

实际返回：

```json
{"text":"第一段未完成的正文","finishReason":"completed","eventCount":1}
```

当前解析器在 EOF 后不核验成功终止事件，还把没有终止原因解释为 `completed`。`HttpProvider.generate` 对该流结果只检查文本非空，因此上游流被正常关闭但语义未完成时，部分章节仍能进入成功生成路径。明确 `response.incomplete` 已修好，但缺失终止事件的情况仍没有保护。

建议：区分传输 EOF 与协议成功完成；仅收到相应协议的成功终止标记才返回成功。缺失标记应保留部分文本及响应证据并报告流未完成，不发布为成功章节草稿。如果保留其他流协议兼容，需各自验证对应终止信号，不以非空文本代替。

应补测试：delta 后直接 EOF、created/in_progress 后 EOF、正常 completed、明确 incomplete、流读取异常。前两种不得返回成功；错误分类可按是否能可靠确认请求完成进一步区分，但不能虚构完成状态。

## R2 / P2：手动提高额度仍被固定限制为 8192

位置：[TaskOutputBudget.ts](../../apps/desktop/electron/ai/TaskOutputBudget.ts) 的 `initialTokens` 和 `recoveryTokens` 计算（复查时第 80—89 行）。

按已有预算测试方式转译当前计算函数，隔离模型与 token 计数依赖，使上下文窗口为 131072、输入为 1000 token，排除上下文不足影响。章节与素材两种任务均得到：

| 手动额度 | 实际初次额度 | 恢复额度 | 允许增额 |
| ---: | ---: | ---: | --- |
| 4096 | 4096 | 4096 | 否 |
| 8192 | 8192 | 8192 | 否 |
| 16384 | 8192 | 8192 | 否 |
| 32768 | 8192 | 8192 | 否 |

原因：章节/素材初次请求一律 `Math.min(8192, desired)`，没有限定仅适用于自动模式；手动模式随后固定 `recoveryTokens=initialTokens`。用户为解决截断而提高额度也无法生效，且没有自动增额恢复机会。

建议：将“先 8K，截断后再增额”的策略限定在自动模式。手动模式按已明确的配置语义使用额度，并受模型实际能力与上下文余量限制；不得再被不可见的固定 8K 限制拦截。若手动字段只是任务预算上限，需提供清晰的任务额度覆盖语义，仍要允许用户解决 8K 截断。

应补测试：手动 16384 的章节生成请求实际超过 8192，自动 8192→16384 行为不变，用户手动上限、上下文不足与模型上限仍受约束。

## 本轮运行的回归

- `task-output-budget-test.mjs`：通过。
- `http-responses-stream-test.mjs`：通过。
- `http-provider-retry-contract-test.mjs`：通过。
- `draft-operation-coordinator-test.mjs`：通过（测试中的数据库锁重试日志属于预期场景）。
- Python：`test_draft_toolchains.py`、`test_intent_service.py`、`test_invocation_ledger.py`、`test_retry.py`、`test_runtime_request_retry.py`、`test_tool_adapter.py`、`test_toolchain_registry.py`，共 **113 passed**，另有依赖弃用警告。

上述两项额外复现说明，现有测试通过不足以证明本次修复完整。修正并补齐用例后，再继续 [原完整章节验收](../../output/playwright/chapter-writing-20260905/test-report.md)，核验正文生成、审校、修订、审核写回及刷新持久化。旧失败计划仍包含素材生成步骤，复测新计划路由时应通过界面重新规划，不能仅重放旧计划来判断路由修复效果。
