/** Compare like costs only. Cross-domain duration is never a prediction of savings. */
export function candidatePriority(c) {
  const executors = c.remainingMethods ?? c.methods ?? [];
  const available = c.remainingMethods!==undefined ? executors.length>0 : executors.length>0 || c.officialMethods?.some(m=>m.executor&&!m.tested&&m.sourceStatus!=='missing');
  const critical = c.criticalPathConfirmed === true || c.data?.criticalPathConfirmed === true;
  return { ...c.priority, executable: Boolean(available), criticalPathConfirmed: critical,
    evidenceClass: critical ? 2 : c.eligible === true ? 1 : 0,
    costScope: c.costScope ?? `${c.metric}:${c.kind}`,
    disposition: c.eligible!==true?'collect-source-and-cost-evidence':c.gainCeiling?.blocked ? 'blocked-by-gain-ceiling' : available ? 'prepare-with-review' : 'collect-evidence-or-reviewed-implementation',
    explanation: 'Goal and field impact first, then verified critical path and executable scope; compare costs only within the same metric and mechanism.' };
}
export function compareCandidates(a,b) {
  const x=candidatePriority(a),y=candidatePriority(b);
  return Number(Boolean(a.gainCeiling?.blocked))-Number(Boolean(b.gainCeiling?.blocked))
    || (y.goalMatch??0)-(x.goalMatch??0) || Number(Boolean(y.fieldBreach))-Number(Boolean(x.fieldBreach))
    || y.evidenceClass-x.evidenceClass || Number(y.executable)-Number(x.executable)
    || (b.lostPoints??0)-(a.lostPoints??0)
    || String(x.costGroupOrder??x.costScope).localeCompare(String(y.costGroupOrder??y.costScope))
    || (x.costScope===y.costScope ? (b.costMs??0)-(a.costMs??0) : 0)
    || String(a.candidateId??`${a.file}:${a.line}`).localeCompare(String(b.candidateId??`${b.file}:${b.line}`));
}

/** Stable scope buckets avoid non-transitive pairwise comparisons of unlike costs. */
export function rankCandidates(rows) {
  const scopes=new Map();
  for(const c of rows){const scope=candidatePriority(c).costScope,id=String(c.candidateId??`${c.file}:${c.line}`);scopes.set(scope,scopes.has(scope)&&scopes.get(scope)<id?scopes.get(scope):id);}
  return rows.map(c=>({...c,priority:{...candidatePriority(c),costGroupOrder:scopes.get(candidatePriority(c).costScope)}})).sort(compareCandidates);
}
