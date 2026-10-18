# 完整备份与恢复需求与设计

状态：需求 v2.0 + 首版实施记录（全量备份/恢复与周期保护已实现，尚未发布；具体范围见第 15 节）

日期：2026-10-08

适用范围：Windows / macOS 桌面端、Electron Main、SQLite 业务库、作品资源文件、Agent 历史与审核资料。

文档定位：本文件是备份与恢复的统一需求入口，替代原 v1 方案；旧 `.nebak` 的读取兼容继续保留。

## 1. 目标与现状

作者应能把作品、资料、图片和未提交草稿一起带到另一台设备，也能在恢复错误或应用崩溃后返回恢复前的完整状态。软件必须说明备份包含什么、缺少什么、恢复将影响什么，不能仅凭压缩包生成成功就宣称完整备份成功。

### 1.1 实施前基线

- `apps/desktop/electron/services/BackupService.ts` 使用 ZIP / `.nebak`，可选 AES-256-GCM 加密；v1 数据为 `data.json` 或 `data.bin`。
- 当前导出覆盖 Novel、Volume、Chapter、Character、Idea、Tag、AgentConversation、AgentMessage、AgentAttachment 九类数据，未覆盖全部业务模型、隐式关联及资源文件。
- `performRestore` 先删除现有数据，再在当前业务库中循环重建；级联删除会影响包内没有保存的关联资料。事务只能保护数据库，不能同时保护图片、JSON 文件和 Runtime 状态。
- `createAutoBackup` 仅在恢复前调用，保留最近三份，并吞掉失败异常；当前不能视为周期自动保护，也不能作为覆盖恢复的可靠前置条件。
- `ReviewCommentStore` 将审批意见保存到 `automation/review-comments.json`；只遍历 Prisma model 会漏掉这些作者资料。
- `AgentAttachment` 当前保存已提取的文本、结构和提取元数据，未持久保存原附件文件；设计不能声称已经能备份原文件。
- Python 状态与执行图分别位于 `agent/agent_state.db`、`agent/agent_graph.db`；业务库中另有 Run、事件、产物、草稿和 Operation 台账。复制业务库不能保证正在执行的图可恢复。
- AI 设置含设备凭据；`ai-settings.json`、Automation 临时 Token 与 CLI 配置不能通过复制整个 userData 一并导出。
- `DatabaseLifecycle` 已有版本化迁移，`DurableDraftCutover` 会按设备文件标记决定是否清理 Agent 数据；恢复必须避免再次触发历史清理。

### 1.2 成功定义

1. 在空白设备恢复完整包后，正文、作品资料、关系、锚点、图片、对话、报告、草稿、审批意见和自定义 Skill 可访问，引用不悬空。
2. 作者未确认写回的草稿仍为草稿；恢复不调用模型，不写回正文，不重新投递历史副作用。
3. 包损坏、密码错误、资源不足、迁移失败或中途崩溃时，原数据集仍可使用或可确定性回滚。
4. 已有作品可通过“恢复为副本”安全共存；作者只恢复一本作品时，其他作品及全局设置不被替换。
5. 凭据不随包迁移；需要重新配置的 AI 服务在完成页明确提示。

## 2. 范围与优先级

| 编号 | 优先级 | 需求 |
| --- | --- | --- |
| BR-01 | P0 | 数据与文件覆盖清单、同一时点快照、校验和与完整性标识 |
| BR-02 | P0 | v2 全量包导出、密码保护、大文件流式处理 |
| BR-03 | P0 | 预检、恢复预览、已验证安全快照、分阶段恢复与崩溃回滚 |
| BR-04 | P0 | 全量替换、完整包恢复为副本、旧 v1 安全导入 |
| BR-05 | P0 | Agent 状态隔离、未知副作用保留、迁移与 Cutover 兼容 |
| BR-06 | P1 | 选择作品备份、从全量包选择作品、单作品替换与依赖闭包 |
| BR-07 | P1 | 周期自动备份、保留策略、失败提示与备份列表 |
| BR-08 | P1 | 无凭据偏好迁移、恢复报告、索引重建与真实桌面验收 |

P0 全部通过后，才能替换当前覆盖恢复入口。P1 完成前不得将“单作品恢复”“周期自动备份”写成已提供的能力。所有阶段均以完整性为前提，不能以遗漏历史或图片换取“备份成功”。

不包含：云同步、团队协作、正文版本库/回收站、正文 TXT/DOCX 导出、移动端交付、自动续跑恢复前的 Agent 图。它们不能替代备份，也不阻塞本需求。

## 3. 数据覆盖与完整性规则

### 3.1 注册表

新增版本化 `BackupDomainRegistry`，每个持久对象必须登记：来源、序列化版本、归属、依赖、资源字段、ID 重映射规则、恢复顺序、是否重建及验收断言。覆盖数据库实际表与 Prisma schema，也覆盖独立文件存储；不能依靠固定九表数组或仅数据库外键推断归属。

CI 必须比较注册表、Prisma model、数据库扩展表和受管文件存储。新增持久数据没有分类时失败。缓存与内部元数据也必须明确登记为排除或重建，未知业务表不得静默忽略。识别到未知内容时，阻止标为完整包，给出需要升级应用的原因。

### 3.2 当前数据分类

