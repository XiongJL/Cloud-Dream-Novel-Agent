# 写后审计→定点修订→复查最小入口验收

2026-10-17。实现门禁与关键测试，真实模型质量验收未通过；不把函数测试通过称作小说质量改善。

## 实现

- 新增 `agent_runtime/novel_agent_runtime/postwrite_audit.py`，现有 `toolchains/chapter_consistency_review.py` 导出 `run_postwrite_loop`。沿用既有review_request/ContextBundle，调用方注入现有模型适配器，未新建平行HTTP服务或默认写作流程。
- 明确源稿身份/版本/分支/SHA；逐字连续唯一引文及offset验证；分类、理由、影响、最小建议；自报confidence不参与判定。修订资格要求目标与独立不重叠反证均同稿有效引文、双方为叙述者断言，交代不足/合理留白/不确定/人物台词/引用文档留人工。标签与引文仍不证明语义正确，最终输出始终待阅读。
- 只局部替换，一轮<=6处，old/new各<=400字符，总覆盖各<=15%；实际修改字符须在已批准证据里，拒绝重叠/远处改写/旧源补丁。无问题跳过修改仍复查；非法补丁保留后回查未改稿。复查同时查旧/新问题，当前bundle精确换成B。
- explicit_facts可选程序层在收费前核对来源/引用并核算明确HH:MM/次日及字面汉字数量，落盘program-checks。extractionVerified=false/suppliedRoleAssignments=true，计算正确不代表起止角色解析或事件真相正确，不授权修正人物误说或不可靠记录。普通中文时序没有自动解析。
- 人物状态只候选，记录事件/获知/叙述位置、动作、来源、版本分支；语义提取未程序证明，不作自动知识。替换原稿的revision checkpoint先持久化失效源；复查失败仍能识别旧候选失效。FileDraftAuditJournal用新目录、原子落盘、拒绝默默恢复重发。没有永久设定入库或完整时序RAG。

## 可调用方式

```python
from novel_agent_runtime.postwrite_audit import DraftSource, FileDraftAuditJournal
from novel_agent_runtime.toolchains.chapter_consistency_review import run_postwrite_loop

source = DraftSource(text, draft_id, draft_version, branch)
result = await run_postwrite_loop(
    source,
    {"chapter": {"id": underlying_chapter_id, "content": text}},
    existing_model_adapter,  # async(operation_id, request) -> parsed JSON dict
    FileDraftAuditJournal(new_artifact_directory),
    explicit_facts=(),
)
# result['text'] 是待审核候选，采用仍走现有草稿服务，不自动写正式章节。
```

模型适配器须保存发送前账本/响应和未知收费请求状态，不自动重发；入口至多audit、patch、recheck各一次。原审核与局部修订采用新的有界结构化返回合同，适配器不能把普通ReviewArtifact或完整章节正文直接冒充patch对象。普通Agent写作未自动接入该入口。

## 验证

最终相关回归63项通过；最后增加旧程序计算不冒充B当前事实断言后，专项29项再次通过。覆盖引用拼接/重复/offset、同名嵌套伪反证、版本/分支/哈希、非冲突不改、人物错误转述、时间角色提取不确定、字面计数、完整重写/周围文字改动拒绝、旧状态失效磁盘重读、复查正文B绑定、未知请求不重试、程序事实源错收费前拒绝。已有FastAPI测试依赖有StarletteDeprecationWarning，不是测试失败。

正式11章版本/正文哈希全部未变；没有写正式人物资料、重启桌面、改模型设置、提交或push。

## 实验与结论

完整材料：[结果与阅读入口](../../output/postwrite-loop-experiment-2026-10-17/结论与阅读入口.md)。读六稿全文之前冻结全六稿A/B、一次局部修订、总18请求/162000输出token上限。旧manual-review、reviewed-state-delta、edited稿、主代理A-only评估没有进入修订模型。

实际6次审计全部max_output_tokens截断，无完整JSON，未进patch/recheck；121955 total token，未重发/扩预算。六稿B均保留A，提供源哈希、空diff、匿名12稿与发送/失败记录。**真实audit→patch→recheck尚未走通，未证明问题修复、降低人工负担或保持声音的质量改善；质量指标不可评估，原问题仍在。**

初版进程一次串行启动六稿后进行了安全审查并收紧最终合同。没有热改在途请求/伪造新字段；最终离线门禁复验确认没有完整审计、没有可授权补丁。合同修订没有改变本轮A/B结果，但不属于最终合同完整在线验证。主代理另做非盲独立助手复核，不是人类盲评分。

当前先解决可消费结构化审计与推理预算分配，并取得实际局部修订的独立阅读证据；尚不值得因本轮结果直接上完整时序RAG。其时钟过滤/场景获知/分支失效与质量增益均需另外验收。

独立助手复核见 [主代理复核](../../output/postwrite-loop-root-review-2026-10-17/主代理复核.md)，其A-only清单先冻结再比较B；全文相等，已知计数问题未修，没有人类盲评分。
