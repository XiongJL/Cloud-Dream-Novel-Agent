# 从Agent回写作时定位当前目录章节

原因：EditorWorkspace在Agent模式卸载写作侧栏。切回后Sidebar从初始滚动位置挂载，原有效果仅展开当前卷，没有滚动到当前章节。

修复：

- 当前章节、所属卷或目录可见状态改变时，展开所属卷并在目录自己的滚动容器内定位当前条目。
- 等待卷展开动画后的最终布局，避免500章长目录在动画中被scrollTop上限截住；隐藏/卸载取消待处理帧。
- 已可见的当前条目保持位置；只滚动目录，不滚动页面或正文，不抢焦点。
- 普通元数据刷新不触发定位，允许用户浏览其他章节、手动折叠当前卷。
- 目录从其他侧栏页签切回时也触发；异步目录载入后重试定位。

仅修改Sidebar与EditorWorkspace的可见性传递，未改Agent运行状态、章节选择、保存、导入或小说数据。

验证：使用实际Sidebar、React StrictMode、实际Tailwind样式与Framer Motion构建隔离浏览器夹具，500章首卷加10章第二卷；Playwright CLI的9项交互通过：首次定位第500章、手动滚动后刷新元数据不拉回、Agent→写作重新挂载、同卷切章、手动折叠、目录隐藏后显示、跨卷切章、异步载入目录、无当前章。页面scrollY在目录定位前后保持70。截图人工查看确认第500章高亮且完整可见。

`tsc --noEmit`通过；`agent-workspace-continuity-test.mjs`通过；修改文件`git diff --check`通过。隔离夹具没有数据库连接或模型调用，未重启用户桌面应用。测试浏览器与临时HTTP服务已关闭。

材料：[浏览器验证记录](../../output/playwright/sidebar-follow-verification.json)、[第500章定位截图](../../output/playwright/sidebar-follow-500.png)。夹具与检查脚本保存在tmp/sidebar-follow-fixture.tsx、tmp/build-sidebar-follow-fixture.mjs、tmp/sidebar-follow-check.js；不是对用户实际数据执行的端到端测试。
