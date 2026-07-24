# 小说与 Agent 文件导入需求

版本：v0.3

日期：2026-07-24

状态：需求确认稿

适用范围：首页小说导入、Agent 会话附件、Python 文档提取 Worker、当前小说正文追加、创作素材结构化导入与审核写回，以及后续资料库能力规划。

## 1. 背景

CloudDream Novel Agent 当前已经支持在首页选择 `.txt`、`.docx`、`.pdf`，按卷/章标题解析后创建一部新小说。Agent 会话、Run、Artifact 和草稿均绑定单一 `novelId`，但 Agent 目前不能读取用户选择的本地文档，也不能从文档中整理并导入正文、情节线、角色或物品。

第一阶段首要目标是建立一条简洁、常用、可审核的读取链路：

```text
用户选择文件
  -> Python Worker 提取结构化内容
  -> 文件成为当前小说、当前会话的附件
  -> 确定性解析正文，或由 AI 整理创作素材
  -> 用户预览/审核
  -> 写入当前小说
```

本阶段不建设资料管理系统。文件读取服务于一次明确的导入或讨论任务，不扩展为跨会话资料库、目录索引或长期分类 RAG。资料库、文件夹、路径映射和分类 RAG 已确认为后续需求，保留在本文档中分阶段交付。

## 2. 已确认决策

1. **首页暂时只支持完整小说导入。** 首页导入用于创建新小说，继续使用结构性强、确定性的卷章解析，AI 不参与。
2. **Agent 文件能力只服务当前小说。** Agent 读取的附件必须绑定当前 `novelId` 和当前会话，禁止跨小说使用。
3. **Agent 不创建或切换小说。** Agent 中导入“小说正文”表示将正文追加到当前小说；创建新小说必须返回首页操作。
4. **Python 是纯文档提取 Worker。** Worker 不属于 LangGraph，不访问数据库、网络或模型，只读取 Electron Main 创建的受控临时文件并返回结构化结果。
5. **正文导入不使用 AI。** 小说正文、单篇文章通过确定性卷章规则生成导入预览。
6. **创作素材导入使用 AI。** 大纲、情节线、角色、物品、技能和世界观需要从自然语言文档中提取结构化候选。
7. **AI 不直接保存业务数据。** 结构化候选必须进入 DraftSession/ReviewPackage，用户确认后才能调用现有写回路径。
8. **大纲映射到现有情节模型。** 第一版不新增 Outline 表；大纲导入生成一个或多个 PlotLine/PlotPoint 草稿。
9. **附件不是资料库。** 第一版没有文件夹、标签、本机路径索引、Embedding、分类 RAG、跨会话资料管理或独立资料页面。
10. **优先完成读取闭环。** Worker、会话附件、只读查看、正文预览和创作素材审核包完成前，不开发资料库。
11. **资料库能力不取消。** 当前小说资料库、用户文件夹、受控路径映射和分类 RAG 是已确认的后续需求，不属于待定的产品探索；其实现以第一阶段稳定的提取块和附件读取能力为基础。

## 3. 目标与非目标

### 3.1 目标

- 提供独立、无状态、按需启动的 Python Document Extractor Worker。
- 支持在 Agent 输入区选择 TXT、Markdown、DOCX 和文本型 PDF。
- 将提取结果保存为当前小说、当前会话的 `AgentAttachment`。
- 支持在会话中查看附件的规范化提取内容。
- 支持 Agent 分段读取附件，不接收任意本地路径。
- 复用首页卷章解析器，将附件正文追加到当前小说。
- 支持从附件生成大纲/情节线、角色、物品、技能和世界观审核包。
- 支持混合文档一次生成多类型创作素材审核包。
- 保持现有审批、版本冲突、DraftSession 和 ReviewPackage 边界。
- 支持大文件分段处理、覆盖统计、失败重试和会话恢复。

### 3.2 第一版非目标

以下项目仅排除在第一版之外；其中资料库、文件夹、路径映射和分类 RAG 已纳入 P2 后续需求，不代表取消：

- 首页导入大纲、情节线、角色、物品或世界观。
- Agent 创建新小说、切换当前小说或把附件导入其他小说。
- 当前小说资料库页面。
- 用户自定义资料文件夹、标签或分类。
- 保存、展示、监听或重新关联原文件绝对路径。
- Embedding、向量 Chunk 或持久分类 RAG。
- 自动扫描目录或监听外部文件变化。
- 忠实还原 Word/PDF 原始视觉排版。
- OCR 扫描 PDF、旧版 `.doc`、音频或视频解析。
- Agent 直接覆盖、移动或删除用户原文件。
- 未经审核直接写入正文或结构化创作素材。

## 4. 产品入口

### 4.1 首页：导入小说

首页保留“导入小说”入口，只处理完整小说并创建新 Novel：

