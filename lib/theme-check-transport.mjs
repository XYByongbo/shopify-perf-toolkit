/** CLI 4 grouped offenses and CLI 5 ThemeCheckResult. Never accept an error envelope as a clean scan. */
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeThemeCheck(input) {
  if (Array.isArray(input)) {
    if (input.some(g => !object(g) || typeof g.path !== 'string' || !Array.isArray(g.offenses))) throw new Error('Invalid grouped Theme Check report.');
    return {format:'grouped-offenses',groups:input,normalization:null};
  }
  if (!object(input) || input.error || typeof input.valid !== 'boolean' || !Array.isArray(input.issues)) throw new Error('Unsupported Theme Check JSON; expected grouped offenses or ThemeCheckResult.');
  if (input.issues.length > 100000) throw new Error('Theme Check report exceeds 100000 issues.');
  const counts={error:0,warning:0,info:0}, groups=new Map();
  for (const issue of input.issues) {
    if (!object(issue) || typeof issue.filePath !== 'string' || !issue.filePath || typeof issue.check !== 'string' || !issue.check || typeof issue.message !== 'string'
      || !Object.hasOwn(counts,issue.severity) || ['startRow','startColumn','endRow','endColumn'].some(k => !Number.isSafeInteger(issue[k]) || issue[k]<1)
      || issue.endRow<issue.startRow || issue.endRow===issue.startRow && issue.endColumn<issue.startColumn) throw new Error('Malformed ThemeCheckResult issue.');
    counts[issue.severity]++;
    if (!groups.has(issue.filePath)) groups.set(issue.filePath,{path:issue.filePath,offenses:[]});
    groups.get(issue.filePath).offenses.push({check:issue.check,severity:issue.severity,message:issue.message,
      start_row:issue.startRow-1,start_column:issue.startColumn-1,end_row:issue.endRow-1,end_column:issue.endColumn-1,nativeIssue:structuredClone(issue)});
  }
  for (const [severity,count] of Object.entries(counts)) if (input[`${severity}Count`]!==count) throw new Error('ThemeCheckResult counts disagree with issues.');
  // `valid` follows the chosen fail-level, not simply the number of errors.
  if (!input.valid && !input.issues.length) throw new Error('ThemeCheckResult failed without diagnostics.');
  return {format:'theme-check-result',groups:[...groups.values()],normalization:{inputFormat:'theme-check-result',inputPositionBase:1,positionBase:0,columns:'zero-based',valid:input.valid}};
}
/** Undefined removes inherited oclif flags; the string "false" still counts as a supplied exclusive flag in CLI 5. */
export function themeCheckEnvironment(env=process.env) {
  return {...Object.fromEntries(Object.keys(env).filter(k=>/^SHOPIFY_FLAG_/.test(k)).map(k=>[k,undefined])),
    CI:'1',SHOPIFY_CLI_NO_ANALYTICS:'1'};
}
