/** Report dimensions are independent from severity and from measured performance. */
export const dimensions = [
 ['i18n','国际化与文案完整性','翻译键与语言文件是否一致，动态 key 仍需渲染验证。','修正默认语言键，再同步目标语言；保留已有翻译。','切换已启用语言，检查商品、导航和空状态。'],
 ['performance','资源加载与性能编码','图片、字体、JS/CSS 的加载方式可能影响关键路径；源码数量不代表耗时。','先核对 LCP 与网络瀑布，再调整加载优先级或按页面拆分。','真实预览同配置前后各至少五次，检查 LCP、CLS、TBT 和首个交互。'],
 ['variables','变量、命名与作用域','冗余赋值和 include 共享作用域增加维护成本。','核实调用参数后迁移 render，清理确实无用途的赋值。','验证 snippet 多调用方、空对象和商品变体状态。'],
 ['references','引用完整性','字面文件引用缺失可定位；动态引用与运行上下文不能只靠文件名判断。','逐条核对调用链、模板分配与参数，修复真实缺失或拼写。','渲染触发分支并检查 Liquid 错误；复查未知过滤器的官方支持。'],
 ['compatibility','废弃 API 与平台兼容','废弃标记表示迁移建议，不等于某日必然失效。','迁移 image_url/image_tag 等接口时保持尺寸、裁剪和替代文本。','对比媒体输出及空值路径，运行当前版本 Theme Check。'],
 ['syntax','Liquid、HTML、Schema 与 JSON','语法和结构问题需与检查器版本相结合，避免把平台新语法误报为缺陷。','确认现代解析器支持，再处理真正的语法、重复 ID 和配置错误。','检查器重扫及主题编辑器加载、保存、重排区块。'],
 ['architecture','嵌套、巨型文件与重复配置','调用深度、文件大小及重复 schema 是维护线索，不证明页面已变慢。','按职责拆分，优先共同加载资源；保留商家已保存的 setting ID。','检查模板分配、多实例、区块移除重加及旧配置兼容。'],
 ['style','代码风格与可读性','格式计数单独列示，不把格式修复当性能收益。','统一格式工具；先看 diff，避免批量更改 Liquid 空白输出语义。','检查输出空白、schema 解析和内容不变。'],
 ['boundaries','安全边界、兜底与工程流程','HTTP 资源、空值路径和第三方来源需要上下文；源码扫描不是安全认证。','对资源失败和空数据设置适用的降级；审阅第三方与版本回滚策略。','断网/资源失败、空配置和未安装 App 状态下验证关键功能。'],
 ['a11y','可访问性与语义','检测图片 alt、可缩放视口、按钮名称和对话框标签线索。','为信息图片和控件提供名称，装饰图片可用空 alt。','键盘、焦点返回、读屏及不同缩放比例；动态 ARIA 需浏览器。'],
 ['seo','SEO 与可索引内容','检查 title、description、canonical、robots、JSON-LD、语言与链接源码。','保留已存在的 SEO 实现，核查动态值和模板分支；不重复注入标签。','按真实 URL 检查最终 HTML、响应头、索引策略与结构化数据有效性。'],
].map(([id,title,mechanism,action,verification])=>({id,title,mechanism,action,verification}));
export const referenceRules = [
 ['ImgWidthAndHeight',['ImgWidthAndHeight'],'performance'],['RemoteAsset',['RemoteAsset'],'performance'],
 ['DeprecatedFilter',['DeprecatedFilter'],'compatibility'],['UnusedAssign',['UnusedAssign'],'variables'],
 ['ParserBlockingJavaScript / ParserBlockingScriptTag',['ParserBlockingScript'],'performance'],
 ['UnknownFilter',['UnknownFilter'],'references'],['NestedSnippet',['Q-NESTED'],'architecture'],
 ['LiquidTag',['Q-LIQUID-TAGS'],'style'],['ImgLazyLoading',['Q-IMAGE-LOADING'],'performance'],
 ['TemplateLength',['Q-LONG-TEMPLATE'],'architecture'],['ConvertIncludeToRender',['Q-INCLUDE'],'variables'],
 ['AssetPreload',['AssetPreload'],'performance'],['AssetUrlFilters',['Q-ASSET-URL'],'references'],
 ['PaginationSize',['PaginationSize'],'performance'],['SpaceInsideBraces',['Q-BRACES'],'style'],
 ['SchemaJsonFormat',['Q-SCHEMA-FORMAT'],'style'],['SyntaxError',['LiquidSyntaxError','LiquidHTMLSyntaxError'],'syntax'],
 ['UndefinedObject',['UndefinedObject'],'references'],['TranslationKeyExists',['TranslationKeyExists'],'i18n'],
 ['MissingTemplate',['MissingTemplate'],'references'],['MatchingTranslations',['MatchingTranslations'],'i18n'],
 ['VariableName',['VariableName'],'variables'],['HardcodedRoutes',['HardcodedRoutes'],'seo'],
 ['ValidSchema / ValidJSON / ValidVisibleIf',['ValidSchema','ValidJSON','ValidVisibleIf'],'syntax'],
 ['UnclosedHTMLElement',['UnclosedHTMLElement'],'syntax'],['OrphanedSnippet',['OrphanedSnippet'],'architecture'],
 ['LiquidNestingDepth',['LiquidNestingDepth'],'architecture'],
 ['ExcessiveSettingsCount / LiquidComplexity',['ExcessiveSettingsCount','LiquidComplexity'],'architecture'],
];
export function dimensionFor(f){
 if(f.dimension)return f.dimension;
 const rule=f.ruleId??'';
 if (/^(?:AssetSize(?:AppBlock)?(?:CSS|JavaScript|Javascript)|DeprecateLazysizes|DeprecateBgsizes|PERF_)/.test(rule)) return 'performance';
 const mapped=referenceRules.find(x=>x[1].includes(rule));if(mapped)return mapped[2];
 if(/^(IMG|FNT|JS|RES)|Blocking|Preconnect|Preload/.test(rule))return 'performance';
 if(/Deprecated/.test(rule))return 'compatibility';
 if(/Missing|Unknown|Undefined|DEP/.test(rule))return 'references';
 if(/Translation/.test(rule))return 'i18n';
 if(/Syntax|Schema|JSON|HTML|Block|Argument|Settings/.test(rule))return 'syntax';
 if(/Deprecated/.test(rule))return 'compatibility';
 if(/CMP|RAW_BYTES/.test(rule))return 'architecture';
 return 'boundaries';
}
export const officialSources=[
 {title:'Shopify 资产与 JSON 注释支持',url:'https://shopify.dev/docs/storefronts/themes/architecture'},
 {title:'Shopify Theme Check 规则与版本迁移',url:'https://shopify.dev/docs/storefronts/themes/tools/theme-check/migrate'},
 {title:'Shopify 当前检查规则',url:'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks'},
 {title:'Google JavaScript SEO 基础',url:'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics'},
];
