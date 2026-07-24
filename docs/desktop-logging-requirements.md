# 桌面端本地日志与诊断支持需求

状态：需求草案 v0.1  
日期：2026-07-24  
适用范围：Electron 主进程、Electron Renderer、Python Agent Runtime、桌面端设置与错误反馈界面。  
暂不包含：Spring Boot 后端、云端日志平台、自动上传服务。

## 1. 背景

产品交付给真实用户后，问题通常发生在开发者无法直接访问的设备上。用户能够描述“保存失败”“Agent 一直启动”“应用突然退出”，但仅凭自然语言描述难以确认当时的应用版本、运行阶段、错误堆栈和跨进程调用链。

当前项目已有部分开发日志能力，但不足以承担用户侧问题诊断：

- `debug-dev.log` 仅在非生产环境启用，正式安装包发生错误时不会记录。
- Electron 主进程与 Renderer 仍有大量 `console.*` 调用，输出位置和格式不统一。
- Renderer 异常没有稳定的生产环境落盘通道。
- Python Agent Runtime 的 stdout/stderr 由 Electron 捕获，但最终仍依赖开发日志。
- 日志到达上限后直接清空，可能丢失问题发生前后的关键上下文。
- 用户没有“打开日志目录”“导出诊断包”等自助反馈入口。
- 现有脱敏主要依赖敏感字段名，无法保证小说正文、Prompt 等内容不会随业务 payload 进入日志。

因此需要建立桌面端统一的本地日志与诊断机制，使用户能够在不暴露作品内容和凭据的前提下，把足以复现、定位问题的诊断材料交给开发者。

## 2. 产品目标

1. 正式安装包、便携版和开发环境均能生成可用的本地日志。
2. Electron 主进程、Renderer 和 Python Agent Runtime 使用统一的事件字段、时间口径和关联标识。
3. 用户能够在应用内打开日志目录并导出经过脱敏的诊断包。
4. 常见崩溃、未处理异常、关键业务失败和 Python 进程异常退出均可追踪。
5. 日志有明确的大小、保留周期和轮转策略，不无限占用用户磁盘。
6. 默认日志不包含 API Key、访问令牌、小说正文、完整 Prompt 或其他高敏感内容。
7. 开发者能够通过诊断编号将用户界面中的一次错误与跨进程日志关联起来。
8. 日志设施自身失败时不得阻断保存、编辑、Agent 执行或应用退出。

## 3. 非目标

- 本阶段不实现后端服务日志。
- 本阶段不建设集中式日志检索平台。
- 本阶段不默认上传任何日志、崩溃转储或设备信息。
- 本阶段不记录用户操作回放、键盘输入或完整页面状态。
- 本阶段不以日志替代业务错误处理、用户提示、数据备份或事务恢复。
- 本文档不指定最终日志框架及其版本，框架在需求确认后独立选型。
- 本阶段不要求一次性替换所有 `console.*`；优先覆盖基础设施、全局异常和关键业务链路。

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 日志根目录 | 所有桌面端运行日志的统一父目录 |
| 日志事件 | 一条具有固定字段的结构化记录 |
| 会话 `sessionId` | 一次应用启动周期的唯一标识 |
| 追踪 `traceId` | 一次用户操作或跨进程调用链的唯一标识 |
| 请求 `requestId` | 一次具体 IPC、HTTP、模型或 Agent 请求的唯一标识 |
| 诊断编号 `diagnosticRef` | 可向用户展示并用于检索相关日志的短标识 |
| 诊断包 | 用户主动导出的日志、环境摘要和清单压缩包 |
| 详细日志 | 用户临时开启、信息量高于生产默认级别的日志模式 |

## 5. 核心原则

### 5.1 统一不等于共写一个文件

三个进程必须统一：

- 日志根目录；
- 时间格式与时区口径；
- 日志级别；
- 事件字段；
- `sessionId`、`traceId`、`requestId` 的传递规则；
- 脱敏和保留策略；
- 用户导出入口。

不同进程不要求直接写入同一个文件。应避免多进程竞争写入和轮转冲突，诊断包可在导出时按时间与关联标识汇总。

### 5.2 本地优先、用户授权

- 日志默认只保存在用户本机。
- 导出和后续发送均由用户主动触发。
- 未来增加自动上报能力时，必须单独征得用户同意，并提供关闭与撤回入口。

### 5.3 默认最少记录

