# RAG 与上下文压缩功能验收（2026-09-24）

状态：P0 局部通过；Agent 网络重试后实际进入只读考据工具链，检索与事实核查报告的输出额度、格式及恢复问题已定位并修复。随后修复原始精确问答的意图与计划路由，真实桌面完成一次 `rag.ask` + `search.query` 只读流程；报告仍有来源/置信度不一致，证据准确性仅局部通过。24K 测试窗口真实触发了降级收缩，但未生成持久摘要，关键连续性未判通过。使用独立测试作品《功能验收-灯塔档案-20260916》（十章已写回）；业务操作通过真实 Electron 界面，数据库仅只读取证。沿用当前已配置模型，不修改 API Key，不更改其他作品或未提交修改。测试结束已恢复临时额度与窗口设置；验收文件不保存 API Key。功能依据当前实现列出，清单本身不代表通过。

## 功能清单与优先级

| 优先级 | 功能 | 主要核验点 | 状态 |
| --- | --- | --- | --- |
| P0 | RAG 索引构建 | 手动重建、片段数、模型/维度、失败降级提示 | 成功路径通过；降级未测 |
| P0 | 小说问答 | 人物状态、剧情线、未解伏笔、设定一致性、普通问答 | 人物关系与时间线实测；其余待测 |
| P0 | 证据可信度 | 命中来源、引用、置信度、警告；空证据/冲突时不编造 | 引用、拒绝编造及精确时刻复问通过；自动预算下基础高置信徽标通过，混合证据回答仍出现字段/正文不一致 |
| P0 | 当前章节上下文开关 | 开启时纳入当前正文，关闭后不泄露；来源可核对 | 预览输入通过 |
| P0 | Agent 检索 | `rag.ask` 与项目全文 `search.query`；空索引不隐式重建 | 路由修复后真实界面完成一次双工具只读流程，全文搜索 2 条《接班夜》命中、事件判定正确；RAG 部分引用与搜索来源不一致，证据准确性局部通过 |
| P0 | 压缩后的关键连续性 | 长会话压缩后保留当前任务、用户决定、关键事实、未决事项与产物引用 | 24K 窗口真实触发降级收缩并召回本会话 2 个产物；针对旧报告的只读跟进完成，更多关键事实/决定保留能力未验证 |
| P1 | 提示词预览与覆盖 | 预览实际证据/预算，编辑提示词后按修改内容提问 | 换题、手工提示词刷新/重置通过；一次临时覆盖实际请求通过，任意改写效果待测 |
| P1 | 索引增量更新 | 章节或素材变更后来源级更新，不重复旧片段 | 物品创建、编辑、删除通过；章节变更待测 |
| P1 | 自动上下文压缩 | 接近输入预算时原文/持久摘要/长消息微压缩按需启用 | 24K 桌面触发 `high_water/degraded`，省略 8 条旧消息；持久摘要与微压缩未触发 |
| P1 | 压缩诊断与可见性 | 模型窗口、输入预算、保留/摘要/省略数、来源列表与实际请求一致 | 24K 压缩态 UI 可见，9 原文/0 摘要/8 省略、2 个产物按引用召回；实际发送内容未独立核对 |
| P1 | 持久摘要与质量重建 | 摘要来源、修订/代数、手动重建、刷新和重启读回 | 24K 实测 `generation 0`、摘要 0，仍未通过 |
| P2 | 异常与降级 | Embedding/模型失败、低置信、超时、取消、摘要失败熔断与恢复 | 待测 |

`search.query` 是作品内全文检索，不是互联网搜索。RAG 查询按当前代码应消费已落库索引，普通查询不触发全量 Embedding；这一行为仍需实测。涉及付费模型的异常测试若遇到鉴权、余额或额度问题，保留首个错误证据并暂停同类调用。

## 执行记录