```text
选择文件
  -> 提取文本
  -> 确定性识别卷和章节
  -> 创建 Novel/Volume/Chapter
  -> 更新搜索、RAG 和摘要派生任务
```

第一阶段不在首页增加导入类型选择，也不允许选择已有小说。现有 JS 导入能力继续可用；Python Worker 上线后可以替换底层文本提取，但不改变首页用户流程和确定性解析语义。

### 4.2 Agent：添加文件

Agent 输入区增加“添加文件”按钮。文件提取成功后以附件 Chip 显示：

```text
[旧稿.docx · 18.4 万字 · 已读取]
```

用户可以在发送前选择导入目标：

- 正文
- 大纲 / 情节线
- 角色
- 物品 / 技能
- 世界观
- 混合素材
- 自动识别
- 仅讨论，不导入

默认值为“仅讨论，不导入”。只有用户明确选择导入类型，或消息中出现清晰的导入意图，Agent 才能生成写入计划。

### 4.3 附件查看

第一版不建设完整资料页面。附件 Chip 和历史消息提供“查看内容”，打开只读对话框或覆盖面板：

- 显示原文件名、格式、大小、字符数和提取警告。
- 显示规范化标题、段落、列表、表格纯文本和页码。
- 支持文内搜索与标题/页码跳转。
- 不显示本地绝对路径。
- 不允许直接编辑提取文本。
- 关闭后返回原会话位置，不打开新页面。

## 5. Python 文档提取 Worker

### 5.1 进程边界

Python Worker 是独立的文档转换程序，不复用 Novel Agent Runtime 的 FastAPI/LangGraph 生命周期。Electron Main 通过子进程 `stdin/stdout` 发送单次任务 JSON，不新增常驻端口。

```text
Electron 文件选择器
  -> Main 校验文件类型、大小和真实格式
  -> Main 复制到单任务临时目录
  -> 启动 Python Worker
  -> Worker 返回 ExtractedDocument JSON
  -> Main 校验输出并删除临时目录
  -> 用户发送消息时持久化 AgentAttachment
```

### 5.2 输入协议

```ts
type DocumentExtractRequest = {
  protocolVersion: 'document-extractor-v1';
  jobId: string;
  temporaryFilePath: string;
  originalFileName: string;
  extension: string;
  mimeType?: string;
  limits: {
    maxCharacters: number;
    timeoutMs: number;
  };
};
```

`temporaryFilePath` 必须位于 Main 为本任务创建并验证的临时目录。Worker 不接受目录、URL、glob、用户输入路径或数据库连接信息。

### 5.3 输出协议

```ts
type ExtractedDocument = {
  protocolVersion: 'document-extractor-v1';
  jobId: string;
  title?: string;
  plainText: string;
  blocks: Array<{
    blockId: string;
    type: 'heading' | 'paragraph' | 'list_item' | 'table' | 'page_break';
    text: string;
    page?: number;
    headingPath?: string[];
    startOffset: number;
    endOffset: number;
  }>;
  metadata: {
    pageCount?: number;
    author?: string;
    language?: string;
    warnings: Array<{ code: string; message: string }>;
  };
};
```

约束：

- `blockId` 根据规范化内容、顺序和结构路径确定性生成，不使用随机 UUID。
- `plainText` 与 `blocks` 必须来自同一次成功提取。
- 同一输入和同一 Worker 版本必须产生稳定块顺序。
- stdout 只输出协议 JSON；诊断进入 stderr，且不得包含用户原始路径。

### 5.4 Worker 能力

第一版建议使用：

- TXT/Markdown：Python 标准库与 `charset-normalizer`。
- DOCX：`python-docx`，保留标题、段落和列表顺序。
- PDF：`PyMuPDF`，按页提取文本和基础块定位。
- 扫描 PDF：返回 `OCR_REQUIRED`，不引入 OCR 依赖。

Worker 必须：

- 不访问 Prisma、SQLite、Agent 状态库或用户配置。
- 不访问网络，不调用模型，不生成 Embedding。
- 不扫描目录，不解析任务文件之外的引用。
- 不写业务文件；中间文件只能位于任务临时目录。
- 支持超时、取消和强制结束。
- 无论成功、失败或取消，Main 都必须清理临时目录。

## 6. 会话附件

### 6.1 数据模型

建议新增：

```prisma
model AgentAttachment {
  id                   String   @id @default(cuid())
  novelId              String
  conversationId       String
  messageId            String?
  originalFileName     String
  extension            String
  mimeType             String?
  sizeBytes            Int
  contentHash          String
  plainText            String
  extractedContentJson String
  extractionMetaJson   String   @default("{}")
  extractorVersion     String
  status               String   @default("ready")
  errorCode            String?
  errorMessage         String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  novel        Novel             @relation(fields: [novelId], references: [id], onDelete: Cascade)
  conversation AgentConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
  @@index([novelId, contentHash])
}
```

