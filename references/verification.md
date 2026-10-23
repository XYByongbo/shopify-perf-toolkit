# 采集与验收边界

## 现有能力

核心离线诊断使用 Node 22.19+ 标准库。十二项 PRD 规则都有覆盖状态；能由源码可靠识别的模式输出 candidate，运行证据不足的规则输出未验证或 not-assessed，不能算成十二项自动验收全部完成。v0.4 包含整站扫描、实测及多文件补丁，详见 [整站工作流](site-workflow.md)；本文件定义浏览器采集的验证边界。

Playwright/Chromium 是可选浏览器依赖，不打包个人浏览器或安装路径。capture 在新上下文进行有限窗口只读采集，包含图像实际选源、属性、组件内容/几何、资源、媒体状态与截图。框架、浏览器、同意、地区和实际端差异仍需记录。网络 POST 被阻止时相关依赖不属于验证覆盖。

## 数据口径

- 单资源分别记录传输字节、编码响应体、HTTP 内容解压后的响应体。`decodedBodySize` 不是位图内存，naturalWidth 不是编码像素宽度的可靠替代。
- DOM 顺序不是源码顺序。没有明确 source identity 不自动把网络成本归因给某行 Liquid。
- 页面指标和组件指标分开。一次 capture 是诊断观察，不是 Lighthouse、真实用户 p75、长期 CLS 或 INP。
- 有限窗口之外的迟加载工作可能尚未出现；需加滚动、激活 Tab、首个交互与静置场景。不同窗口的总字节不可直接比较。
- preview URL、HTTP 错误、密码页、占位图和缺失的运行字段保持可见，不以 0 或绿色补齐。

## 前后验证

验证按补丁影响选择，不把下面每项都变成每轮必跑。未改变渲染/布局的内部代码改动以相关行为与性能证据为主；图片/CSS/呈现改动需要对应截图，事件/生命周期改动需要对应实例与重连测试。无关的支付、App、全站媒体套件不自动加入。优先复用已有脚本和可比基线，只对实际变化补证据。

手机 390px、桌面 1440px 及组件断点前后采用相同 DPR、浏览器、页面状态、wait-ms 和 URL。源码版本分别保存；宿主第三方、商品内容和配置必须可比。verify 对不一致环境拒绝自动比较，内容/链接/图片素材/几何有变化给出需复核或退化状态。

使用截图查看裁切、文字、布局和清晰度；几何相等不证明像素等价。图片 srcset 允许选中不同尺寸，但素材身份、alt、原 src、比例和用途保持。将截图像素比较作为诊断，视频帧/时间等动态内容需要有记录的处理，不可遮掉整个问题组件。

目标图片在基线中未显示、盒子高度为零或仍未解码时，先记录基线异常，不能把两次空白截图当成图片视觉通过。`object-fit: cover` 的内容宽度可能大于元素盒子宽度；选择 sizes 时要结合素材比例与裁切容器，避免为减少字节而降低所需清晰度。

组件检查至少覆盖三个实例、相同 init 调用两次、重复挂载/卸载、再次连接、最早交互与错误路径。不能从一次堆快照证明通用无泄漏。计时器或 listener 测量需注明插桩范围。

本地迁移预览只验证所支持的布局与安全交互；其 App、API、写表单、结账被禁止，不声称 Shopify 线上完整验收。没有真实主题的同条件报告时，将性能收益标为未验证。

## Lighthouse 导入

```sh
node "<skill-dir>/scripts/perfkit.mjs" lighthouse --before "<five-before-json>" --after "<five-after-json>" --out "<new-summary.json>"
```

上述 lighthouse 命令只导入报告；真实本地 Lighthouse/PSI 运行使用 [measure](measurement.md)。汇总使用 Python 3.9+：固定 Lighthouse/浏览器/configSettings、URL/设备、真实独立 fetchTime，每组至少五份，不复制一次报告凑次数。跨基线与候选比较只忽略 preview_theme_id 参数，其余 URL 不自动映射。

新增 Speed Index 数值与五项 audit score 中位数的 strict_green。score 缺失则 all_green 为 null，不能推断通过。0.9 是报告评分的绿色分档界线；具体指标的评分由输入所锁定的 Lighthouse 版本给出，不硬编码跨版本毫秒标准。该字段不代替功能、视觉、真实用户 CWV 或正式发布审批。

报告 raw evidence 可能含私有链接，默认本地保存。HTML 对常见 URL 令牌和凭据字段做有限遮盖，不承诺自动移除任意源码或业务文字中的秘密。

## 官方依据

- https://web.dev/articles/optimize-lcp
- https://web.dev/learn/images/responsive-images
- https://web.dev/articles/vitals
- https://shopify.dev/docs/api/liquid/objects/section
- https://shopify.dev/docs/storefronts/themes/best-practices/editor/integrate-sections-and-blocks