1. 打开写作台“AI 创作工坊 → 小说问答”。测试作品原先的 `rag_vector_chunks` 总数为 0。在 UI 点击“重建向量索引”，完成后提示 **120 个片段，`quentinz/bge-large-zh-v1.5`，1024 维**。SQLite 只读核对该作品恰为 120：章节 42、章节摘要 7、角色 6、物品/技能 14、叙事摘要 6、情节线 5、情节点 34、世界设定 6；嵌入 provider 为 `openai-compatible`，本次未触发 Hash 降级。
2. 预览并以当前模型提问“周鹤与周鸣是什么关系、周鸣职务”。预览提供 12 条证据，含角色卡 E1 和第十章正文 E2；回答判高置信，正确指出周鹤是周鸣弟弟、周鸣为白礁号大副，并区分已写事实与大纲计划，引用可对应到实际证据。
3. 提问三年前 22:40—23:20 旧停灯与本周一 23:10—23:47 新日志伪签是否同一事件。回答正确判定为两次改动，引用已写章节；但称未找到本周一具体时段。只读索引核实《接班夜》至少两片段含 `23:10`，其中一片明确写 `23:10到23:47`，说明本次 Top 12 证据未召回已索引的关键片段。该结论局部正确，但完整召回未通过。
4. 问不存在的“方雨泽驾驶宇宙飞船去火星是第几章”。实际回答拒绝编造，整体 UI 标低置信；然而提示词预览把四条无关证据计入并标中置信，预览证据质量判定不一致。
5. 切换“包含当前章节上下文”：预览关闭时无 `currentContext`，开启时出现当前《潮汐表上的缺口》正文与来源，重新关闭后再次消失。该项目前只验证实际预览输入，未宣称模型输出隔离已测。
6. 在同一问答面板把问题从“周鹤是谁”改为“三年前停灯时段是多少”，发现点击“预览提示词”后临时提示词仍以旧问题开头；实际提问因未启用 override，仍使用新问题。已局部修复并加载新构建，真实界面回归预览首行改为新问题。TypeScript 类型检查与 Vite 构建通过。
7. 写作界面“搜索”输入 `23:10`，命中第 1 章《接班夜》两处，结果预览一处直接显示 `23:10—23:47，主灯停止运转，检修`，另一处显示门禁记录与该时间段。索引查询前后该作品 RAG 片段仍为 120，普通问答没有隐式重建。此证据与第 3 项一起定位了 RAG 精确时刻召回问题。
8. Agent 新建考据会话两次要求只读调用 `rag.ask`、`search.query`。第一次约一分钟后仅回复“按流程执行”的确认，没有任何检索工具结果或计划。第二次明确要求“现在执行”后界面报 `Network connection failed.`，失败记录显示没有可用模型结果引用、提供“重新生成回答”。没有再点重试或发送第三次，避免重复消耗；不能判定 Agent 检索通过，也没有证据表明是鉴权或余额问题。
9. Agent 检查器“上下文”显示当前会话窗口 1,000,000 Token、输入约 4,679/969,819 Token，压缩模式 `none`。只读 SQLite 核对测试作品 14 个会话，持久摘要 0、压缩消息 0；目前没有实际压缩供桌面重启/连续性验证。`agent-context-v2`、`agent-context-coordinator`、`agent-context-state-refs` 三组针对性脚本均通过，但只证明代码路径，不能替代桌面实测。鉴于 Agent 真实调用网络失败，本轮不临时调小模型窗口发起大量压缩调用。
10. 修改精确时刻检索排序后构建并重启 Electron，以第 3 项原问句重新预览。证据集现在含第 1 章《接班夜》E3，其中逐字包含 `23:10—23:47，主灯停止运转，检修`；普通“周鹤与周鸣”预览仍含关系与职务来源。随后对原问句做了一次真实模型复问：回答引用 E1/E2/E3/E4，明确不是同一次事件，并区分三年前实际停灯与本周一仅有伪签日志、实际是否停灯未知。精确时刻召回和实际回答均通过。预览结构化信息只显示意图和证据条数，不再在模型回答前给出误导性置信度。
11. 在新构建里手动编辑一次“本次临时提示词”，点击刷新后编辑内容保留；换到新问题并重新预览时，该临时提示词被清空，新预览首行正确对应新问题。第 10 项真实复问时，界面显示“本次请求已使用临时覆盖”，返回内容遵循覆盖中的问题与证据；这证明覆盖参数实际发出，但尚未用与默认提示词显著不同的任意改写来验证模型行为。
12. 为验证来源级增量更新，在测试作品“角色与世界观 → 物品”通过 UI 新建并保存唯一临时物品“验收临时索引物品-蓝铜哨”。只读 DB 见该作品片段数由 120 增至 121，新增片段标题为 `item: 验收临时索引物品-蓝铜哨`，未全量重建。随后在同一 UI 删除此临时物品，列表由 15 回到原 14；只读 DB 见片段数回到 120、临时物品和对应索引片段均为 0。最终作品资料恢复原状。章节正文变更的增量路径未在本轮重复测试。
13. 第 10 项回答正文末尾写“置信度 **高**”，但 UI 徽标显示“低置信度”。定位到解析器先在全文搜索“资料不足”等词，回答的“不确定处”提及证据不足，覆盖了末尾明确的总体置信度。已调整为优先读取独立置信度行，再用缺证词兜底；针对“高且局部证据不足”“低且资料不足”“英文中等”“未声明且缺证”四例的脚本通过。该补丁尚未重新加载到桌面 UI，因此目前不能宣称徽标桌面回归通过。
14. 用户在此前 `Network connection failed` 后自行重试，Agent 成功生成并实施只读考据计划。真实执行明细显示 `rag.ask` 与五次 `search.query` 均被调用；前者因 2048 Token 固定上限截断，搜索分别返回 17、0、1、8、2 项，随后 8 条声明的 `research.synthesize` 又在 6000 Token 固定上限被截断。这证实连接问题已恢复，新的失败是输出额度，不是鉴权或余额。
15. 对 RAG 问答和结构化考据新增任务级自动输出预算：新用户默认自动模式下，RAG 先 2048、未发布截断后最多一次 4096；考据报告先 8192、最多一次 16384；均受模型、上下文和产品安全上限约束。旧手动配置仍按已有上限执行，本机原配置 `deepseek-v4-flash`、手动上限 16384 未改动。针对性预算测试通过，真实恢复时 12K 仍截断；收紧报告各项文字与证据摘录后，16K 结果完整产生，进入格式校验。
16. 只读工具链失败的终止事件虽标记 `retryable=true`，Runtime 原先只认 `request_retry_exhausted` 事件，导致“重试失败步骤”被当成新任务。桌面界面又只从当前运行查找失败运行，历史运行上的恢复指令会静默丢失。两处均修复。实测先后跳过两份误生成、未执行的新计划；之后使用精确恢复指令成功从 `research.synthesize` 继续。12K 重试运行只有 7 项操作；只读事件库核对最终成功运行 `run_3a7634f3aaad4494` 的 `tool_call` 为 0、`research.synthesize` 启动 1 次，没有重复搜索或写回。
17. 16K 生成了完整可解析 JSON，但 Python 报“格式检查失败”。只读检查模型结果存档显示 8 条 findings 均在，前端结构契约无问题；实际 Pydantic 错误为 `searchStats.projectSearchEvidenceClaimIds` 是列表、预期整数。该统计字段本来会根据真实搜索结果重算，现归一化时忽略模型自填统计再验证。对应测试及从已保存结果进行的本地验证通过。重启后在真实桌面点击“修复结果并继续”，最终运行 completed，展示 8 项考据建议；事件库确认该恢复运行没有重复工具调用。报告偏向现实事实核查，且原 `rag.ask` 首轮曾截断、报告标注 RAG 证据为空，因此不能把这次报告成功算作原始 Agent 精确问答完整通过。
18. 针对错误路由，在意图层把显式 `rag.ask` 识别为普通只读考据，并在同时指定 `rag.ask`、`search.query` 且未显式要求多章节考据时优先于语义建议。意图测试通过，但第一次真实桌面重试仍生成 `research.range_fact_check` 计划，证明计划模型又覆盖了正确意图。该计划在 UI 跳过，未执行检索。保留 `23-explicit-rag-still-wrong-plan.txt`。
19. 在计划层为明确指定两个工具的单一只读考据请求生成确定性原子工具计划；原子 `search.query` 只抽取用户指定词，`rag.ask` 使用原问题和作品范围，不再套入“编辑/读者视角”问句。重启桌面后，新会话真实生成“作品知识库问答与全文检索”计划，仅一项 `research_rag` 步骤和 `rag.ask`、`search.query` 两个工具，无 `research.range_fact_check`。按已获授权在 UI 实施。
20. 真实运行约 44 秒完成，操作明细显示恰好调用两项工具并生成最终报告，无写回。`search.query` 对 `23:10` 返回 2 条，均来自《接班夜》；结论为三年前停灯与本周一伪签不是同一事件。最终报告同时指出 RAG 回答引用的《夹层里的信》《姐姐的名字》与本次搜索实际来源不符，且 RAG `confidence=low` 与正文自评高不一致；还把部分未在本次证据片段出现的台词标为待核对。因此本次流程完成，但引用精确度和置信度显示仍是未通过项。证据 `24-explicit-rag-atomic-plan.txt`、`25-agent-direct-rag-completed.txt/png`。
21. 为验收新用户无需手调 Token，在真实设置界面暂时把已有配置的 `outputBudgetMode` 从 `manual` 改成 `auto`，其余非敏感配置保持 `deepseek-v4-flash`、`maxTokens=16384`、`contextWindowTokens=0`。重启后在小说问答面板提问周鹤与周鸣关系及周鸣职务，模型成功回答弟弟/哥哥关系与白礁号大副，引用 E1/E2/E6，界面显示高置信度。此例未触发截断恢复，只验证自动预算正常请求。随后在同一真实设置界面恢复 `manual`，再次只读配置文件确认 `manual/16384/0`；未更改 API Key。证据 `26-auto-budget-rag-ui.txt/png`。验收文档及该证据目录的密钥模式扫描没有命中。
22. 凭据处理失误：读取设置界面的内部工具回显时，完整控件快照意外包含了配置输入框中的 API Key。未将该值写入验收文档或 `output/playwright/acceptance-rag-context-20260924/` 证据文件，此后仅检查非敏感字段。由于工具记录可能可见，建议轮换这枚密钥；本次没有代用户更改鉴权配置。
23. 为测真实上下文压缩，临时设 `outputBudgetMode=auto`、上下文窗口 8K，重启后在已有 10 条历史消息的 Agent 会话发一次只读跟进。请求在模型调用前被本地预算检查拦下：“当前窗口无法同时容纳必要能力描述、任务上下文和回复空间”；固定输入诊断已有 8,683 Token，因此 8K 无法触发有效压缩。未重发新用户消息，保留失败记录 `27-context-8k-fixed-input-failure.txt`。
24. 随后临时设 24K 窗口，用 UI 的“重新生成回答”只重试该失败请求。真实回答完成，无新工具、计划或写回；检查器显示窗口 24,000、输入 3,115/11,429、`high_water`、`degraded`、9 条原文、0 摘要、8 条旧消息省略、按引用召回本会话 2 个产物，`generation 0`。这证明降级收缩与产物召回路径在桌面被触发，但并未生成持久摘要。回答按本会话旧考据报告的证据边界陈述“不能确认”，符合这次仅根据本会话报告复述的请求；另一新会话的双工具报告给出“不是同一事件”，本次并未请求跨会话合并两份报告，不能据此判错。更多关键事实和用户决定在收缩后的保留能力尚未验证。证据 `28-context-24k-degraded.txt`。测试后在 UI 恢复原 `manual/16384/contextWindowTokens=0`，只读配置再次核对并重启 Electron。

