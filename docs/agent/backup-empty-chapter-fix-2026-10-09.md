# 空章节导致完整备份失败：修复记录

日期：2026-10-09。用户人工导出时提示“章节正文不是有效的编辑器文档”。

## 原因与验证盲点

`BackupEngine.validateDataset()` 无条件对每一章正文执行 `JSON.parse` 并要求 Lexical 根节点。软件新建/清空章节时正常存储 `content: ''`；编辑器也支持旧版纯文本，JSON 解析失败时会回退为文本。备份校验比实际存储和编辑器读取契约更严格，导致正常空章节阻止整库备份。

初始集成测试和桌面演练把章节都写成有效 Lexical JSON，遗漏了空章节及历史格式，因此通过结果不能覆盖这个场景。加入空章节后，修复前集成测试稳定复现了与用户截图一致的错误，见 [修复前失败日志](../../output/backup-content-before-fix.log)。

## 修复

- 正文校验改为验证字符串存储类型；空字符串、空白、旧版纯文本及编辑器文本回退格式都可以备份。
- 导出和全量恢复保持正文原始字节，不在备份时转换为 Lexical、去除空白、重写换行或修复 JSON，避免改变章节版本/草稿内容 hash。
- 副本恢复仅对识别为 Lexical 文档的 `content` 字符串处理结构化引用。作者正文里的 JSON 示例即使包含 `chapterId` 等字段，也保持原样。
- SQLite 完整性、外键、领域覆盖、包 hash、资源、草稿身份及代际切换检查继续生效。

实现：`apps/desktop/electron/backup/BackupEngine.ts`。本次没有修改作者真实章节数据，也没有对真实库执行恢复。

## 修复后验证

| 检查 | 结果 |
| --- | --- |
| 五组 `test:backup` | 通过；集成 fixture 新增空正文、空白、纯文本、JSON 示例、JSON 字符串、截断 JSON、Lexical 与尾部文本混合格式 |
| 副本/全量集成往返 | 各格式正文逐条比较原始字符串；JSON 示例里的章节 ID 不重写；有效 Lexical 引用仍按副本身份映射 |
| 类型检查与 Vite 构建 | 通过 |
| 真实 Electron：副本与全量替换 | 通过；真实 `createChapter` 生成空章节，另添加纯文本及 JSON 示例；重启后逐章读取并逐字比较 |
| 桌面其他验证 | 加密、错误密码重试、历史会话、未发送输入、图片、FTS/RAG 本地索引、自动保护与固定保留重启持久性仍通过 |
| 真实开发库只读快照 | 518 章，含 1 个空章节；隔离副本导出/重新读取预检成功，共 2605 条业务记录 |
| 真实安装版库只读快照 | 501 章，含 1 个空章节；隔离副本导出/重新读取预检成功，共 554 条业务记录 |

真实库诊断使用 SQLite 只读连接将一致快照写入临时目录，后续备份、验证及清理均在该隔离目录中完成。没有删除、转换或修复用户库里的空章节。诊断备份及隔离数据库已清理，仅保留统计结果和日志。

证据：[专项日志](../../output/backup-content-fixed-tests.log)、[类型检查](../../output/backup-content-fixed-typecheck.log)、[构建](../../output/backup-content-fixed-build.log)、[真实库统计](../../output/backup-real-content-result.json)、[真实库导出日志](../../output/backup-real-content-check.log)、[副本桌面日志](../../output/backup-content-electron-copy.log)、[全量桌面日志](../../output/backup-content-electron-replace-all.log)。

## 生效范围

源码与开发构建已更新。已经启动的旧 Main 进程需要重启以加载修复；安装版需要重新构建/更新安装包。本次没有发布安装包。原验收记录中的既有 Skill 断言失败和跨平台/压测限制仍见 [初次复验记录](./acceptance-backup-2026-10-09.md)。
