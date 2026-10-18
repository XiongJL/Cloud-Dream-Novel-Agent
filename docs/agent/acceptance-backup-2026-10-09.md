# 完整备份与恢复：2026-10-09 复验

本次验证当前工作区代码，并重新构建 Renderer、Main 与 Preload 后运行 Windows 真实 Electron 演练。范围参见 [需求与实施记录](../../BackupDesign.md)及[首版验收记录](./acceptance-backup-2026-10-08.md)。

后续人工测试发现空章节被误判为无效 JSON，说明本次初始 fixture 的格式覆盖不足。该缺陷已复现并修复，补充验证见 [空章节备份修复记录](./backup-empty-chapter-fix-2026-10-09.md)；不能再将下述初始通过结果视作覆盖了所有历史正文格式。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir apps/desktop typecheck` | 通过 |
| `pnpm --dir apps/desktop exec vite build` | 通过；现有大 chunk 提示仍存在，未生成或发布安装包 |
| 备份注册表、轮替、维护屏障、集成往返 | 通过；覆盖 40 个领域、隐式关联、加密与损坏、图片、历史会话/草稿/审核文件、未来表遗漏、预览失效、取消、v1 导入限制与候选损坏回滚 |
| 新增归档边界检查 | 通过；实际 ZIP 路径穿越、大小写重复条目、超大声明长度、空间不足、未来格式版本、缺失输入文件、流式取消及 Windows 文件句柄释放 |
| Windows：副本恢复及重启 | 通过；恢复后作品数 2，正文、历史消息、未发送输入、实际图片解码、FTS 与本地 hash RAG 索引正常 |
| Windows：全量替换及重启 | 通过；恢复后作品数 1，同样验证正文、会话、图片、索引及恢复日志确认 |
| Windows：错误密码与重试 | 两种恢复模式均拒绝错误密码，保留当前作品库，随后正确密码预检及恢复成功 |
| Windows：周期保护持久性 | 空闲后生成有效自动包；固定保留、关闭自动保护后再次重启，两项设置仍生效，自动包仍通过校验 |
| 既有 Agent 回归 | 46 个子检查中，45 个通过，1 个既有源码契约断言失败。组合命令在失败处停止，其后的 16 项已单独执行通过 |

新增 `apps/desktop/scripts/backup-archive-test.mjs` 已接入 `test:backup`，该入口现包含注册表、轮替、维护屏障、归档边界和集成往返五组检查。CI 沿用该入口。

所有恢复演练使用临时 userData；进程退出后删除本次隔离目录。没有对作者真实作品库执行恢复。空间不足通过注入零可用空间的 `statfs` 结果验证拒绝行为，没有填满实际磁盘。

## 已知回归问题

`agent-structured-output-contract-test.mjs:37` 的正则要求精确的 `{ autoRepair: true }`。当前工作区既有 `AutomationService.ts` 调用同时透传 `agentSkill`（第 1341、1829 行），因此该源码断言不匹配。本次复验没有修改这段业务逻辑或放宽断言；完整 `test:agent-recovery` 仍记为失败，不能把 45 项单独通过等同于组合命令通过。

本次未发现备份功能的新失败，改动仅增加验证用例、强化桌面演练证据及更新文档。

## 证据

- [备份专项日志](../../output/backup-verify-2026-10-09.log)、[类型检查](../../output/backup-typecheck-2026-10-09.log)、[构建](../../output/backup-build-2026-10-09.log)。
- [Agent 组合回归](../../output/backup-agent-regression-2026-10-09.log)、[失败后其余检查](../../output/backup-remaining-regression-2026-10-09.log)。
- [副本恢复结果](../../output/playwright/backup-electron-copy-result.json)、[全量替换结果](../../output/playwright/backup-electron-replace_all-result.json)。结果含执行时间、错误密码拒绝、作品/消息数量、资源解码、索引报告；副本结果另含自动保护持久性。
- [副本桌面日志](../../output/backup-electron-copy-2026-10-09.log)、[全量替换桌面日志](../../output/backup-electron-replace-all-2026-10-09.log)。

## 尚未验证的发布门槛

macOS、跨平台安装包互导、2 GiB 资源压测与 512 MiB 峰值内存目标、真实磁盘耗尽、OS 断电/强杀矩阵仍未完成。现有证据支持首版范围在 Windows 开发环境中的功能验证，不代表全部发布门槛通过。选择作品恢复与无凭据偏好迁移等 P1 功能仍未实现。