同时增加 Novel 和 AgentConversation 的反向关系。`messageId` 在附件随用户消息发送后写入，用于恢复时间线位置；第一版不要求建立 AgentMessage 外键关系。

### 6.2 生命周期

```text
selected -> extracting -> ready -> attached_to_message
                  |          |
                  v          v
                failed     removed_before_send
```

- 文件选择和提取成功后先保存在输入区临时状态。
- 用户发送消息时创建 AgentAttachment 并绑定 conversationId/messageId。
- 发送前移除附件不会产生持久记录。
- 已经参与 Run 的附件保持不可变，避免历史回答和审核包失去来源。
- 归档会话不删除附件；删除小说时级联删除。
- 第一版不保存原文件副本或绝对路径，提取快照是会话恢复的事实源。
- AgentAttachment 和提取快照进入 `.nebak`；临时文件不进入备份。

### 6.3 作用域校验

所有附件读取必须同时满足：

1. attachment.novelId 等于当前 Run 的 novelId。
2. attachment.conversationId 等于当前 Run 的 conversationId。
3. attachment.status 为 ready。

仅依靠模型提示、Renderer 传参或文件名不构成安全边界。

## 7. Agent 读取工具

### 7.1 `attachment.list`

列出当前会话附件的元数据，不返回完整正文。

```json
{
  "novelId": "required",
  "conversationId": "required"
}
```

### 7.2 `attachment.search`

在当前会话已经发送的附件中执行本地关键词搜索，不调用模型或 Embedding。可通过 `attachmentId` 限定单份附件；省略时搜索当前会话全部已发送附件。

```json
{
  "novelId": "required",
  "conversationId": "required",
  "query": "required",
  "attachmentId": "optional",
  "limit": 10
}
```

返回文件名、命中片段、blockId、页码、标题路径和 UTF-16 字符偏移。单次最多返回 20 条；Agent 需要更多上下文时使用命中偏移调用 `attachment.read`。未绑定到消息的待发送附件不可搜索。

### 7.3 `attachment.read`

通用附件读取接口。`selector` 支持 `section`、`offset_range`、`page_range` 和 `block_range`。短于 12,000 字符的目标范围一次返回；更长范围按不超过 8,000 字符的块边界分页，并返回 `nextSelector`。结果同时包含实际字符范围、标题、页码、blockId、歧义候选和提取警告。

```json
{
  "novelId": "required",
  "conversationId": "required",
  "attachmentId": "required",
  "selector": { "kind": "section", "title": "第二章" }
}
```

### 7.4 `attachment.get`（兼容）

按字符窗口读取指定附件：

```json
{
  "novelId": "required",
  "conversationId": "required",
  "attachmentId": "required",
  "offset": 0,
  "limit": 12000
}
```

返回内容包含总字符数、当前窗口、下一 offset、覆盖到的 blockId 和提取警告。`limit` 必须有服务端上限，模型不能通过参数绕过上下文预算。Runtime 同时兼容模型历史上使用的 `startOffset/endOffset`，并在边界归一化为 `offset/limit`。

### 7.5 `attachment.outline`

返回附件标题树、页码、块范围和字符范围，用于大文件先导航再读取：

```json
{
  "novelId": "required",
  "conversationId": "required",
  "attachmentId": "required"
}
```

四项工具均为只读工具，可以进入普通聊天探索图，但必须受最大调用次数和上下文预算限制。

## 8. 首页小说导入

### 8.1 范围

首页只处理“选择完整小说文件并创建新小说”。不支持：

- 导入到已有小说。
- 导入大纲、情节线或角色。
- AI 自动判断导入类型。
- AI 修改章节标题或正文。

### 8.2 解析规则

- 卷标题沿用现有 `VOLUME_HEADING_RE`。
- 章节标题沿用现有 `CHAPTER_HEADING_RE`。
- Markdown 标题可以作为补充结构信号。
- 没有卷标题时使用“正文”卷。
- 没有章节标题时使用“开始”章节。
- 用户文件名作为默认小说名。

### 8.3 写入与后处理

- Novel、Volume 和 Chapter 必须在单个 Prisma 事务中创建。
- 任一步骤失败时整次导入回滚。
- 事务成功后异步更新全文搜索、章节 RAG 和章节摘要任务。
- 派生任务失败不回滚小说，但必须允许后续重试。
- 首页导入流程不依赖 Agent Runtime、模型配置或 Agent 会话。

## 9. Agent 正文导入

### 9.1 产品语义

Agent 中“导入小说”固定解释为“把附件正文追加到当前小说”。如果用户要求创建一部新小说，Agent 应提供返回首页导入的明确入口，不能自行创建 Novel 或迁移会话。

支持：

- 完整小说片段或后续卷章。
- 多章节正文。
- 单篇文章作为一个章节。

### 9.2 确定性流程