## 缺陷、修复与回归

已修复 [NovelAskPanel.tsx](../../apps/desktop/src/components/AIWorkbench/NovelAskPanel.tsx)：更改问题时清除旧回答、错误、预览、临时提示词和修改标志；刷新预览时，未被用户手动编辑的临时提示词随新检索结果更新，已编辑的提示词则保留。预览尚未调用回答模型，故结构化预览不再展示会误导为答案置信度的字段。换题预览、章节上下文开关和一次实际临时覆盖请求已通过真实 UI 回归；更复杂的任意覆盖效果未测。

已修复 [vectorIndex.ts](../../apps/desktop/electron/ai/rag/vectorIndex.ts) 的时刻召回问题：分词把 `23:10` 拆成 `23`、`10`，当前 embedding 为 1024 维，查询端本地向量维度不兼容而采用 lexical fallback；错误时刻的片段可凭数字碎片取得高分。现仅对查询中的完整 `HH:mm` 增加精确匹配权重，其他普通词的评分保持原路径。新构建重启后同一问句预览已把《接班夜》精确片段纳入 E3，普通人物问答的预览证据仍在。类型检查与 Vite 构建通过。

已修复 [NovelRagService.ts](../../apps/desktop/electron/ai/rag/NovelRagService.ts) 的置信度解析顺序。局部不确定性不应把一个明确自评为高置信度的主判断统一标为低。新增 [rag-confidence-test.mjs](../../apps/desktop/scripts/rag-confidence-test.mjs) 覆盖该冲突和低置信兜底。基础高置信回答已通过重启后的真实 UI 回归；复杂混合证据报告仍有字段与正文自评不一致，保留为未通过项。

