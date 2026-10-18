# Skill Pack 统一选择与运行设计

日期：2026-10-13。状态：首版已实施，实际兼容边界与验证见[实施记录](./acceptance-skill-pack-runtime-selection-2026-10-13.md)。本文件保留设计决策；取消默认采用墓碑/CAS，旧客户端通过功能启用边界保持原路径。

## 1. 产品目标与首版决定

用户选择一个文风包，即可在 Agent 的新任务中统一使用；用户无需记住语言、悬念、群像三个独立 Skill，更不需要逐个调用。

保留成员文档独立维护。Pack 负责保存成员版本、任务绑定和加载规则；成员仍只提供写作方法，不承担调度、权限或创建 Agent。

首版明确采用：

1. `/` 菜单增加 **Skill Pack**，输入框显示一个已选包标签。
2. **保存、当前请求使用、设为本书默认**是三个独立动作。保存成功不自动改默认。
3. 显式单 Skill、显式 Pack、本轮不使用 Skill 互斥；未显式选择时才读取本书默认。
4. 每个步骤仍为 **一个主成员＋最多一个辅助成员**。文风写作任务固定语言核心，辅助按绑定选择；提供本次辅助覆盖选项。
5. 首版自动选择按明确的 Operation/Role 绑定执行，不增加一次模型调用来猜场景，也不因正文里出现某个词偷偷换辅助。
6. 包作为整体解析，不把不同包的成员按优先级混到一起。
7. 计划确认前显示实际组合并冻结版本；执行与重试沿用冻结结果。
8. 仅覆盖现有 Agent 请求链路。普通写作页的直接 AI 操作不在首版接入范围，UI 不能宣称全应用都已使用默认文风。

“统一调用”指一个选择入口和一份明确的运行配置，不意味着每次把所有三个成员塞入上下文。若用户需要悬念和群像共同强约束，首版需要选择主辅助组合；三成员同时加载另作后续设计，不能隐式绕开现有两成员限制。

## 2. 当前实现与需要修正的缺口

已存在 `AgentSkillPack`、不可变 `AgentSkillPackRevision`，提交 Pack 会同时保存成员 Skill 和绑定。Runtime 根据 Operation/Role 匹配绑定，Resolver/PlanStep 限制最多两个 Skill，Compiler 分段加载所选正文。

当前问题：

- `/` 菜单、Composer 和 IntentEntryHint 只认识单 Skill，没有 Pack 入口。
- `commitPackDraft` 同时创建启用的 `pack_primary/pack_auxiliary` 平面绑定；保存已改变匹配任务的默认行为，却没有明确的本书默认选择。
- `AgentSkillBinding` 没有 Pack 归属，Runtime 按 priority 汇总所有匹配项，多个 Pack 可发生成员混选，不能表达“仅选包 A”。
- Pack Revision 已记录成员 `revisionId`，运行选择却只使用平面绑定里的 `skillId`，可能加载成员新版本而丢失包版本语义。
- Runtime 持久化注册缓存主要加载当前成员版本；一个登记对象只包含一次 get 返回的版本。新任务与历史恢复需要显式加载指定版本，不能靠缓存恰好保留旧对象。
- 现有文风多章续写绑定不包含语言成员。当前质量试写只测试第一条 writer 绑定，不能推广到全部组合。

## 3. 用户流程

### 3.1 从产物保存

产物卡保留“保存文风包”，清楚显示成员数、版本及适用任务。保存后提供两个可选动作：

- **本次使用**：将 Pack 加入当前输入框，按下一条发出的请求使用。
- **设为本书默认**：设置当前小说的 Agent 文风默认，显示被替换的旧默认；不影响其他小说。

不自动提交草稿、不自动发送任务。绑定或正文调整仍先进入草稿；内容/组合验证通过后才能发布新版本。

### 3.2 `/` 统一选择

菜单保留“创建 Skill”“本次不使用 Skill”，增加类型区分：