- 只记录定位问题所需的状态、标识、耗时、结果和脱敏错误。
- 对业务对象采用允许字段白名单，不能直接记录整个 IPC payload、数据库对象或模型请求。
- 详细日志可以增加技术上下文，但不得降低敏感信息保护标准。

## 6. 日志目录与文件组织

### 6.1 统一根目录

逻辑路径定义为：

```text
<app.getPath('userData')>/logs/
```

预期路径示例：

```text
正式安装版（Windows）  %APPDATA%/云梦小说智能体/logs/
开发环境（Windows）    %APPDATA%/@novel-editor/desktop-dev/logs/
macOS                  <userData>/logs/
```

便携版也使用系统可写的 `userData/logs`，不依赖可执行文件所在目录是否可写。用户通过应用内入口访问和导出日志，不应要求用户理解平台目录差异。

### 6.2 文件划分

建议的逻辑文件划分如下，具体文件名可在框架选型时调整：

```text
logs/
  main.log             # Electron 主进程
  renderer.log         # Renderer
  agent-runtime.log    # Python Agent Runtime
  archive/             # 轮转后的日志，可由框架管理
```

要求：

- 文件必须使用 UTF-8。
- 每条事件独占一行，换行内容必须被安全编码。
- 当前文件和归档文件必须能够被诊断包导出器识别。
- 进程崩溃后再次启动不得覆盖尚在保留期内的全部历史。

## 7. 结构化日志契约

### 7.1 必填字段

每条正式日志至少包含：

```ts
type DesktopLogEvent = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  process: 'main' | 'renderer' | 'agent-runtime';
  scope: string;
  event: string;
  message: string;
  appVersion: string;
  sessionId: string;
};
```

字段规则：

- `timestamp` 使用 ISO 8601 UTC，例如 `2026-07-24T03:12:45.123Z`。
- `scope` 表示稳定的模块或能力，例如 `db.chapter`、`agent.runtime`。
- `event` 使用稳定、可检索的英文标识，例如 `chapter_save_failed`。
- `message` 是简短的人类可读摘要，不能承载完整业务 payload。
- 日志级别在三个进程中含义一致。

### 7.2 可选关联字段

```ts
type DesktopLogContext = {
  traceId?: string;
  requestId?: string;
  diagnosticRef?: string;
  operation?: string;
  durationMs?: number;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'degraded';
  error?: {
    name: string;
    code?: string;
    message: string;
    stack?: string;
  };
  context?: Record<string, string | number | boolean | null>;
};
```

`context` 只允许经过审核的标量字段，不允许嵌套任意对象。错误堆栈只进入本地日志和用户主动导出的诊断包，不直接作为 UI 提示展示。

### 7.3 示例

```json
{"timestamp":"2026-07-24T03:12:45.123Z","level":"error","process":"main","scope":"db.chapter","event":"chapter_save_failed","message":"Failed to save chapter","appVersion":"0.2.0","sessionId":"01J...","traceId":"01J...","diagnosticRef":"ERR-7K2M9P","error":{"name":"PrismaClientKnownRequestError","code":"P2002","message":"Database operation failed"},"context":{"chapterId":"2f6..."}}
```

## 8. 日志级别

| 级别 | 使用场景 | 生产环境默认落盘 |
| --- | --- | --- |
| `debug` | 阶段推进、分支判断、开发诊断 | 否，开启详细日志后记录 |
| `info` | 启动完成、关键能力初始化、重要操作完成 | 是 |
| `warn` | 可恢复失败、降级、重试、无害的异常状态 | 是 |
| `error` | 当前操作失败，需要用户知晓或开发者处理 | 是 |
| `fatal` | 进程无法继续、启动失败或崩溃前错误 | 是并尽力刷新 |

禁止使用 `error` 记录正常业务分支，也禁止使用 `info` 输出高频输入、正文或完整响应。

## 9. 关联标识与跨进程传递

### 9.1 Session

- 每次桌面应用启动生成一个 `sessionId`。
- Electron 主进程负责生成并传递给 Renderer 和 Python Runtime。
- 同一次启动中的全部日志使用相同 `sessionId`。

### 9.2 Trace

- 用户触发保存、导入、搜索、AI 生成、Agent Run 等操作时创建或沿用 `traceId`。
- Renderer 到 Electron IPC、Electron 到 Python Runtime、Python Runtime 回调 Automation 时必须继续传递原 `traceId`。
- 后台任务没有用户入口时，由任务发起方创建新的 `traceId`。

