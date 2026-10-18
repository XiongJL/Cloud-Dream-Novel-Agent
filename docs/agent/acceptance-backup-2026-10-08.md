# 完整备份与恢复：首版验收记录

日期：2026-10-08。需求：[完整备份与恢复](../../BackupDesign.md)，实施范围以第 15 节为准。

## 交付范围

设置 → 备份与恢复支持全量 `.nebak` v2 导出、正文与资源一并加密、预检、副本恢复、全量替换、取消、恢复报告及本机周期备份。覆盖 39 个业务模型与标签隐式关联，共 40 张表；历史会话、消息、摘要、报告、草稿、审核意见和受管图片纳入备份。RAG/FTS 缓存在恢复后本地重建，使用本地 hash 向量，不调用模型或嵌入服务。

未来表由显式注册和运行时/CI 覆盖检查约束：未登记业务表阻止完整导出。新增资源字段、独立文件和结构化引用仍需登记迁移规则及往返用例。

## 已执行检查

| 检查 | 结果与证据 |
| --- | --- |
| `pnpm --dir apps/desktop typecheck` | 通过 Renderer 与 Electron 类型检查 |
| `pnpm --dir apps/desktop exec vite build` | Renderer、Main、Preload 构建通过；仍有现有大 chunk 提示。未执行安装包发布 |
| `pnpm --dir apps/desktop test:backup` | 四组检查通过：注册表、轮替、维护屏障、真实 SQLite/ZIP 集成 |
| 备份集成 | 40 表、标签关联、审核文件、图片、Runtime 历史往返；加密/错误密码/损坏、取消、缺失图片、未来表、预览失效、v1 限制、候选损坏启动回滚均通过 |
| 大记录分批 | 210 条约 86 KiB 的资料记录验证 200 行游标分页及约 8 MiB 分批；并验证副本记录数量。该用例不替代 2 GiB 压测 |
| 写入屏障 | 等待已启动与嵌套写入；拒绝新写入及已结束任务的迟到回调；切换后旧代写入永久封存 |
| Windows 真实 Electron：副本恢复 | 加密导出、预检、副本恢复、退出及新进程启动后，作品数 2；正文、消息、未发送输入、实际图片解码、FTS 与本地 RAG 报告均通过 |
| Windows 真实 Electron：全量替换 | 同一流程，作品数 1；恢复后正文、会话、图片、索引及恢复日志确认通过 |
| Windows 真实周期备份 | 等待连续空闲后生成有效自动包与校验收据；固定保留、策略关闭均通过 |
| 浏览器界面 | 检查密码确认、预检默认副本、全量替换二次确认、旧包只能副本、预览失效提示和备份列表；界面截图人工检查 |
| 相关既有回归 | Runtime client、Operation 排空、批次提交、创作素材写回、会话/草稿恢复、数据库生命周期及上下文/审核/索引相关检查通过 |

集成测试仅创建临时 SQLite 与文件目录。真实 Electron 演练使用 `NOVEL_EDITOR_USER_DATA_DIR` 指向临时目录，禁用测试进程自动 relaunch，再显式启动新进程；该覆盖仅在开发模式生效。没有在作者真实作品库中执行恢复。演练结束关闭进程并清理隔离目录。

本机演练证据位于 `output/playwright/backup-electron-smoke.mjs`、`backup-electron-copy-result.json`、`backup-electron-replace_all-result.json` 与 `backup-panel.png`。这些为本次工作区验收产物；CI 的固定入口为 `test:backup`，不依赖本机 Playwright 缓存路径。

## 回归限制与未完成项

完整 `test:agent-recovery` 在 `agent-structured-output-contract-test.mjs` 第 37 行的源码正则断言停止：断言要求精确的 `{ autoRepair: true }`，工作区已有 Skill 透传代码使用 `{ autoRepair: true, agentSkill: ... }`。此次备份实现未修改该 Skill 透传逻辑或放宽断言。后续 16 项回归已单独运行通过；完整组合命令不能记录为通过。日志位于 `output/backup-agent-regression.log` 与 `output/backup-remaining-regression.log`。

首版尚未发布。macOS、跨平台安装包互导、2 GiB 资源/512 MiB 内存目标、磁盘不足真实桌面演练、OS 断电/强杀矩阵尚未完成，不能据现有通过项宣称完整发布门槛已经满足。

后续 P1 保留：选择作品导出/恢复、单作品替换与依赖闭包、可选无凭据偏好迁移、草稿副本重新校验后写回及专用资源修复入口。当前界面不展示这些功能。

## 恢复后的行为

- 每次恢复前建立并重新读取校验安全快照；候选数据库和图片通过检查后才切换代际指针，启动失败回退旧代。
- 导入历史任务不自动执行，Outbox 仅作归档；自定义 Skill 默认停用。
- 副本草稿保留可阅读历史，但禁止直接提交/撤销；摘要副本标记过期。
- 原附件文件未被现有产品持久保存，因此只备份已保存的提取内容；外部 URL 保留并提示，不自动下载。
- 凭据、AI 配置、临时 Token 和日志不进入便携包；本机自动包不加密，界面明确说明。