| 领域 | 当前模型/来源 | 备份与恢复要求 |
| --- | --- | --- |
| 作品与正文 | Novel、Volume、Chapter | 所有字段、顺序、版本、删除标识、formatting、原始 Lexical JSON/空正文/旧版纯文本；保留原始字节，不进行格式转换 |
| 人物与世界 | Character、Item、ItemOwnership、WorldSetting、Relationship | 自定义 profile、物品/技能/地点、归属、角色关系及排序 |
| 故事结构 | PlotLine、PlotPoint、PlotPointAnchor | 情节状态、描述、顺序、章节和段落锚点 |
| 灵感与标签 | Idea、Tag、Idea.tags 隐式多对多 | 显式导出 `ideaTags` 关联边；保留 quote、cursor 与章节关联 |
| 地图 | MapCanvas、MapElement、CharacterMapMarker | 地图背景、文字/图标元素、位置和角色标记 |
| 摘要与记忆 | ChapterSummary、NarrativeSummary | 全部已有版本及来源指纹；保留作者约束和状态，不能只保存最新摘要 |
| 会话与附件 | AgentConversation、AgentMessage、AgentAttachment | 消息顺序、输入草稿、上下文摘要、计划、用户决定、提取文本和结构；原附件文件按 3.3 处理 |
| 执行与报告 | AgentRun、AgentRunEvent、AgentArtifact、AgentRevisionTask | 历史状态、报告、审核结果、待改清单与关联；按第 7 节处理可执行状态 |
| 模型结果 | AgentModelResultCheckpoint、AgentModelRepairAttempt | 保存已有结果和修复历史；归属按真实 requestId 引用解析，不用时间范围猜测 |
| 草稿 | DraftSession、DraftBatch、DraftBatchChild | payload 中原文、草稿、版本快照、批次依赖、写回/撤销台账等完整保存 |
| 生成操作 | DraftGenerationOperation、DraftGenerationAttempt、DraftOperationOutbox | 保存幂等键、尝试、结果和未知状态；恢复不领取租约、不重新发事件 |
| 自定义 Skill | AgentSkill、AgentSkillRevision、AgentSkillBinding、AgentSkillDraft、AgentSkillPack、AgentSkillPackRevision | 用户/作品规则、历史版本、草案、工作区内容及绑定依赖；包内内容不自动执行 |
| 审批意见 | `automation/review-comments.json` | 转为版本化 `reviewComments` 领域记录，保存段落/diff 锚点、版本、发送与处理状态 |
| Runtime 历史 | AgentStateStore / tool_invocations | 导出经过结构校验的历史与调用结果台账，去重业务库已有事件；保留未知副作用凭据，不携带活动执行图 |
| 偏好 | `editor_preferences`、`user_shortcuts` 等允许字段 | 可选、默认不恢复；只含显示与编辑偏好，经过 Main 白名单校验 |
| 同步状态 | SyncState | 不迁移旧游标；恢复后停用同步，明确重新关联与冲突确认后才能启动 |
| 可重建数据 | 全文搜索、`rag_vector_chunks` 等索引/缓存 | 不进入便携包，恢复后重建；状态明确，不影响正文可读 |
| 设备设施 | 迁移记录、Cutover 标记、后台租约、端口等 | 不作为作者数据导入；由本机恢复流程正确生成/归一化 |

模型分类以实施时 schema 为准。任何后来增加的版本库、回收站或作者规则同样属于持久作品数据，必须补进注册表和往返测试。

### 3.3 文件、图片与外部引用

- 从实体字段和已知 JSON/Lexical 节点追踪 `covers/`、`characters/`、`maps/` 及其他受管资源；不整目录递归打包 userData。
- 每个文件记录 resourceId、SHA-256、字节数、媒体类型及字段引用，按内容去重；包内使用平台无关相对路径。
- 已内嵌的 Base64/data URL 保留并校验，不改变图片语义。受管文件采用一致快照，不允许读到半写入文件。
- 外部绝对路径仅在作者明确纳入且本地可读取时复制为受管资源；不递归扫描外部目录。不自动访问 URL 或下载网络图片，URL 作为外部引用列入报告。
- 受管资源缺失或读取失败时，默认阻止完整包发布；作者可选择导出“缺资源备份”，私有清单标 `completeness=degraded`，准确列出对象和缺项。损坏正文/数据库关系不能降级放行。
- 当前 Agent 附件以提取内容为备份对象，清单标明 `originalFileStored=false`，不能展示“原文件已备份”。未来增加原文件持久化时，必须登记资源且通过 hash 校验。
- P0 不要求补造过去不存在的附件原件。资源完整性的定义是“源端已持久保存的资源全部保留”，外部依赖与原件未保存必须可见。

### 3.4 单作品依赖闭包

选中 Novel 后包含该作品全部领域及间接依赖，尤其包含没有 Prisma 外键的 DraftSession/Operation、JSON 内引用和 Runtime 请求台账。遍历到稳定集合后验证所有引用。

- 用户级 Skill/Pack 仅携带作品绑定或历史草稿实际引用的版本依赖，不携带无关作品和全局绑定。
- 导入依赖时，已有同 stableId 且内容完全一致的版本可以复用；冲突生成独立身份与来源标记，不覆盖当前用户规则，也不新增其他作品的绑定。
- 全量包保留全部用户级自定义规则及其草案；内置只读规则记录版本，恢复时从本机版本解析，不覆盖程序内置资源。
- 模型结果按 requestId / repairAttemptId 的关联闭包筛选；无法证明归属的记录不能泄漏进单作品包，单作品完整包在依赖不可解析时应失败。全量包保存全局无归属历史，并说明其归属未知。

## 4. v2 便携格式

扩展名沿用 `.nebak`，新写入格式固定为 v2。便携包采用逻辑数据，不直接分发业务 SQLite、Python 图数据库或本机目录。

```text
backup.nebak                       # 外层 ZIP，载荷项不再二次压缩
├── manifest.json                  # 最小公开头
└── payload.zip                    # 无密码时
    或 payload.bin                 # 有密码时：完整 payload.zip 的密文

payload.zip（解密后）
├── bundle-manifest.json            # 私有清单、作品目录、统计、缺项、entry hash
├── data/<domain>.ndjson            # 分领域记录与关联边
├── resources/<sha256>/<file>       # 受管资源
└── preferences.json               # 可选允许字段
```

### 4.1 清单契约

公开头必需字段：`formatVersion=2`、backupId、appVersion、createdAt（UTC ISO-8601）、sourcePlatform、encrypted、payloadBytes、payloadSha256；加密时增加 KDF 标识、迭代次数、随机 salt、IV、authTag。公开头不暴露作品名称、角色、正文、源绝对路径或设备凭据。

