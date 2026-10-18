# 第一章独立重写：实现与真实验收

日期：2026-10-16。用户授权继续实验，并允许删除既有章节内容以实现真正重写。

## 结论

已实现并通过真实调用验证单章 `outline_only` 输入策略，第一章《接班夜》已完整替换为本轮修订稿，回读与交付文件逐字一致。其他10章未修改。目标小说ID为 `cmu0xs9wo0000ubukv5asbb2a`，第一章ID为 `cmu0xs9wp0002ubukovaewrfo`。

**旧文污染与追加写回的问题得到具体修复；稳定轻改成稿尚未达成。** 本轮原始输出仍需实质编辑，不能把成功隔离旧文等同于解决AI味。

## 交付与备份

- [第一章修订稿，已写回](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/第一章-修订后.md)
- [模型原始重写稿](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/第一章-原始重写稿.md)
- [12处编辑及理由](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/editorial-changes.json)
- [改动指标](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/editorial-metrics.json)
- [原有11章完整备份](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/chapters-before.json)
- [真实写回核对](D:/aiproject/novalEditor/output/fresh-rewrite-2026-10-16/writeback-verification.json)

不必先删除整本小说才能隔离输入。本轮在旧章仍存在时完成生成侧验证，最后只替换第一章。程序读取旧正文计算写回版本哈希、保留原文对照与撤销快照；这些保存用途不进入生成模型。

## 输入策略

新增单章请求字段：

```json
{
  "mode": "rewrite_chapter",
  "sourcePolicy": "outline_only",
  "freshWritingBrief": "本次独立的章节目标、人物处境与章节终点，不含旧修订节拍或会话记录",
  "currentContent": "",
  "excludedWorldSettingIds": ["本次明确排除的设定ID"]
}
```

`freshWritingBrief` 必填且不能超过12000字符。只在显式选用该策略时生效，原续写、常规改写的上下文行为保留。现有多章改写批次不能使用它，会在调用模型前报错；不默默复用旧批次节拍。

该策略在上下文构建前生效，跳过当前章、前后章正文、章节摘要、卷/全书摘要和近章回退；不复用 `preparedContext`、`batchContext`、旧 `userIntent`、提示词覆盖、旧当前位置或灵感引用。重新从数据库取得人物、物品、地图、设定及大纲，剧情节点按计划提供，不携带旧章锚点或已完成状态。只有明确指定的世界设定ID被本次排除，不修改原设定。

本次完整加载语言Skill 1.0.2，修订ID `29553bd2-d5c5-4b9d-b831-4936f5b9445d`；本次排除“文风规范” `cmuchznbo003lub0wxzdjcn7v`，全局记录未改。新章任务遵循原大纲的“三年前停灯记录”，没有沿用此前实验自行冻结的“本周一”情境。

接口工具说明及字段已更新；**普通聊天是否自动选择此策略、UI选择入口、批量重建及后续章节的新旧事实隔离均未验收，不能称整个聊天重写流程已经解决。** 当前已验收的是显式单章接口，从提示词预览到草稿提交的完整路径。

## 替换与写回

`ChapterDraftPayload.writeMode` 区分 `append` 与 `replace`，旧草稿缺省按追加处理。单章重写新增完整替换标记，草稿预览、按意见修订与最终提交均遵守此标记；提交时依旧核对原章版本及哈希，撤销快照保留原内容。

验收中发现开发进程热更新报错，导致首次提交仍执行旧的追加逻辑。回读立刻检测到多出的旧章，随后通过 `draft.undo` 恢复原文，确认与备份完全一致。完整重启并确认打包产物包含替换逻辑后，再次提交成功。原章版本经历3→4（错误追加）→5（撤销恢复）→6（正确替换）；不存在未核对的覆盖。相关记录保存在 `commit-stale-process-undone.json`、`undo-stale-process-writeback.json`、`chapter-restored-after-stale-process.json` 和最终 `commit-result.json`。

## 真实调用与质量结果

仅发起一次模型生成，完成于2026-10-16北京时间17:23:40左右。操作ID `draftop_305df2c34b5e418da8ea5afc30a62e42`，草稿ID `4130fb8d-be6f-4e1b-85a3-31f4512c083e`，响应ID `aec044ce-9850-4836-885c-8d49925545a6`。服务用量：输入7896、输出4564（含2791推理token）、合计12460 token；没有篇幅补写或再次生成。后续工作使用已保存结果。

实际提示词预览没有匹配旧稿38个长度至少40字符的段落；注入旧文、缓存摘要、旧节拍、会话意图、当前位置与覆盖提示词的哨兵测试也未泄漏。生成回执的 `chapterSources`、`narrativeSummaryIds` 为空。原章4698字符，新稿2623字符，最长连续相同片段9字符；93个旧非空段落中只保留1个相同短段。这些指标验证未沿旧稿大段扩写，不是文学质量评分。

原稿2080汉字，落在1800—2400目标范围，仍有：

- 用手指判断纸张吸墨，凭字迹推断运笔顺序等不可靠描写。
- 检修月份与“夏天”表述冲突；“下一个守塔人”六字被写成五字。
- 姐姐以“旧账翻不动”“名字可以改”代替具体交流；任务要求保留记录，正文却没有实际落实。
- 缺乏过渡理由地翻到三年前；看灯、放回、等待等重复收束。

当前助手进行了12处编辑，修订稿1922汉字；按SequenceMatcher字符对齐，1034/2623原字符被删除或替换，约39.42%。指标含标点换行，不能换算人工工时。编辑重做了部分发现过程、对白和收尾，**应记为实质编辑，不能称轻微润色。** 没有独立人类盲评或外部检测，也没有证据证明风格已达到用户目标。

## 校验

全部通过：

- `pnpm --dir apps/desktop exec tsc --noEmit`
- `node apps/desktop/scripts/outline-only-rewrite-test.mjs`：真实方法执行，禁止读取正文与摘要，检查模型边界泄漏、预览与入库替换、撤销快照、版本冲突拒绝。
- `node apps/desktop/scripts/chapter-generation-quality-test.mjs`
- `node apps/desktop/scripts/chapter-state-checkpoint-test.mjs`
- `node apps/desktop/scripts/writing-policy-test.mjs`
- `node apps/desktop/scripts/agent-skill-consumption-test.mjs`
- `node apps/desktop/scripts/agent-runtime-renderer-contract-test.mjs`
- 真实预览、一次生成、草稿修改与提交、正文回读一致、其他10章逐条与备份一致。

代码工作区已有大量先前改动。本轮修改前保存了所触及文件的基线，`scoped-code-changes.patch`只描述相对这份基线的变化；不把全部Git差异归于本轮。未提交或推送代码。

## 对后续工作的约束

隔离旧文是必要的输入控制，不能当作提升文章质量的充分条件。下一轮应把“整库人物/大纲资料”与“为当前场景整理的少量事实”作同条件比较；本次整库输入与上轮简化输入不同，不能仅凭两篇结果证明哪一项导致退化。仍应以用户对实际文字的判断和真实编辑负担为主要验收，不继续以叠加Skill或全章润色次数代替证据。

后续10章仍是旧版本，不代表新第一章与其已经逐章衔接；重建后续章节时，应使用已接受的新章事实，同时排除旧后章正文和派生记忆。当前不宣称整本重写完成。