```text
AgentAttachment
  -> 复用首页卷章解析器
  -> chapter_import_preview Artifact
  -> 用户选择目标卷/新卷并检查章节列表
  -> 用户确认
  -> chapter.import.commit
  -> 搜索/RAG/摘要后处理
```

AI 不参与卷章切分和正文改写。Agent 只负责理解用户是否明确请求导入、组织计划和展示预览。

### 9.3 导入预览

预览至少包含：

- 来源 attachmentId、文件名和 contentHash。
- 当前小说 ID、版本和更新时间快照。
- 目标为新卷或指定现有卷。
- 卷名、章节名、顺序、字数和每章开头摘要。
- 同名卷/章节冲突。
- 无法识别标题、空章节和超长章节警告。

用户可以修改目标卷、卷名和章节名，但不能在导入预览中编辑大段正文。需要修改正文时，应导入后在编辑器中处理，或另行发起章节改写草稿。

### 9.4 工具

新增：

#### `chapter.import.preview`

- 只读效果。
- 输入 attachmentId、novelId、目标卷选择。
- 输出确定性结构预览和目标版本快照。
- 不创建 Volume/Chapter。

#### `chapter.import.commit`

- 数据写入效果。
- 必须关联已批准的 previewId 和用户确认记录。
- 校验 attachment、当前 novelId、preview Hash 和目标版本。
- 新内容只能追加，不覆盖已有章节。
- 同一 invocation key 重试必须幂等。

### 9.5 冲突规则

- 同名章节默认阻止提交，用户明确选择“保留并追加”后才允许创建。
- 第一版不提供覆盖、自动合并或按标题更新。
- 目标小说版本变化返回 `IMPORT_TARGET_CHANGED`，要求重新生成预览。
- attachment Hash 与预览不一致返回 `IMPORT_SOURCE_CHANGED`。
- 所有 Volume/Chapter 在同一事务写入，禁止部分成功。

## 10. Agent 创作素材导入

### 10.1 支持类型

| 用户选择 | 输出草稿 | 最终业务实体 |
| --- | --- | --- |
| 大纲 / 情节线 | plotLines + plotPoints | PlotLine、PlotPoint |
| 角色 | characters | Character |
| 物品 / 技能 | items/skills | Item 或现有技能表示 |
| 世界观 | worldSettings | WorldSetting |
| 混合素材 | 多类型 ReviewPackage | 对应多类实体 |

第一版没有独立 Outline 表，因此“大纲”按主线、阶段、事件节点整理为 PlotLine/PlotPoint。AI 不得把大纲内容直接写成章节正文。

### 10.2 明确类型优先

用户在附件发送前选择的导入类型是最高优先级。Agent 不需要再次判断，也不应额外调用分类模型。

当用户选择“自动识别”时：

- 类型识别合并进结构化提取调用，不单独发起模型请求。
- 输出必须列出实际识别的类型和覆盖范围。
- 置信度低、类型冲突或无法映射时暂停并要求用户选择。
- 自动识别结果只是草稿类型，不构成写入授权。

### 10.3 复用现有审核链路

建议扩展 `creative_assets.generate_draft`：

```ts
type CreativeAssetsImportInput = {
  novelId: string;
  attachmentIds: string[];
  requestedKinds: Array<'plotLine' | 'character' | 'item' | 'skill' | 'worldSetting'>;
  userIntent: string;
  locale?: string;
};
```

执行链：

```text
attachment.outline/get
  -> 分段结构化提取
  -> creative_assets.generate_draft
  -> creative_assets.validate_draft
  -> ReviewPackage / DraftSession
  -> 用户逐处批注意见或确认
  -> 现有 CreativeAssetsWriteback
```

不得直接调用 `plotline.create`、`character.create`、`item.create` 等保存工具绕过审核包。用户确认后由现有事务写回路径创建正式实体并刷新 RAG 索引。

### 10.4 来源追踪

审核包中的每个条目保存：

- sourceAttachmentId。
- sourceBlockIds。
- sourceExcerpt。
- extractionConfidence。
- 用户选择的 requestedKind。

用户在审核页查看来源时，打开会话附件只读查看器并高亮相关块。来源信息不进入最终业务实体的用户可见字段，但保留在 Artifact/ReviewPackage metadata 中供审计和重新生成。

## 11. 大文件与 Token 控制

### 11.1 基本原则

- 正文卷章解析不调用模型，因此文件大小不会产生模型 Token 成本。
- 附件不会自动进入之后每一轮聊天上下文。
- 模型只能通过 attachment 工具读取当前任务需要的窗口。
- 用户明确选择导入类型时不产生额外分类调用。
- 自动识别合并进第一次结构化提取调用。

### 11.2 分批策略

创作素材导入不能把大文件一次塞入 Prompt：