私有清单必需字段：dataContractVersion、sourceDatabaseSchemaVersion、scope（all/novels）、novelIds、snapshotId、snapshotAt、completeness、domains、resources、excludedDomains、warnings、runtimePolicy（archive_only）。每个领域有记录数、序列化版本、文件大小和 SHA-256，每个资源有引用清单与 hash。

- 备份格式版本、数据契约版本、数据库迁移版本分别管理；不得仅比较 appVersion 决定兼容。
- 必需领域即使为空也写出零条清单。未列出与“确实为空”必须能区分。
- DateTime 使用 UTC，BigInt 使用十进制字符串，布尔值/空值保持类型；正文及未知自定义文本保持原字节语义。
- NDJSON、资源复制、压缩和加解密使用流式处理；不得先把全部数据 JSON、ZIP 和密文同时读入内存。读取每条记录也有大小限制。
- 无密码包的 hash 用于损坏检测，不代表可信签名；所有导入数据仍按不可信输入校验。

### 4.2 密码与凭据

- v1 继续按原 AES-256-GCM + PBKDF2-SHA256 100000 次参数读取；v2 使用 AES-256-GCM，salt 16 字节、IV 12 字节，每次导出重新随机生成。
- v2 初版 PBKDF2-SHA256 默认 600000 次、32 字节派生密钥；参数写入头，接收端限制为已支持范围且最高 2000000 次，防止恶意参数消耗资源。实现前做低配置设备耗时验证；调整默认需升级文档与测试。
- 对完整载荷加密，正文和图片不得混用“正文加密、图片明文”。公开头关键字段通过规范化 AAD 认证，先完成认证再使用暂存明文构建恢复候选。
- 用户主动导出时可设置密码并二次输入；不记录、不记住明文密码。密钥只在本次工作内存使用，最佳努力清理。
- `ai-settings.json`、API Key/Token、代理认证、CLI/MCP 环境配置、Automation runtime Token、日志、安装缓存和备份历史不进入包；不提供“顺便备份密钥”选项。
- 不能自动删改用户写在正文/对话中的敏感文字；提示备份含作品与历史对话，密码保护适用于整个包。凭据排除承诺针对应用管理的配置和运行设施。
- 同设备恢复保留现有 AI 配置；跨设备恢复后按当前设备配置使用或提示重新配置。新包不能覆盖本机凭据。

## 5. 备份创建与一致性

状态：`queued → preparing → waiting_idle → snapshotting → packaging → verifying → completed`，失败/取消分别为 `failed/cancelled`。对外统一返回 jobId、阶段、已处理数量/字节、结果与错误码。

1. 确定范围、密码和目标文件；取消系统对话框返回 cancelled，不显示成功。
2. 检查目标可写、范围有效、空间预估与已有任务。导出文件使用 `.partial`，完成验证后同文件系统原子改名；不得先覆盖原有有效备份。
3. 通过应用统一写入屏障，拒绝新 Agent Run、Operation、Automation/MCP 修改、同步写入及资源修改；等待当前数据库/文件写入队列排空。Renderer 将当前正文与会话输入草稿 flush 并确认落盘。
4. 活跃模型调用/草稿任务时，周期备份延后；手动备份提供“等待任务完成”与“停止任务后备份”。停止遵循既有取消链并确认写入停止，不以杀进程后立即复制充当快照。无法确认静止时失败，正文不受损。
5. 在短写入屏障期间通过 SQLite 一致快照机制生成隔离快照，保存文件型存储和资源引用集合。不得只复制活动 `.db` 而忽略 WAL；审阅意见队列与资源写入队列也必须排空。
6. 将引用资源复制到快照暂存区，固定 hash，完成后释放屏障。大资源复制首版保持屏障，UI 显示阶段；后续优化仅允许采用不可变资源版本，不能提前解锁后从可变原文件打包。
7. 从隔离快照导出闭包、关联边和允许字段，执行完整性与资源校验，再压缩/加密。整个过程中不请求模型、不重建 RAG。
8. 重新打开生成包并核对清单、认证、记录数与全部 entry hash，成功后发布文件。失败或取消只清理本 job 暂存内容，不轮替有效备份。

“备份时点”是已持久化的 snapshotAt；没有响应 flush 的其他窗口不能默认认为已经保存。所有窗口和外部写通道必须纳入屏障，否则不得生成完整包。

## 6. 恢复模式与确认流程

### 6.1 模式

| 模式 | 用途 | 身份与影响 |
| --- | --- | --- |
| 恢复为副本（默认） | 从包取回全部或指定作品，保留当前数据 | 所有导入作品生成新身份；标题默认加“恢复副本”；未选作品不导入 |
| 替换指定作品 | 把一部作品退回备份状态 | 明确选择源作品与当前目标，只替换目标闭包；不按标题自动匹配 |
| 替换全部作品资料 | 整库回滚/迁移 | 预览当前受影响作品列表，确认后切换完整候选数据集；不替换凭据和同步关联 |

备份文件不能决定恢复模式；默认副本。P0 完整包副本导入包含包内所有作品，P1 再开放选择作品与指定作品替换。正文/设定字段级合并不在本期范围。

### 6.2 预检与预览

1. 选择包、需要时输入密码，读取受限清单；错误不触碰当前数据。
2. 验证格式、版本、认证/hash、重复条目、记录 schema、ID/唯一约束、关联闭包、资源及空间，生成只读恢复预览。
3. 预览展示作品和章节数量、资料/图片/草稿/会话数量、缺失与外部引用、版本兼容性、选用模式、将替换的当前作品，以及“Agent 历史保留但不会自动续跑”。当前有活跃任务时，明确展示恢复会停止的任务；作者可返回等待结束，不能默默中断其他作品的任务。
4. 缺资源包必须显示具体缺项，作者确认后才可继续；正文/关系损坏、未知必需领域、未来格式或不支持的迁移直接阻止。
5. 选择可选偏好（默认保留当前），点击“开始恢复”；覆盖模式需确认具体影响，不能以选文件动作代表覆盖授权。