```text
本小说
  [文风包] 悬疑解谜文风包 · v1.0.0 · 3 个成员
  [Skill] 语言风格：紧凑限知叙述
  [Skill] 悬念与信息释放
  [Skill] 群像推进
```

选包后，输入框只展示一个标签，例如：

```text
文风包：悬疑解谜 v1.0.0
辅助方法：按包默认 ▾
```

辅助选项为“按包默认”“只用核心”以及该包公开的辅助成员。名称来自包元数据，UI 不写死 Skill ID。显式辅助覆盖只对本条请求生效，不改本书默认或包内容。

成功发送后清除本次覆盖；发送失败保留输入与选择。持续使用通过“本书默认”实现，不能暗中把一次选择永久保存。切换小说清除未发送的作用域不兼容选择；切换会话的未发送内容按现有 Composer 规则管理，并始终以当前小说检查可见性。

### 3.3 计划和运行记录

计划每一步显示包版本、实际成员及选择原因：

```text
续写第 12 章
文风包：悬疑解谜 v1.0.0
语言 v1.0.0 ＋ 悬念 v1.0.0
来源：本次选择；辅助：该任务的包默认
```

成员详情按需展开完整正文，首页不常驻三个文档。对不适用的专家步骤显示“该文风包不适用于此步骤”，而不是显示已选择就当已加载。Run 记录的是每步最终解析结果，不能只展示包的三个库存成员。

普通聊天可以解释包的用途，但不因选包就自动创建写作任务；任务仍由 Intent 决定。

## 4. 解析优先级与行为

先确定选择来源，再解析成员。禁止先汇总全部绑定再截取两个。

| 来源 | 行为 |
| --- | --- |
| 本轮不使用 Skill | 不加载任何可选 Skill，包括本书默认；Role、Toolchain 和权限约束照常 |
| 显式 Pack | 只用该包的指定版本和覆盖选项，不追加其他包或角色默认成员 |
| 显式单 Skill | 保持单 Skill 入口与现有兼容检查；不补入默认 Pack 的成员。既有非 Pack 默认解析保持可见、可审计 |
| 本书默认 Pack | 从当前小说保存的默认引用解析该包，不合并其他包 |
| 没有上述选择 | 使用现有非 Pack 的 Operation/Role 默认，不随机选最近保存的包 |

API 同时收到显式单 Skill 与 Pack 时返回输入冲突；不通过排序猜用户意图。旧请求未提供新字段时按兼容策略处理，不要求全部历史事件补字段。

确定任务后，对每一个正式步骤进行解析：

1. 取明确的 Operation、Role 和小说 ID，不根据工具链名称猜文风。
2. 验证已选 Pack 与指定版本的归属、启用状态和哈希。
3. 按 Operation/Role 取得该包的一条绑定；生成阶段不允许重复绑定。
4. 使用绑定默认辅助，或执行本次显式覆盖。覆盖成员必须在该包的允许候选范围内，且支持相同 Operation/Role。
5. 按成员指定的 Revision 加载完整方法、约束、示例，不能取成员 currentRevision 代替。
6. 在计划上记录最终结果与原因，进行现有上下文/输出预算检查。

显式 Pack 完全不支持本次任务时，在执行前明确报“不适用于当前任务”，不偷偷换其他包。多步骤任务只在兼容步骤中应用，且显示不适用步骤。若某个应加载成员不存在、被停用、指定版本缺失或包结构损坏，应阻止使用该包开始新任务，不能装作“无规则正常写作”。本书默认故障只阻断实际依赖该默认的步骤，不妨碍无关工具或查看历史。

### 4.1 文风包的核心规则

新生成的文风包将语言成员显式标记为 `core`，悬念/群像标记为 `auxiliary`。核心身份来自发布时校验的元数据，不能通过标题包含“语言”或稳定 ID 的前缀判断。

