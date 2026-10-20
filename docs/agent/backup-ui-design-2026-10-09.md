# 备份与恢复界面优化记录（2026-10-09）

## 交付内容

设置中的创建、恢复、自动保护、备份列表及最近恢复报告改为统一卡片布局。宽内容区并列显示创建与恢复，窄窗口使用单列；支持浅色与深色主题。预览独立展示作品、记录和图片数量，以可选择的模式卡片区分副本与全量替换，默认副本，旧版备份只提供副本。

全局操作弹窗展示操作标题、分阶段步骤、当前阶段进度、实际资料计数和已用时间。没有有效总量时显示流动进度条，不生成假百分比。后端进度事件新增可选 operation 字段，确保恢复过程中的安全快照不会显示成创建备份。

取消期间显示等待并禁用重复请求，失败提供重试。切换数据时移除取消按钮并说明需要保持应用打开。焦点限制在进度弹窗内，Escape 不会关闭背景设置窗口，结束后恢复之前的焦点；支持减少动画偏好。

实现入口：

- `apps/desktop/src/components/Settings/BackupRestorePanel.tsx`
- `apps/desktop/src/components/Settings/BackupProgressDialog.tsx`
- `apps/desktop/src/components/Settings/backup.css`
- `apps/desktop/src/App.tsx`
- `apps/desktop/shared/backup.ts`
- `apps/desktop/electron/backup/BackupEngine.ts`
- `apps/desktop/electron/services/BackupService.ts`

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir apps/desktop typecheck` | 通过 |
| `pnpm --dir apps/desktop exec vite build` | 通过；既有大资源块提示保留 |
| `pnpm --dir apps/desktop test:backup` | registry、retention、maintenance、archive、integration 五组全部通过 |
| UI 密码校验与恢复模式 | 空密码自定义提示、副本默认值、旧版仅副本通过 |
| UI 进度 | 18 / 40 显示 45%；无总量省略 aria-valuenow 并显示“处理中” |
| UI 取消和键盘 | 一次取消请求、焦点限制、StrictMode 焦点保持、Escape 背景拦截通过 |
| UI 恢复阶段 | 安全快照校验仍属恢复第二阶段；切换阶段不可取消，焦点仍保留 |
| UI 外观 | 浅色、深色与 760px 窄窗口检查通过；面板无水平溢出 |
| UI 补充交互 | 全量替换二次确认、过期预览清除、预检两阶段、取消失败可重试通过 |
| UI 小尺寸弹窗 | 380px 窗口无水平溢出；失败提示和取消按钮正常展示 |

UI 使用 Vite 构建产物与 Playwright CLI，注入 Electron API fixture 驱动实际 React 界面；本轮没有通过 UI 写入作者真实资料库。后端五组回归使用真实归档及隔离数据库，桌面真实恢复验证见同日既有验收记录。

检查脚本及截图位于 `output/playwright/backup-ui-init.js`、`backup-ui-check.js`、`backup-ui-final-check.js`、`backup-redesign-light.png`、`backup-redesign-dark.png`、`backup-redesign-narrow.png`、`backup-progress-count.png`、`backup-progress-dialog-light.png`、`backup-progress-dialog-dark.png`、`backup-progress-narrow.png`、`backup-history-redesign.png` 与 `backup-preview-options.png`。验证日志位于 `output/backup-ui-typecheck.log`、`backup-ui-build.log`、`backup-ui-regression.log`。
