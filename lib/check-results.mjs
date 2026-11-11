const statuses=new Set(['PASS','FAIL','NOT RUN','N/A']);

/** Reporting adapter only. Acceptance continues to use the original pass predicates. */
export function checkResult(check) {
  const reason=typeof check.reason==='string'&&check.reason.trim()?check.reason:null;
  let status;
  if(check.applicable===false)status=reason?'N/A':'NOT RUN';
  else if(check.enabled===false||check.executed===false||check.implemented===false)status='NOT RUN';
  else if(check.checkStatus!==undefined) {
    if(!statuses.has(check.checkStatus))throw new Error('Unknown check status.');
    status=check.checkStatus;
    // A declared PASS cannot override a failed predicate; N/A needs an applicability reason.
    if(status==='PASS'&&check.pass!==true)status=check.pass===false?'FAIL':'NOT RUN';
    if(status==='N/A')status='NOT RUN';
  } else status=check.pass===true?'PASS':check.pass===false?'FAIL':'NOT RUN';
  return {id:check.id,status,executed:status==='PASS'||status==='FAIL',
    reason:reason??(status==='NOT RUN'?'Execution or applicability evidence was not supplied.':null)};
}
