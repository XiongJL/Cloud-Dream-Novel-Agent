# 分片分析/质量审核网络错误的手动恢复

## 故障证据

只读检查 `run_ac8497145b06465f`（原始根任务 `run_7121899d53974fba`）：在文风证据审核阶段失败，failure.code=`NETWORK_ERROR`，recovery=null。请求 `skill_382ef78e12d71b521dbef97062765f518cf64073d9f0214524b2c50275abce8d` 的引用为 unknown，工作单元 running，本地没有该请求的 ModelResultCheckpoint。

Native 日志同时记录模型端 `net::ERR_CONNECTION_RESET`，请求运行约 46.9 秒且 didTimeout=false；Python 终态却是 `Automation service connection failed`。这说明当前展示不能完整定位两段传输边界；日志不足以断定为何模型错误返回也没有成功到达 Runtime。

缺失手动入口的确定原因：受控工作单元保留未知请求而不自动重复模型调用，但 NETWORK_ERROR 没进入父任务恢复描述的白名单。这个路径不产生普通请求重试耗尽事件，UI 又仅在恢复描述或耗尽事件存在时显示按钮，于是只有失败提示。

## 行为修改

- 对受支持的只读检查点统一支持 NETWORK_ERROR、PROVIDER_TIMEOUT、UPSTREAM_TIMEOUT、PROVIDER_UNAVAILABLE。保持原计划、任务检查点和已保存结果。
- 原任务有自身拥有的未确认分析/合并/路由/质量审核请求时，立即提供“重新请求未确认分片”入口及可能重复计费说明。读取历史失败状态也补齐；不自动查模型或自动重新生成。
- 手动选择后先核对保存的结构化返回。有结果则复用；只有明确 MODEL_RESULT_NOT_FOUND 时才允许新请求编号重发对应分片。核对过程再次断网、存储失败或格式无效都不能当作“没有结果”，继续保留恢复入口。
- 没有自身未确认请求的可恢复只读阶段提供普通检查点入口；写入阶段、取消任务和缺失检查点不扩大恢复权限。
- 更新 UI 文案：未知请求不再被称为已经确认“没有可用结果”。已有调用/Token 预算和收费请求保护不变。
- Automation 传输异常使用中文描述，并记录 transportLayer、transportErrorType、method、requestId。HTTP Provider 网络异常标记 model 层；有效模型错误信封保持原始消息和层级。父任务终态保留安全诊断字段，不把部分正文复制到公开传输诊断。

## 验证与边界

- 64 个 Python 相关检查通过：网络/超时旧任务恢复、立即终态/SSE恢复描述、未知请求保护、已保存结果复用、明确缺失后定向重发、核对再次断网、取消/写入阶段限制、证据审核缓存及截断拆分。
- Renderer/Electron 类型检查通过。
- Renderer 恢复入口专项与 HTTP Provider 网络/截断专项通过。
- 另 41 个系统失败终态、取消和仅完成结果收尾检查通过；合计 105 个相关 Python 检查。
- Native 模拟连接重置保留 model 层；Python 模拟有效模型错误信封不改称 Automation 断线。本地连接中断记录实际传输异常类型。

本次没有对真实失败任务执行恢复、修改用户数据库或调用模型。实际网络稳定性不由这次修复保证；修改保证可恢复任务有明确手动入口，且不会因为网络中断而自动重复收费请求。
