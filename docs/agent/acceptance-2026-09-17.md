# Agent 传统小说创作验收（2026-09-17）

状态：执行中。目标为《灯塔档案》蓝图、大纲与素材初始化、文风确认和十章创作。不得据中间阶段成功宣称十章或完整自动流程通过。

## 环境与范围

- 测试作品：功能验收-灯塔档案-20260916，ID `cmu0xs9wo0000ubukv5asbb2a`；保留其他作品。
- 当前源码构建的 Electron，通过 Playwright CDP `127.0.0.1:9333` 操作真实页面；业务写入走 UI，SQLite 只用于读取验收证据。
- 数据目录：`%APPDATA%/@novel-editor/desktop-dev`。
- 当前配置：DeepSeek V4 flash，Responses 协议，手动 16384 Token，配置 timeoutMs=60000；未修改密钥或供应商。
- 使用应用内“新建小说 v1.3.0”，先生成蓝图，再审核映射为项目素材。题材为现实悬疑、男性主角沈砚、查明人为海难真相；第二轮确认地方利益链与社会派写实追责。
- 目标：10 章，每章约 2300 汉字。第三人称限知、冷静克制，以动作、对话、物证推进；无超自然解释，主线闭环。

## 已发现问题与修复

1. 9 月 16 日初始化问答后的 `agent.generate_user_input_followup` 在约 11150 ms 后返回 `max_output_tokens`。实际请求被代码压为 1800 Token，未使用手动配置的 16384。调用没有形成蓝图。
2. 已将追问步骤接入已有 intent 输出预算及有界恢复机制；同一初始化链路的蓝图生成原来固定限制 5000，也接入 creative_assets 预算。手动模式不自动增额，自动模式仅按现有安全截断规则恢复一次；保留原阶段时限。
3. 针对性脚本 `apps/desktop/scripts/agent-followup-budget-test.mjs` 验证请求额度、任务类型、取消信号、阶段标识与蓝图上下文预留；测试通过。现有 task-output-budget 回归通过，9 月 17 日 typecheck 通过；构建通过，有既有大包提示。
4. 重启后原请求、待答问卷和失败记录保留；但“重新生成回答”会被待答问卷拦住并提示先完成问答。需要重选原答案后提交，不应把这个按钮记为成功恢复。暂记录为恢复体验缺陷。
5. 9 月 17 日加载修复后重选相同答案，真实追问调用成功，生成了两项非重复深度定制问题；完成回答后形成“新建小说方案”计划，已审批执行。

## 证据

- `output/playwright/acceptance-20260916/02-bootstrap-failure.txt` 和同名 PNG：原始截断现场。
- `output/playwright/acceptance-20260916/03-failure-after-refresh.txt`：刷新后的失败状态。
- `output/playwright/acceptance-20260917/01-restart-recovery.txt`：重启恢复。
- `output/playwright/acceptance-20260917/02-followup-success.txt`：修复后问答。
- `output/playwright/acceptance-20260917/03-blueprint-plan.txt`：蓝图计划。
- `output/playwright/acceptance-20260917/04-initial-state.json`：仅测试作品的数据库只读证据。
- `output/playwright/acceptance-20260917/typecheck.log`：类型检查。

## 待完成

蓝图内容审核、项目素材生成与审核写入、文风规范落实、首章样稿与后续九章、必要修订及重启一致性核验。
