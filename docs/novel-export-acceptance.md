# 小说导出实施与验证

日期：2026-10-19
对应需求：[小说导出需求与设计 v0.4](./novel-export-requirements.md)

## 实施结果

- 首页“编辑作品”旁和编辑页顶部设置按钮左侧提供“导出小说”，共用格式弹窗、范围、进度、结果和重试流程。编辑页写作 / Agent 模式共用顶部入口。
- 支持 TXT、DOCX，顺序为书名、作者、简介、各卷各章正文；DOCX 在作品信息后增加目录。空作者和简介省略；空卷空章保留实际标题。
- 作者沿用 `Novel.formatting.author`，简介沿用 `Novel.description`。无需增加数据库字段或迁移。
- 当前章保存、切章保存、目录重命名接入按作品保存队列；保留失败写入供重试，队列在编辑器卸载后仍可由首页导出等待。导出读取最新 Lexical 状态，并等待已开始的输入法组合输入结束。
- 主进程保存后通过数据库事务读取完整、稳定排序的有效卷章快照，排除软删除数据；取得快照后解除编辑暂停。
- 复用 `shared/lexicalDocument.ts` 的解析与节点遍历，增加 `extractChapterParagraphs`。保留段落、空行、缩进、段内换行、Mention 名称和标记包裹文字，原 `extractReadableText` 默认行为保持兼容。
- 独立 Python `document_exporter` Worker 生成 TXT、DOCX，不依赖模型、Agent 服务或数据库直连。Electron 负责受控输入、文件位置选择和最终提交。
- TXT 使用 UTF-8 BOM 和 CRLF。DOCX 使用 Title / Heading 1 / Heading 2、卷分页、唯一书签、初始目录链接、TOC 域及更新域设置。
- 同目录临时产物完整写入、关闭并同步后才替换最终目标；失败清理临时目录并保留原文件。目标在生成期间变化时拒绝覆盖。
- 导出 Worker 已接入现有运行时打包脚本，新增 Windows/macOS 共用的 PyInstaller spec 和两种格式的打包冒烟验证。

## 自动化验证

环境：Windows 11 x64；Intel Core i5-11300H；16 GiB RAM；Node.js 24.14.0；Python 3.12.12；python-docx 1.2.0。

| 验证 | 结果与覆盖范围 |
| --- | --- |
| `pnpm --filter @novel-editor/core run build` | 通过，生成当前 schema 的 Prisma Client 并编译 core；生成产物不作为本次业务源码改动 |
| 桌面 `pnpm exec tsc --noEmit` | 通过，含 React、共享模块、preload 和主进程 |
| 桌面 `pnpm exec vite build` | 通过，含渲染层、主进程和 preload；现有大 chunk 提示仍存在 |
| 桌面 `pnpm run test:novel-export` | 通过：公共解析、保留空白及引用、历史文本、损坏正文、保存队列失败重试、真实 SQLite 排序及软删除过滤、等待保存、快照隔离、真实 Python TXT/DOCX 进程、取消、扩展名覆盖拒绝、旧文件保护、数据集变化和重试读取最新内容 |
| 桌面 `pnpm run test:lexical-document` | 通过，原公共可读文本、追加、规范化和结构恢复回归 |
| 桌面 `pnpm run test:backup` | 通过，含 schema 注册、保留策略、维护边界、归档边界及全部 41 类业务域的备份恢复集成验证 |
| Python `tests/test_document_exporter.py` | 提供打包二进制环境变量后 8 项通过：元数据、编码、空内容、DOCX 样式及目录 XML、协议、错误、大作品和打包独立运行 |
| 独立 PyInstaller 导出 Worker | Windows x64 实际打包成功；移除 Python 环境变量、将 PATH 限制到 Windows 系统目录后，打包 exe 成功生成并读取 TXT、DOCX |

Python 测试复现（在 `agent_runtime` 下）：

```powershell
.venv/Scripts/python.exe -m PyInstaller document-exporter.spec --noconfirm --distpath build/export-verification/dist --workpath build/export-verification/work
$env:NOVEL_EXPORTER_BINARY = (Resolve-Path build/export-verification/dist/document-exporter/document-exporter.exe).Path
.venv/Scripts/python.exe -m pytest tests/test_document_exporter.py -q -s
```

大作品样本为 10 卷、1,000 章，正文至少 120 万 Unicode 字符，包含 Emoji 和逐章末尾标记。两种文件均逐章核对，无截断：