| 写作操作 | 新文风包主成员 | 默认辅助 |
| --- | --- | --- |
| chapter.create | 语言核心 | 悬念，若包提供并支持 |
| chapter.continuation | 语言核心 | 悬念，若包提供并支持 |
| chapter.sequence_continuation | 语言核心 | 悬念，若包提供并支持 |
| chapter.rewrite | 语言核心 | 悬念，若包提供并支持 |
| chapter.batch_rewrite | 语言核心 | 无；可由本次覆盖选择兼容辅助 |

群像场景可在统一入口将辅助改为群像，不需要单独调用它。没有群像成员的包不展示该选项。编辑、分析步骤仍按自身绑定，不强制以语言为主；文风不能改变该步骤原有产物类型。

这张表是新文风包生成/修订时的产品校验策略，不是运行时篡改任意用户 Pack。一般方法 Pack 可声明其他主成员，按自身绑定解析。

旧包没有核心元数据时，按原绑定展示与执行；提示“旧版包，按已保存绑定使用”。不偷偷将成员换位、不伪装为已验证新组合。现有十章草稿可在后续定向修订绑定后重新验证，不需要重读十章。

## 5. 数据与协议

### 5.1 Pack Revision 编码

沿用不可变 Revision 和现有 `bindingsJson` 存储，新增有版本的 JSON 编码。读取同时支持旧数组与新对象；不能将旧数组原地重写，旧哈希算法也保持可验证。

新结构示意（存储与对外响应均需要正式 Schema 验证）：

```json
{
  "schemaVersion": "novel-editor.agent-skill-pack.v2",
  "kind": "style",
  "members": [
    {"memberKey": "language", "skillId": "skill-language", "revisionId": "revision-language", "contentHash": "sha256", "slot": "core"},
    {"memberKey": "suspense", "skillId": "skill-suspense", "revisionId": "revision-suspense", "contentHash": "sha256", "slot": "auxiliary"},
    {"memberKey": "ensemble", "skillId": "skill-ensemble", "revisionId": "revision-ensemble", "contentHash": "sha256", "slot": "auxiliary"}
  ],
  "bindings": [
    {"operationId": "chapter.continuation", "roleId": "writer", "primaryMemberKey": "language", "auxiliaryMemberKey": "suspense", "allowedAuxiliaryMemberKeys": ["suspense", "ensemble"]}
  ]
}
```

示例的 `sha256` 是占位，实际要求 64 位哈希。每个成员必须记录精确版本与哈希；绑定只能引用本包成员。核心与辅助不能相同，操作/角色双向兼容，不允许两份绑定争用同一 Operation/Role。文风生成草稿仍使用符号 draftKey，提交事务中转换成正式 Skill/Revision 引用。

旧数组的成员集合由绑定引用去重获得；其角色只是每条绑定的 primary/auxiliary，不强行推断一个全包核心。

### 5.2 本书默认

新增 `AgentSkillPackPreference` 表：

| 字段 | 含义 |
| --- | --- |
| novelId，主键 | 每本小说最多一个默认 Pack |
| packId | 正式 Pack 身份 |
| packRevisionId | 明确选中的包版本 |
| version | 设置的 CAS 修订号 |
| updatedAt | 修改时间 |

没有记录表示“未设置 Pack 默认”，允许既有非 Pack 默认继续工作。取消默认删除引用，但不删除 Pack/成员。默认版本固定；发布新版本后提示可切换，用户切换才更新默认，避免写作中无感改变文风。

同一小说可以选择本小说 Pack 或用户全局 Pack；本小说 Pack 不可跨小说使用。预置字段与引用通过 Electron 校验和事务写入，Python 不访问业务库。

新表需要同时接入备份注册表、依赖排序和恢复 ID 映射。复制恢复需重映射 novelId、packId、packRevisionId；恢复后引用到停用 Pack 的偏好保持不可用状态，不能绕过现有恢复停用策略。缺少 Pack 的旧备份仍可恢复。

