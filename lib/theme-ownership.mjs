import {scanTheme} from './scan.mjs';
import {readThemeSource} from './check-import.mjs';
import {sourceOwnership,applyOwnershipMappings} from './theme-governance.mjs';
/** Recompute ownership context at plan preparation; stale audit rows cannot replace it. */
export async function planOwnership(project,changes,reviews=[]) {
  if(!Array.isArray(reviews))throw new Error('ownership must be an audit ownership array.');
  const scan=await scanTheme({project}),files=[];
  for(const f of scan.inventory.files.filter(f=>/\.(?:liquid|m?js|css|json)$/.test(f.path)&&f.rawBytes<=5*1024*1024)) {
    const {source}=await readThemeSource(scan.project,f.path,f.sha256);files.push({file:f.path,text:source,sourceHash:f.sha256});
  }
  const inferred=sourceOwnership(files,scan.dependencies);
  return changes.map(c=>{
    const actual=inferred.find(r=>r.file===c.target)??{file:c.target,sourceHash:c.beforeHash,status:'ownership-unreviewed',generators:[],action:'review-theme-ownership',automaticPermission:false};
    if(actual.sourceHash!==c.beforeHash)throw Object.assign(new Error('Source changed during ownership preparation.'),{code:'SOURCE_DRIFT'});
    const supplied=reviews.filter(r=>r.file===c.target);
    if(supplied.length>1||supplied.length&&supplied[0].sourceHash!==c.beforeHash)throw Object.assign(new Error('Ownership review must match the original source.'),{code:'SOURCE_DRIFT'});
    actual.contextComplete=scan.complete&&files.length===scan.inventory.files.filter(f=>/\.(?:liquid|m?js|css|json)$/.test(f.path)).length;
    const review=supplied[0];
    return review?.owner?applyOwnershipMappings([actual],[review])[0]:actual;
  });
}