| 格式 | 生成并校验耗时 | 文件大小 |
| --- | --- | --- |
| TXT | 0.03 秒 | 4,032,009 字节 |
| DOCX | 3.80 秒 | 72,911 字节 |

同一 Python pytest 进程累计峰值工作集为 88.0 MiB，包含测试样本、生成及重新读取 DOCX 的开销；此数值不是完整 Electron 应用的峰值内存。以上时间为本机一次测试结果，未作为跨设备性能承诺。

该压力样本使用重复文本，每章仅有两个正文段落；其 DOCX 压缩率很高。结果证明这份合成样本生成完整，不代表同字数、更多段落的真实小说在 Word/WPS 中的打开速度。

## 章节范围和自动分批扩展

- 整本单文件、指定起止位置、按每 N 章拆分三种方式均已接入；默认每份 500 章。
- 位置按已排序且排除软删除的全书目录计数，包含空章；跨卷不重新计数。输出保留原显示章号。
- 每个批次仅包含相关卷章，独立带作者、简介和 DOCX 目录。分批的总章节数和当前文件进度可见。
- 全部分片使用同一个已保存作品快照。依次转换各份并启动独立 Python Worker，生成成功的文件先留在临时目录；全部成功后，原子提交一个新文件夹。
- `test:novel-export` 新增并通过：跨卷范围、越界及空作品拒绝、1001 章按 500 拆为三份且无重漏、真实 Python TXT/DOCX 分批、各份元数据、总进度、后续批次不混入新修改、第二份失败不交付半套、目录选择取消。
- 扩展后的 TypeScript 检查和 Vite 渲染层 / 主进程 / preload 构建通过。
- Playwright 在生产前端构建与隔离 API 替身上验证：分批默认 500、零值禁用提交、预计文件数更新、请求中的拆分数量和成功结果中的文件数；起止颠倒禁用提交，合法范围请求保留正确位置。真实文件落盘与后续批次失败由上面的集成测试验证。

提供给用户实际打开比较的文件保留在本地忽略目录 `apps/desktop/output/export-samples/2026-10-19/`：

| 文件 | 来源 | 大小 |
| --- | --- | --- |
| `large-1000-chapters-original.docx` | 从 pytest 保留目录复制的原始 1000 章测试结果 | 72,911 字节 |
| `large-0001-0500.docx` | 使用相同源样本截取前 500 章，通过同一 Python 导出器生成 | 55,318 字节 |
| `large-0501-1000.docx` | 使用相同源样本截取后 500 章，通过同一 Python 导出器生成 | 55,390 字节 |

已重读两份范围文件，确认各含 500 个章节标题。尚未将用户在 Word/WPS 中打开这些文件的结果计入通过记录。

## 浏览器界面验证

使用 Playwright CLI 打开实际生产前端构建，注入隔离的 Electron API 测试替身，不接触用户小说数据：

- 首页和编辑页均可打开同一格式弹窗；作者、简介和 DOCX 目录说明可见。
- 验证格式切换、成功路径展示、错误反馈、重新选择位置、正常取消及取消后重新启用按钮。
- 实际挂载编辑器，验证 A 章修改后切章、B 章即时修改并立刻导出时，保存回调提交了两章最新内容。
- 查看了 1280×720 浅色和 390×844 深色截图，弹窗内容与主要按钮可见。
- 该界面测试使用模拟进度与保存对话框结果；真实文件生成和替换由上面的 SQLite + Python + 文件系统集成测试另行验证。

截图和隔离测试脚本位于本地忽略目录 `apps/desktop/output/playwright/`。

## 尚未覆盖的实机验收

- Word 和 WPS 的实际打开、导航窗格、初始目录点击及更新整个目录后的页码。当前验证到 DOCX 可重读、标题样式及大纲层级、TOC 域、初始内部链接与书签对应关系。
- macOS 打包和实机运行；本次实际构建的是 Windows 独立导出 Worker，未生成完整桌面安装包。
- 完整 Electron 窗口中系统保存对话框、覆盖确认、跨窗口保存应答超时及中文输入法组合输入的人工操作。
- 真实磁盘写满、文件被 Word/WPS 占用、恢复切库与导出并发的端到端操作；已验证生成异常时旧文件保留、保存失败停止和数据集标识变化拒绝继续。
- 1000 章整本作品在完整桌面应用中的 UI 响应与全进程内存；当前大作品测量覆盖 Python 生成链路。

功能已经接入应用；上述项目需在对应实际环境中按需求验收表补验，不将结构检查或模拟界面测试记为实机通过。
