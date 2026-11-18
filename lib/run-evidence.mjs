import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeLhrUrl, validateLhrReport } from './lhr-contract.mjs';

const fail = (message, code = 'INVALID_RUN_EVIDENCE') => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const groupIdentity = group => JSON.stringify([group.pageId, group.device]);

export function requiredGoalGroups(goal, groups, {representative = false} = {}) {
  if (!goal.requiredGroups) return groups;
  const keys = new Set(goal.requiredGroups.map(groupIdentity));
  const selected = groups.filter(group => keys.has(groupIdentity(group)));
  if (representative ? groups.length !== 1 || selected.length !== 1 : new Set(selected.map(groupIdentity)).size !== keys.size) {
    throw new Error(representative ? 'Experiment must measure a required goal page/device.' : 'Measurement matrix is missing a required goal page/device.');
  }
  return selected;
}

/** Only cross-before/after comparisons may omit the preview theme ID. */
export function normalizeEvidenceUrl(value) {
  const url = new URL(normalizeLhrUrl(value));
  url.searchParams.delete('preview_theme_id');
  return url.href;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f\x7f]/.test(value)
      || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)
      || value !== path.posix.normalize(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('Evidence paths must be normalized run-relative paths without traversal.', 'UNSAFE_EVIDENCE_PATH');
  }
  return value;
}

async function safePath(root, relative, kind) {
  relativePath(relative);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw fail(`Evidence symlinks are not allowed: ${relative}`, 'UNSAFE_EVIDENCE_PATH');
    if (index < parts.length - 1 && !info.isDirectory()) throw fail(`Evidence parent is not a directory: ${relative}`);
    if (index === parts.length - 1 && !(kind === 'directory' ? info.isDirectory() : info.isFile())) throw fail(`Evidence entry must be a regular ${kind}: ${relative}`);
  }
  if (await realpath(current) !== current) throw fail(`Evidence path changed or escaped its root: ${relative}`, 'UNSAFE_EVIDENCE_PATH');
  return current;
}

