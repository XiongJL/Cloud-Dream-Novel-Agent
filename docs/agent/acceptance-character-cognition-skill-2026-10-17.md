# 人物认知与行为内置 Skill 第一版验收

日期：2026-10-17。用户要求新增内置 Skill、补充不足人物信息并开展对照试验，特别要求人物认知随故事时间变化。

## 交付与边界

新增 `builtin.character-cognition`，版本 `1.0.0`，修订 `builtin.character-cognition@1.0.0`。在既有注册表提供，可与文风 Skill 组合，支持写作、修订、审核及人物素材补全；不强制成为所有任务默认项。写作输出正文，审核输出问题及依据。

区分事件发生时间、人物获知时间、叙述位置和有效稿件版本；处理同章认知变化、错误信念及纠正、倒叙和废弃稿失效。判断欲望、顾虑、能力、关系与情绪，不把人物统一限制为理性决策者。信息缺失不能直接判为人物不知道；作者真相不能直接成为人物已知。

本版是方法层，未实现自动时序记忆库、RAG 时间过滤或采用章节后的自动状态写回。人物补全仅保存为试验候选，两组使用相同人物卡，未写入正式人物档案。现有 11 章版本与正文哈希均未变化。

新的隔离运行时通过真实 `/invoke` 目录和组合预览读取了本机文风 Skill，确认完整双 Skill 内容及冻结修订一致。当前桌面 Agent 没有重启，需重启后载入新增内置项；未验证当前旧进程 UI 已显示该项。

## 试验结论

固定文风、人物卡、任务、模型和参数，仅增加新 Skill，完成每组 3 篇共 6 篇正文。两组篇幅合格均为 1/3，没有观察到稳定降低改稿量。生成前选定各组第一篇进行一次编辑：基线 2 个修改块，新 Skill 8 个修改块；修改块大小不同，不能换算人工时间，也不能据此宣称人类水平已经达成。

8 个独立构造案例，基线匹配预设答案 7/8，新 Skill 8/8。差异仅在一个存在解释空间的情绪选择案例；时间相关案例两组均通过，不能外推为长篇时序记忆已经可靠。

两次完成的写后审计发现部分问题，但也出现引用改写、误判和漏检。保留逐条复核及经校正的认知状态候选，绑定源稿哈希与获知动作，未自动入库。一次审计耗尽预算无正文结果，保留记录后仅提高输出上限恢复一次，没有重生成正文。

累计 11 次服务请求，含 1 次未完成请求，共 118838 token。单模型、单开篇题材、小样本、助手非盲评；未使用朱雀检测结果。降低 AI 味并稳定轻改成稿的目标尚未验收通过。

## 验证

- 注册、解析、组合、版本锁定及目录相关第一批测试 65 项通过。
- 新增写作/审核传递验证后，新测试文件 9 项通过；既有模型消费回归 21 项通过。新增测试曾误写审核方法名，已修正，没有未解决失败。
- 导出 `SKILL.md` 格式校验通过；Windows 下使用 Python UTF-8 模式。
- 真实路由目录及组合预览通过；试验冻结版本与代码一致。
- 本轮代码差异空白检查通过。未提交或推送 Git。

## 阅读入口与复现

- [完整结论、原稿、修订稿及匿名阅读包](D:/aiproject/novalEditor/output/character-cognition-experiment-2026-10-17/结论与阅读入口.md)
- [Skill 可读导出](D:/aiproject/novalEditor/output/character-cognition-experiment-2026-10-17/SKILL.md)
- [真实路由验证](D:/aiproject/novalEditor/output/character-cognition-experiment-2026-10-17/runtime-route-verification.json)
- [经核对的时点状态示例](D:/aiproject/novalEditor/output/character-cognition-experiment-2026-10-17/reviewed-state-delta-examples.json)
- [实现](D:/aiproject/novalEditor/agent_runtime/novel_agent_runtime/agent_skills/registry.py)及[专项测试](D:/aiproject/novalEditor/agent_runtime/tests/test_character_cognition_skill.py)

实验脚本位于 `tmp/character_cognition_experiment_20261017.py`，编辑与报告脚本为 `tmp/edit_character_cognition_20261017.py`、`tmp/report_character_cognition_20261017.py`；真实路由验证脚本为 `tmp/verify_character_cognition_runtime_20261017.py`。生成已有防重复保护，复核应读取既有输出，不重复发起付费生成。输出目录保存生成前设计、全部样本及用量、逐篇原句证据、审计复核和章节未变检查。

建议后续先分离程序可核的引用、计数、版本检查与需要语义判断的认知、动机审计，再独立实现并验证时序检索及采用稿件后的状态失效机制。本轮不宣称这些能力已经完成。