1. 先读取 attachment.outline。
2. 按标题、页码或连续 block 范围分批。
3. 每批输出结构化候选和覆盖 blockIds。
4. 最终合并、去重并进行跨批冲突检查。
5. 发布审核包时记录总块数、已处理块数和遗漏原因。

默认限制建议：

- 单个模型批次最多约 12,000 字符，最终值由 ContextAssembler 预算决定。
- 每个附件最多 64 个结构批次。
- 单次导入最多 5 个附件。
- 覆盖不足时返回部分草稿和明确警告，不伪装为完整导入。

### 11.3 会话上下文

普通聊天历史只保存：

- 附件 ID、文件名、字符数和提取摘要。
- 用户本轮明确引用的片段。
- 已生成审核包的结构化摘要。

完整附件正文不重复拼入每轮模型历史。需要再次读取时通过 `attachment.read` 获取；成功读取目标范围后，旧的 list/outline/search 结果退出模型上下文但保留在审计 checkpoint 中。

## 12. UI 要求

### 12.1 首页

- 保留单一“导入小说”按钮。
- 文件选择后显示导入进度和最终卷/章数量。
- 第一阶段不增加复杂导入向导或 AI 选项。
- 导入失败显示稳定错误码对应的用户提示。

### 12.2 Agent 输入区

- 提供回形针或文档图标按钮。
- 文件选择后显示 extracting/ready/failed 状态。
- ready 后显示文件名、格式、字符数和移除按钮。
- 提供简洁的“用途”选择，默认“仅讨论”。
- 发送时附件与用户消息原子绑定，不能出现消息已发送但附件丢失。

### 12.3 会话附件查看器

- 从输入区附件、历史消息、活动流和审核来源打开同一个查看器。
- 显示规范化内容、标题导航、页码和文内搜索。
- 支持按 sourceBlockIds 高亮来源。
- 不承担文件管理、分类、RAG 状态或电脑路径管理。

### 12.4 正文导入审核

- 显示目标小说、目标卷、新增卷章树、字数和冲突。
- 主操作明确写出影响，例如“向《七夜》新增 1 卷、12 章”。
- 用户确认前不得调用 commit。
- 提交成功后提供跳转到首个新增章节。

### 12.5 创作素材审核

- 复用现有统一 ReviewPackage 和 CreativeAssetsReviewPanel。
- 每个条目可以查看来源附件片段。
- 混合类型仍按一个审核包整体提交。
- 用户批注意见触发新版本，不覆盖旧 DraftSession。

## 13. 错误与限制

第一版限制：

- 支持 `.txt`、`.md`、`.docx`、文本型 `.pdf`。
- 单文件最大 50 MiB。
- 单份附件规范化文本最大 2,000,000 字符。
- 单条 `attachment.get` 最大 12,000 字符；`attachment.read` 的长范围块最大 8,000 字符。
- `.doc` 返回另存为 `.docx` 的提示。
- PDF 无可提取文本时返回 `OCR_REQUIRED`。

稳定错误码至少包括：

- `FILE_TOO_LARGE`
- `UNSUPPORTED_FILE_TYPE`
- `FILE_READ_FAILED`
- `TEXT_EXTRACTION_FAILED`
- `EXTRACTOR_UNAVAILABLE`
- `EXTRACTOR_TIMEOUT`
- `EXTRACTOR_PROTOCOL_ERROR`
- `OCR_REQUIRED`
- `EMPTY_DOCUMENT`
- `ATTACHMENT_NOT_FOUND`
- `ATTACHMENT_SCOPE_MISMATCH`
- `ATTACHMENT_NOT_READY`
- `IMPORT_PREVIEW_EXPIRED`
- `IMPORT_SOURCE_CHANGED`
- `IMPORT_TARGET_CHANGED`
- `IMPORT_CONFLICT_UNRESOLVED`
- `IMPORT_VALIDATION_FAILED`

用户提示不得包含完整本地路径。日志只记录经过脱敏的文件名、扩展名、大小、错误码、attachmentId 和 traceId。

## 14. 隐私与安全

- 只有用户通过 Electron 文件选择器主动选择的文件可以读取。
- Main 负责授权、格式/大小校验、受控临时副本和持久化。
- Renderer 不自行读取本地路径。
- Python Worker 只能读取 Main 创建的单任务临时文件。
- Python Agent Runtime 不访问本地文件，只通过 attachmentId 调用 Automation/FastMCP。
- 不保存原文件绝对路径或原始二进制副本。
- 不把完整附件自动发送给模型；只发送用户任务需要的分段内容。
- attachment 工具执行 novelId 和 conversationId 双重校验。
- 删除小说时级联删除附件快照。
- 云端文本模型会接收任务实际读取的片段，添加文件界面必须显示隐私提示。

## 15. 实现分层

### Electron Main

