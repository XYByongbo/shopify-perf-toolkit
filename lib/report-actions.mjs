export function reportActions(report){
  const groups={fix:[],review:[],notRun:[],passed:[],notApplicable:[]};
  const checks=report.checkResults??[],findings=report.findings??[];
  for(const c of checks){
    const row={id:c.id,ruleIds:c.standardRuleIds??[],summary:c.summary??c.id,location:c.subject??c.page??'',reason:c.reason??''};
    const destination=c.status==='NOT RUN'?'notRun':c.status==='N/A'?'notApplicable':c.status==='PASS'?'passed':c.reviewRequired?'review':c.status==='FAIL'?'fix':'review';
    // Detailed finding rows below already supply the matching failed observation.
    if(c.status==='FAIL'&&findings.some(f=>f.id===c.id||f.ruleId===c.id&&f.evidence?.some(e=>e.profileIndex===c.profileIndex)))continue;
    groups[destination].push(row);
  }
  for(const f of findings){
    const destination=f.status==='external-observation'?'review':f.checkStatus==='FAIL'?'fix':'review';
    groups[destination].push({id:f.id,ruleIds:f.standardRuleIds??[],summary:f.summary,location:f.file??f.target??f.evidence?.[0]?.selector??f.subject??'',reason:f.status==='external-observation'?'External observation; reproduce before changing source.':f.verification?.[0]??''});
  }
  return {groups,counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),unit:'action/check rows, not unique standards or full coverage'};
}
