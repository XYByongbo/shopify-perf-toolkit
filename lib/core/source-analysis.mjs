import {readThemeSource, relativeFile} from './source-reader.mjs';

// A scan may keep verified text for its consumers. Reports never carry this cache.
const contexts = new WeakMap();
const maxRetainedBytes = 32 * 1024 * 1024;

export function createSourceAnalysis() {
  const analysis = {};
  contexts.set(analysis, {project: null, files: new Map(), bytes: 0});
  return analysis;
}

export function beginSourceAnalysis(analysis, project) {
  const context = contexts.get(analysis);
  if (!context || context.project !== null) throw new Error('A fresh source analysis is required for each scan.');
  context.project = project;
  return ({file, source, sourceHash, bytes}) => {
    if (context.bytes + bytes > maxRetainedBytes) return;
    context.files.set(file, {source, sourceHash});
    context.bytes += bytes;
  };
}

export async function readAnalyzedThemeSource(project, file, sourceHash, analysis) {
  const relative = relativeFile(file);
  const context = contexts.get(analysis);
  const cached = context?.project === project ? context.files.get(relative) : null;
  if (sourceHash && cached?.sourceHash === sourceHash) return cached.source;
  const current = await readThemeSource(project, relative, sourceHash);
  if (current.sourceHash !== sourceHash) throw new Error('Source fingerprint mismatch.');
  return current.source;
}