- 文件选择、校验、临时文件和 Worker 生命周期。
- AgentAttachment CRUD 与作用域校验。
- 附件分页读取和结构目录查询。
- 首页小说导入事务。
- Agent 正文导入 preview/commit。
- 创作素材审核包写回和派生索引刷新。
- 备份恢复集成。

### Python Document Extractor Worker

- 实现 `document-extractor-v1` stdin/stdout 协议。
- 提取 TXT、Markdown、DOCX 和文本型 PDF。
- 返回稳定 plainText、blocks 和 metadata。
- 不访问网络、数据库、模型、Agent 状态或临时目录之外的文件。
- 独立打包和测试，不增加 Novel Agent Runtime 的启动依赖。

### Python Agent Runtime

- 注册 attachment.list/search/get/outline 只读工具。
- 注册 chapter.import.preview/commit 并执行审批边界。
- 扩展 creative_assets.generate_draft 的附件输入。
- 实现结构化导入分批、合并、覆盖统计和恢复。
- 保证当前 Run 的 novelId/conversationId 作用域。

### Renderer

- Agent 输入区附件选择、用途选择和状态。
- 会话附件只读查看器。
- 正文导入预览和确认。
- 复用创作素材审核包 UI 并展示附件来源。

## 16. 分阶段交付

### P0-A：Worker 与会话附件

- Python Worker 和版本化协议。
- Electron 临时文件、超时、取消、清理和输出校验。
- AgentAttachment 数据模型和备份恢复。
- Agent 输入区附件和只读查看器。
- attachment.list/search/get/outline。

### P0-B：当前小说正文导入

- 抽取并复用首页确定性卷章解析器。
- chapter.import.preview Artifact。
- 目标卷、冲突和版本快照。
- chapter.import.commit 事务、幂等和后处理。

### P0-C：创作素材导入

- 用户显式选择导入类型。
- creative_assets.generate_draft 附件输入。
- 大纲/情节线、角色、物品/技能、世界观和混合素材。
- 分批提取、来源 blockIds、覆盖统计和冲突检查。
- ReviewPackage 审核和现有写回路径。

### P1：读取质量与范围扩展

- 自动识别类型。
- 多附件综合导入。
- 更复杂 DOCX/PDF 结构和表格提取。
- 更完善的大文件恢复与部分重试。

### P2：当前小说资料库

P2 是已确认的后续需求，在读取与导入闭环稳定后实施，不作为 P0/P1 的前置依赖。

#### P2-A：资料库页面与文件夹

- 每部小说拥有独立资料库，不提供跨小说默认共享。
- 提供资料列表和只读内容查看，显示文件名、类型、字数、更新时间、索引状态和提取警告。
- 用户可以创建、重命名、移动和删除虚拟文件夹；文件夹只负责组织，不对应或修改电脑目录。
- 新资料默认进入“未分类”，导入时可以选择已有文件夹，也可以导入后移动。
- Agent 导入资料时优先沿用用户明确选择的文件夹；没有选择时进入“未分类”，不为分类额外调用模型。
- 会话附件可由用户明确操作“保存到资料库”，不自动把所有聊天附件持久化为资料。

#### P2-B：本机路径映射

- 资料记录可以保存经过 Electron Main 授权的原文件位置，用于“在文件夹中显示”和重新提取。
- 路径是可失效的外部引用，不是资料主键；资料 ID、提取快照和内容 Hash 仍是内部事实源。
- 文件移动、权限变化或磁盘离线时标记为“原文件不可用”，已有提取快照仍可查看和检索。
- 重新关联必须由用户通过文件选择器确认，并校验文件 Hash；不自动扫描目录寻找同名文件。
- Renderer、Agent Runtime、模型上下文、遥测和普通日志不得获得或显示完整绝对路径。
- 资料进入备份时默认包含提取快照与元数据，不依赖原路径才能恢复；是否包含原始文件副本另行提供显式选项。

#### P2-C：分类 RAG

- 复用 Python Worker 产生的稳定 `blocks` 作为切分输入，不直接复用章节 Chunk 业务表。
- 抽取共享的 Chunk/Embedding 基础设施，并为资料建立独立实体或明确的 `sourceType = reference` 隔离，避免章节正文与考据资料在召回、删除和重建时互相污染。
- 每个检索块保留 `novelId`、资料 ID、文件夹 ID、来源 blockIds、内容 Hash、提取器版本和索引版本。
- 检索范围默认限制为当前小说；用户可以选择全部资料、一个或多个文件夹、单个文件，或关闭资料检索。
- 文件夹是用户组织与检索过滤条件，不要求每个文件只能属于一种语义分类；后续可在不改变目录结构的前提下增加标签。
- Agent 先使用元数据过滤，再执行关键词/向量混合检索，只把命中的必要片段及引用加入上下文。
- 回答中的考据结论应可跳转到资料、页码或来源块；索引失败时仍允许查看资料，但必须显示不可检索状态。
- 文件内容、文件夹或路径重新关联发生变化时，按内容 Hash 增量重建索引；删除资料必须同步清理对应 Chunk 和 Embedding。

