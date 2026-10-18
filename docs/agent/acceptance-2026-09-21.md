# Agent 传统小说创作验收（2026-09-21）

状态：执行中，十章创作尚未完成。承接 9 月 16、17 日的真实桌面测试，不将独立补测记为一次自动流程通过。

## 范围与环境

- 独立作品：功能验收-灯塔档案-20260916（`cmu0xs9wo0000ubukv5asbb2a`）。其他作品与既有未提交修改保留。
- 当前源码构建的 Electron，Playwright 通过本机 CDP 9333 操作实际界面；业务操作走 UI，数据库只读取证。
- 继续当前 DeepSeek V4 flash 配置：手动 16384 Token，未修改 API Key 或供应商配置。
- 创作路线：已有蓝图 → 情节/角色/物品/世界设定初始化并审核 → 首章文风检查 → 其余九章 → 审校、修订、写回、重启核验。

## 已修复缺陷与回归

1. 先前真实蓝图生成已成功，但 `artifactFromRunEvent` 的运行时类型白名单遗漏 `novel_bootstrap_draft`、`agent_skill_pack_draft`，导致 Electron 不保存或展示相应产物。补齐白名单与存储类型，并从持久化事件恢复缺失产物；已保存产物优先，避免覆盖审核状态或产生重复。
2. 蓝图工具结果压缩仅保留警告，报告模型误称“蓝图尚未生成”。`_complete_toolchain` 现在向报告传递实际蓝图产物 ID、状态、概要和章节计划。历史错误报告保留，不冒充重新生成的成功报告。
3. 针对性回归通过：agent-run-recovery、agent-sqlite-recovery、Python bootstrap 执行测试。TypeScript 检查与 Vite 构建完成，日志见前次证据目录。
4. 9 月 21 日完整启动 Electron，打开原测试作品与会话：原蓝图按钮、完整产物及“生成可审核素材”入口正常显示；未重新调用蓝图模型。恢复验证通过。

## 实际操作记录

- 审阅《灯塔档案》已生成的总纲、六名角色、世界规则及十章章纲。以原始蓝图为准：陈修平、林晓，不使用口头摘要中的误写姓名。
- 从蓝图界面点击“生成可审核素材”，得到项目初始化计划并批准执行；目前正在生成素材草稿。
- 已知待观察：计划同时包含 `novel.project_initialize` 和 `creative_asset.draft` 两步，需核验是否产生重复素材，不能直接把两份重复草稿全部写入。

### 本日新发现

- 初始化运行 `run_e7ac05c0da664fe5` 生成两份素材包，分别为 `0336cfb5-a84b-490e-8747-6e533df112bc`（41 条）与 `4d82c219-5d24-4011-a242-d812d35bd389`（42 条）。尚未入库。
- 第一份素材将陈修平、林晓、老郑换成无依据的新角色，并混淆船检与灯塔检修。实际工具参数完整，但 `assembleDraftGenerationPrompt` 将输入标为虚构稳定引用 `context-builder`，超过 8000 字符后微压缩成 1600 字符首尾摘录。已去掉该输入的虚构引用，仍受现有上下文预算管理；真实方法结合上下文组装器回归确认中段角色与全文保留。
- 意图同时包含项目初始化及普通素材草稿，产生两次同目的生成。已在意图归一化中由初始化操作独占素材生成；端到端 Runtime 测试断言单步骤、单次生成通过。
- 两个素材步骤成功后，最终报告达到硬编码 4000 Token，运行标记失败。已改为既有 plan 预算与有界恢复，手动配置保持 16384。针对性预算测试通过。此次失败不是鉴权或余额问题，不重跑已成功素材阶段。
- 本日验证：agent-followup-budget、agent-context-assembler 通过；Python approved_novel_blueprint 测试通过（1 passed，既有 Starlette 警告）。系统 Python 无 pytest，已改用仓库 `.venv`，不额外安装依赖。

## 证据

- `output/playwright/acceptance-20260921/01-restored-blueprint.txt`：重启恢复后的界面。
- `output/playwright/acceptance-20260921/02-initialization-plan.txt`：初始化执行前计划。
- `output/playwright/acceptance-20260917/灯塔档案-蓝图.md`：此前真实模型生成的完整蓝图。
- `output/playwright/acceptance-20260917/typecheck-artifact-fix.log`、`build-artifact-fix.log`：修复构建验证。

## 尚未通过

素材审核落库、首章及十章正文、完整编辑审校与修订、审核写回、最终重启一致性，均须继续实际验收。问答失败后“重新生成回答”被待答问卷拦截的问题仍在前次文档登记，未宣称修复。
