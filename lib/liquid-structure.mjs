import { toLiquidHtmlAST, isLiquidHtmlNode, nonTraversableProperties } from '@shopify/liquid-html-parser';

const branching = new Set(['if','unless','case','for','tablerow','paginate']);
const nesting = new Set(['if','unless','case','for','tablerow']);

/** Explanation only. Official Theme Check diagnostics remain authoritative. */
export function analyzeLiquidStructure(source, { maxComplexity = 120, maxDepth = 10 } = {}) {
  const ast = toLiquidHtmlAST(source), decisions = [], paths = [], repeated = new Map(), hints = [];
  let complexity = 1, deepest = [], thresholdDecision = null;
  const locate = n => {
    const p = n.blockStartPosition ?? n.position;
    return { line: source.slice(0,p.start).split('\n').length, column: p.start - source.lastIndexOf('\n',p.start-1) - 1,
      start: p.start, end: p.end, tag: source.slice(p.start,p.end) };
  };
  function visit(node, ancestors = []) {
    if (!isLiquidHtmlNode(node)) return;
    const parentControl = ancestors.findLast(n => ['LiquidTag','LiquidBranch','LiquidVariableOutput'].includes(n.type));
    const point = node.type === 'LiquidTag' && branching.has(node.name)
      || node.type === 'LiquidBranch' && ['elsif','when'].includes(node.name)
      || node.type === 'LogicalExpression' && (parentControl?.type === 'LiquidTag' && ['if','unless'].includes(parentControl.name)
        || parentControl?.type === 'LiquidBranch' && parentControl.name === 'elsif');
    if (point) {
      const decision = { ...locate(node), kind: node.type === 'LogicalExpression' ? node.relation : node.name };
      decisions.push(decision); complexity++;
      if (!thresholdDecision && complexity > maxComplexity) thresholdDecision = decision;
    }
    if (node.type === 'LiquidTag' && nesting.has(node.name)) {
      const route = [...ancestors.filter(n => n.type === 'LiquidTag' && nesting.has(n.name)),node].map(locate);
      if (route.length > deepest.length) deepest = route;
      if (route.length > maxDepth) paths.push({ ...locate(node), depth: route.length, path: route });
    }
    if (node.type === 'LiquidTag' && ['if','unless'].includes(node.name) && node.markup?.position) {
      const condition = source.slice(node.markup.position.start,node.markup.position.end).trim();
      const key = node.name + ':' + condition;
      const rows = repeated.get(key) ?? []; rows.push(locate(node)); repeated.set(key,rows);
      const branches = node.children;
      if (branches?.length === 2 && branches.every(b => b.type === 'LiquidBranch') && branches[1].name === 'else') {
        const body = b => source.slice(b.blockStartPosition.end,b.blockEndPosition.start);
        if (body(branches[0]) && body(branches[0]) === body(branches[1])) hints.push({ type:'identical-branches-candidate', ...locate(node),
          reason:'两个分支源码相同；核对空白裁剪、赋值副作用与输出后再合并。' });
      }
    }
    for (const [key,value] of Object.entries(node)) {
      if (nonTraversableProperties.has(key)) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === 'object') visit(child,[...ancestors,node]);
    }
  }
  visit(ast);
  for (const [condition,locations] of repeated) if (locations.length > 1) hints.push({ type:'repeated-condition-candidate', condition, locations,
    reason:'重复条件可能可复用；先核对循环项、变量赋值及作用域，不能直接跨块合并。' });
  const breakdown = {};
  for (const d of decisions) breakdown[d.kind] = (breakdown[d.kind] ?? 0) + 1;
  return { complexity, maxDepth:deepest.length, breakdown, thresholdDecision, deepestPath:deepest, exceedingPaths:paths, hints,
    recommendation: breakdown.when > decisions.length / 2 ? '多数决策来自 case/when 选项；先确认功能分支必要性，再按职责拆分，不能直接删除选项。'
      : '先复核重复条件与深层嵌套；无法等价简化时，再评审独立 snippet 和显式参数。' };
}