Main 生成一次性 restorePlanId，绑定源包 hash、模式、范围、目标 datasetId 与业务变更代号、预检版本及过期时间。不能仅依赖 updatedAt 或 Renderer 传回的统计。进入提交屏障后再次校验；当前数据变化则刷新预览，禁止按过期计划覆盖。

### 6.3 候选构建、提交与回滚

首版采用“新数据集 + 单一活动指针”，不在当前业务库 `deleteMany`。数据库、图片和文件型资料同属一个数据集；普通文件 rename 加数据库事务不能宣称跨文件原子性。

```text
userData/
├── active-dataset.json              # 当前 generationId，原子替换
├── datasets/<generationId>/
│   ├── novel.db                     # 当前 schema 的业务库
│   ├── resources/                   # 受管资源
│   ├── automation/review-comments.json
│   └── agent/                       # 本数据集本机 Runtime 状态
├── backups/{manual,auto,rollback}/   # 不嵌套进备份载荷
└── recovery/<jobId>/journal.json     # 本机恢复日志，不含正文/凭据
```

1. 预检后进入维护屏障，flush 当前编辑，停止 Runtime 和所有后台 writer，封存迟到回调；所有写请求校验 datasetEpoch，旧代请求不得写新库。
2. 创建并验证恢复前的完整安全快照，固定 rollbackId；失败必须阻止恢复，不能沿用吞异常的 `createAutoBackup`。原数据集保持完整，回滚点不参与普通自动轮替。
3. 在独立候选目录创建当前 schema 的数据库：副本/单作品模式以当前快照为基底，全量替换以空库为基底，再导入逻辑记录、映射 ID 和文件资源。
4. 使用隔离连接完成关联、正文节点、资源、计数、草稿版本和状态校验。只有候选通过才允许提交；不得加载包内 SQL、脚本或程序。
5. 先落盘候选完成标记和 recovery journal，再原子切换活动指针；同卷文件写入/rename 与耐久化流程必须经平台验证。
6. 重建 Main 服务实例/Prisma 连接、文件缓存和资源协议映射，刷新 Renderer，离线验证正文、资料、图片、草稿与状态可读取；不启动模型和任务。
7. 验证通过后记录 committed，释放屏障，按第 7 节启动隔离后的 Runtime；索引后台重建。原 generation 和安全快照保留至规定期限。
8. 激活/验证失败则关闭新连接，恢复旧指针与服务，记录 rolled_back；若回滚也无法激活，保持恢复模式，只提供重试回滚/选择已验证快照，不向空库开放写入。

副本/单作品恢复的候选必须继承当前数据集中未受影响的资源、文件型资料、设备已确认的 Runtime 历史及停止后的本机状态。第 7 节的导入隔离只作用于包中记录，不得把其他作品的 Outbox、草稿和历史也改成导入状态。维护期间已被明确停止的当前任务按真实取消/中断记录保留；回滚不会重新发起这些任务。索引只失效受影响来源，全量替换则全部重建。

取消在切换指针前立即停止并保留原数据；切换后 UI 显示“正在完成或回滚，暂不能取消”，不承诺随时中断。

启动时必须先读取 journal 再开放数据库与 writer：未切换的候选丢弃或重试；已切换未 committed 的候选重新验证，失败回旧代；committed 直接使用新代。每个边界断电后必须可确定当前代，不能根据目录修改时间猜测。

### 6.4 与现有目录的适配

新增统一 `DatasetPathResolver`，替代 main.ts 的 covers/characters/maps 路径、资源协议、数据库路径、ReviewCommentStore 和 Runtime stateDir 等直连 userData 路径。初次升级将旧数据作为 legacy generation 读取，验证迁移后再切换指针；禁止启动即清空旧目录。

设备级 AI 配置、日志、备份目录和临时 Automation descriptor 留在 userData 根；作品级文件随 generation 走。数据库迁移使用现有不可变版本链，候选完成后写入本机已验证的 Cutover 完成标记，使 `applyDurableDraftCutover` 不再清掉恢复的会话和草稿。标记不得直接信任包内设备文件。回滚也须恢复匹配的标记和 Runtime 代。

## 7. Agent 恢复语义

### 7.1 历史保留，执行隔离

- 便携包不导入活动 Python graph checkpoint、进程信息、租约、临时端口/Token，也不把旧 userData/agent 原样覆盖本机。
- 历史 Run、事件、计划、审批和调用台账保存。running/queued/waiting 状态投影为“恢复后已中断”，保留 originalStatus 与来源；历史审批可查看，但不能直接提交给旧 Runtime。
- 原终态 completed/failed/cancelled 保留；追加恢复边界记录，不修改原事件顺序/内容，不伪造模型完成事件。
- DraftGenerationOperation 移除活动 leaseOwner/leaseExpiresAt，保留结果；未知副作用继续显示“需要对账”，不得改成成功、未发生或可自动重试。
- 导入的 Outbox 标为历史隔离，禁止启动 worker 时投递；需要新增可迁移状态时走正式 schema migration，不能复用 pending。
- 导入模型结果可供查看或离线格式修复；旧 requestId/providerResponseId 不再作为新调用的幂等键。
- 已保存草稿继续可审阅，提交前重新验证当前正文版本/hash、目标身份及未决意见。来源不完整、未知副作用或冲突的草稿保持不可直接写回。
- 用户选择“基于历史重新开始”时创建新 Run/requestId，引用历史报告和草稿重新规划；正文写回仍经既有审核流程。

### 7.2 ID 与嵌套引用

恢复为副本需要重映射 Novel/Volume/Chapter、实体、会话/消息、Run/Event/Artifact、附件、草稿/批次/Operation、请求/修复标识、审核意见和自定义 Skill/Pack 身份；复合键及 operationKey 也须重新生成。原身份作为来源元数据保留。

