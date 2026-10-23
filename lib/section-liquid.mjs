import {parse} from 'acorn';
import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {htmlName,literalAttribute,lookupPath} from './performance-syntax.mjs';
import {readTarget} from './changes.mjs';
import {readThemeSource} from './check-import.mjs';
import {fields} from './evidence-contract.mjs';
import {sha256} from './runtime-profile.mjs';
import {managedSectionController} from './section-controller.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'UNSUPPORTED_CODE_PATTERN'});};

function consumesLoader(script,name) {
  try {
    let reference=false;
    visitAST(parse(script,{ecmaVersion:'latest',sourceType:'module'}),(n,parents)=>{
      const p=parents.at(-1);
      if(n.type==='MemberExpression'&&['window','globalThis'].includes(n.object.name)
        &&(n.computed?n.property.value:n.property.name)===name)reference=true;
      if(n.type!=='Identifier'||n.name!==name)return;
      if(p?.type==='MemberExpression'&&p.property===n&&!p.computed||p?.type==='Property'&&p.key===n&&!p.computed&&!p.shorthand
        ||p?.type==='VariableDeclarator'&&p.id===n||/Function/.test(p?.type??'')&&(p.id===n||p.params.includes(n))||/^Import/.test(p?.type??''))return;
      reference=true;
    });return reference;
  }catch {return new RegExp('\\b'+name+'\\s*\\(|(?:window|globalThis)\\s*\\.\\s*'+name+'\\b').test(script);}
}

/** Remove only one direct, argument-free startup call; retain the loader and dynamic callers. */
export function initialSectionStartup(source,fetchOffset) {
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const fn=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.async&&n.id&&n.start<fetchOffset&&n.end>fetchOffset);
  if(!fn)return null;
  const starts=tree.body.filter(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'
    &&n.expression.callee.type==='Identifier'&&n.expression.callee.name===fn.id.name&&n.expression.arguments.length===0);
  if(starts.length!==1)return null;
  let unsafe=false,dynamic=false,directFetch=false;
  visitAST(tree,(n,parents)=>{
    if(n.type==='Identifier'&&n.name===fn.id.name) {
      const p=parents.at(-1);
      if(p===fn&&p.id===n)return;
      if(p?.type!=='CallExpression'||p.callee!==n){unsafe=true;return;}
      if(p===starts[0].expression)return;
      if(!parents.some(x=>/Function/.test(x.type))){unsafe=true;return;}
      dynamic=true;
    }
    if(n.start===fetchOffset&&n.type==='CallExpression')directFetch=parents.filter(p=>/Function/.test(p.type)).at(-1)===fn;
  });
  return !unsafe&&dynamic&&directFetch?{name:fn.id.name,start:starts[0].start,end:starts[0].end}:null;
}

