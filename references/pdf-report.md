# 同款 PDF 报告与执行衔接

report-pdf 使用参考评估报告的蓝色标题、灰色表头、红色新增标注和 A4 版式，按实际证据生成页数。默认扫描主题，不联网、不下载素材、不执行报告中的整改命令。

```sh
PERF_KIT_PYTHON=/absolute/python-with-reportlab node scripts/perfkit.mjs report-pdf --config /absolute/report-config.json --out /absolute/new-report
```

配置见 assets/examples/pdf-report.json。必须提供 schemaVersion:1、project；可选 title、context、checks、baseline、review、before、run、sourceSnapshot。路径建议全部使用绝对路径。输出目录必须尚不存在，也不能通过符号链接重定向。

- sourceSnapshot：可选冻结的主题源码副本，用于修改完成后重建修改前报告；project 仍标识所属主题，PDF 与 JSON 明示实际取证目录。checks 必须对应这个副本。
- checks：本工具 import-check 的结果。不会启动 Theme Check；先运行真实检查器，使用同一扫描快照的 metadata 导入。缺少 checks 时明确未包含规范检查器。历史源码漂移保留并标明 needs-rescan，不自动把旧告警当成当前缺陷。
- baseline：上一次 report.json。相同项目和报告契约才做新增/消失对比；行号移动可能形成增减，消失不是业务修复证明。
- review：人工核实的 JSON 数组。每项必须有 file、line（从 1 开始）、sourceHash、summary；可选 ruleId、priority、status、action、verification、evidence。路径、行号和当前指纹必须匹配。报告只展示这些说明，不执行 action。
- before / run：真实 measure 结果目录，分别显示前、后样本。所有分数、警告、失败数和证据问题保留；探索样本不能用于正式验收。源码部署身份仍须另行核实，报告不会自动判定提分或达标。

输出 report.pdf 和 report.json；JSON 包含所有条目的稳定编号、原始告警、校正信息、源码哈希及多行代码。PDF 对很长的代码行明确截断，完整原文留在 JSON。不同来源可能指向同一个问题，分来源统计，不能把记录数相加当作独立缺陷数量。

执行衔接：从已核实的报告条目取问题编号、目标和源码哈希，放入 recipe.evidence，再使用 plan-site/apply/rollback。报告本身不是自动修改授权；遵循用户任务范围，保留其他聊天修改。复测后重新生成报告，记录修复、保留、回滚和未测情况。

Python 渲染依赖 reportlab；工具测试还使用 pypdf。PERF_KIT_PYTHON 指向已有环境；PERF_KIT_PDF_FONT 可指定中文 TrueType 字体。macOS 默认尝试系统 Arial Unicode，缺失时明确报错，不自动下载字体。生成后应渲染全部 PDF 页面检查表格、中文和分页。PDF 缺依赖时保留 JSON 和错误，不输出伪 PDF。

本命令独立于 batch；可在 batch 完成后用其 checks.json、measurement 目录接入。不会自动重跑测速，也不会把旧批次当成当前候选的线上结果。

## 0.8.0 分析型报告

report-pdf 默认增加 audit-quality：按参考文档组织执行摘要、统计、十个代码维度、隐藏问题、SEO、风险路线、回归/回滚、收益、能力覆盖与规则附录。PDF 正文精选代表代码与整改依据；report.json 保留每条完整记录。提供 review 时应写 dimension（见 quality-catalog）、evidence.reason（根因与触发条件）、action、verification，不只写“有问题”。人工说明必须绑定当前源码哈希。

`node scripts/perfkit.mjs audit-quality --project /absolute/theme --checks /absolute/check-import.json --out /absolute/new-quality.json`

可独立运行，不联网、不改主题。batch 可加 `quality: true`，产出 quality.json/html，诊断复核状态与原正式评分门槛独立。report-pdf 自行运行本地扩展分析，复用当前 checks；不自动启动 Shopify CLI 或测速。

覆盖矩阵映射示例的 27 个规则组（包含正文规则和基线中额外列出的规则）。现代 Theme Check 负责语法、变量、翻译、资产、配置等；工具补充旧规则的源码启发式、SEO、JS AST、CSS AST 与架构统计。不是旧 Ruby 检查器的逐条计数复刻：例如连续 assign 合并提示、600 行阈值、两空格 JSON 格式都明确列出自有口径。配置缺失、过期哈希、新增未扫文件均不显示“当前检查器已启用”。

SEO 静态能力：通过布局字面 render/include 闭包识别 title/description/canonical/lang/社交元数据；检测静态空值与无效 canonical、静态 JSON-LD 解析、javascript 链接，记录 robots/hreflang/h1 与动态结构化数据。密码布局默认不当公开索引页。存在声明不代表实际 URL 的输出正确；不从源码缺少 robots/sitemap 文件反推平台未提供。

扩展能力：JS 用 Acorn 统计注册/Observer/计时器/import，检查 connectedCallback 且没有本类或可解析父类清理的候选；CSS 用 PostCSS 检查重复规则、全局选择器、font-display；另分析 snippet 路径、缺失字面引用、重复 setting ID/type 序列与原生可访问性属性。父类跨文件、helper、AbortSignal、模板运行分支仍需复核。动态 Liquid 无法直接解析的 JS/CSS 区域进入 issues，complete=false；不会悄悄跳过后宣称全覆盖。

报告契约升级到 3；旧契约基线不可比较。本地静态完整性、功能验收、SEO 输出验证与性能提分分别报告。任何报告都不能承诺覆盖所有业务、索引、安全或运行状态。
