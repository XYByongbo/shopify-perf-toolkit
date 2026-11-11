import {fields,goalContract} from './evidence-contract.mjs';

export function acceptanceContract(policy,goal) {
  if(policy!==undefined&&policy!=='standards-v1')throw new Error('Unknown acceptancePolicy; use standards-v1 or omit for legacy acceptance.');
  const target=goalContract(goal);
  if(policy&&target.kind==='score')throw new Error('standards-v1 requires an explicit loading or interaction goal; score is diagnostic only.');
  return {id:policy??'legacy-score',version:1,scoreGate:!policy,goal:target,
    scope:'Laboratory change acceptance, not field CWV compliance or authorization to publish.'};
}

const requirement=(id,level,evidenceLevel,description,extra={})=>({id,level,evidenceLevel,description,...extra});
const requirements=[
  requirement('rendered-output',1,'E1','Inspect actual rendered content, links, image crop and empty states.'),
  requirement('responsive-layout',1,'E4','Review content and overflow on the required widths.'),
  requirement('component-isolation',2,'E2','Verify scoped styles with neighboring sections removed.'),
  requirement('multi-instance',3,'E2','Verify two independently configured instances without duplicate IDs or handlers.'),
  requirement('editor-lifecycle',3,'E2','Add, configure, reorder, remove and re-add sections in the theme editor.'),
  requirement('keyboard-motion',3,'E2','Verify keyboard focus, reduced motion and affected interactions.'),
  requirement('global-matrix',4,'E2','Verify affected page types, locale/market and consent states.'),
  requirement('field-follow-up',4,'E3','Obtain post-release field evidence; never inferred from laboratory results.',{blocking:false}),
];

/** Infer a conservative minimum. Shared assets are global unless a future source graph proves isolation. */
export function verificationPlan({beforeFiles=[],afterFiles=[],scope={}}={}) {
  fields(scope,['level','pages'],'verification scope');
  const before=new Map(beforeFiles.map(f=>[f.file,f.sourceHash])),after=new Map(afterFiles.map(f=>[f.file,f.sourceHash]));
  const files=[...new Set([...before.keys(),...after.keys()])].filter(f=>before.get(f)!==after.get(f)).sort();
  if(!files.length)throw new Error('Verification scope needs actual changed source files.');
  let minimum=1;
  for(const file of files) {
    const level=/^(?:layout|assets|snippets|locales)\//.test(file)?4
      :/^(?:sections|blocks)\/.*\.liquid$/.test(file)?3
      :/^(?:config|templates|sections)\/.*\.json$/.test(file)?1:4;
    minimum=Math.max(minimum,level);
  }
  if(scope.level!==undefined&&(!Number.isInteger(scope.level)||scope.level<minimum||scope.level>4))throw new Error('Declared verification level cannot reduce the inferred scope.');
  if(scope.pages!==undefined&&(!Array.isArray(scope.pages)||!scope.pages.length||scope.pages.some(p=>typeof p!=='string'||!/^https?:\/\//.test(p))))throw new Error('scope.pages must be explicit HTTP(S) page URLs.');
  const level=scope.level??minimum;
  return {schemaVersion:1,kind:'standards-verification-plan',level,minimumLevel:minimum,files,
    pages:scope.pages??[],widths:level>=2?[375,768,1024,1280,1920]:[375,1280],
    checks:requirements.filter(r=>r.level<=level).map(r=>({...r,blocking:r.blocking!==false,status:'NOT RUN'})),
    automatic:['theme-check-delta','independent-lab','deployment-identity','functional-regression','content-and-visual-review'],
    limitation:'Files determine a minimum only. Caller must declare all affected pages; static inference cannot prove full theme coverage.'};
}
