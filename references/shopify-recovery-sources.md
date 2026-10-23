# Shopify 官方资料与本次实现

后续扩展：2026-10-23 已读取并建立 70 篇性能专题和 161 个相关官方页面的机器方法库；最新范围、执行合同及未实现项见 [官方知识库](shopify-knowledge.md) 和 [完整映射](shopify-method-matrix.md)。下文保留较早一轮恢复流程的阅读记录。

核验日期：2026-10-22。实际查阅范围为主题性能入口、测量方法、诊断与关键优化专题；不是 Shopify 开发平台全部文档。以下为归纳与实现映射，不复制整站内容。官方建议和本工具的实验阈值、预算、状态名称分别维护。

| 实际查阅的官方资料 | 本次采用的方法 / 边界 | 实现位置 |
| --- | --- | --- |
| [性能总览](https://shopify.dev/docs/storefronts/themes/best-practices/performance) | 按实际加载、渲染与执行问题选择方向，规范检查是入口之一 | recovery 的多类调查路线 |
| [持续性能实践](https://shopify.dev/docs/storefronts/themes/best-practices/performance/sustainable-performance) | 提出假设、实验、验证；丢弃无效实验，继续下一机会 | improvement-session 状态机、rollback、历史 |
| [性能测试](https://shopify.dev/docs/storefronts/themes/best-practices/performance/testing-for-performance) | 相同条件、多次独立采样和中位数；区分实验室与线上证据 | 复用 measure、verify-patch、verify-optimization |
| [指标间隔诊断](https://shopify.dev/docs/storefronts/themes/best-practices/performance/performance-gaps) | 按页面与设备定位可疑阶段，再用 trace 证实；缺少线上数据保留不确定性 | recovery 的页面/设备调查任务；统一诊断 |
| [定位最昂贵的 JS](https://shopify.dev/docs/storefronts/themes/best-practices/performance/finding-worst-offenders) | 同时审查字节、CPU 与阻塞影响，确认业务用途 | 源码绑定候选和 App 归属路线；不把字节减少当成收益 |
| [平台优化](https://shopify.dev/docs/storefronts/themes/best-practices/performance/platform) | 区分平台提供的能力和主题可修改部分 | 平台边界记录，不虚构主题可达到的分数上限 |
| [Theme Inspector](https://shopify.dev/docs/storefronts/themes/tools/theme-inspector) | 服务端 Liquid 需专门剖析 | 复用 profile-liquid；文档完成时间不能单独证明 Liquid 成本 |
| [不要懒加载 LCP 图片](https://shopify.dev/docs/storefronts/themes/best-practices/performance/never-lazy-load-lcp-image) | 确认真实初始视口与图片发现时机 | domain-candidates 的实际 LCP 关联；domain-plan 的 eager / high priority img 与 image_tag 改写 |
| [避免图片布局偏移](https://shopify.dev/docs/storefronts/themes/best-practices/performance/prevent-image-layout-shift) | 用图片真实尺寸/比例预留空间，保持响应式语义 | ResizeObserver 与 LayoutShift 关联候选，dimensions / aspect-ratio 补丁和独立 CLS 对比 |
| [为应用注入内容预留空间](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reserve-space-app-injected) | 按实际容器及移动/桌面数据设置局部预留值 | app-reserve-space 双设备几何门禁与局部 CSS |
| [延迟脚本](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-scripts) | defer 保持顺序；async 只适用独立脚本 | app-defer / app-async；依赖审阅、原资源加载、业务交互与耗时实测 |
| [延迟非关键资源](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-non-critical-resources) | 区分主题可控脚本和平台注入脚本 | 保留 content_for_header，不移除 App，不把平台资源当成本地补丁目标 |
| [Liquid 性能模式](https://shopify.dev/docs/storefronts/themes/best-practices/performance/liquid-performance-patterns) | 缓存重复不变计算，使用专用 profiler 验证 | live Liquid 文件/行定位、受限循环缓存变换、experiment-liquid 服务端收益与导航收益双门禁 |
| [按交互加载 JavaScript](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-javascript-on-user-interaction) | 延后组件资源时仍需保证首次操作有效 | 原 plan-demand / plan-split、交互回归 |
| [同步加载关键 CSS](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-critical-css-synchronously) | 关键和非关键样式需要不同交付方式，必须验证实际页面 | critical-css 路线与真实浏览器复测 |
| [字体切换 CLS](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reduce-cls-font-swapping) | 回退字体度量影响布局，不能凭空猜值 | layout-fonts 路线，原字体策略 |
| [首屏资源与 content_for_header](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-critical-resources-before-content-for-header) | 调整位置前检查 Shopify 全局依赖、defer 顺序与层叠；预览不验证 streaming 收益 | liquid-streaming 路线，保留 header 保护 |
| [理解 INP](https://shopify.dev/docs/storefronts/themes/best-practices/performance/understanding-inp) | 输入、处理、呈现分别调查 | 复用独立交互采集与验收，不以 TBT 代替线上 INP |
| [识别虚假性能应用](https://shopify.dev/docs/storefronts/themes/best-practices/performance/fake-performance-apps) | 页面测试必须保留用户实际资源与内容 | 无资源屏蔽、无测试专用内容、原始样本保留 |
| [Stylesheet subsetting](https://shopify.dev/docs/storefronts/themes/best-practices/performance/stylesheet-subsetting) | 样式归属与渲染树决定拆分边界 | audit-stylesheets、critical-css 调查路线 |
| [javascript/stylesheet 标签](https://shopify.dev/docs/storefronts/themes/best-practices/javascript-and-stylesheet-tags) | 资源模块化须遵守原生标签与作用域语义 | 沿用现有解析器与原生作用域检查 |

本次先加入跨轮次执行与恢复机制，再接通 [图片、CLS、Liquid 和 App 的定位/生成/实测](domain-optimization.md)。并非每篇文章都对应通用自动改写。无效证据、未知源归属和复杂动态结构仍须先补证据。无法保证所有主题或每次实验提高评分，也不通过降低阈值、隐藏内容、关闭业务功能来获得通过。
