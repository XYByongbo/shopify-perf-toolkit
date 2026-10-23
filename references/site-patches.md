# 多文件优化补丁

编写 replacement 或准备拆分候选前，采用 [主题代码生成技能](../theme-code-generation/SKILL.md)；计划生成后复核实际 after 内容及其完整主题上下文。结构预算不改变以下支持范围、指纹校验和回滚契约，也不授权为达标删除功能。

plan-site 接收 schemaVersion:1 和 changes 数组。每项必须含 target、kind、非空 reason、evidence.summary。目标只能是现有的 assets JS/MJS/CSS 或 sections/snippets/layout/templates/blocks Liquid；config 和 JSON 模板等不属于此写入范围。路径逃逸、符号链接、重复目标及同一物理文件别名被拒绝。

计划保留每个文件的完整 before/after、SHA-256、diff 和验证要求，再由 planHash 绑定整体内容。哈希不是安全审阅或授权签名；人工编辑计划可能破坏校验，应从真实源码重新生成。

## Recipe 类型

**js-raf-listener / css-dedupe-declarations / css-offscreen-rendering / liquid-limit-guarded-loop**：根据源码结构和显式证据生成代码，而非要求预先提供 replacementText。参数、适用边界、示例与回归要求见 [可执行代码策略](code-strategies.md)。生成计划在 apply/rollback 时重新运行生成器校验，保留原有指纹与冲突保护。

**reviewed-replacement**：提供 replacementText，或相对 recipe 文件目录的 replacementFile（二选一）。文件不得越出 recipe 目录或经过符号链接。候选需要针对主题编写和审阅；这个命令封装候选为可检查补丁，不自动重构任意业务代码。参考 [示例](../assets/examples/site-recipe.json)。

**image-responsive**：提供 sourceIndex、CSS sizes、widths 数组，沿用简单 image_url 图片补丁器。sourceIndex 是 inspect 的源码图片索引，不是浏览器 DOM 序号。裁切、复杂动态结构或已有策略等不受支持的输入会拒绝。依据所有相关断点与配置填写 sizes。

**image-loading**：提供 sourceIndex、loading（eager/lazy），且 evidence 必须包含：
- summary、当前文件 sourceHash、相同 sourceIndex、initialViewport:true。
- eager：inViewport:true、isLCP:true；生成 eager/high。
- lazy：inViewport:false、isLCP:false；不覆盖已有高优先级图片。

这些布尔值必须来自实际初始视口观察，命令不会替用户证明 LCP。动态页面、多个设备使用不同主图时，需要分别核对；不能把某一实例的条件强加给全部配置。

同文件的多项修改需先合并为一个 reviewed-replacement；不允许依赖数组顺序叠加多个同文件计划。Liquid schema、content_for_header 和相关注释/raw-text 上下文受保护，但语义等价仍需审阅与回归；字符串保护不是完整 HTML/Liquid 解释器。

## 应用、失败与回滚

apply/rollback 先验证完整计划和所有目标当前字节，再逐文件临时写入/rename，保留权限。指纹漂移拒绝覆盖。不是跨文件事务；运行中其他进程仍可能修改文件。

失败会逆序尝试恢复已提交文件，若出现并发冲突则保留新内容并报告冲突。receipt 明确 writesOccurred、partial、atomicAcrossFiles:false 及 recovery 状态。preflight-failed 表示预检失败；failed-restored 表示本次已写内容成功恢复；partial-failure 要求人工检查恢复记录。

CLI 的 receipt 输出失败也不改变真实操作结果；查看 stdout 回退 JSON。保留原计划和 receipt；不要直接修改哈希强行回滚。若后续合法改动已漂移，应基于实际差异生成新的修复计划。

## 0.9.0 新文件

create-asset 仅用于不存在的直接 assets/*.js、*.mjs、*.css，replacementText 提供完整可解析源码，仍需 reason/evidence.summary。与其他修改一起预检；任何同名已有文件拒绝创建。rollback 仅删除仍与计划哈希相符的新增文件，漂移拒绝；保留失败恢复 receipt。包含新建文件的计划再次 apply 会拒绝，而非认定同名文件由本工具创建。

content_for_header 的完整行与解析上下文继续保护；独立资源标签可以改变，但不能把该输出包进新的条件、注释、raw-text 或惰性容器。