### 9.3 Diagnostic reference

- 用户可见错误应生成短 `diagnosticRef`，例如 `ERR-7K2M9P`。
- 同一失败在 UI、主进程日志和关联子进程日志中使用相同编号。
- 诊断编号不得编码用户 ID、章节 ID、时间或其他隐私数据。
- UI 不用堆栈替代诊断编号；用户看到简明错误和可复制的编号即可。

## 10. 必须覆盖的事件

### 10.1 应用与进程生命周期

- 应用启动、版本、平台、是否打包、是否便携模式。
- 日志系统初始化成功或失败。
- 数据库初始化和 Schema 检查结果。
- 主窗口创建、加载失败和 Renderer 异常退出。
- Electron `uncaughtException`、`unhandledRejection`。
- Python Runtime 启动、健康检查、恢复、退出码和信号。
- 应用正常退出和异常退出前的最后状态。

### 10.2 关键业务链路

P0 必须覆盖：

- 章节保存、自动保存与读取失败；
- 小说导入、备份导出与恢复失败；
- 数据库初始化、迁移及关键 Prisma 错误；
- AI 设置读取、连接测试和生成请求失败；
- Python Agent Runtime 启动、调用、SSE 解析和恢复失败；
- Agent Run 的启动、完成、取消和最终失败；
- 搜索索引初始化及重建失败。

P1 逐步覆盖：

- 素材图片、地图和封面处理；
- 同步客户端错误；
- 低风险 UI 状态恢复和编辑器解析降级；
- 性能异常，例如启动、保存、搜索和 Agent 调用超出阈值。

### 10.3 Renderer 全局错误

- 捕获 `window.error` 和 `unhandledrejection`。
- React 关键页面需有 Error Boundary，记录组件范围和脱敏错误。
- Renderer 日志必须通过受控通道写入，Renderer 不得获得任意文件系统写权限。

## 11. 敏感信息与脱敏要求

### 11.1 绝不记录

- API Key、Access Token、Refresh Token、Authorization Header。
- Python Runtime 启动 token、Automation runtime token。
- 代理认证密码、数据库连接凭据。
- 小说正文、选中文字、章节完整内容。
- 完整 Prompt、模型完整输入和完整输出。
- 导入文件内容、附件二进制、图片 Base64。
- 用户密码和加密备份密码。

### 11.2 默认不记录

- 小说标题、章节标题、角色名等作品内容。
- 用户姓名、邮箱及其他直接身份信息。
- 完整本地绝对路径。
- Provider 原始响应正文和 HTTP Header。

确需定位时，优先记录对象 ID、数量、长度、哈希摘要、文件扩展名、状态码和规范化错误码。

### 11.3 脱敏策略

- 业务上下文使用字段白名单，不允许对任意对象做“序列化后再脱敏”。
- 对外部库错误进行规范化和长度限制，再写入日志。
- URL 必须移除用户信息、查询参数中的密钥和签名。
- 本地路径默认仅保留逻辑目录名或最后一级文件名。
- 诊断包生成前再次执行独立的敏感模式扫描；发现高风险字段时阻止导出并提示用户。
- 脱敏失败不得退回原始值。

## 12. 保留、轮转与磁盘策略

默认策略：

- 生产环境默认记录 `info` 及以上级别。
- 日志保留最多 14 天。
- 全部桌面端日志总量建议不超过 100 MB。
- 单文件达到配置上限后轮转，保留有限数量归档。
- 清理应在应用启动后后台执行，不阻塞首屏显示。
- 达到磁盘或写入限制时，优先删除最旧归档，不删除当前会话日志。
- 日志写入持续失败时，只在内存中限频报告一次，不形成递归日志。

详细日志模式：

- 由用户主动开启，默认持续 24 小时。
- 到期后自动恢复生产默认级别。
- 设置页明确显示剩余时间并允许提前关闭。
- 开启详细日志不改变敏感数据禁止规则。

具体单文件大小、归档数量和压缩能力在框架选型与压测后确定，但不得突破上述总量和保留期要求。

## 13. 用户体验需求

在“设置”中增加“诊断与日志”区域，至少包含：

1. **打开日志目录**：调用系统文件管理器打开实际日志目录。
2. **导出诊断包**：用户选择保存位置，生成可发送给开发者的压缩包。
3. **启用详细日志**：显示开启状态、剩余时间和关闭操作。
4. **清理旧日志**：只清理可安全删除的归档，不影响当前会话。