#### P2-D：跨会话复用边界

- 资料库属于当前小说，因此同一小说的创作界面和 Agent 会话可以访问同一批资料。
- 创作界面以轻量资料入口和引用状态为主，完整管理在独立资料库页面完成，避免两个界面重复建设管理能力。
- Agent 只能读取当前 `novelId` 下且用户允许参与本轮检索的资料，不能跨小说搜索。
- 资料不会自动注入每轮对话；只有检索命中片段进入上下文，以控制 Token 成本。

### P3：通用小说结构分析与导入预览（低优先级）

P3 解决非标准卷章标题、分篇正文、站点水印和源文件缺号导致的错误切分。该能力不进入当前 P0/P1 交付，也不以继续扩充单个 `CHAPTER_HEADING_RE` 的方式实现；实施时应以确定性、可解释、可预览的结构分析管线替换“正则命中后立即切章”。基础解析全程本地执行，不调用模型。

已知案例 `临兵斗者皆阵列在前贰.txt` 为 GB18030/GBK 文本，包含 `第二章上/下`、`第三章上/下`、混合括号的 `第十三章(上）/（下）` 和 `第二十五章（全）`。现有规则会把这些内容并入前章，并把站点水印创建为“开始”章节；源文件自身从第三十章跳到第三十二章，应报告缺号而不能伪造第三十一章。

#### P3-A：解码与文本规范化

- 按 BOM 优先识别 UTF-8、UTF-16LE、UTF-16BE；无 BOM 时使用严格 UTF-8，再对 GB18030、Big5 等候选按乱码率、中文比例和控制字符比例评分。
- 统一换行、全半角空格、制表符、全角数字、中英文及混合括号、零宽字符，同时保留规范化文本到原始字符范围的映射。
- 高置信网址、下载站声明和重复水印默认排除；书名、作者进入元数据；无法确定的前置信息进入预览，不静默删除或创建“开始”章节。

#### P3-B：结构化标题识别

- 将候选行解析为 `kind`、`ordinal`、`unit`、`part`、`subtitle`、`rawText`、`sourceRange` 和 `confidence`，不把标题识别结果仅表示为布尔值。
- 支持中文、阿拉伯、罗马及常见大写中文数字，支持卷/部/册/集/篇和章/回/节/话，以及序章、楔子、前言、终章、尾声、后记、番外等无编号标题。
- `part` 统一表示上/中/下、前/后和全篇等分篇标记；括号、空格和标点差异在规范化层消除，不为具体书名或具体章号建立特例。
- TXT 使用独立行、长度、标点和相邻空行作为信号；Markdown、DOCX、PDF 额外使用标题层级、样式和页内布局，但最终进入同一解析结果。
- 标题必须满足完整行和章节语法约束；“第一种结果”“第二天一早”等正文句子不得仅因以中文序数开头而被识别为标题。

#### P3-C：两阶段切分、归并与诊断

- 第一遍只接受高置信标题并构建卷章树；第二遍针对长度超过相邻中位数 2.5 倍、编号跳跃、重复、倒序或包含疑似标题行的区段重新扫描。
- 使用 `scope + unit + ordinal` 作为逻辑章节键。相邻且分篇顺序合理的同键上/中/下或前/后片段合并为一个目录章节，原始分篇标题保留为正文内部小标题和来源记录。
- `全篇` 标记归一为单个逻辑章节；没有分篇标记的同编号重复标题不得静默合并，必须进入预览警告。
- 缺号、重复、倒序、异常超长、连续极短、层级歧义和低置信标题均产生结构化诊断；解析器不得自动补造源文件不存在的章节。
- `篇` 等可能同时表达卷或章的单位，结合前后层级和子章节分布判定；仍有歧义时交给预览处理。

#### P3-D：分析接口与导入预览

- 将直接导入拆为 `analyzeNovelImport(filePath)` 和 `commitNovelImport(analysisId, decisions)`；保留旧入口作为兼容包装，但首页正式流程必须先分析、再确认、后提交。
- 分析结果包含编码、解析器版本、源文件 Hash、前置信息、卷章树、原始/规范化标题、字符范围、字符数、分篇归并记录、置信度和诊断列表。
- 预览允许把候选行改为标题或正文、合并/拆分章节、调整卷章层级、决定是否保留前置信息，并展示异常章节的首尾片段。
- commit 只接受同一分析结果和用户确认的决策，继续复用单事务写入、搜索/RAG/摘要后处理和幂等约束。
- 已导入作品不自动重切。重新解析默认创建新副本；需要替换旧作品时必须展示卷章和字数差异，并明确提示可能覆盖用户后续编辑。

#### P3-E：测试与发布