export async function readEvidenceJSON(root, relative) {
  const file = await safePath(root, relative, 'file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw fail(`Evidence JSON must be a regular file no larger than 128 MiB: ${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) throw fail(`Evidence changed while reading: ${relative}`);
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    let data;
    try { data = JSON.parse(text); } catch { throw fail(`Evidence JSON cannot be parsed: ${relative}`); }
    return { data, file, relative, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
const readJSON=readEvidenceJSON;

async function jsonFiles(root, relative, result = [], budget = { entries: 0 }) {
  const directory = await safePath(root, relative, 'directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (++budget.entries > 10000) throw fail('Evidence directory has more than 10000 entries.');
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw fail(`Evidence symlinks are not allowed: ${child}`, 'UNSAFE_EVIDENCE_PATH');
    if (entry.isDirectory()) await jsonFiles(root, child, result, budget);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) result.push(child);
    else if (!entry.isFile()) throw fail(`Evidence directory contains a non-regular entry: ${child}`);
  }
  return result;
}

/** Read an explicit measurement manifest and every listed raw report. Never writes. */
export async function readRunEvidence(run, { allowPartial = false, allowExploration = false } = {}) {
  if (typeof run !== 'string' || !run) throw fail('A measurement run directory is required.');
  const requestedRoot = path.resolve(run);
  const rootInfo = await lstat(requestedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw fail('Measurement run must be a real directory, not a symlink.', 'UNSAFE_EVIDENCE_PATH');
  const root = await realpath(requestedRoot);
  const manifestRecord = await readJSON(root, 'run.json');
  const manifest = manifestRecord.data;
  if (!object(manifest) || manifest.kind !== 'site-measurement' || manifest.schemaVersion !== 1
      || !['lighthouse', 'psi'].includes(manifest.engine) || !Array.isArray(manifest.groups) || !manifest.groups.length) throw fail('Unsupported or empty site-measurement manifest.');
  if (!allowPartial && manifest.status !== 'complete') throw fail('Measurement run is not complete.');
  const groups = [], issues = [], identities = new Set(), reportPaths = new Set(), directories = new Set();
  const issue = (message, group, code = 'INVALID_RUN_EVIDENCE', report = null) => issues.push({ code, message, pageId: group?.pageId ?? null, device: group?.device ?? null, report });
  if (manifest.status !== 'complete') issue(`Measurement status is ${manifest.status ?? 'missing'}; this audit is partial.`);
  const config = manifest.config;
  const exploration = config?.purpose === 'exploration';
  if (config?.purpose !== undefined && !['acceptance','exploration'].includes(config.purpose)) throw fail('Unknown measurement purpose.');
  if (exploration && !allowExploration) throw fail('Exploratory measurements cannot be used as acceptance evidence.', 'EXPLORATION_NOT_ACCEPTANCE');
  if (!object(config) || config.schemaVersion !== 1 || config.engine !== manifest.engine
      || !Array.isArray(config.pages) || !config.pages.length || !Array.isArray(config.devices) || !config.devices.length
      || !Number.isInteger(config.runs) || config.runs < (exploration ? 1 : 5) || config.runs > (exploration ? 4 : 10)) throw fail('Measurement manifest lacks a valid declared page/device/run configuration.');
  if (config.throttlingMethod !== undefined && (config.engine !== 'lighthouse' || !['simulate','devtools'].includes(config.throttlingMethod))) {
    throw fail('Invalid declared Lighthouse throttling method.');
  }
  if (new Set(config.devices).size !== config.devices.length || config.devices.some(device => !['mobile', 'desktop'].includes(device))) throw fail('Declared device matrix is invalid.');
  const expected = new Map(), pageIds = new Set();
  for (const page of config.pages) {
    if (!object(page) || typeof page.id !== 'string' || !page.id.trim() || pageIds.has(page.id)) throw fail('Declared page matrix is invalid or duplicated.');
    pageIds.add(page.id);
    const url = normalizeLhrUrl(page.url);
    for (const device of config.devices) expected.set(groupIdentity({ pageId: page.id, device }), url);
  }
  const locks = { version: null, profiles: new Map(), times: new Set() };
  for (const group of manifest.groups) {
    if (!object(group) || typeof group.pageId !== 'string' || !group.pageId.trim() || !['mobile', 'desktop'].includes(group.device)
        || !Array.isArray(group.reports)) throw fail('Malformed measurement group.');
    const groupUrl = normalizeLhrUrl(group.url);
    const key = groupIdentity(group);
    if (identities.has(key)) throw fail('Duplicate page/device group in measurement manifest.');
    if (!expected.has(key) || expected.get(key) !== groupUrl) throw fail('Measurement group differs from the declared page/device matrix.');
    identities.add(key);
    const relativeDirectory = relativePath(group.reportsDirectory);
    if (directories.has(relativeDirectory)) throw fail('Measurement groups cannot share a reports directory.');
    directories.add(relativeDirectory);
    const records = [], listed = new Set();
    for (const relative of group.reports) {
      relativePath(relative);
      if (!relative.endsWith('.json') || path.posix.dirname(relative) !== relativeDirectory) throw fail('Every report must be an immediate .json file in its declared reportsDirectory.', 'UNSAFE_EVIDENCE_PATH');
      if (listed.has(relative) || reportPaths.has(relative)) throw fail('Duplicate raw report path in measurement manifest.');
      listed.add(relative); reportPaths.add(relative);
    }
    let directory;
    try {
      directory = await safePath(root, relativeDirectory, 'directory');
      const actual = await jsonFiles(root, relativeDirectory);
      if (actual.length !== listed.size || actual.some(relative => !listed.has(relative))) throw fail('Raw report directory contains unlisted or missing JSON evidence.');
    } catch (error) {
      if (!allowPartial || error.code === 'UNSAFE_EVIDENCE_PATH') throw error;
      issue(error.message, group, error.code); directory = null;
    }
    if (group.status !== 'complete') {
      if (!allowPartial) throw fail(`Measurement group ${key} is not complete.`);
      issue(`Group status is ${group.status ?? 'missing'}.`, group);
    }
    if (!group.reports.length) {
      if (!allowPartial) throw fail(`Measurement group ${key} has no raw reports.`);
      issue('Group has no raw reports.', group);
    }
    if (group.reports.length !== config.runs) {
      if (!allowPartial) throw fail(`Measurement group ${key} does not contain its declared number of runs.`);
      issue('Saved report count differs from the configured run count.', group);
    }
    for (const relative of group.reports) {
      try {
        const record = await readJSON(root, relative);
        const report = record.data?.lighthouseResult ?? record.data;
        const evidence = validateLhrReport(report, { url: groupUrl, device: group.device });
        if (config.throttlingMethod !== undefined && report.configSettings.throttlingMethod !== config.throttlingMethod) {
          throw fail('Lighthouse report differs from its declared throttling method.', 'PROFILE_DRIFT');
        }
        if (locks.times.has(evidence.timestampKey)) throw fail('Duplicate report fetchTime in measurement run.', 'DUPLICATE_FETCH_TIME');
        if (locks.version && locks.version !== report.lighthouseVersion) throw fail('Lighthouse version changed within the measurement run.', 'VERSION_DRIFT');
        if (locks.profiles.has(group.device) && locks.profiles.get(group.device) !== evidence.profileSha256) throw fail('Browser or Lighthouse settings changed for the selected device.', 'PROFILE_DRIFT');
        locks.times.add(evidence.timestampKey);
        locks.version = report.lighthouseVersion;
        locks.profiles.set(group.device, evidence.profileSha256);
        records.push({ ...record, report });
      } catch (error) {
        if (!allowPartial || error.code === 'UNSAFE_EVIDENCE_PATH') throw error;
        issue(error.message, group, error.code, relative);
      }
    }
    groups.push({ ...group, key, directory, records });
  }
  if (identities.size !== expected.size) {
    if (!allowPartial) throw fail('Measurement groups do not cover the entire declared page/device matrix.');
    issue('Measurement groups do not cover the entire declared page/device matrix.');
  }
  return { root, manifest, manifestHash: manifestRecord.sha256, groups, issues,
    complete: manifest.status === 'complete' && issues.length === 0 && groups.every(group => group.status === 'complete' && group.records.length === group.reports.length && group.records.length > 0) };
}
