import {parse} from 'acorn';
import postcss from 'postcss';
import {liquidAST} from './advanced-strategies.mjs';

const maxEntries = 32;
const maxCharacters = 2 * 1024 * 1024;

/** Reuse read-only parser results for exact text and grammar within one analysis. */
export function createSourceSyntaxCache() {
  const entries = new Map();
  let characters = 0;

  function get(grammar, source, parseSource) {
    if (grammar.length + 1 + source.length > maxCharacters) return parseSource(source);
    const key = grammar + '\0' + source;
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
    } else {
      try { entry = {tree: parseSource(source)}; }
      catch (error) { entry = {error}; }
      characters += key.length;
    }
    while (entries.size && (entries.size >= maxEntries || characters > maxCharacters)) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      characters -= oldest.length;
    }
    entries.set(key, entry);
    if ('error' in entry) throw entry.error;
    return entry.tree;
  }

  return {
    liquid: source => get('liquid', source, liquidAST),
    css: source => get('css', source, text => postcss.parse(text)),
    javascript: (source, {allowReturnOutsideFunction = false} = {}) =>
      get(allowReturnOutsideFunction ? 'js-module-with-return' : 'js-module', source,
        text => parse(text, {ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction})),
  };
}
