import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './bounded-process.mjs';

/** Saved HTML observations must never masquerade as deployment or scoring proof. */
export function validateRenderedHTMLAudit(report) {
  const count=n=>Number.isInteger(n)&&n>=0;
  const summary=report?.summary,input=report?.input,findings=report?.findings;
  if(report?.schemaVersion!==1 || report.kind!=='rendered-html-audit' || report.complete!==true
    || !['document','fragment'].includes(report.scope) || report.sourceAssociation!=='unverified-saved-html' || report.acceptance!=='not-evaluated'
    || !summary || !count(summary.errors) || !count(summary.warnings) || summary.findings!==summary.errors+summary.warnings
    || report.error_count!==summary.errors || report.warning_count!==summary.warnings
    || report.reviewRequired!==(summary.findings>0) || report.success!==(summary.errors===0)
    || typeof input?.file!=='string' || !path.isAbsolute(input.file) || !/\.html?$/i.test(input.file)
    || !/^[a-f0-9]{64}$/.test(input.sha256??'') || !count(input.bytes) || input.bytes>20*1024*1024
    || !Array.isArray(findings) || findings.length!==Math.min(200,summary.findings) || report.findings_truncated!==(summary.findings>200)
    || findings.some(f=>!f || typeof f.code!=='string' || !['error','warning'].includes(f.severity) || !Number.isInteger(f.line) || f.line<1
      || typeof f.summary!=='string' || f.file!==input.file || f.status!=='rendered-html-observation')
    || !Array.isArray(report.limitations) || report.limitations.some(x=>typeof x!=='string')) throw new Error('Invalid saved HTML audit contract.');
  const errors=findings.filter(f=>f.severity==='error').length,warnings=findings.length-errors;
  if(errors>summary.errors || warnings>summary.warnings || !report.findings_truncated&&(errors!==summary.errors||warnings!==summary.warnings)) throw new Error('HTML finding totals do not match retained evidence.');
  return report;
}

/** Saved HTML only. Neither renders Liquid nor proves deployment identity or performance. */
export async function auditRenderedHTML({ input, fragment = false, lcpId = null, timeoutMs = 30000, profile = 'all', python = process.env.PERF_KIT_PYTHON || 'python3' } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input)) throw new Error('HTML input must be an absolute file path.');
  if (typeof fragment !== 'boolean' || lcpId !== null && (typeof lcpId !== 'string' || !lcpId.trim() || lcpId.length > 512 || /[\x00-\x1f\x7f]/.test(lcpId))) throw new Error('Invalid fragment or caller-identified LCP id.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('HTML audit timeout must be 1..30000 ms.');
  if(!['all','seo'].includes(profile))throw new Error('Invalid HTML rule profile.');
  const args = ['-B',fileURLToPath(new URL('../../scripts/audit_rendered_html.py',import.meta.url)),input];
  if(profile==='seo')args.push('--profile','seo');
  if (fragment) args.push('--fragment');
  if (lcpId !== null) args.push('--lcp-id='+lcpId);
  // This stdlib helper never spawns children. Inherit a batch supervisor's group
  // so its deadline kills Node and Python together; standalone timeouts kill the helper PID.
  const result = await runProcess(python,args,{timeoutMs,maxBytes:2*1024*1024,ownProcessGroup:false,env:{PYTHONDONTWRITEBYTECODE:'1'}});
  let report; try { report = JSON.parse(result.stdout); } catch { throw new Error('HTML helper returned invalid JSON.'); }
  if (![0,1].includes(result.code) || typeof report.success !== 'boolean' || !Array.isArray(report.findings)
    || result.code !== (report.success ? 0 : 1)) throw new Error(report.error || 'HTML helper failed or returned inconsistent evidence.');
  return validateRenderedHTMLAudit({ schemaVersion:1,kind:'rendered-html-audit',...report,complete:true,
    reviewRequired:report.error_count>0 || report.warning_count>0,
    summary:{errors:report.error_count,warnings:report.warning_count,findings:report.error_count+report.warning_count},
    sourceAssociation:'unverified-saved-html',acceptance:'not-evaluated',
    findings:report.findings.map(f => ({...f,ruleId:'HTML-'+f.code.toUpperCase(),status:'rendered-html-observation',summary:f.message,
      file:report.input.file,verification:['Review the matching page/instance and deployment; this audit is not performance or business acceptance.']})),
    limitations:[report.limitations,'Saved HTML hash identifies the input bytes only; it does not prove theme/source/deployment identity.'] });
}