已修复 [TaskOutputBudget.ts](../../apps/desktop/electron/ai/TaskOutputBudget.ts)、[AiService.ts](../../apps/desktop/electron/ai/AiService.ts) 中 RAG 问答和考据报告固定低额度的问题；自动模式按任务设定初始/单次恢复预算，不要求新用户手动调 Token。模型/上下文/产品上限与旧手动模式仍生效。考据报告改为简短 findings 和短证据摘录，降低完整 JSON 被截断的机会；[NovelRagService.ts](../../apps/desktop/electron/ai/rag/NovelRagService.ts) 接入同一未发布结果的单次预算恢复。

已修复 [runtime.py](../../agent_runtime/novel_agent_runtime/runtime.py) 对可重试工具链终止事件的识别，以及 [AgentWorkspace.tsx](../../apps/desktop/src/components/AgentWorkspace/AgentWorkspace.tsx) 从历史运行查找失败运行的 UI 衔接。已修复 [research_range_fact_check.py](../../agent_runtime/novel_agent_runtime/toolchains/research_range_fact_check.py) 忽略并重算模型自填 `searchStats` 的本地格式问题。恢复测试 15 项、桌面真实恢复及事件库核查通过。

已修复 [rules.py](../../agent_runtime/novel_agent_runtime/intent/rules.py)、[service.py](../../agent_runtime/novel_agent_runtime/intent/service.py)、[planner.py](../../agent_runtime/novel_agent_runtime/planner.py)、[runtime.py](../../agent_runtime/novel_agent_runtime/runtime.py) 中显式 `rag.ask` + `search.query` 请求的意图与计划路由、搜索词提取。`test_intent_service.py` 与 `test_toolchain_registry.py` 共 69 项通过，`test_runtime.py` 与 `test_runtime_request_retry.py` 共 81 项通过，`task-output-budget-test.mjs` 通过；真实桌面计划和执行均不再转为多章节考据。自动输出预算仍是新用户默认模式，旧用户手动模式保留，临时配置已恢复。

