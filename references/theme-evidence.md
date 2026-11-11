# 主题整改证据与配置内嵌代码

适用于比较两个主题、复核整改报告，以及检查模板 JSON 中的自定义 Liquid/HTML/JS/CSS。只需一个局部补丁时，不必扩大为两主题审计。

## 先分清要验证的成果

规范修复、业务修复、内容/视觉变更和真实性能收益分别记录。告警减少可能来自修复、工具升级、范围变化或豁免；源码体积减少不等于页面传输减少。报告陈述不能替代实际部署快照。

`theme-diff` 比较本地输入目录；店铺、主题 ID、抓取时间、部署哈希、页面/模板绑定仍由实际证据提供。文件一致不能证明历史上从未修复，也不能据此推断作者、未上传或生成器覆盖。

```sh
node scripts/perfkit.mjs theme-diff --before /absolute/baseline-theme --after /absolute/target-theme --out /absolute/run/theme-diff.json
node scripts/perfkit.mjs report --input /absolute/run/theme-diff.json --out /absolute/run/theme-diff.html
```

输出包括全部主题文件哈希、增删改统计、JSON Pointer 字段变化，以及发生变化的内嵌代码位置/启用状态。JSON 数组作为整体比较；大字段只显示带 `truncated` 标记的预览与哈希，原始值在输入快照中。格式或字段顺序变化单独标为 `jsonOnlyFormatting`。不比较远端菜单实体、App 服务端数据或 `.theme-check.yml` 等本地 CI 配置。解析或遍历受限保留 issues、complete=false；源码漂移拒绝结果。输出必须位于两个主题目录之外。

逐项复核报告时使用可观察的状态：当前已具备、当前仍存在、仅豁免、与陈述不一致、证据不足。分别给出源码位置、有效规则与版本、部署身份；需要历史原因时再查 commit 和上传记录。CLI 不自动阅读 PDF，也不推断陈述的真实性或操作者意图。

## JSON 中也可能有业务代码

`audit-quality` 展开 templates/sections JSON 与 config/settings_data.json 的 settings 代码候选和 custom_css。识别依赖字段名与标记，属于静态候选，不保证穷尽自定义 schema 的所有代码字段。普通文本、翻译文件不作为代码运行。保留：

- `jsonPointer`：在原 JSON 中定位字段；`embeddedLine`：解码后的字段内行号。`line:null` 明确没有物理 JSON 行号映射。
- `configurationState`：disabled-ancestor、enabled-in-config 或 unknown；任一状态的实际 runtime 仍为 unverified。section 是否出现在 order、模板是否绑定、Liquid 条件和 App 状态仍需页面证据。
- 字段及原文件哈希、语言、脚本/样式数量、监听器/定时器/import 等观察，以及商品/变体/购物车业务逻辑候选。
- 支持的图片 loading 与外部阻塞脚本候选；JS/CSS 解析失败或嵌入 Liquid 要求渲染时记录未完成项。HTML template 等惰性内容不当作已执行脚本。

这些检查是有界子集，不等同于独立 Liquid 文件的全套规则，也不会据此自动改写商家配置。变体/套餐代码需检查组合切换、未找到/缺货/零价、前台价格与最终加购项；禁用内容不算等价性能优化。

## 当前 Shopify CLI 的检查接入

`import-check`、`precheck`、`check-performance` 支持旧 grouped offenses 和 CLI 5 ThemeCheckResult。后者的原始行列为 1-based，适配器转为内部 0-based；导入 metadata.positionBase 使用 0，并在 metadata.transport 留下转换记录。原始 issue 和报告哈希保留，计数不一致、错误包和无诊断失败不能当作通过。

执行检查前移除继承的 SHOPIFY_FLAG_*，由命令行显式指定只读检查范围。不要给互斥的 INIT/AUTO_CORRECT 变量赋字符串 false。独立命令失败时 --out 保存失败命令及诊断；退出 2，不能拿失败包作为成功检查导入。有效告警保持待复核退出语义。

正式评分、五样本、部署身份、内容/视觉与交互回归继续沿用原验收协议；本功能不降低门槛、不通过禁用规则清零。

0.19.0：跨框架对比要将隔离层、模板/内容变更和加载优化分开；先核实真实 LCP 对象及延迟恢复窗口，再论证收益。具体采集与案例经验见 [LCP 身份与重复加载检查](runtime-integrity.md)。
