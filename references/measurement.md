# 真实测量与证据

代码优化先复用符合源码、预览和环境条件的历史基线，再测实际候选；不在未变更源码上反复启动全站矩阵。缺少证据时先小范围探索，正式验收规则不变。测量中的图片、视频请求是浏览器正常渲染的一部分，不能为省流量或提分拦截。减少请求应通过减少无关页面/重复诊断轮次实现；独立冷启动样本仍按原配置加载，不以共享热缓存替代。代码任务不额外下载素材原件。

measure 支持固定版本本地 Lighthouse 和 Google PSI v5。参考 [配置示例](../assets/examples/measurement.json)。字段严格校验：

| 字段 | 约定 |
| --- | --- |
| schemaVersion | 1 |
| engine | lighthouse 或 psi |
| pages | 非空唯一 id/url 列表；id 使用小写安全名称，URL 为 HTTP(S)，不含用户密码或 fragment |
| devices | mobile / desktop，不重复；缺省两者 |
| runs | 每组 5–10 次；缺省 5 |
| timeoutMs | 单次超时，缺省 120000，上限 180000 |

本地先 npm ci --ignore-scripts，使用锁定 Lighthouse 13.5.0 和已有 Chrome（自动查找常见路径，或显式配置 PERF_KIT_BROWSER_EXECUTABLE / CHROME_PATH）。runner 按页面和设备串行运行，使用独立临时 Chrome profile，异常/超时清理子进程。当前进程组清理针对 macOS/Linux；本地 Windows 不受支持。页面渲染为正常 navigation，页面自身脚本可能向业务或统计服务器发送请求。

PSI 仅支持公开可访问的地址，不接受本地/私网目标，不继承用户登录或浏览器 cookie。传输使用 Google 官方 HTTPS API；API key 通过环境变量传入并从错误输出清除。没有 key 可能遇到配额限制；失败会保存为失败，不切换引擎、不拿模拟数据替代。实时 PSI 的服务版本由 Google 决定，跨时段版本变化可能使前后报告不可比较。

## 输出与失败

--out 必须是新目录。run.json 记录规范配置、引擎、页面设备矩阵、各次尝试、成功报告路径及失败。原始报告位于 groups/<pageId>/<device>/lhr。失败尝试单独保留；失败样本不会冒充有效样本或凑满次数，不能只挑分数高的报告。目录使用规范真实路径；macOS /tmp 或 /var 等系统符号链接别名可能被拒绝，按错误提示改用真实路径。

本地 Lighthouse 同时保存每次导航的 trace 和 DevTools 网络日志，放在 `groups/<pageId>/<device>/diagnostics/run-XX/`，不会混入只允许 LHR 的目录。`run.json` 的 attempt.diagnostics 绑定 LHR、trace、日志和分析结果的 SHA-256。合并交替样本时复制并重新校验这些文件，原单次目录删除后仍可诊断。文件保存在本地私有目录；网络日志可能包含页面请求上下文，不应随意公开。

`fcp.json` 使用同版本 Lighthouse 和原始设置离线重放 Lantern；模拟 FCP 必须与 LHR 相差不超过 0.001ms，原始 FCP 必须与 LHR 的整数值一致（允许 1ms 舍入差）。它记录乐观/悲观图、观察时间、模拟时间、网络依赖和同任务内的脚本/首次 Layout。这个容差是重放一致性检查，**不是性能验收阈值**。缺文件、错版本或重放不一致标为 `unavailable`，不能编造原因；PSI 不提供这套本地原始导航资产。

FCP 退步而原始 observed FCP 未退步时，恢复流程读取每一个样本的绑定图，辨别任务合并引起的依赖变化。模型敏感性改变原因判断，不改变已拒收结论，不开放原补丁重试，不用 observed 指标替换模拟评分。具体实例见 [Section FCP 诊断](section-fcp-review.md)。可对已有原始文件执行以下只读重放（只写新的分析文件，不启动浏览器）：

```sh
node scripts/inspect_lantern_fcp.mjs /absolute/report.json /absolute/trace.json /absolute/devtoolslog.json /absolute/new-fcp-analysis.json
```

只有报告 URL、设备、分数、指标、时间戳、环境有效，才计为成功采样。UA 要有 Chrome/Chromium 版本，节流方式与对应数值必须完整。同轮锁定版本和设备配置；原始 runtimeError、重复时间戳、错误页等不能通过。provided 环境记录人工复核要求；运行警告在评分阶段阻止自动通过。

重定向可能改变页面身份；先使用最终稳定页面 URL。店铺密码页、同意弹窗等内容状态仍需实际确认，单靠报告字段无法证明拿到正确主题。

## 前后比较

verify-site 要求相同引擎、页面 id/设备矩阵、每组完整报告、同一页面 URL（仅忽略 preview_theme_id），并逐组调用 score-target 校验环境与门槛。目录逃逸、符号链接、重复路径、额外/遗漏 JSON、失败/缺失组均不允许全站通过。原始 JSON 和 manifest 是本地可修改文件，校验不构成外部签名或主题发布证明。

每次 apply 后必须确认实际预览已同步补丁。记录主题 ID/源码指纹、内容、同意状态、App 配置、地区和机器负载。没有真实主题时只能做隔离工具验证。功能、视觉、CWV 和未来分数不由实验室门槛证明。

官方资料：[Lighthouse](https://github.com/GoogleChrome/lighthouse)、[PSI v5](https://developers.google.com/speed/docs/insights/v5/get-started)、[评分波动与曲线](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring)。

## v0.5.0 执行预算与探索

默认正式 runs=5 不变。显式 purpose=exploration 才允许1–4次（默认3），verify-site拒绝探索数据。budget限制时间/总尝试/失败，停止后保留全部已执行报告和失败，未执行项明确计为缺测。measure默认安静并落盘summary.json；批处理、历史早停、外部模型计量的严格边界见 [execution.md](execution.md)。