/** Reuse an existing render tag and snippet; never freeze a captured response into Liquid. */
export async function prepareInitialLiquid({project,source,fetchOffset,selector,config}) {
  fields(config,['targetFile','sourceFile','renderOffset','startupFunction','legacyView','update'],'initialLiquid');
  const startup=initialSectionStartup(source,fetchOffset);
  if(!startup||startup.name!==config.startupFunction)fail('Select the measured async loader with one direct startup call and retained dynamic callers.');
  if(!/^sections\/[\w-]+\.liquid$/.test(config.targetFile??'')||! /^(sections|snippets)\/[\w-]+\.liquid$/.test(config.sourceFile??''))fail('Select existing section and render-source Liquid files.');
  if(config.legacyView!==undefined&&!/^[\w-]+$/.test(config.legacyView))fail('legacyView must name the existing alternate template suffix.');
  fields(config.update,['triggerSelector','assertionSelector','requestUrl'],'initialLiquid.update');
  if(![config.update.triggerSelector,config.update.assertionSelector].every(s=>typeof s==='string'&&/^#[A-Za-z_][\w-]*(?: [A-Za-z][\w-]*)?$/.test(s)))fail('Identify the retained dynamic control and changed-content assertion.');
  const requestUrl=new URL(config.update.requestUrl);
  if(!['http:','https:'].includes(requestUrl.protocol)||requestUrl.username||requestUrl.password||requestUrl.hash)fail('Dynamic request URL must be explicit HTTP(S).');
  const [{source:target},{source:donor}]=await Promise.all([readTarget(project,config.targetFile),readTarget(project,config.sourceFile)]);
  const targets=[];let localTarget=false;visitAST(liquidAST(target),(n,parents)=>{
    if(n.type==='HtmlElement'&&literalAttribute(n,'id')===selector.slice(1))targets.push({n,parents});
    if(n.type==='LiquidTag'&&['assign','capture','include','liquid','increment','decrement'].includes(n.name))localTarget=true;
  });
  if(localTarget)fail('Target section has local-scope effects; global render inputs cannot be proven unchanged.');
  if(targets.length!==1||targets[0].n.attributes.filter(a=>htmlName(a)==='id').length!==1)fail('Initial container must have a unique literal id in the selected section.');
  const {n,parents}=targets[0];
  if(parents.some(p=>p.type==='LiquidTag'||['template','noscript','script'].includes(htmlName(p)))
    ||target.slice(n.blockStartPosition.end,n.blockEndPosition.start).trim())fail('Initial container must be empty and unconditional; preserve existing content through another reviewed implementation.');
  let render,unsafe=false;
  visitAST(liquidAST(donor),(node,ancestors)=>{
    if(node.position?.start===config.renderOffset&&node.type==='LiquidTag'&&node.name==='render') {
      render=node;
      if(ancestors.some(p=>p.type==='LiquidTag'||['template','script','noscript'].includes(htmlName(p))))unsafe=true;
    }
    // Moving a locally assigned name would silently change the render's inputs.
    if(node.type==='LiquidTag'&&['assign','capture','include','liquid','increment','decrement'].includes(node.name))unsafe=true;
  });
  const m=render?.markup;
  if(unsafe||m?.snippet?.type!=='String'||m.variable||m.alias||! /^[\w-]+$/.test(m.snippet.value))fail('Render source must use an existing literal snippet without conditional/local-scope dependencies.');
  for(const arg of m.args) {
    const value=arg.value,key=lookupPath(value);
    if(!['String','Number','LiquidLiteral'].includes(value.type)&&!(key&&/^(product|collection|section|settings|shop|localization|routes)(\.[\w-]+)*$/.test(key)))fail('Render inputs must be explicit literals or reviewed global theme objects.');
  }
  const snippetFile=`snippets/${m.snippet.value}.liquid`,{source:snippet}=await readTarget(project,snippetFile);
  if(!snippet.trim())fail('Render snippet is empty.');
  const tag=donor.slice(render.position.start,render.position.end);
  const after=target.slice(0,n.blockStartPosition.end)+'\n  '+tag+'\n'+target.slice(n.blockEndPosition.start);
  liquidAST(after);
  return {startup,targetFile:config.targetFile,targetSource:target,after,contract:{selector,update:config.update,legacyView:config.legacyView??null,
    renderSource:{file:config.sourceFile,offset:config.renderOffset,sourceHash:sha256(donor),tag},snippet:{file:snippetFile,sourceHash:sha256(snippet)},startupFunction:startup.name}};
}

/** Bounded isolated controller: remove its sole external request, without delaying first interaction. */
export async function checkControllerOwnership({project,snapshot,file,source,initial,inline=false}) {
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  for(const n of tree.body) {
    if(n.start===initial.startup.start||n.type==='FunctionDeclaration'&&n.id.name===initial.startup.name)continue;
    const c=n.type==='ExpressionStatement'&&n.expression;
    if(c?.type!=='CallExpression'||c.callee.type!=='MemberExpression'||c.callee.computed||c.callee.object.name!=='document'||c.callee.property.name!=='addEventListener'
      ||c.arguments.length!==2||c.arguments[0].type!=='Literal'||!['FunctionExpression','ArrowFunctionExpression'].includes(c.arguments[1].type))fail('Inline controller supports only the loader and delegated document listeners.');
  }
  const name=file.slice('assets/'.length),escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const nonce=`nonce=(?:"[^"]*"|'[^']*')`;
  const tag=new RegExp(`<script\\s+${inline?'':`(?:${nonce}\\s+)?`}src=["']\\{\\{\\s*['"]${escaped}['"]\\s*\\|\\s*asset_url\\s*\\}\\}["']\\s+defer${inline?'':`(?:\\s+${nonce})?`}\\s*>\\s*</script>`,'g');
  const matches=[...initial.after.matchAll(tag)];
  if(matches.length!==1||initial.after.split(name).length!==2)fail('Inline controller requires exactly one plain deferred asset tag in the target section.');
  for(const item of snapshot.files)if(item.file!==file&&item.file!==initial.targetFile) {
    const {source:text}=await readThemeSource(project,item.file,item.sourceHash);
    if(text.includes(name))fail('Controller is referenced elsewhere; preserve its shared asset lifecycle.');
    if(item.file.endsWith('.js')||item.file.endsWith('.mjs')||item.file.endsWith('.liquid')) {
      const scripts=item.file.endsWith('.liquid')?[
        ...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi),
        ...text.matchAll(/\{%-?\s*javascript\s*-?%\}([\s\S]*?)\{%-?\s*endjavascript\s*-?%\}/gi)
      ].map(m=>m[1]).join('\n'):text;
      if(consumesLoader(scripts,initial.startup.name)||new RegExp('on[a-z]+\\s*=\\s*["\'][^"\']*\\b'+initial.startup.name+'\\b','i').test(text))
        fail('Another theme script or inline handler consumes the loader global.');
    }
  }
  return matches[0];
}

export async function inlineInitialController({project,snapshot,file,source,controller,initial}) {
  if(Buffer.byteLength(controller)>4096||/<\/script|<!--|\{[{%]/i.test(controller))fail('Inline controller must be at most 4 KiB and contain no HTML/Liquid delimiters.');
  const match=await checkControllerOwnership({project,snapshot,file,source,initial,inline:true});
  const managed=managedSectionController({source,controller,startup:initial.startup,selector:initial.contract.selector,file});
  if(Buffer.byteLength(managed.script)>8192)fail('Controller plus lifecycle bootstrap exceeds the 8 KiB inline budget.');
  if(Buffer.byteLength(controller)>4096||/<\/script|<!--|\{[{%]/i.test(managed.script))fail('Inline controller must be at most 4 KiB before lifecycle wrapping and contain no HTML/Liquid delimiters.');
  const text=`<script>\n${managed.script}</script>`;
  const after=initial.after.slice(0,match.index)+text+initial.after.slice(match.index+match[0].length);
  liquidAST(after);
  return {...initial,after,contract:{...initial.contract,controllerLifecycle:{key:managed.key,signature:managed.signature},inlineController:{file,bytes:Buffer.byteLength(controller),totalBytes:Buffer.byteLength(managed.script),key:managed.key}},assetAfter:`// Controller moved into ${initial.targetFile}; this asset has no remaining references.\n`};
}
