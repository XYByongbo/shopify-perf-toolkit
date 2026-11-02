import { sha256 as hash } from './source-utils.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRunDirectory} from './measure.mjs';

export const performanceRoot='https://shopify.dev/docs/storefronts/themes/best-practices/performance';
export const referenceSources=[
  'https://shopify.dev/docs/api/liquid/filters/image_tag',
  'https://shopify.dev/docs/api/liquid/filters/image_url',
  'https://shopify.dev/docs/api/liquid/filters/font_face',
  'https://shopify.dev/docs/api/liquid/filters/font_url',
  'https://shopify.dev/docs/api/liquid/filters/preload_tag',
  'https://shopify.dev/docs/api/liquid/objects/section',
  'https://shopify.dev/docs/api/liquid/tags/paginate',
  'https://shopify.dev/docs/api/liquid/tags/render',
  'https://shopify.dev/docs/api/liquid/objects/content_for_header',
  'https://shopify.dev/docs/api/ajax/section-rendering',
  'https://shopify.dev/docs/storefronts/themes/best-practices/javascript-and-stylesheet-tags',
  'https://shopify.dev/docs/storefronts/themes/tools/theme-inspector',
  'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks',
  'https://shopify.dev/docs/api/shopify-cli/theme/theme-profile',
  'https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration',
  'https://shopify.dev/docs/apps/build/performance',
  'https://shopify.dev/docs/apps/build/performance/storefront',
  'https://shopify.dev/docs/apps/build/performance/general-best-practices',
  'https://shopify.dev/docs/apps/build/performance/admin-installation-oauth',
  'https://shopify.dev/docs/apps/build/checkout/extension-performance',
];

export function officialUrl(value,base=performanceRoot) {
  const u=new URL(value,base);
  if(u.protocol!=='https:'||u.hostname!=='shopify.dev'||u.port||u.username||u.password||!u.pathname.startsWith('/docs/')||u.search)throw new Error('Only canonical HTTPS shopify.dev/docs URLs are accepted.');
  u.hash='';u.pathname=u.pathname.replace(/\.md$/,'').replace(/\/$/,'');return u.href;
}
export function markdownLinks(text,base) {
  const links=new Set();
  for(const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g))try{links.add(officialUrl(match[1],base));}catch{}
  return [...links].sort();
}
export function describeDocument(text,url) {
  if(!/^#\s+.+/m.test(text)||!/^---\s*\n/.test(text))throw new Error('Expected official Markdown document, received a non-document response.');
  const title=text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {url,title,contentHash:hash(text),bytes:Buffer.byteLength(text),
    headings:[...text.matchAll(/^#{2,4}\s+(.+)$/gm)].map(m=>m[1].trim()).slice(0,100),links:markdownLinks(text,url)};
}
async function fetchDocument(url,{fetchImpl,timeoutMs,maxBytes}) {
  const signal=AbortSignal.timeout(timeoutMs);
  let request=url+'.md';
  for(let redirects=0;redirects<=3;redirects++) {
    const r=await fetchImpl(request,{redirect:'manual',signal,headers:{accept:'text/markdown'}});
    if(r.status>=300&&r.status<400) {
      const next=officialUrl(r.headers.get('location'),request);await r.body?.cancel();
      if(next!==url)throw new Error(`Canonical URL changed to ${next}; review the source mapping.`);
      request=next+'.md';continue;
    }
    if(!r.ok){await r.body?.cancel();throw new Error(`HTTP ${r.status}`);}
    if(!/text\/(markdown|plain)/i.test(r.headers.get('content-type')??'')){await r.body?.cancel();throw new Error('Official Markdown content type is missing.');}
    const reader=r.body.getReader(),chunks=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>maxBytes)throw new Error('Document byte budget exceeded.');chunks.push(value);}}
    catch(e){await reader.cancel().catch(()=>{});throw e;}
    return describeDocument(Buffer.concat(chunks).toString('utf8'),url);
  }
  throw new Error('Redirect budget exceeded.');
}
export const bundledIndexPath=new URL('../assets/shopify-performance/sources.json',import.meta.url);
export async function readShopifySources(){return JSON.parse(await readFile(bundledIndexPath,'utf8'));}

/** Explicit network operation. Saves provenance/structure, not a full-text mirror or executable remote instructions. */
export async function syncShopifyDocs({output,config={},dependencies={}}={}) {
  if(Object.keys(config).some(k=>!['maxPages','timeoutMs','maxWallTimeMs'].includes(k)))throw new Error('Unknown Shopify docs sync option.');
  const {maxPages=250,timeoutMs=15000,maxWallTimeMs=180000}=config;
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>250||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000||!Number.isInteger(maxWallTimeMs)||maxWallTimeMs<100||maxWallTimeMs>600000)throw new Error('Invalid bounded docs sync configuration.');
  const out=await createRunDirectory(output),started=Date.now(),known=await readShopifySources().catch(()=>({documents:[]})),prior=new Map(known.documents.map(d=>[d.url,d]));
  const documents=[],failures=[],queued=new Set([performanceRoot,...referenceSources]),done=new Set(),pending=[...queued];
  while(pending.length&&done.size<maxPages&&Date.now()-started<maxWallTimeMs) {
    const batch=pending.splice(0,Math.min(4,maxPages-done.size));
    await Promise.all(batch.map(async url=>{
      done.add(url);
      try {
        const doc=await fetchDocument(url,{fetchImpl:dependencies.fetch??fetch,timeoutMs:Math.max(1,Math.min(timeoutMs,maxWallTimeMs-(Date.now()-started))),maxBytes:512*1024});
        documents.push({...doc,checkedAt:new Date().toISOString(),change:prior.has(url)?prior.get(url).contentHash===doc.contentHash?'unchanged':'changed':'new'});
        for(const link of doc.links)if((link.startsWith(performanceRoot+'/')||link.startsWith('https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/'))&&!queued.has(link)){queued.add(link);pending.push(link);}
      }catch(error){failures.push({url,error:error.message});}
    }));
  }
  documents.sort((a,b)=>a.url.localeCompare(b.url));failures.sort((a,b)=>a.url.localeCompare(b.url));
  const result={schemaVersion:1,kind:'shopify-docs-index',output:out,status:failures.length||pending.length?'incomplete':'complete',startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),
    scope:'Transitive performance subsection and Theme Check checks linked from official indexes, plus explicitly listed Liquid, CLI, app and Section Rendering references; not all Shopify products or hidden/unlinked pages.',
    root:performanceRoot,seeds:[performanceRoot,...referenceSources],documents,failures,pending,
    coverage:{discovered:queued.size,fetched:documents.length,failed:failures.length,pending:pending.length},
    removedSincePrevious:failures.length||pending.length?[]:[...prior.keys()].filter(url=>!queued.has(url)),
    notRediscovered:failures.length||pending.length?[...prior.keys()].filter(url=>!queued.has(url)):[],
    limitations:['A fetched page is not an implemented transformation. Changed/new pages require method-card review.', 'No full-text redistribution; methods are locally reviewed paraphrases and code, never executed remote instructions.']};
  await writeFile(path.join(out,'sources.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}
