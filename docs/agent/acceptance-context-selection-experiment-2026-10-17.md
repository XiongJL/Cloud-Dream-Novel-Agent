# 第一章资料选择对照验收

生成：2026-10-16；评阅完成：2026-10-17。

接续[独立重写验收](D:/aiproject/novalEditor/docs/agent/acceptance-outline-only-rewrite-2026-10-16.md)，本轮只比较HardContext资料选择，不修改产品逻辑或真实章节。

## 结论

共完成6次真实调用，整库组与场景摘选组各3次。输入token由7896降到3445，但没有观察到精简组稳定改善连贯性、对白或编辑负担。篇幅合格数分别为2/3、1/3。样本少、非盲评，不作统计优劣推断。

按生成前约定编辑各组第一篇：full-1修改2块，scene-1修改5块，其中实质修改分别2块和3块。前者修改后1643汉字，仍不满足1800–2400要求；后者2119汉字。字符改动比例不能替代人工用时或文学质量评估。稳定轻改成稿尚未验收通过。

后续候选实验是固定其余条件，对比结果型大纲与补足行动因果的大纲。本轮仅提出该假设，未生成新一轮样本、未实装默认上下文筛选。

## 交付

- [完整结论和阅读入口](D:/aiproject/novalEditor/output/context-selection-experiment-2026-10-16/实验结论与阅读入口.md)
- [逐篇原句证据](D:/aiproject/novalEditor/output/context-selection-experiment-2026-10-16/assessment-evidence.json)
- [六篇匿名阅读包](D:/aiproject/novalEditor/output/context-selection-experiment-2026-10-16/匿名阅读包.md)
- [修改前后及理由](D:/aiproject/novalEditor/output/context-selection-experiment-2026-10-16/editorial-changes.json)
- [预先约定的评阅规则](D:/aiproject/novalEditor/output/context-selection-experiment-2026-10-16/evaluation-protocol.json)

## 验证范围

模型请求为deepseek-v4-flash，服务返回deepseek-flash；Skill 1.0.2修订29553bd2-d5c5-4b9d-b831-4936f5b9445d不变。移除HardContext差异后请求相同；无旧正文/摘要/会话、无自动补长、无二次模型润色。场景摘选只使用输入原有事实片段；未来概念在共享任务中仍存在，不宣称完全消除未来信息。

六次结果均completed；证据引用逐条匹配原稿。现有11章版本及内容哈希全部未变。此次只有实验脚本、输出和此验收文档，不涉及应用代码验证。

脚本：tmp/context_selection_experiment_20261016.py、tmp/edit_context_selection_20261017.py、tmp/report_context_selection_20261017.py。生成脚本已有重复提交保护，不应为复核重复调用生成；package只整理已有输出并核对章节状态。
