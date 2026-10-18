# Agent 传统小说创作验收（2026-09-22）

状态：执行中。十章正文与单次完整自动流程尚未通过。

## 实际进展

- 重启当前源码构建的 Electron，通过 Playwright CDP 操作真实界面。测试作品继续使用 `功能验收-灯塔档案-20260916`，ID `cmu0xs9wo0000ubukv5asbb2a`。其他作品未改动；模型配置未改动。
- 上次 45 条修订素材全部恢复，草稿 ID `778e2708-03ea-44f1-ba12-77bf4b1302a3`。首次入库被图片字段冲突校验拦截。
- 原因：素材修订函数把空的 imageBase64 也替换成 `[保留原图片数据]`，模型将占位文本返回为图片数据，并与 imagePrompt 冲突。已修复：只遮蔽非空图片；返回保留标记时从同名唯一原条目恢复真实图片，绝不保存标记为图片。`creative-assets-image-revision-test.mjs` 覆盖空图、真实图、历史坏标记，测试通过；类型检查通过。此修复尚待新构建加载后的真实回归。
- 经 UI 审批意见要求四张地图仅保留地点文字设定，删除图片生成字段。生成新草稿 `ae07eb7e-60d0-4b01-beb2-34b2f722cc83`，27 秒完成。审核后整包入库成功，UI 显示“已入库”。未调用图片模型。
- 写入内容：5 条情节线、10 章情节点、6 名角色、9 件物品、5 项角色技能、6 条世界设定（含文风规范）、4 个地图地点。数据库只读检查显示情节点共 34 条，其中另有情节线内嵌的 24 个要点，非重复写回；技能存于 Item，因此 Item 共 14 条。
- 在写作界面选择既有空白第一章，标题修改为《接班夜》，切回 Agent 新建正文创作会话。

## 新发现与限制

- 第一次正文任务发送报“当前消息与已保存会话不一致”；刷新后点击“重新生成回答”可处理该消息，未重复追加用户消息。仍需定位新会话首次发送的一致性问题。
- 原请求含“提交可审核草稿”“不直接写回”，被路由为普通会话不可写回并拒绝规划。改用明确的 `chapter.continuation` 草稿生成和编辑审校请求继续测试。此原始自然语言路由未通过。
- 前日的“重试失败步骤”误路由和同一运行多份素材时审核面板总打开最新素材的问题仍保留证据，尚未修复。

## 证据

- `output/playwright/acceptance-20260922/01-restored-materials.txt`
- `output/playwright/acceptance-20260922/02-map-revision.txt`
- `output/playwright/acceptance-20260922/03-materials-committed.txt`
- `output/playwright/acceptance-20260922/04-persisted-materials.json`
- `output/playwright/acceptance-20260922/05-first-chapter-context-error.txt`
- `output/playwright/acceptance-20260922/typecheck.log`