注册表必须通过对应 schema/节点解析器处理：Lexical Mention/PlotAnchor/IdeaMark、profile 约定引用、payloadJson、plan/run/contextSummary、审批、review anchor、sourceSnapshot、写回/撤销记录、Skill manifest/pack bindings 中的结构化 ID。禁止全文字符串替换，以免改坏正文、摘录和内容 hash。

映射导致结构化文档/hash 改变时，重算派生指纹并记录转换报告；源指纹独立保留。无法安全识别的可执行引用阻止恢复相应完整领域，不能悄悄丢弃规则或跨作品连接。历史自由文本中出现旧 ID 不自动改写，仅将结构化链接解析到新 ID。

恢复为副本及指定作品替换不允许携带可直接执行的历史撤销动作；保存历史快照并展示，新的写回产生新撤销台账。全量原身份恢复的既有撤销也需重新验证对象 hash 与版本，验证失败禁用。

## 8. 旧包兼容

- v1 读取 manifest.version、data.json/data.bin，兼容原加密参数，并接受当前九表及更早六表结构。
- v1 固定标为 legacy_incomplete，缺少字段不是“零条资料”。预览明确列出没有保存的领域和图片文件。
- v1 仅允许“恢复为副本”；即使作者选全部，也不允许覆盖现有作品和资料。需要历史整库灾备时保留原包供专门迁移，不借此恢复入口清空当前库。
- 缺关系记录仅在 v1 兼容转换有明确规则时生成报告；缺失父实体、重复 ID 或非法正文阻止相关作品导入。无法导入的作品不能以局部成功冒充完整成功。
- 引用存在于备份之外的图片显示缺失占位和修复入口，不扫描本机猜测文件，不把其他作品同名图片绑定进去。
- v2 只支持已登记的数据契约迁移；新于当前 reader 的必需领域/格式拒绝导入，提示升级应用，不降级猜测。

## 9. 自动备份与空间

- P1 默认开启周期自动备份；有持久业务变化且距上次成功快照不少于 15 分钟、连续空闲不少于 30 秒时触发，活跃 Run/写入则排队延后。长期延后超过 60 分钟在设置及状态提示“尚未形成新备份”，不强制取消作者任务。
- 应用启动只检查/修复备份状态；退出时仅最佳努力完成，不把退出备份作为唯一保护。不变更时不重复生成，不补齐关机期间所有周期。
- 默认保留最近 10 份、最近 7 天每天最后一份、最近 4 周每周最后一份；同包去重计算。自动目录软预算 2 GiB，保留最新 3 份有效包及固定回滚点优先，无法满足预算时提示，不删除最后可用备份来凑空间。
- 每包为独立全量快照，本期不做依赖链式增量。轮替只在新包完整验证后执行，损坏包不算有效备份。
- 覆盖恢复前快照至少保留 72 小时，并保证当前恢复成功/回滚确认前不清理；用户可固定保留。手动导出文件与固定包不自动删除。
- 默认本机自动包不加密码，面板明确说明其包含作品内容；导出到外部位置可重新包装成密码保护包。本期不自动保存用户密码，不把设备密钥加密包宣传成跨设备可读。
- 首版目录固定为本机 backups/auto，提供打开目录；自定义周期、容量和备份目录为后续可选项，不阻塞默认保护。
- 磁盘不足、目录不可写、校验失败均保留上次成功备份并记录失败状态。周期失败不阻止正文保存；恢复前安全快照失败必须阻止恢复。

## 10. 交互与接口

### 10.1 设置面板

现有“备份与恢复”改为四区：创建备份、恢复备份、自动保护、最近备份。术语使用“作品资料备份”，与正文导出区分。

- 创建：全部作品/选择作品、包含偏好、密码保护、预计大小、备份时点与当前任务阻塞情况。
- 恢复：文件选择/密码 → 校验 → 作品与影响预览 → 确认 → 进度 → 完成报告；覆盖确认使用具体作品数量与名称。
- 列表：时间、来源（手动/周期/恢复前）、大小、完整性、验证状态、是否加密、固定保留/打开位置/恢复；不能仅用文件名推断状态。
- 完成：正文/资料/图片/草稿统计、缺项、ID 转换、任务中断、索引重建、偏好应用及 AI 配置提示。允许导出不含正文和凭据的恢复报告。
- 流程覆盖空态、取消、密码错误、损坏包、版本过新、磁盘不足、任务阻塞、长内容、窄窗口与回滚失败。新增 Agent 相关 UI 原型遵守项目既有 Stitch 门禁；本文不代表原型已确认。

### 10.2 Main / Preload 契约

新增类型化接口（名称为目标契约，实施时可沿用兼容封装）：

| 接口 | 职责 |
| --- | --- |
| `backup.create(options)` | 创建 job，scope/password/preferences；目标由 Main 文件对话框确定 |
| `backup.inspect({fileHandle,password})` | 预检并返回可展示目录，不执行恢复 |
| `backup.planRestore({inspectionId,mode,selection,target})` | 建立绑定源 hash/当前代的只读计划 |
| `backup.executeRestore({restorePlanId})` | 一次性执行已确认计划，幂等返回同一 job |
| `backup.cancel({jobId})` | 在可取消阶段请求取消 |
| `backup.getJob / backup.onProgress` | job 状态与分阶段进度，刷新后能恢复显示 |
| `backup.list / backup.pin / backup.openLocation` | 管理本机已登记备份，不接受任意路径删除 |
| `backup.getPolicy / backup.updatePolicy` | 自动保护设置与最近成功/失败信息 |

不直接向 Renderer 暴露原始路径、数据库句柄或解密载荷。fileHandle/inspectionId 由 Main 授权选择后产生，有有效期且绑定包 hash；密码不进入日志或 job 持久化。刷新导致密码丢失时重输，不能从状态文件读取。

### 10.3 状态与错误

恢复状态：`inspecting → awaiting_confirmation → quiescing → safety_snapshot → staging → validating → committing → activating → completed`；异常分为 `failed / cancelled / rolling_back / rolled_back / recovery_required`。每个状态记录可取消性、阶段计数和诊断编号。

