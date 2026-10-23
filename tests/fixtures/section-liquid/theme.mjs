import http from 'node:http';
import path from 'node:path';
import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {Liquid} from 'liquidjs';
import {verifyDeployment} from '../../../lib/deployment.mjs';

export const renderTag="{% render 'catalog-content', collection: collection, section: section %}";
export const controller=`async function load(next) {
  const url = new URL(next || location.href);
  url.searchParams.set('view', 'ajax');
  const response = await fetch(url.href);
  if (!response.ok) throw new Error('Content unavailable');
  const html = await response.text();
  const content = new DOMParser().parseFromString(html, 'text/html').querySelector('#hero');
  if (!content) throw new Error('Content missing');
  document.querySelector('#hero').innerHTML = content.innerHTML;
}
document.addEventListener('click', event => {
  const refresh = event.target.closest('#refresh');
  if (refresh) {
    event.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('sort_by', new URL(refresh.href).searchParams.get('sort_by'));
    load(url.href).catch(() => location.assign(refresh.href));
  }
  if (event.target.closest('#open')) document.querySelector('#more').hidden = false;
});
load();
`;
const schema=`{% schema %}
{"name":"Catalog","settings":[{"type":"text","id":"heading","label":"Heading","default":"Complete unchanged section content"}]}
{% endschema %}`;
export async function writeTheme(project) {
  const files={
    'layout/theme.liquid':'<!doctype html><html lang="{{ request.locale.iso_code }}"><head><title>{{ shop.name | escape }}</title>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>',
    'sections/main.liquid':`<section class="catalog"><div id="hero"></div></section>\n<script src="{{ 'main.js' | asset_url }}" defer></script>\n${schema}`,
    'sections/ajax-main.liquid':`<div id="hero">\n  ${renderTag}\n</div>\n${schema}`,
    'snippets/catalog-content.liquid':`<h1>{{ section.settings.heading | escape }}</h1>
<p id="first-title">{{ collection.products.first.title | escape }}</p>
<ul>{% for item in collection.products %}<li><a href="{{ item.url }}">{{ item.title | escape }}</a></li>{% else %}<li>No products</li>{% endfor %}</ul>
<button id="open" type="button">Open details</button>
<p id="more" hidden>Full product detail</p>
<a id="refresh" href="{{ collection.url }}?sort_by=title-descending">Reverse order</a>
`,
    'assets/main.js':controller,
    'templates/collection.json':JSON.stringify({sections:{main:{type:'main',settings:{heading:'Complete unchanged section content'}}},order:['main']}),
    'templates/collection.ajax.json':JSON.stringify({sections:{main:{type:'ajax-main',settings:{heading:'Complete unchanged section content'}}},order:['main']}),
    'config/settings_schema.json':'[]',
    'config/settings_data.json':'{"current":{}}',
    'locales/en.default.json':'{}',
  };
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(project,file)),{recursive:true});await writeFile(path.join(project,file),text);}
}

export async function serveTheme(projects) {
  let failure=null,policy={headers:[],meta:[]};const requests=[];
  const server=http.createServer(async(req,res)=>{
    try {
      const u=new URL(req.url,'http://fixture.test'),ref=new URL(req.headers.referer??u.href),id=u.searchParams.get('preview_theme_id')??ref.searchParams.get('preview_theme_id')??'1';
      requests.push({url:u.href,themeId:id});res.setHeader('cache-control','no-store');
      if(policy.headers.length)res.setHeader('content-security-policy',policy.headers);
      const project=projects[id];if(!project){res.writeHead(404);res.end();return;}
      if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
      if(/^\/assets\/[\w.-]+$/.test(u.pathname)){res.setHeader('content-type','text/javascript');res.end(await readFile(path.join(project,u.pathname.slice(1))));return;}
      const scoped=u.searchParams.has('section_id'),ajax=u.searchParams.get('view')==='ajax';
      if(scoped||ajax)await new Promise(r=>setTimeout(r,scoped?60:900));
      if(scoped&&failure==='timeout')await new Promise(r=>setTimeout(r,5100));
      if(scoped&&failure==='500'){res.writeHead(500);res.end('Unavailable');return;}
      const engine=new Liquid({root:path.join(project,'snippets'),extname:'.liquid'});engine.registerFilter('asset_url',n=>'/assets/'+n);
      const products=u.searchParams.has('empty')?[]:[{title:'Alpha product',url:'/fr/products/alpha'},{title:'Beta product',url:'/fr/products/beta'}];
      if(u.searchParams.get('sort_by')==='title-descending')products.reverse();
      const context={section:{id:'template--123__main',settings:{heading:u.searchParams.has('alternate')?'Alternate & localized heading':'Complete unchanged section content'}},collection:{products,url:u.pathname}};
      const file=ajax&&!scoped?'sections/ajax-main.liquid':'sections/main.liquid';
      const liquid=(await readFile(path.join(project,file),'utf8')).replace(/\{% schema %\}[\s\S]*?\{% endschema %\}/g,'');
      const body='<div id="shopify-section-template--123__main" class="shopify-section">'+await engine.parseAndRender(liquid,context)+'</div>';
      res.setHeader('content-type','text/html');
      if(scoped){res.end(failure==='invalid'?'<div id="wrong">Wrong section</div>':body);return;}
      const policies=policy.meta.map(p=>'<meta http-equiv="Content-Security-Policy" content="'+p.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'">').join('');
      res.end('<!doctype html><html lang="en"><head><title>Liquid initial content fixture</title><meta name="viewport" content="width=device-width,initial-scale=1">'+policies+'<script nonce="fixture">window.Shopify={theme:{id:'+id+'},shop:"fixture.myshopify.com"};</script><style>body{font-family:sans-serif}h1{font-size:54px}button{padding:12px}</style></head><body><header>Catalog</header>'+body+'</body></html>');
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,requests,setFailure:value=>{failure=value;},setPolicy:value=>{policy=value;},close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
export const deployment=args=>verifyDeployment({...args,dependencies:{runProcess:async(_cmd,argv)=>{await cp(args.config.project,argv[argv.indexOf('--path')+1],{recursive:true});return {code:0};}}});
export const steps=[
  {action:'assert-text',selector:'#first-title',text:'Alpha product'},
  {action:'checkpoint',selector:'#hero',key:'initial'},
  {action:'click',selector:'#open'},{action:'assert-visible',selector:'#more',visible:true},
  {action:'checkpoint',selector:'#hero',key:'details-open'},
  {action:'click',selector:'#refresh'},{action:'assert-text',selector:'#first-title',text:'Beta product'},
  {action:'checkpoint',selector:'#hero',key:'dynamic-update'},
  {action:'click',selector:'#open'},{action:'assert-visible',selector:'#more',visible:true},
  {action:'checkpoint',selector:'#hero',key:'updated-details'},
];