用户可见错误要求：

- 使用简明、可行动的错误说明。
- 对需要反馈的问题显示可复制的诊断编号。
- 不直接显示堆栈、原始 HTML、Provider 完整响应或本地日志路径。
- 导出失败时说明失败原因，并保留原日志，不执行破坏性清理。

## 14. 诊断包

### 14.1 文件格式

诊断包使用 ZIP，建议文件名：

```text
CloudDream-Diagnostics-YYYYMMDD-HHmmss.zip
```

建议结构：

```text
diagnostics.zip
  manifest.json
  environment.json
  logs/
    main.log
    renderer.log
    agent-runtime.log
  redaction-report.json
```

### 14.2 Manifest

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-24T03:12:45.123Z",
  "appVersion": "0.2.0",
  "platform": "win32",
  "arch": "x64",
  "packaged": true,
  "sessionIds": ["01J..."],
  "diagnosticRef": "ERR-7K2M9P"
}
```

### 14.3 包含与排除

允许包含：

- 保留期内且通过脱敏检查的桌面端日志；
- 应用版本、操作系统、CPU 架构、打包模式；
- 日志 Schema 版本、诊断包生成时间；
- Python Runtime 可用状态和非敏感组件版本；
- 脱敏扫描结果摘要。

禁止包含：

- `novel_editor.db` 及其 journal/WAL 文件；
- `ai-settings.json` 原文件；
- 小说正文、草稿、附件、地图、封面和备份文件；
- API Key、Token、代理密码；
- Crash dump、内存转储。此类文件未来必须设计单独的明确授权流程。

### 14.4 导出范围

- 默认导出最近 7 天日志。
- 从某个错误入口触发时，优先覆盖对应 `diagnosticRef` 前后时间段，同时保留必要的启动日志。
- 导出前展示包大小和包含的类别，不要求用户阅读原始日志。
- 诊断包本身不自动上传。

## 15. 稳定性与性能要求

- 日志调用不得抛出异常影响业务代码。
- 高频路径不得使用同步文件写入阻塞 Electron 主线程。
- 日志序列化失败时记录安全的降级摘要，不得尝试输出原对象。
- 应用异常退出时应尽力刷新 `error/fatal` 日志，但不得无限等待。
- Renderer 到主进程的日志通道需要限流和单条大小限制，防止消息风暴或超大 payload。
- Python stdout/stderr 需要按行缓冲并正确处理半行、多字节字符和超长行。
- 默认日志模式对正常编辑和自动保存无可感知性能影响。
- 单条事件建议限制在 16 KB 以内，超出时截断并记录 `truncated=true`。

## 16. 框架选型约束

下一阶段对候选框架进行评估，至少验证：

| 评估项 | 必须满足 |
| --- | --- |
| Electron 兼容性 | 支持 Electron 主进程，Renderer 可通过安全通道接入 |
| 生产落盘 | 打包后的 Windows/macOS 应用可稳定写入指定目录 |
| 结构化输出 | 能输出或承载本需求定义的单行结构化事件 |
| 轮转清理 | 支持大小轮转、保留数量或可扩展清理策略 |
| 异步与性能 | 不在高频路径同步阻塞主线程 |
| 错误刷新 | 异常退出前具备合理的 flush/close 能力 |
| 扩展能力 | 支持自定义脱敏、字段补充和多目标输出 |
| 维护状态 | 社区活跃、许可证可接受、与当前 Electron/Node 版本兼容 |
| 测试能力 | 可以替换 transport 或输出目录，支持自动化验证 |
| Python 对接 | 能解析或接收 Python Runtime 的统一事件，不要求两端使用同一语言库 |

选型原则：项目拥有统一的 `Logger` 接口和事件契约，业务代码不直接依赖第三方框架 API，以便后续替换 transport 或增加用户授权的远程上报。

## 17. 分阶段范围

### P0：生产可诊断

- 建立统一日志根目录和项目 Logger 接口。
- 正式包默认落盘并实现轮转、保留和启动清理。
- 接入 Electron 主进程全局异常。
- 接入 Renderer 全局异常和关键 Error Boundary。
- 接入 Python Runtime stdout/stderr 与进程生命周期。
- 覆盖第 10.2 节的 P0 关键业务失败。
- 设置页提供打开目录、导出诊断包和详细日志开关。
- 建立敏感字段白名单、二次扫描和测试。

### P1：关联与质量提升

- 关键 IPC、AI 和 Agent 链路贯穿 `traceId/requestId`。
- 所有用户可见关键错误提供 `diagnosticRef`。
- 逐步替换无结构的 `console.*`。
- 增加耗时阈值、限频和性能类日志。
- 完成 P1 业务链路覆盖。

### P2：可选远程诊断

- 在独立隐私评审和用户授权设计完成后，再评估 Sentry 或其他错误收集服务。
- 明确采样、区域、数据保留、删除和撤回机制。
- 本地日志与诊断包能力继续保留，不以远程服务替代。

## 18. 验收标准

1. 正式 Windows 安装包启动后，在统一日志目录生成主进程日志，重启应用不会清空上一会话。
2. 便携版从只读或不可写安装目录运行时，仍能在系统 `userData/logs` 生成日志。
3. Renderer 抛出未处理异常后，`renderer.log` 中存在结构化错误、`sessionId` 和诊断编号。
4. Electron 主进程发生未处理异常时，尽力写入 `fatal` 事件，下一次启动仍能读取该事件。
5. Python Runtime 启动失败或异常退出时，日志包含阶段、退出码/信号和关联 `traceId`，但不包含启动 token。
6. 一次 Agent 调用可以通过相同 `traceId` 串联 Renderer、Electron 和 Python Runtime 日志。
7. 触发章节保存失败时，UI 显示简明错误和诊断编号；日志包含规范化错误但不包含章节正文。
8. 日志超过单文件上限时完成轮转，保留旧日志且总量不超过策略上限。
9. 模拟磁盘不可写时，日志设施不会导致编辑、保存错误处理或退出流程再次崩溃。
10. 开启详细日志后能够记录 `debug` 事件，24 小时后自动恢复，敏感内容仍不落盘。
11. 导出的诊断包包含 manifest、环境摘要和三类日志，不包含数据库、AI 设置原文件、正文和附件。
12. 使用包含 API Key、Bearer Token、Prompt、正文、绝对路径的测试 payload 后，日志和诊断包扫描均未发现原值。
13. Renderer 高频连续产生日志时受到限流和大小限制，不造成应用明显卡顿或磁盘失控。
14. 日志框架写入或轮转异常不会产生递归日志循环。

## 19. 测试要求

至少建立以下自动化测试：

- 日志事件 Schema 校验测试。
- 敏感字段白名单与脱敏测试。
- 错误对象、循环引用、超长字符串和不可序列化值测试。
- 文件轮转、过期清理和总量限制测试。
- Renderer 日志 IPC 的权限、限流和大小限制测试。
- Python stdout/stderr 分行、半行、UTF-8 和超长行测试。
- `sessionId/traceId/requestId/diagnosticRef` 传递契约测试。
- 诊断包内容清单、路径穿越和二次敏感扫描测试。
- 磁盘不可写、文件被占用和日志目录损坏的降级测试。
- 打包后 Windows 安装版和便携版冒烟测试；macOS 发布前补充对应冒烟测试。

## 20. 待决策项

以下问题在框架选型阶段确定：

1. Electron 侧采用 Electron 专用框架，还是通用 Node 结构化日志框架加自建 Renderer IPC。
2. 日志文件使用严格 JSON Lines，还是框架文本格式中嵌入结构化 JSON；优先选择便于机器检索的格式。
3. Python Runtime 输出由 Electron 统一落盘，还是 Python 独立写入同一日志根目录；必须避免竞争写入。
4. 单文件大小、归档数量、归档压缩和精确总量预算。
5. `traceId` 使用 UUID、ULID 或现有 Agent `requestId` 体系扩展。
6. 是否需要本地 Crashpad/minidump；如需要，必须独立设计授权、敏感性和导出流程。
7. 是否在 P0 保留对现有 `console.*` 的兼容捕获，以及兼容层的退场时间。

## 21. 完成定义

本需求 P0 完成需要同时满足：

- 正式包能够稳定生成、轮转和清理日志；
- 三个桌面端进程的关键错误均有生产日志；
- 用户能够自行打开日志目录并导出安全诊断包；
- 关键用户错误能够通过诊断编号关联；
- 敏感信息测试和诊断包安全测试通过；
- Windows 安装版与便携版完成真实打包验证；
- 框架故障不会影响产品核心流程。