错误码至少包含：CANCELLED、BUSY、FLUSH_FAILED、PASSWORD_REQUIRED、DECRYPTION_FAILED（密码错误或认证损坏）、CORRUPT_ARCHIVE、UNSUPPORTED_VERSION、INCOMPLETE_LEGACY、REFERENCE_INVALID、RESOURCE_MISSING、DISK_INSUFFICIENT、SNAPSHOT_FAILED、PLAN_STALE、MIGRATION_FAILED、ACTIVATION_FAILED、ROLLBACK_FAILED。用户文案解释影响及下一步，不直接展示 SQL 或内部 payload。

进度按真实阶段和数量展示，无法估算总量时使用阶段进度，不伪造百分比。事件不含正文、原始模型输出、密码、Token 或完整资源路径。新类型覆盖 Main、Preload、vite-env.d.ts 和共享协议；旧 backup:import 不得绕过新预检/确认流程。

## 11. 资源限制与验证边界

- ZIP 读取拒绝路径穿越、绝对/盘符/UNC 路径、symlink、重复 entry、平台大小写冲突和 Unicode 规范化冲突；暂存文件只能写入 Main 创建的 job 目录。
- 初始可配置上限：包 20 GiB、解压总量 50 GiB、entry 100000、单资源 2 GiB、单 NDJSON 记录 64 MiB；超限拒绝并解释。清单声明值与流式读取实际计数均检查，不能信任声明长度。
- 防止压缩炸弹：限制总输出、单项输出和解压工作量；对纯文本高压缩率用绝对限制与受控时间预算，不仅以压缩率误拒正常正文。
- 预检估算候选、暂存、解密载荷、安全快照所需空间，避免重复计入可复用原代；按各实际目标卷分别检查，预留 10% 或 512 MiB 的较大值，并在写入中继续处理空间耗尽。
- 加密暂存目录限定当前用户访问；认证前的暂存明文不供解析/渲染，失败删除。启动清理上次未完成的解密暂存，只针对验证后的 job 路径，不扫描删除 userData。
- 只读逻辑 schema 与允许字段；包内不允许执行 SQL、脚本、Skill 代码或模型请求。资源 MIME 与图片可解码性检查不能执行附件内容。
- 备份不是诊断包。校验、job 和恢复报告只包含计数、hash、阶段、对象标识及必要错误，导出报告默认不含作品标题，用户可另行选择包含。

## 12. 验收标准

### 12.1 自动化

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| AT-01 | 每个 model、隐式标签关系、扩展存储的覆盖 | 注册表无遗漏；fixture 的记录/边数量、字段与 hash 往返相等 |
| AT-02 | 图片、地图、Base64、附件提取内容、审核意见 | 图片实际可读，资源去重与引用正确；意见锚点/状态和提取结构保留 |
| AT-03 | 保存/资源写入/Agent/外部 MCP 并发 | 屏障形成同一时点快照，无半写文件、漏写关联、过时代回调 |
| AT-04 | 副本及单作品替换 | 结构化 ID 全部有效；正文自由文本未替换；其他作品/全局规则指纹不变 |
| AT-05 | 自定义 Skill、历史版本、Pack 与跨域依赖 | 相同版本正确复用，冲突独立保存，无额外绑定和隐式执行 |
| AT-06 | 草稿/Operation/Outbox/未知副作用 | 未批准草稿不写回、无旧租约/事件重投，未知状态仍要求对账 |
| AT-07 | v1 六表/九表、旧加密与缺领域 | 仅副本导入，缺项明确；取消/错误不删除当前资料 |
| AT-08 | 密码/截断/篡改/hash/未来格式/ZIP 攻击 | Main 拒绝，原数据和已验证备份不变，无目录外写入 |
| AT-09 | 空间不足、迁移/校验/安全快照失败 | 未切换当前代；安全快照失败阻止恢复 |
| AT-10 | 指针切换前后、激活、committed 写入等逐阶段故障注入 | 重启确定性选择/回滚，无半库或数据库与图片分属不同代 |
| AT-11 | 恢复后的首次启动与 Cutover | 不清空会话、草稿、审核意见；不默认发起任何 provider 请求 |
| AT-12 | 自动策略/轮替/长 Run 延后 | 使用可控时钟测试；失败不删最后有效包、回滚点不被轮替 |
| AT-13 | 凭据和偏好 | 应用管理的密钥/Token 测试哨兵不出现在包/报告；偏好默认不覆盖，源 AI 配置未导出 |
| AT-14 | 索引与同步 | 正文先可读，全文索引重建正确；RAG 缺 embedding 显示可用降级，同步不会自动上传 |
| AT-15 | 孤立/复合键/超大记录/新领域 | 校验报告明确；无法证明闭包不能标 complete；新增表漏登记使 CI 失败 |

比较算法区分保留字段、映射字段与归一化状态，不能只比较“恢复后小说数量相同”。JSON/Lexical 嵌套引用、历史 hash、资源和全局依赖都须有真实断言。

### 12.2 桌面与跨平台

- 在隔离 userData 中建立至少两部作品，包含所有领域、实际角色/地图图片、标签关联、已完成和未完成 Run、单章/批次草稿、审批意见及自定义 Skill。
- 真实 UI 导出、恢复为副本、替换指定作品、全量替换，再重启逐项读回；验证另一本作品未被修改。
- Windows → macOS、macOS → Windows 均验证路径、图片、中文/Unicode 名称、密码与重启；未实测方向不宣称通过。
- 真实 UI 验证取消、任务阻塞、错误密码、旧包缺项、损坏、磁盘不足和恢复失败后的回滚页。
- 压测基线：1000 章/500 万字符、10000 条会话消息、2 GiB 资源；峰值新增内存不超过 512 MiB，取消响应在可取消阶段 2 秒内，Renderer 不出现超过 1 秒持续冻结。实施前固定参考设备并记录分阶段耗时，不用虚假固定时长替代报告。
- 真实模型调用不是备份验收的必要条件：使用隔离任务 fixture 验证调度边界，并以请求计数证明恢复不发网络请求。