尚未解决：不存在的人物/火星问题仍会召回少量无关片段；虽然模型未编造答案，证据相关性排序仍需单独评估。Agent 本次完整只读报告的 RAG 引用与全文搜索来源不一致、置信度字段和正文自评不一致，需针对证据绑定另测。上下文压缩目前只验证了降级省略及本会话产物召回，持久语义摘要、重启读回与更完整的关键连续性仍待测。

## 证据

- `output/playwright/acceptance-rag-context-20260924/01-before-index.txt`、`02-index-built.txt` / PNG：索引前后 UI。
- `03-first-question-preview.txt`、`04-first-question-answer.txt`：人物关系预览和引用回答。
- `05-time-conflict-answer.txt`：时间线问答。
- `06-agent-context-before-test.txt`：当前会话模型上下文诊断基线。
- `07-preview-fix-context-toggle.txt`：换题预览修复和当前章节开关回归。
- `08-no-evidence-question.txt`：无依据问题的实际拒绝编造结果。
- `09-agent-research-failed.txt` / PNG：Agent 网络失败现场；`10-fulltext-2310.txt` / PNG：作品全文搜索精确命中。
- `11-context-db-baseline.json`：当前测试作品无持久摘要和压缩消息的只读数据。
- `12-rag-time-recall-after-fix.txt` / PNG：重启后精确时刻进入 E3 的提示词证据；`13-manual-prompt-preview.txt`：临时提示词刷新/换题回归。
- `15-time-answer-after-fix.txt` / PNG：同一时间线问句修复后的真实回答、E3 引用及修复前置信度徽标不一致。
- `14-index-increment-result.json`：临时物品删除后的作品与索引恢复读数；创建后的 121 片段和单项新索引见本轮终端只读查询记录。
- `output/playwright/acceptance-rag-context-20260924/typecheck-rag.log`、`build-rag.log`：最终源码 TypeScript 检查与 Vite 构建通过。前两次局部构建日志为 `typecheck.log` / `build.log`、`typecheck-final.log` / `build-final.log`。
- `apps/desktop/scripts/rag-confidence-test.mjs`：置信度解析针对性回归通过；最终补丁的类型检查见 `typecheck-rag-final.log`，构建见 `build-rag-final.log`。
- `16-agent-retry-new-failure.txt`、`17-agent-output-budget-detail.txt` / PNG：用户网络重试后 RAG 截断、五次全文搜索和 6K 综合截断。
- `18-retry-command-new-plan.txt`：精确恢复入口修复前，重试语句误生成新计划；两份误计划均已跳过。
- `19-agent-failed-node-retry.txt`：12K 只重试综合节点、未重复检索，但仍截断。
- `20-agent-16k-format-failure.txt` / PNG：16K 完整输出后的格式错误；本地存档 `research-saved-result.json` 可复现 `searchStats` 类型冲突。
- `21-agent-saved-result-repair.txt`、`22-agent-recovered-report.txt` / PNG：真实界面修复已保存结果后 completed，8 项建议。最终成功运行 `run_3a7634f3aaad4494` 的只读事件核对为 0 次工具调用、1 次综合启动。
- `23-explicit-rag-still-wrong-plan.txt`：意图修复后计划模型仍错误选择范围考据，该计划跳过。`24-explicit-rag-atomic-plan.txt`：确定性双工具计划。`25-agent-direct-rag-completed.txt/png`：真实双工具执行与报告，含证据不一致的现场。
- `26-auto-budget-rag-ui.txt/png`：临时自动预算模式下的真实小说问答与高置信度 UI；本机配置已恢复为原手动模式。
- `27-context-8k-fixed-input-failure.txt`：8K 窗口固定输入不足的本地失败；`28-context-24k-degraded.txt`：24K 窗口真实降级收缩、产物召回与回复现场。最终配置已恢复并重启。
- `typecheck-agent-recovery-final.log`、`build-agent-recovery-final.log`、`typecheck-research-report-final.log`、`build-research-report-final.log`：本轮最终检查和构建；`task-output-budget-test.mjs`、`agent-retry-renderer-contract-test.mjs`、Python 考据与恢复测试均通过。
