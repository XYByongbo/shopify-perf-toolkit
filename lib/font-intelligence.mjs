import {displayUrl} from './resource-audit.mjs';
import {validDomainProfile} from './domain-profile.mjs';
export function fontIntelligence({profiles=[],snapshot,fonts=[]}={}) {
  return {version:1,declarations:fonts,captures:profiles.filter(p=>validDomainProfile(p,snapshot)).map(p=>({
    page:p.config.url,device:p.config.device,state:p.config.state,
    faces:(p.resourceHealthAfter??p.resourceHealth)?.fonts??[],
    text:(p.resourceHealthAfter??p.resourceHealth)?.text??[],
    requests:(p.resources??[]).filter(r=>r.type==='Font').map(r=>({url:displayUrl(r.url),status:r.status,source:r.source??null,
      requestMs:Number.isFinite(r.finishedTimestamp-r.timestamp)?(r.finishedTimestamp-r.timestamp)*1000:null})),
    usageStatus:(p.resourceHealthAfter??p.resourceHealth)?.text?'computed-stack-observed-actual-glyph-face-unverified':'not-collected',
  })),reviewTasks:fonts.map(f=>({file:f.file,sourceHash:f.sourceHash,offset:f.offset,family:f.family??null,
    route:f.syntax==='font_face'?'liquid-font-display':'css-font-display',
    recipe:{target:f.file,kind:f.syntax==='font_face'?'liquid-font-display':'css-font-display',parameters:f.syntax==='font_face'?{outputStart:f.offset,display:null}:{family:f.family??null,display:null},reason:'',evidence:{sourceHash:f.sourceHash,summary:''}},
    required:['actual-font-usage','fallback-and-wrap-review','cold-and-warm-load','text-geometry-and-CLS','independent-metric-gain'],
    performanceClaim:false})),automaticFontReplacement:false};
}