## 13. 实施顺序与交付门槛

1. **BR-A：覆盖与基础契约。** 注册全部数据源和文件资源，编写往返 fixture、v1 reader、v2 schema、snapshot barrier；先阻止旧入口无预检覆盖。
2. **BR-B：完整创建。** 全量流式导出、加密、资源/关联校验与原子发布；实现 job 状态，取消不报成功。
3. **BR-C：恢复基础设施。** DatasetPathResolver、legacy 目录迁移、journal、预检/计划、安全快照、候选激活/回滚；配套 DatabaseLifecycle/Cutover 测试。
4. **BR-D：P0 用户闭环。** 完整包副本/全量替换、旧包副本导入、Agent 隔离、恢复报告；完成所涉 UI 原型及实现验收。
5. **BR-E：P1 扩展。** 单作品闭包/替换、自动备份与轮替、可选偏好、索引状态和跨设备矩阵。

发布门槛：P0 自动化与真实桌面恢复闭环全部通过；不得只通过格式单测就启用覆盖入口。P1 可分批上线，界面和文档按实际交付显示支持范围。备份应在空白隔离目录演练恢复，不能对用户真实作品库做破坏性验收。

## 14. 实现影响与关联文档

主要改动边界与实现入口（实施状态见第 15 节）：

- `apps/desktop/electron/services/BackupService.ts`：拆出领域注册/快照/载荷 reader-writer/恢复协调/自动策略。
- `apps/desktop/electron/main.ts`、`preload.ts`、`src/vite-env.d.ts`：类型化接口、写入屏障、统一路径、资源协议和启动恢复门禁。
- `apps/desktop/src/components/Settings/BackupRestorePanel.tsx`：预检、范围/模式、确认、状态、列表和报告。
- `packages/core/prisma/schema.prisma`、`electron/database/DatabaseLifecycle.ts`、`DatabaseMigrations.ts`：必要状态/代际元数据及正式迁移，不改已发布迁移。
- `electron/automation/ReviewCommentStore.ts`、`DraftSessionStore.ts`、Operation/Outbox、AgentConversation/Review/SkillStore：排空、快照、引用映射、缓存失效与恢复隔离。
- `electron/agent/PythonRuntimeClient.ts`、`agent_runtime/.../store.py` / `invocations.py`：静止确认、结构化历史导出及隔离后初始化。
- `electron/search/searchIndex.ts`、`electron/ai/rag/*`：恢复后重建和状态展示；不得暗中调用付费模型完成恢复。

关联规范：

- [数据库生命周期](apps/desktop/electron/database/README.md)
- [Durable Draft Operation](docs/agent/durable-draft-operation-requirements.md)
- [Agent 会话连续性](docs/agent/agent-workspace-continuity-requirements.md)
- [失败恢复与副作用边界](docs/agent/retry-failover-resilience-requirements.md)
- [文件导入与会话附件](docs/agent/file-import-requirements.md)
- [Agent Skill](docs/agent/agent-skill-requirements.md)
- [本地日志与诊断](docs/desktop-logging-requirements.md)

第 1～14 节保留完整需求目标；当前代码支持范围以第 15 节为准。后续范围调整须同步注册表、兼容矩阵和验收标准。

## 15. 首版实施记录（2026-10-08）

### 15.1 已实现的用户闭环

- 设置 → 备份与恢复：全量 `.nebak` v2 导出、可选密码保护、预检预览、默认恢复副本、全量替换、二次确认、进度与取消。恢复后重新启动应用以重新建立数据库连接、缓存和资源协议。
- 39 个业务 Prisma 模型及 `_IdeaToTag` 隐式关联，共 40 个领域表；按实际字段导出，包括正文、版本、摘要、历史会话/消息、附件提取内容、运行/报告/检查点、草稿/批次/操作台账、审核意见和 Skill/Pack。
- 封面、人物图片、地图背景及已登记结构化图片字段中的受管资源随包迁移，按内容 SHA-256 去重。外部 URL 保留并提示，不自动下载；外部绝对路径要求先导入受管目录。受管图片缺失时阻止完整导出。
- 审批意见独立保存；Runtime 调用结果和未知副作用台账以只读历史迁移。再次备份恢复后的数据时仍保留这些历史，并去除完全重复的调用记录。
- RAG 的作者原始资料、正文和摘要包含在业务包中。FTS 与向量缓存不打包；恢复后在本机重建全文索引和本地 hash 向量索引，不访问模型或嵌入服务。
- 本机周期自动保护默认开启：有持久内容变化、距上次成功不少于 15 分钟且连续空闲不少于 30 秒时触发；活跃 Run/Operation 延后。提供成功/失败状态、固定保留、打开备份目录和最近恢复报告。
- 自动包独立全量、默认不加密码。轮替保留最近 10 份、最近 7 天每日最后一份、最近 4 周每周最后一份；2 GiB 软预算优先保留最新 3 份、固定包及未验证包。恢复前快照放在独立 `backups/rollback`，首版不自动清理。

### 15.2 数据保护与实现约束