- 建立标题格式矩阵、正文误判反例、编码矩阵、TXT/Markdown/DOCX/PDF 结构夹具，以及超长章节、跳号、重复、倒序和前置信息测试。
- 将已知问题文件转换为不含版权正文的最小化黄金夹具，固定验证物理标题、逻辑章节、分篇归并和缺号诊断。
- Parser、首页导入和 Agent 正文导入共享同一套结构分析器和黄金测试；开发构建通过后还必须对安装包执行真实文件导入冒烟测试。
- 仅记录编码、标题数量、诊断代码、耗时和解析器版本等非正文指标，用于后续调整规则和置信度阈值。

## 17. 验收标准

### Worker 与附件

1. Worker 只能读取 Main 创建的单任务临时文件。
2. TXT、Markdown、DOCX 和文本型 PDF 返回稳定结构。
3. 超时、取消、崩溃或非法 JSON 后，Main 终止进程并清理临时目录。
4. 扫描 PDF 返回 OCR_REQUIRED，不创建空附件。
5. 附件只能由相同 novelId、conversationId 的 Run 读取。
6. 历史消息可以重新打开完整提取快照。
7. 完整附件不会自动进入每一轮聊天上下文。

### 首页导入

1. 首页仍只创建新小说，不显示 Agent 或 AI 选项。
2. 卷章识别结果与现有行为兼容。
3. 首页导入不依赖 Agent Runtime 和模型配置。
4. 写入失败时 Novel/Volume/Chapter 零部分写入。

### P3 通用结构分析（低优先级）

1. 已知案例应得到 40 个逻辑章节：楔子加源文件实际存在的 39 个编号章节；不生成“开始”章节。
2. 第二、三、十三章的上下篇分别归并为单个目录章节，分篇标题保留在正文内部；第二十五章的全篇标记正常归一。
3. 第一章正文不得包含第二章内容；第三十章到第三十二章的源文件缺号必须产生诊断，不能自动创建第三十一章。
4. “第一种结果”“第二天一早”等正文反例保持正文，不能误切章。
5. 分析预览展示所有低置信候选、归并动作和结构异常，用户确认前不得创建 Novel、Volume 或 Chapter。
6. 同一文件通过首页和 Agent 正文导入得到一致结构；安装包冒烟结果与自动化黄金测试一致。

### Agent 正文导入

1. Agent 只能向当前小说追加正文。
2. 卷章切分不调用模型。
3. 用户确认前不创建 Volume/Chapter。
4. 同名冲突和目标版本变化必须阻止无提示提交。
5. commit 重试幂等，不产生重复章节。
6. 成功后搜索、RAG 和摘要后处理可观察、可重试。

### 创作素材导入

1. 用户选择明确类型时不额外调用分类模型。
2. 大纲生成 PlotLine/PlotPoint 草稿，不直接生成正文。
3. 角色、物品、技能和世界观进入同一审核包机制。
4. 每个候选条目可追溯到 attachmentId 和 sourceBlockIds。
5. 大文件处理显示真实覆盖率和遗漏警告。
6. 未经用户确认不得写入正式业务表。
7. 混合审核包不能部分提交造成项目状态错位。

### 自动化测试基线

- Worker：协议、格式、编码、临时路径、超时、取消、非法输出、扫描 PDF。
- Attachment：作用域、分页、目录、持久化、备份和上下文预算。
- 正文导入：卷章识别、目标卷、冲突、版本变化、事务和幂等。
- 素材导入：类型约束、分批合并、来源追踪、校验和审核写回。
- 安全：跨小说/跨会话拒绝、路径不泄露、未审批写入拒绝。

## 18. 迁移与兼容

- 现有首页 `db:import-novel-file` 保持可用。
- Worker 上线后，首页可以复用 Worker 的文本提取结果，但继续调用同一卷章解析函数。
- 首页和 Agent 正文导入必须共享解析器与测试夹具，避免同一文件产生不同结构。
- 现有 `creative_assets.generate_draft` 在没有 attachmentIds 时保持原语义。
- 新附件表不改变既有会话、Run、Artifact 和 DraftSession 数据。
- 旧版备份没有 AgentAttachment 时按空集合恢复。

## 19. 完成定义

本需求完成必须同时满足：

- 首页保持简单、确定性的完整小说导入。
- Python Worker 保持纯提取职责，不进入 Agent Runtime、数据库或网络边界。
- Agent 可以安全读取当前小说、当前会话附件。
- 附件可以在会话中查看，但不演化为第一阶段资料库。
- 正文导入完全确定性，并经过预览和事务提交。
- 大纲、情节线、角色、物品、技能和世界观经过结构化草稿、校验和审核包写回。
- 所有附件读取和写入工具执行真实作用域、审批和幂等校验。
- 大文件 Token 预算、覆盖率和失败状态可观察。
- 自动化测试和备份恢复通过。
