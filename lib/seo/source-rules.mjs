import {tags,maskNonRendering,inspectImages} from '../core/html-source.mjs';
// Both legacy audit-quality and standalone seokit call these exact rules.
export function inspectSEOFile({file,source,add,observe}) {
  const active=tags(maskNonRendering(source)).filter(t=>!t.inert&&!t.svg);
  const activeStarts=new Set(active.map(t=>t.start));
  for(const img of inspectImages(source)) {
    if(!img.mappingSafe||!activeStarts.has(img.start))continue;
    if(!Object.hasOwn(img.attributes,'alt'))add(file,img.start,'Q-ALT','a11y','原生 img 未提供 alt 属性；需区分信息图与装饰图。');
  }
  for(const t of active) {
    const a=t.attributes;if(t.dynamic||t.duplicate)continue;
    if(t.name==='title'&&!t.body.trim())add(file,t.start,'Q-SEO-EMPTY-TITLE','seo','title 标签为空，需要页面级标题。');
    if(t.name==='meta'&&a.name?.toLowerCase()==='description'&&typeof a.content==='string'&&!a.content.trim())add(file,t.start,'Q-SEO-EMPTY-DESCRIPTION','seo','description 为静态空值；核实是否有其他有效描述输出。');
    if(t.name==='link'&&a.rel?.toLowerCase().split(/\s+/).includes('canonical')&&(!a.href?.trim()||/^(javascript:|#)/i.test(a.href.trim())))add(file,t.start,'Q-SEO-CANONICAL-VALUE','seo','canonical 目标为空或不是有效页面地址。');
    if(t.name==='a'&&/^javascript:/i.test(a.href??''))add(file,t.start,'Q-CRAWL-LINK','seo','链接使用 javascript: 地址；该入口不提供常规可抓取目标。');
    if(t.name==='script'&&a.type==='application/ld+json'){
     if(/\{[{%]/.test(t.body))observe(file,t.start,'structured-data','render-required','检测到动态 JSON-LD；解析最终输出才能验证字段和值。');
     else{try{const value=JSON.parse(t.body);observe(file,t.start,'structured-data','source-present','静态 JSON-LD 语法可解析；schema 类型/必填值仍需验证。');if(!value||typeof value!=='object')add(file,t.start,'Q-JSONLD-TYPE','seo','JSON-LD 根节点不是对象或数组。');}catch{add(file,t.start,'Q-JSONLD-JSON','seo','纯静态 JSON-LD 无法作为 JSON 解析。');}}
    }
    if(t.name==='meta'&&a.name?.toLowerCase()==='robots')observe(file,t.start,'robots','render-required',`发现 robots 声明 ${a.content??''}；需检查条件分支与最终响应头。`);
    if(t.name==='link'&&a.hreflang)observe(file,t.start,'hreflang','render-required','存在语言替代链接；需验证实际站点与互返关系。');
    if(t.name==='h1')observe(file,t.start,'h1','render-required','发现 h1 源码；页面实例数量由 section 配置和分支决定。');
  }
}
export function inspectSEOLayouts({sources,edges,add,observe}) {
 const layouts=[...sources.keys()].filter(f=>/^layout\/.*\.liquid$/.test(f));
 for(const file of layouts){
  const reachable=new Set([file]),q=[file];
  for(let i=0;i<q.length;i++)for(const e of edges.filter(e=>e.from===q[i]))if(!reachable.has(e.to)){reachable.add(e.to);q.push(e.to);}
  const all=q.flatMap(f=>tags(maskNonRendering(sources.get(f)??'')).filter(t=>!t.inert&&!t.svg).map(t=>({...t,file:f})));
  for(const [check,predicate]of [['title',t=>t.name==='title'],['description',t=>t.name==='meta'&&t.attributes.name?.toLowerCase()==='description'],['canonical',t=>t.name==='link'&&t.attributes.rel?.toLowerCase().split(/\s+/).includes('canonical')],['lang',t=>t.name==='html'&&t.attributes.lang?.trim()],['social',t=>t.name==='meta'&&/^(og:|twitter:)/.test(t.attributes.property??t.attributes.name??'')]]){
   const matches=all.filter(predicate);if(matches.length)for(const t of matches)observe(t.file,t.start,check,'source-present',`${file} 的字面 snippet 闭包中存在声明；动态值、条件和重复输出尚未验证。`);
   else if(file==='layout/password.liquid')observe(file,0,check,'not-applicable-by-default','密码保护布局不是公开索引页，不按全站 SEO 缺陷统计；若用于公开页面需另核实。');
   else add(file,0,'Q-SEO-'+check.toUpperCase(),'seo',`布局 ${file} 的字面 snippet 闭包未发现 ${check} 声明。`,{reachable:q,caveat:'dynamic render, content_for_header, App or platform injection may supply it'});
  }
 }
}