1. Main 请求与后台摘要/RAG 写入经过维护屏障；Renderer 先确认保存正文和会话输入，等待现有写入排空，停下 Outbox 与 Runtime。任务仍在执行时拒绝操作，避免无提示终止作者任务。
2. SQLite `VACUUM INTO` 固定业务快照。记录按 rowid 游标读取，并按约 8 MiB 原始数据分批；单条记录上限 64 MiB。NDJSON、ZIP、SHA-256 与 AES-GCM 均使用流式处理。
3. v2 外层仅允许 `manifest.json` 与 `payload.zip`/`payload.bin`；私有清单、正文和图片一起加密。PBKDF2-SHA256 为 600000 次；外层关键元数据作为 AES-GCM AAD。错误密码、载荷损坏、未知领域、重复/非法路径、超限与空间不足均拒绝。
4. 预览绑定文件 hash、当前数据库/审批意见/受管图片指纹及 10 分钟期限；预览后变更必须重新预检。每次恢复都先创建并重新读取校验完整安全快照。
5. 候选位于 `datasets/<generationId>`；复制模式保留原代其他数据，仅对导入记录重映射身份、复合请求键和已登记 JSON/Lexical 引用。自由正文、摘录与未变化的 JSON 原始字节保持原样。
6. 候选执行 SQLite 完整性/外键检查，以及作品归属、草稿身份/版本、正文存储类型和审批文件检查；正文兼容空字符串、旧版纯文本和编辑器既有文本回退格式，不强制解析 JSON。图片校验并落盘后才原子切换 `active-dataset.json`。旧进程写入封存，启动验证完成后确认恢复日志；失败返回旧代，不创建空库掩盖问题。
7. 导入的活跃 Run 中断；Operation 租约清空，未决操作保持 `reconcile_required`；Outbox 标为 `restored_archive`，不重新投递。该字段现为 SQLite TEXT，无枚举约束，故未修改既有 schema/migration。
8. 历史图不作为可续跑状态导入。恢复副本中的草稿/撤销台账可查看，但禁止直接写回/撤销，需重新生成；摘要副本标为 stale。导入 Skill/Binding/Pack 默认停用，审阅后手动启用。
9. `ai-settings.json`、凭据、临时 Token、CLI 配置与日志留在本机，不进入便携包。Cutover 标记由目标代生成，避免重新清掉导入的会话和草稿。
10. 预检暂存到期清理；启动只清理带合法任务标记、所属进程已退出的暂存目录，不删除活动任务或其他 userData 内容。

实现文件：`electron/backup/{BackupRegistry,BackupArchive,BackupEngine,DatasetManager,MaintenanceGate,BackupRetention}.ts`、`electron/services/BackupService.ts`、`shared/backup.ts`，以及 Main/Preload、设置面板、编辑保存与后台服务接入。

### 15.3 兼容与扩展边界

| 内容 | 首版行为 |
| --- | --- |
| 当前 v2 完整包 | 全量导出；副本恢复或全量替换 |
| v1 九表/更早六表包 | 明确标记不完整，只能导入副本；缺失图片改为缺失引用，不能绑定本机同名图片 |
| 未来新增业务表 | Prisma/generated SQL 的 CI 检查及运行时数据库检查要求登记；未登记则阻止“完整备份”，不能静默遗漏 |
| 已登记表新增普通字段 | 根据实际 columns 序列化；旧包缺少的新字段由当前 schema 的默认值/约束处理，不猜测必需字段 |
| 新资源字段、JSON 引用或独立文件存储 | 必须同步资源/引用规则和往返用例；自动保存字段不能替代文件与语义依赖登记 |
| 新于当前契约的包 | 拒绝必需领域/字段不兼容，提示升级；首版未提供跨任意未来版本迁移 |
| 原附件文件 | 当前产品未持久保存，无法补进备份；已保存的提取内容完整保留 |

### 15.4 验收与后续阶段

自动化入口：`pnpm --dir apps/desktop test:backup`，已加入 CI。覆盖 registry、轮替、维护屏障、归档边界、40 领域往返、隐式关联、加密/损坏/错误密码、资源缺失、预览失效、分页大记录、副本 ID 与自由文本、历史再次备份、候选损坏回滚及 v1 导入限制。

Windows 已在全新临时 userData 中运行真实 Electron 演练：加密导出 → 预检 → 副本/全量替换 → 新进程启动 → 正文、会话、未发送输入、图片、FTS 与本地 RAG 索引读取。检查均不操作作者真实作品库。完整验收记录见 [备份验收记录](docs/agent/acceptance-backup-2026-10-08.md)。

2026-10-09 重新构建并复验两种恢复模式，补查错误密码重试、自动保护策略与固定保留的重启持久性；新增 ZIP 路径/重复/大小/空间不足/取消边界用例。最新结果和既有 Agent 契约断言失败见 [复验记录](docs/agent/acceptance-backup-2026-10-09.md)。

同日人工测试发现正常空章节被错误 JSON 校验阻止备份。已修正正文存储契约并补齐历史格式往返、真实空章节桌面演练及两份真实库只读快照导出，见 [空章节备份修复记录](docs/agent/backup-empty-chapter-fix-2026-10-09.md)。

仍保留在后续 P1：选择作品导出/从全量包选择作品、单作品替换与依赖闭包、可选无凭据偏好迁移、草稿副本离线重新校验后写回、资源修复专用入口与 macOS/跨平台安装包演练。首版 UI 不提供这些入口，不能把它们宣传为已完成。

### 15.5 界面与进度设计（2026-10-09）

- 创建与恢复采用并列卡片；内容区不足 530px 时切换为单列。密码字段、预览统计、恢复模式、自动保护、备份列表和最近恢复报告保持统一间距、边框与明暗主题。
- 全局进度弹窗区分创建、预检与恢复。创建显示准备资料 → 生成快照 → 打包备份 → 校验备份；恢复显示准备恢复 → 安全快照 → 导入资料 → 完成切换；预检显示准备读取 → 完整性校验。恢复中的安全快照校验始终属于恢复流程。
- 进度为当前阶段进度：仅当后端提供有效总量和已完成量时显示真实百分比与计数；无总量时使用流动进度条及“处理中”，不得猜测总进度或剩余时间。显示阶段编号和已用时间。
- 取消发送后禁用重复点击并显示等待状态；请求失败可重试。进入数据切换阶段后移除取消按钮，提示保持应用打开与完成后重启。
- 弹窗限制键盘焦点并拦截背景快捷键和 Escape，结束后恢复焦点；进度提供无障碍名称与状态，遵循系统减少动画偏好。

实现与验证记录见 [备份界面优化记录](docs/agent/backup-ui-design-2026-10-09.md)。
