export const htmlName = node => typeof node?.name === 'string' ? node.name : node?.name?.map(n => n.value ?? '?').join('');
export const literalAttribute = (node, key) => {
  const attrs = (node.attributes ?? []).filter(a => htmlName(a)?.toLowerCase() === key);
  return attrs.length === 1 && attrs[0].value?.every(n => n.type === 'TextNode') ? attrs[0].value.map(n => n.value).join('') : null;
};
export const lookupPath = node => node?.type === 'VariableLookup' && node.lookups?.every(x => x.type === 'String')
  ? [node.name, ...node.lookups.map(x => x.value)].join('.') : null;
export const filterArgument = (filter, name) => filter?.args?.find(a => a.type === 'NamedArgument' && a.name === name);
export const imageFilter = node => node?.type === 'LiquidVariableOutput' ? node.markup?.filters?.find(f => f.name === 'image_tag') : null;
export const hasAttribute = (node, key) => (node.attributes ?? []).some(a => htmlName(a)?.toLowerCase() === key);
export const opaqueParents = parents => parents.some(p => ['HtmlComment', 'HtmlRawNode', 'LiquidRawTag'].includes(p.type)
  || p.type === 'LiquidTag' && p.name === 'capture' || p.type === 'HtmlElement' && ['template', 'noscript'].includes(htmlName(p)));

// Only literal, unambiguous attributes can establish an exact duplicate.
export function literalAttributes(node) {
  const values = {};
  for (const attr of node.attributes ?? []) {
    const name = htmlName(attr)?.toLowerCase();
    if (!/^Attr/.test(attr.type) || !/^[a-z][a-z0-9-]*$/.test(name ?? '') || Object.hasOwn(values, name)) return null;
    if (attr.type === 'AttrEmpty') values[name] = '';
    else if (attr.value?.every(n => n.type === 'TextNode')) values[name] = attr.value.map(n => n.value).join('');
    else return null;
  }
  return values;
}
export const hintKey = attrs => attrs ? JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) : null;
