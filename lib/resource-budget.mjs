const types = new Set(['document','script','stylesheet','image','media','font','other','third-party']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;

export function validateResourceBudget(config) {
  if (!object(config) || !Object.keys(config).length || Object.keys(config).some(k =>
    !['maxTotalTransferBytes','maxByType','maxRequests'].includes(k))) throw new Error('Invalid resource budget fields.');
  for (const key of ['maxTotalTransferBytes','maxRequests']) if (Object.hasOwn(config,key) && !nonnegative(config[key]))
    throw new Error(`${key} must be a nonnegative safe integer.`);
  if (Object.hasOwn(config,'maxByType') && (!object(config.maxByType) || !Object.keys(config.maxByType).length
    || Object.entries(config.maxByType).some(([type,limit]) => !types.has(type) || !nonnegative(limit))))
    throw new Error('maxByType requires known Lighthouse resource types and nonnegative byte limits.');
  return config;
}

/** Hard limits per navigation, never summed across pages/samples or overlapping rows. */
export function checkPerformanceBudget(candidate, config) {
  validateResourceBudget(config);
  if (!candidate.groups?.length) throw new Error('Resource budget requires measurement groups.');
  const details = [];
  for (const group of candidate.groups) {
    if (!group.records?.length) throw new Error('Resource budget requires samples for every group.');
    for (const [index,record] of group.records.entries()) {
      const where = `${group.pageId}/${group.device}/${record.relative ?? index + 1}`;
      const audit = record.report.audits?.['resource-summary'], items = audit?.details?.items;
      if (!Array.isArray(items) || !items.length || audit.errorMessage || ['error','notApplicable'].includes(audit.scoreDisplayMode))
        throw new Error(`Missing resource-summary evidence: ${where}`);
      const rows = new Map();
      for (const row of items) {
        if (!object(row) || typeof row.resourceType !== 'string' || rows.has(row.resourceType)
          || !nonnegative(row.transferSize) || !nonnegative(row.requestCount)) throw new Error(`Invalid resource-summary row: ${where}`);
        rows.set(row.resourceType,row);
      }
      const total = rows.get('total');
      if (!total || [...rows.values()].some(r => r.transferSize > total.transferSize || r.requestCount > total.requestCount))
        throw new Error(`Missing or inconsistent resource-summary total: ${where}`);
      const disjoint=[...rows.values()].filter(r=>types.has(r.resourceType)&&r.resourceType!=='third-party');
      if(disjoint.reduce((sum,r)=>sum+r.transferSize,0)>total.transferSize
        ||disjoint.reduce((sum,r)=>sum+r.requestCount,0)>total.requestCount)
        throw new Error(`Resource-summary categories exceed total: ${where}`);
      const check = (metric,value,limit) => details.push({pageId:group.pageId,device:group.device,
        sample:record.relative ?? index + 1,metric,value,limit,passed:value <= limit});
      if (config.maxTotalTransferBytes !== undefined) check('totalTransferBytes',total.transferSize,config.maxTotalTransferBytes);
      if (config.maxRequests !== undefined) check('requestCount',total.requestCount,config.maxRequests);
      for (const [type,limit] of Object.entries(config.maxByType ?? {})) {
        if (!rows.has(type)) throw new Error(`Missing resource-summary ${type} evidence: ${where}`);
        check(`transferBytes:${type}`,rows.get(type).transferSize,limit);
      }
    }
  }
  return {passed:details.every(d => d.passed),scope:'every-page-device-sample',details,
    note:'Configured resource budgets are hard per-navigation limits; score, gain and behavior gates still apply.'};
}
