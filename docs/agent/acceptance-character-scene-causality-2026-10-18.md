# 人物认知与行为 1.2.0 修订

根据用户提供的续写与原文对照，将场景交锋、反转前提、处境限制和比喻取舍加入内置 `builtin.character-cognition`。本轮修订方法，不改正式章节、人物设定或模型配置。

## 新规则

- 按一段交锋检查信息、关系、情绪、决定或行动空间的变化。允许闲话、嘴硬及有目的的拖延；压缩重复宣告聪明、危险、恐惧却不改变局势的对峙。
- 关键反转回查此前对白、行动、空间和规则，不能为揭晓临时补造已发生的前提。允许诈唬、误判与隐藏计划，人物断言不自动成为叙述事实；材料缺失要区分未知与矛盾。
- 按需核对回合、开锁、移动和位置，不向正文输出完整账本。伤势、疲惫、资源及技能应实际影响可行动范围，不能只作装饰；有依据的忍痛和特殊能力仍允许。
- 比喻增加感受、人物视角或理解；删改只复述前句或泛泛暗示深意的表达，不禁用“像”，不按词频控制，也不为去掉含糊而赋予视角人物全知。

规则保留 1.1.0 的细节取舍及 1.0.0 的时点、错误信念和候选状态边界。表达建议不冒充事实冲突，不绕过已有修订门禁。

## 版本与核验

默认修订为 `builtin.character-cognition@1.2.0`。1.0.0、1.1.0 内容哈希不变，显式锁定旧版本的运行保持原版本。新增规则在续写预览中完整出现。

`test_character_cognition_skill.py` 与 `test_skill_model_consumption.py` 共 41 项通过，覆盖三个版本在写作、审核等操作的编译、默认目录、与文风组合及模型调用参数传递。一个既有 Starlette/httpx 弃用提示。导出 Skill 格式校验与改动文件空白检查通过。

没有新增模型调用，也没有宣称新规则已改善生成质量。当前运行的 Agent 未重启；重新加载当前源码的 Agent 后，重新选择此 Skill 使用默认 1.2.0。已锁定旧版本的任务不会自动换版。

- [可读 Skill](D:/aiproject/novalEditor/output/character-cognition-scene-1.2.0-2026-10-18/SKILL.md)
- [续写编译预览](D:/aiproject/novalEditor/output/character-cognition-scene-1.2.0-2026-10-18/preview.json)
- [内置实现](D:/aiproject/novalEditor/agent_runtime/novel_agent_runtime/agent_skills/registry.py)

未提交或推送 Git。
