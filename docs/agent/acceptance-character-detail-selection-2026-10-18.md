# 人物认知与行为 1.1.0：细节取舍与模型名称更新

2026-10-18 完成核验。依据用户阅读《接班夜》试稿后的反馈更新内置 Skill，并将当前 DeepSeek Flash 名称统一为 `deepseek-flash`。

## Skill

`builtin.character-cognition@1.1.0` 新增“按场景作用取舍细节”：

- 人物知道、作者想得到或细节合理，不等于需要写进正文。
- 专业对白交代听者需要理解的影响和下一步；不堆部件名与维修步骤，也不凭空补造技术事实。
- 普通过渡动作可以概括或省略；有后果的上锁、交接及承载悬念或情绪的动作仍须保留。
- 环境声和感官细节参与场景或形成有辨识度的氛围，避免习惯性填充；生活细节不必全部推动主线。
- 已表达清楚的内容不默认再解释、总结；允许合并句段并调整衔接，不把修订限制为零碎删字。
- 保留人物声音、有效心理与线索，不机械追求短句、少字；表达建议不冒充事实冲突以绕过修订门禁。

未锁定版本的选择默认解析为 1.1.0。1.0.0 的正文、约束和内容哈希保持不变，显式锁定旧版仍可复现。时间线、误信和同章认知变化等原有规则保留。

实现：[registry.py](D:/aiproject/novalEditor/agent_runtime/novel_agent_runtime/agent_skills/registry.py)。
可读导出：[SKILL.md](D:/aiproject/novalEditor/output/character-cognition-detail-1.1.0-2026-10-17/SKILL.md)。导出目录沿用本次工作开始日期。

## 模型配置

模型目录改为 `deepseek-flash` / `DeepSeek Flash`，保留既有上下文额度；历史 `deepseek-v4-flash` 名称仍能查询同一能力配置，避免旧记录退回通用额度。此兼容只用于能力查询，不声称模型服务继续接受旧请求名。

本机 `desktop-dev/ai-settings.json` 中 `http.model` 已由旧名改为 `deepseek-flash`；核对全部其他字段相等，API Key、地址、采样和预算等设置未变，密钥未输出或复制进仓库。共用实验请求助手允许新名称，生成记录从实际配置读取模型名；历史输出和验收记录不批量改写。

当前运行的桌面进程缓存设置和 Python 模块，本轮没有重启应用。需要重新启动使用当前源码的小说编辑器以加载新设置和内置 Skill；如使用打包版本，则需包含本轮代码的构建。重启后重新选择 Skill 可使用默认 1.1.0，旧运行已锁定的 1.0.0 不自动替换。

## 核验与范围

- `test_character_cognition_skill.py`、`test_postwrite_single.py`、`test_skill_model_consumption.py` 共 46 项通过，包含新旧修订解析、旧哈希不变、目录默认版本、与文风组合及写作/审核提示传递。一个既有 Starlette/httpx 弃用提示。
- TypeScript 模型目录检查通过：新名称、历史别名、带前缀名称与未知模型回退；未调整其他模型。
- Skill 导出格式验证通过，改动的跟踪文件 `git diff --check` 通过。
- 本轮是 Skill 与配置修改，没有新增模型调用或正文试稿。尚未验证 1.1.0 实际生成质量；不能用回归测试代替用户阅读验收。
- 未写正式章节或人物库，未提交或推送 Git。
