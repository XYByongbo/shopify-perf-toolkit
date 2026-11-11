// Synthetic, deployment-bound integrity contract. Never an actual storefront observation.
export function integrityForRun(run,snapshot,offset=0){
  const url=run.manifest.config.pages[0].url,remote=run.manifest.deployment.after;
  const at=n=>new Date(Date.UTC(2026,10,1,0,offset,n)).toISOString();
  const identity={selector:'#main',tag:'H1',capturedAtMs:100,fontSize:24,text:'Visible fixture',textCharacters:15,textTruncated:false,
    viewportCoverage:.2,viewport:{width:390,height:844},backgroundImage:'none',effectiveOpacity:1,
    ancestors:[{opacity:'1',display:'block',visibility:'visible',activeAnimations:0}],expectedMatch:null};
  const integrity={version:1,timeOrigin:1,lcpSupported:true,lcpEntries:[{startTime:90,size:100,url:'',identity}],settledLcp:identity,lcpTruncated:false,
    events:[],eventsTruncated:false,initializationEvents:['StartAsyncLoading'],expectedLcpSelectors:[],capturedAtMs:200,errors:[]};
  return {kind:'runtime-profile',status:'complete',sourceStable:true,snapshot,project:snapshot.project,themeId:remote.themeId,finalUrl:url,
    createdAt:at(2),finishedAt:at(3),config:{url,device:'mobile',state:'initial',actions:[],initializationEvents:['StartAsyncLoading']},
    domainProof:{version:1,url,startedAt:at(2),finishedAt:at(3),before:{...remote,startedAt:at(0),finishedAt:at(1)},after:{...remote,startedAt:at(4),finishedAt:at(5)}},
    timeOrigin:1,browserVersion:'synthetic-fixture',environment:{cache:'disabled',serviceWorkers:'blocked'},actions:[],resources:[],
    initial:{lcp:{startTime:90,size:100,url:''},integrity},afterActions:{integrity:{...structuredClone(integrity),capturedAtMs:1000}},
    networkCapture:{version:1,complete:true,truncated:false,redirectsTruncated:false,mainFrameId:'m',mainLoaderId:'l'}};
}