### 5.3 请求入口

保留 `skill.use` 与 `skill.none`，新增结构化 `skill.pack.use`，不把包名称塞进自然语言作为唯一身份：

```json
{
  "actionId": "skill.pack.use",
  "kind": "skill.pack.use",
  "packId": "pack-id",
  "requestedPackRevisionId": "pack-revision-id",
  "auxiliaryMode": "default"
}
```

`auxiliaryMode` 为 `default|none|member`；member 模式要求 `auxiliaryMemberKey`。辅助覆盖是请求设置，包定义本身不修改。

`IntentDecision` 新增可空 `requestedSkillPack`，不会在意图识别前展开成两项 `requestedSkills`，因为同一包在不同步骤可能有不同组合。包身份及显式覆盖从请求确定性传递，语义模型不能替换用户选择。单 Skill 和 Pack 冲突在请求校验时拒绝。

### 5.4 API 分层

| Runtime/API | Electron Automation/Store | 用途 |
| --- | --- | --- |
| agent.skill.packs | agent_skill.pack.list | 菜单索引，只有标题、版本、成员摘要、适用任务与可用性 |
| agent.skill.pack | agent_skill.pack.get | 精确版本、绑定和成员索引，不默认加载全部正文 |
| agent.skill.pack.preview | pack.get＋指定 revision 的 skill.get | 按 Operation/Role 预览实际组合及预算，不调用生成模型 |
| agent.skill.pack.default.get | agent_skill.pack.default.get | 读取当前小说默认 |
| agent.skill.pack.default.set | agent_skill.pack.default.set | CAS 设置或取消默认；仅保存偏好，不发送任务 |

成员正文沿用 `agent_skill.get` 的指定版本读取，不新增另一套模型生成接口。首版更新 bindings/核心声明需新草稿、新 Revision 和验证，不允许 get/list/default API 执行方法正文。

Python HTTP 与 FastMCP method dispatcher、Runtime health capabilities、Electron preload 与 Renderer 类型同时更新，前端在旧 Runtime 上显示“当前运行服务暂不支持文风包选择”，不能发送未知 kind 后退化为单 Skill。

## 6. 版本冻结、执行与 LangGraph

```mermaid
flowchart LR
  A[选择单 Skill / Pack / 本书默认] --> B[结构化 Intent]
  B --> C[现有计划中的 Operation 与 Role]
  C --> D[PackResolver 解析完整包版本]
  D --> E[冻结每一步的成员版本与选择原因]
  E --> F[现有 SkillCompiler 与输入预算检查]
  F --> G[现有 LangGraph 执行]
  G --> H[产物与实际加载记录]
```

**不为 Pack 新建一套多 Agent 图，不引入 LangChain 或升级 LangGraph。** PackResolver 是计划准备阶段的确定性解析器，执行仍使用当前图、预算、取消和检查点逻辑。

新数据字段建议：

- `AgentPlanStep.skillPackSelection?`：Pack ID、Revision、包哈希、来源（explicit/novel_default）、Operation/Role、最终辅助模式和 reasonCodes。`step.skills` 继续保存真正加载的成员引用，最多两个。
- `AgentPlan.skillPackRequest?`：本次统一入口设置，包含小说与默认设置修订，供调整计划时解释，不是执行时重新查默认的指令。
- `AgentRun.skillPackSnapshot?`：已批准步骤的包版本和逐步组合。继续使用既有 `skillSnapshot` 保存成员快照，避免靠全局去重丢掉不同步骤的组合关系。

成员注册/正文缓存按 `(skillId, revisionId, contentHash)` 管理；读取一个新版本不能覆盖已锁定版本。Plan 准备时只加载所需成员版本；执行/重启恢复从已锁定引用重建注册集合。若保存成员正文快照，应连同哈希验证，并明确不能取最新正文补位。

