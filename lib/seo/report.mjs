import {escapeHTML as esc} from '../core/report-format.mjs';
import {validateSEOAudit} from './audit.mjs';

export function renderSEOReport(value) {
  validateSEOAudit(value);
  const rows=value.findings.map(f=>`<tr><td>${esc(f.ruleId)}</td><td>${esc(f.severity)}</td><td>${esc(f.file)}:${f.line}</td><td>${esc(f.summary)}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shopify SEO 审查</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#202020}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left;overflow-wrap:anywhere}h1{color:#315f91}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Shopify SEO 审查</h1><p>范围：${esc(value.scope)} · 状态：${esc(value.status)} · SEO 验收：未执行</p><p>问题 ${value.summary.findings}；错误 ${value.summary.errors}；告警 ${value.summary.warnings}；观察 ${value.summary.observations}；覆盖问题 ${value.summary.issues}</p><p>来源：${esc(value.sourceAssociation)}。${value.findingsTruncated?'问题详情已截断，不能视为完整审查。':''}</p><table><thead><tr><th>规则</th><th>级别</th><th>位置</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table><h2>源码观察</h2><pre>${esc(JSON.stringify(value.observations,null,2))}</pre><h2>覆盖与未完成项</h2><pre>${esc(JSON.stringify(value.issues,null,2))}</pre><h2>适用边界</h2><ul>${value.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></body></html>`;
}
