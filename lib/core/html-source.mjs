import {lineAt} from './source-utils.mjs';
export const RAW_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

export function liquidEnd(source, start) {
  const close = source[start + 1] === '{' ? '}}' : '%}';
  let quote = null;
  for (let i = start + 2; i < source.length; i++) {
    if (quote) {
      if (source[i] === quote) quote = null;
    } else if (source.startsWith(close, i)) return i + 2;
    else if (source[i] === '"' || source[i] === "'") quote = source[i];
  }
  return source.length;
}

// Preserve offsets and line numbers, and never inspect non-rendering Liquid/HTML comments.
export function maskNonRendering(source) {
  let result = '', cursor = 0, rawEnd = -1;
  for (let i = 0; i < source.length;) {
    let end = null;
    if (i >= rawEnd && source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      end = close < 0 ? source.length : close + 3;
    } else if (i >= rawEnd && /^<[a-z][\w:-]*\b/i.test(source.slice(i))) {
      const tagEnd = htmlTagEnd(source, i);
      if (tagEnd === null) { i++; continue; }
      const raw = source.slice(i, tagEnd).match(/^<([a-z][\w:-]*)\b/i)?.[1].toLowerCase();
      if (RAW_HTML_ELEMENTS.has(raw)) {
        const close = new RegExp(`<\\/\\s*${raw}\\s*>`, 'gi');
        close.lastIndex = tagEnd;
        rawEnd = raw === 'plaintext' ? source.length : close.exec(source)?.index ?? source.length;
      }
      // Comment-shaped text inside an HTML attribute is still attribute text.
      i = tagEnd;
      continue;
    } else if (source.startsWith('{%', i)) {
      const tokenEnd = liquidEnd(source, i);
      const token = source.slice(i, tokenEnd);
      const block = token.match(/^\{%-?\s*(comment|schema|raw)\b/);
      if (block) {
        const close = new RegExp(`\\{%-?\\s*end${block[1]}\\s*-?%\\}`, 'g');
        close.lastIndex = tokenEnd;
        const match = close.exec(source);
        end = match ? match.index + match[0].length : source.length;
      } else if (/^\{%-?\s*#/.test(token)) end = tokenEnd;
      else { i = tokenEnd; continue; }
    } else if (source.startsWith('{{', i)) { i = liquidEnd(source, i); continue; }
    if (end !== null) {
      result += source.slice(cursor, i) + blank(source.slice(i, end));
      cursor = end;
      i = end;
    } else i++;
  }
  return result + source.slice(cursor);
}

export function htmlTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i++) {
    if (source.startsWith('{{', i) || source.startsWith('{%', i)) { i = liquidEnd(source, i) - 1; continue; }
    if (quote) { if (source[i] === quote) quote = null; }
    else if (source[i] === '"' || source[i] === "'") quote = source[i];
    else if (source[i] === '>') return i + 1;
  }
  return null;
}

export function readAttributes(tag, offset) {
  const attributeList = [], attributes = Object.create(null);
  let dynamic = false, malformed = false, duplicate = false;
  let i = tag.match(/^<[a-z][\w:-]*\b/i)?.[0].length ?? 0;
  while (i < tag.length) {
    while (/\s/.test(tag[i] ?? '') && i < tag.length) i++;
    if (tag[i] === '>' || tag.slice(i).match(/^\/\s*>$/)) break;
    if (tag.startsWith('{{', i) || tag.startsWith('{%', i)) { dynamic = true; i = liquidEnd(tag, i); continue; }
    const attrStart = i;
    const nameMatch = tag.slice(i).match(/^[^\s=<>"'`{}\/]+/);
    if (!nameMatch) { malformed = true; i++; continue; }
    const rawName = nameMatch[0], name = rawName.toLowerCase();
    i += rawName.length;
    const nameEnd = i;
    while (/\s/.test(tag[i] ?? '') && i < tag.length) i++;
    let value = null, quote = null;
    if (tag[i] === '=') {
      i++;
      while (/\s/.test(tag[i] ?? '') && i < tag.length) i++;
      if (tag[i] === '"' || tag[i] === "'") {
        quote = tag[i++];
        const valueStart = i;
        while (i < tag.length && tag[i] !== quote) {
          if (tag.startsWith('{{', i) || tag.startsWith('{%', i)) i = liquidEnd(tag, i);
          else i++;
        }
        value = tag.slice(valueStart, i);
        if (tag[i] !== quote) malformed = true;
        else i++;
        if (i < tag.length && !/[\s/>]/.test(tag[i])) malformed = true;
      } else {
        const valueStart = i;
        while (i < tag.length && !/[\s>]/.test(tag[i])) {
          if (tag.startsWith('{{', i) || tag.startsWith('{%', i)) i = liquidEnd(tag, i);
          else i++;
        }
        value = tag.slice(valueStart, i);
        malformed = true; // Valid unquoted HTML is intentionally outside the patch grammar.
      }
    } else i = nameEnd;
    if (Object.hasOwn(attributes, name)) duplicate = true;
    attributes[name] = value;
    attributeList.push({ name, value, quote, start: offset + attrStart, end: offset + i });
  }
  return { attributes, attributeList, dynamic, malformed, duplicate };
}

export function collectImages(source, masked) {
  const images = [], rawRegions = [];
  let pictureDepth = 0;
  for (let i = 0; i < masked.length;) {
    if (masked.startsWith('{{', i) || masked.startsWith('{%', i)) { i = liquidEnd(masked, i); continue; }
    const opening = masked.slice(i).match(/^<\s*(\/?)\s*([a-z][\w:-]*)\b/i);
    if (!opening) { i++; continue; }
    const end = htmlTagEnd(masked, i);
    if (end === null) break;
    const name = opening[2].toLowerCase(), closing = !!opening[1];
    if (name === 'picture') pictureDepth = Math.max(0, pictureDepth + (closing ? -1 : 1));
    if (!closing && RAW_HTML_ELEMENTS.has(name)) {
      const close = new RegExp(`<\\/\\s*${name}\\s*>`, 'gi');
      close.lastIndex = end;
      const match = name === 'plaintext' ? null : close.exec(masked);
      rawRegions.push({ name, start: end, end: match?.index ?? masked.length });
      i = match ? match.index + match[0].length : masked.length;
      continue;
    }
    if (name === 'img' && !closing) {
      const tag = source.slice(i, end), parsed = readAttributes(tag, i);
      const sourceExpression = parsed.attributes.src ?? null;
      const simple = sourceExpression?.match(/^\{\{-?\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*\|\s*image_url\s*:\s*width\s*:\s*([1-9]\d*)\s*-?\}\}$/);
      const maxWidth = simple && Number.isSafeInteger(Number(simple[2])) ? Number(simple[2]) : null;
      let reason = 'Simple Shopify image_url expression with one literal width; eligible for a reviewed local patch.';
      if (!simple || !maxWidth) reason = 'Source is not a simple image_url with one positive literal width; transformations, variable widths and other sources require manual review.';
      else if (parsed.dynamic) reason = 'Liquid injects or conditionally changes attributes; the rendered tag must be inspected.';
      else if (parsed.duplicate || parsed.malformed) reason = 'Duplicate or unsupported attribute syntax; automated patch is unsafe.';
      else if (pictureDepth) reason = 'Inside picture; preserve source selection and art direction until all sources are verified.';
      else if (Object.hasOwn(parsed.attributes, 'srcset') || Object.hasOwn(parsed.attributes, 'sizes')) reason = 'Existing responsive source configuration must be preserved and evaluated in a browser.';
      const eligibleForPatch = !!simple && !!maxWidth && !parsed.dynamic && !parsed.duplicate && !parsed.malformed && !pictureDepth && !Object.hasOwn(parsed.attributes, 'srcset') && !Object.hasOwn(parsed.attributes, 'sizes');
      images.push({ index: images.length, line: lineAt(source, i), start: i, end, tag, sourceExpression, imageObject: simple?.[1] ?? null, maxWidth, attributes: parsed.attributes, attributeList: parsed.attributeList, mappingSafe: !parsed.dynamic && !parsed.duplicate && !parsed.malformed, eligibleForPatch, reason });
    }
    i = end;
  }
  return { images, rawRegions };
}

/** Parse original source independently of any serialized inspection report. Offsets use UTF-16 string indexes. */
export function inspectImages(source) {
  if (typeof source !== 'string') throw new TypeError('Image source must be a string.');
  return collectImages(source, maskNonRendering(source)).images;
}

// Offset-preserving Liquid tokens; quoted delimiters never end a token.
export function liquidTokens(s){const out=[];for(let i=0;i<s.length;i++){if(!s.startsWith('{{',i)&&!s.startsWith('{%',i))continue;const start=i,close=s[i+1]==='{'?' }}'.trim():'%}';let q=null;i+=2;for(;i<s.length;i++){if(q){if(s[i]===q)q=null;}else if(s.startsWith(close,i))break;else if('"\''.includes(s[i]))q=s[i];}out.push({start,end:i+2,text:s.slice(start,i+2)});i++;}return out;}
// HTML scanner skips script/style bodies, so JS strings are never HTML findings.
export function tags(s) {
  const out=[], contexts=[];
  for(let i=0;i<s.length;) {
    if(s.startsWith('{{',i)||s.startsWith('{%',i)){const token=liquidTokens(s.slice(i))[0];i+=token?.end??2;continue;}
    const m=s.slice(i).match(/^<(\/?)([a-z][\w:-]*)\b/i);
    if(!m){i++;continue;}
    const end=htmlTagEnd(s,i);if(!end){i++;continue;}
    const name=m[2].toLowerCase();
    if(m[1]){const index=contexts.lastIndexOf(name);if(index>=0)contexts.splice(index);i=end;continue;}
    const parsed=readAttributes(s.slice(i,end),i);
    const inert=contexts.some(n=>['template','noscript'].includes(n)),svg=contexts.includes('svg');
    let close=null,body='';
    if(RAW_HTML_ELEMENTS.has(name)){const re=new RegExp(`</${name}\\s*>`,'ig');re.lastIndex=end;close=name==='plaintext'?null:re.exec(s);body=s.slice(end,close?.index??s.length);}
    out.push({name,start:i,end,body,bodyStart:end,inert,svg,...parsed});
    if(['template','noscript','svg'].includes(name)&&!RAW_HTML_ELEMENTS.has(name)&&!s.slice(i,end).endsWith('/>'))contexts.push(name);
    i=close?close.index+close[0].length:RAW_HTML_ELEMENTS.has(name)?s.length:end;
  }
  return out;
}