冻结时点是计划准备完成、用户看见具体组合之前。审批等待期间包发布新版本，不改变当前计划。Run 开始前验证冻结内容可读与哈希一致；新任务读取最新默认设置所指定的版本。运行中禁用包只影响新任务，停止现有任务使用已有取消流程。

从失败检查点继续复制原 Run/Plan 的包与成员快照，不查询当前默认、不重新解析组合、不重新执行已完成模型请求。更换包/成员/辅助方式属于调整并重新规划，不能伪装为原任务恢复。

上下文预算使用完整所选正文及现有模型计量器，仍为一次任务生成的规则材料。超限应在收费请求前显示实际成员和预算缺口，不静默裁掉某个成员、摘要规则或另加多个 Agent 来消化它。

## 7. 保存与旧数据迁移

新 Pack 提交只保存包和成员，不创建新的全局启用平面默认绑定。设为本书默认由专用设置接口完成。修正保存后 UI 文案，不再提示在 `/` 里选择一个并不存在的“整包 Skill”。

不能直接删除所有 `pack_primary/pack_auxiliary`：现有用户可能正在依赖自动绑定。采用一次性、有记录的匹配迁移：

1. 根据已提交 Pack Revision 的成员引用、Operation/Role、scope/owner 和平面绑定的类型，重建归属；不依赖标题、priority、创建时间猜包。
2. 只有成员启用状态、全部已启用绑定与一个 Pack 一一对应，且没有竞争的非 Pack 默认或其他包时，才建立固定版本的本书默认引用，迁移其已归属的旧绑定为停用，保持原有组合。
3. 多包竞争、缺少引用、残留/不完整绑定、用户全局来源或非 Pack 默认竞争时，不自动推断偏好；保留旧行为为 `legacy_bindings` 路径，并显著显示待确认的实际组合与“选择一个默认包”。
4. 用户明确选 Pack/设默认/显式不使用时，新原子解析优先于 legacy 路径；未选且未迁移的旧用户可继续原有功能，不能无提示失去规则。
5. 迁移在 Electron 事务中执行并记录版本，重复启动不重复设置。已创建的 Plan/Run 不重新解析，原 Skill Snapshot 可继续恢复。

此过渡承认旧平面绑定缺少来源，不能宣称存在无损、无歧义的一键迁移。旧包多章续写缺语言的问题也不能靠迁移改变；需要新包修订与验证。

## 8. 文风生成与组合验证

新生成器输出语言核心声明，并用确定性模板建立写作绑定，再让模型规划选择辅助候选。Pydantic 和 Native 对同一策略做校验；普通 Pack 的主成员不受文风模板限制。

修改正文、绑定或允许的辅助候选都形成新的 authoringInputHash，并使相应验收失效。不能只改为语言＋群像就沿用语言＋悬念的通过结论。

对新 v2 文风包，试写以 **主成员版本＋辅助成员版本＋任务模式** 去重验证，主辅顺序也是组合身份的一部分；覆盖默认写作组合及 UI 允许切换到的辅助组合。未覆盖的辅助不能标成“已验证”，首版文风发布不将其暴露为可选。分析/编辑绑定按对应产物要求做应用验证，不能用写作试写证明诊断输出正确。

运行时解析/预览不新增模型调用；生成或修订包的组合验收会增加实际请求，沿用现有预算和缓存，并显示组合数。质量分级与示例校对等此前人工复核问题单独处理，不以“有统一入口”宣称正文质量已提升。

## 9. 错误与状态

建议新增或归一到明确错误：包不可见/停用、包版本不可用、成员版本不可用、绑定不支持、成员不兼容、包内容哈希不匹配、显式选择冲突、默认设置版本冲突、完整规则超过输入预算。

错误显示“哪个包/版本、哪一步、缺什么、可采取什么动作”。选择列表加载失败保留输入与用户选择，提供重新加载；不能替用户清空选择后无规则执行。CAS 冲突回传当前偏好，用户输入仍保留。

运行中的发现走既有统一失败链路，关闭进行中活动并发出终态；保存草稿与已完成结果保留。是否开放恢复按具体错误确定：服务短暂连接问题可以恢复原快照，缺失版本或不兼容组合需要调整规划，不能用泛化重试按钮反复生成收费请求。

## 10. 开发范围与验收顺序

| 阶段 | 工作 | 完成证据 |
| --- | --- | --- |
| P1 | Pack v1/v2读取、精确版本接口、默认偏好、备份和迁移 | SQLite 临时库：旧数组、新结构、双包不混选、CAS、恢复 ID 映射 |
| P2 | 结构化入口、PackResolver、冻结快照与恢复 | 单 Skill/不使用兼容；新任务与旧 Run 使用各自版本；未知请求不重复发送 |
| P3 | `/` 包入口、辅助覆盖、本书默认和逐步加载展示 | 一次选择可用；发送失败保留；切书隔离；服务旧版本不错误降级 |
| P4 | 新文风核心绑定与不同组合验证 | 多章写作仍加载语言；默认与允许辅助组合都有对应验收记录 |

首版必须同时交付 P1–P4，不能只加一个菜单项。包正文内容修订是独立任务，不能顺带重跑用户十章分析。

关键验收用例：

- 保存 Pack 不改本书默认；设为默认后，新的匹配任务应用；取消默认不删除技能。
- 同书两个包 A/B，选 A 时全部成员来自 A，B 的高 priority 也不能插入。
- 新建、续写、多章续写加载语言核心；群像覆盖只在允许且兼容时采用。
- 显式单 Skill 不被默认包补齐；本次不使用关闭全部可选方法；普通聊天不自动生成正文。
- 有关步骤显示真实组合，无关专家显示不适用；全部不兼容时执行前可操作报错。
- 默认/包更新、成员独立更新、审批等待、重启和失败恢复均不能偷偷换已冻结版本。
- 草稿/停用/归属错误/缺失成员/读取失败/预算不足均不能变成“已加载并成功执行”。
- 旧单 Skill、没有 Pack 的用户、旧 Pack 和多包歧义迁移按明确兼容路径运行。
- HTTP/FastMCP、IPC、Renderer/Native 类型契约一致；不改变工具权限、写回审批和取消语义。
- 以真实十章产物的离线副本验证索引、预览和绑定；费用为零。实际模型应用验证由用户启动，不自动执行。

## 11. 实施文件边界

- `packages/core/prisma/schema.prisma`：默认偏好及关联；同时处理生成客户端和桌面既有 ensureSchema 策略。
- `apps/desktop/electron/agentSkills/AgentSkillStore.ts`：Pack 索引/精确版本、默认事务、提交行为及旧数据迁移；包 JSON 校验保持可测试。
- `apps/desktop/electron/automation/AutomationService.ts`、preload、Renderer 声明：接口贯通。
- `agent_runtime/novel_agent_runtime/agent_skills/`：Pack 类型、解析器与指定版本注册加载；Compiler 仍处理实际成员。
- `intent/schemas.py`、`intent/service.py`：确定性传递包选择，不让语义模型改身份。
- `runtime.py`、`schemas.py`、`main.py`：计划应用、能力声明、快照和恢复；不在执行图里重复查默认。
- `shared/agentSkillComposer.ts`、`AgentSkillSlashMenu.tsx`、`AgentWorkspace.tsx`、产物卡与计划显示：统一入口、设置和实载说明。
- 文风生成/校验/`style_quality.py`：核心绑定与实际组合验收；复用既有证据与请求缓存。
- `electron/backup`：默认偏好依赖、复制/替换恢复与旧备份兼容。

数据库事务、按需全文加载和运行预算职责维持现有架构。此次设计不要求引入新框架依赖。
