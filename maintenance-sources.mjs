import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86400000;
const INTERACTIVE = new Set(['cli', 'vscode', 'exec', 'appServer', 'unknown']);
const MAX_ROWS = 10000;
const clean = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function iso(value) {
  if (value == null || value === '') return undefined;
  const time = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(time) || time < Date.UTC(2020, 0, 1)) return undefined;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString() : undefined;
}

// Match exact Windows roots, including extended paths and the equivalent WSL
// mount spelling. Never use a prefix match to infer project membership.
export function normalizeProjectPath(value) {
  let path = clean(value)?.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  if (!path) return undefined;
  path = path.replace(/\/+$/, '').toLowerCase();
  path = path.replace(/^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(?:\/(.*))?$/, (_, rest) => '/' + (rest || ''));
  return path.replace(/^\/?([a-z]):(?:\/(.*))?$/, (_, drive, rest) => `/mnt/${drive}${rest ? '/' + rest : ''}`);
}

/** Undefined means membership is unverified; null means explicitly projectless. */
export function resolveLocalProject(row, state, projects) {
  if (!state) return undefined;
  const assignment = state['thread-project-assignments']?.[row.id];
  if (assignment != null) {
    const matches = projects.filter(project => project.projectId === assignment.projectId
      && (!assignment.hostId || assignment.hostId === 'local')
      && (!project.hostId || project.hostId === 'local'));
    return matches.length === 1 ? assignment.projectId : undefined;
  }
  if (Array.isArray(state['projectless-thread-ids']) && state['projectless-thread-ids'].includes(row.id)) return null;
  const path = normalizeProjectPath(row.cwd);
  if (!path) return undefined;
  const candidates = projects.filter(project => project.projectKind === 'local'
    && (!project.hostId || project.hostId === 'local')
    && [project.path, ...(Array.isArray(project.rootPaths) ? project.rootPaths : []),
      ...(Array.isArray(project.rootPathAliases) ? project.rootPathAliases.map(alias => alias?.alias) : [])]
      .some(root => normalizeProjectPath(root) === path));
  return candidates.length === 1 ? candidates[0].projectId : undefined;
}

/** Explicit app-owned backing metadata is the only project alias authority. */
export function resolveProjectAliases(state, projects) {
  const localProjects = state?.['local-projects'];
  if (!localProjects || typeof localProjects !== 'object' || Array.isArray(localProjects) || !Array.isArray(projects)) return [];
  const local = projects.filter(project => project?.projectKind === 'local'
    && (!project.hostId || project.hostId === 'local') && clean(project.projectId));
  const aliases = [];
  for (const project of local) {
    if (local.filter(candidate => candidate.projectId === project.projectId).length !== 1
      || !own(localProjects, project.projectId)) continue;
    const saved = localProjects[project.projectId];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.id !== project.projectId) continue;
    const backing = saved.chatGptBacking;
    const target = backing && typeof backing === 'object' && !Array.isArray(backing) ? backing.projectId : undefined;
    if (typeof target !== 'string' || !/^g-p-[0-9a-f]{32}$/i.test(target)) continue;
    if (projects.filter(candidate => candidate?.projectKind === 'chatgpt' && candidate.projectId === target).length !== 1) continue;
    aliases.push({ sourceId: project.projectId, hostId: 'local', chatgptProjectId: target });
  }
  return aliases.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function snapshot(path, read) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    return read(db);
  } finally {
    try { db.exec('ROLLBACK'); } finally { db.close(); }
  }
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function requireColumns(actual, required) {
  if (required.some(column => !actual.has(column))) throw new Error('unsupported_schema');
}

function localRows(path) {
  return snapshot(path, db => {
    const available = columns(db, 'threads');
    requireColumns(available, ['id', 'source', 'title', 'cwd', 'updated_at', 'archived']);
    const optional = ['name', 'updated_at_ms', 'agent_path', 'thread_source', 'history_mode', 'parent_thread_id', 'ephemeral'];
    const selected = ['id', 'source', 'title', 'cwd', 'updated_at', 'archived', ...optional.filter(column => available.has(column))];
    const rows = db.prepare(`SELECT ${selected.join(',')} FROM threads WHERE source IN ('cli','vscode','exec','appServer','unknown') LIMIT ${MAX_ROWS + 1}`).all();
    if (rows.length > MAX_ROWS) throw new Error('row_limit');
    return rows;
  });
}

function cachedRows(path) {
  return snapshot(path, db => {
    const available = columns(db, 'local_thread_catalog');
    requireColumns(available, ['host_id', 'thread_id', 'display_title', 'source_kind', 'source_updated_at', 'project_id', 'missing_candidate']);
    const fields = ['host_id', 'thread_id', 'display_title', 'source_updated_at', 'project_id', 'missing_candidate'];
    if (available.has('pending_observed_title')) fields.push('pending_observed_title');
    const rows = db.prepare(`SELECT ${fields.join(',')} FROM local_thread_catalog WHERE source_kind='chatgpt' LIMIT ${MAX_ROWS + 1}`).all();
    if (rows.length > MAX_ROWS) throw new Error('row_limit');
    // The cache can contain multiple account partitions. There is no verified
    // current-account selector in this source, so do not combine their data.
    if (new Set(rows.map(row => row.host_id)).size > 1) throw new Error('multiple_accounts');
    return rows;
  });
}

function errorFor(source, error) {
  const known = new Set(['unsupported_schema', 'row_limit', 'multiple_accounts']);
  return { source, code: known.has(error?.message) ? error.message : error?.code === 'ENOENT' ? 'unavailable' : 'read_failed' };
}

function localTitle(row) {
  const title = clean(row.name);
  if (title && title.length <= 1000) return title;
  const fallback = clean(row.title)?.replace(/\s+/g, ' ');
  if (!fallback || fallback.startsWith('<') || fallback.startsWith('{')) return undefined;
  // The app uses a cleaned preview, shortened to 60 characters, when unnamed.
  return fallback.length <= 60 ? fallback : `${fallback.slice(0, 59).trimEnd()}…`;
}

/**
 * Read current local metadata only. This function never changes source files or
 * declares an absent record missing. Callers must merge current sidebar/project
 * and explicit archive listings separately, with their stronger evidence.
 */
export async function collectRecentSources({ projects = [], now = new Date(), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  const observedAt = iso(now instanceof Date ? now.getTime() : now);
  if (!observedAt || !isAbsolute(codexHome) || !Array.isArray(projects)) throw new Error('Invalid recent-source options.');
  const observations = [];
  const exceptions = [];
  const exception = (source, sourceId, title, reason, detail) => {
    if (!clean(sourceId)) return;
    exceptions.push({ id: `${source}:chat:${sourceId}`, title: clean(title)?.slice(0, 1000) ?? null, reason, detail });
  };
  const errors = [];
  const counts = { localActive: 0, localArchived: 0, localFiltered: 0, localUntitled: 0, localMembershipUnknown: 0,
    localProjectAliases: 0, chatgptRecent: 0, chatgptMissingCandidatesSkipped: 0, chatgptStaleSkipped: 0, chatgptInvalidSkipped: 0, chatgptPendingTitlesSkipped: 0 };
  const cutoff = Date.parse(observedAt) - 30 * DAY;
  const coverage = { localIndex: 'unavailable', localMembership: 'unavailable', localProjectAliases: 'unavailable', chatgptCache: 'unavailable', chatgptWindowDays: 30,
    chatgptFreshness: 'source_updated_at is a conservative timestamp; cache has no per-row retrieval time',
    absenceIsDeletion: false, cloudWorkComplete: false };
  let state, projectAliases = [];
  try {
    state = JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('unsupported_schema');
    coverage.localMembership = 'explicit assignments, explicit projectless state, and exact unambiguous current roots';
    projectAliases = resolveProjectAliases(state, projects);
    counts.localProjectAliases = projectAliases.length;
    coverage.localProjectAliases = 'explicit local chatGptBacking metadata with a current accessible ChatGPT target; absence does not unlink';
  } catch (error) { errors.push(errorFor('local_membership', error)); }
  try {
    const rows = localRows(join(codexHome, 'state_5.sqlite'));
    for (const row of rows) {
      if (!INTERACTIVE.has(row.source) || row.parent_thread_id || row.ephemeral
        || (row.agent_path && row.agent_path !== '/root')
        || /sub.?agent/i.test(row.thread_source || '') || row.history_mode === 'ephemeral') { counts.localFiltered++; continue; }
      const title = localTitle(row);
      if (!clean(row.id) || !title) {
        counts.localUntitled++;
        exception('codex', row.id, null, 'untitled', 'The local index has no usable display title; saved metadata is retained.');
        continue;
      }
      const projectId = resolveLocalProject(row, state, projects);
      const updatedAt = iso(row.updated_at_ms ?? row.updated_at);
      const observation = { id: `codex:chat:${row.id}`, source: 'codex', kind: 'chat', sourceId: row.id, title,
        hostId: 'local', url: `codex://threads/${row.id}`, observedAt, evidence: 'local_index', outcome: row.archived === 1 ? 'archived' : 'found' };
      if (projectId !== undefined) observation.projectId = projectId;
      else {
        counts.localMembershipUnknown++;
        exception('codex', row.id, title, 'project_membership_unverified', row.archived === 1
          ? 'This archived local chat has no verified current project assignment; saved membership is retained.'
          : 'This local chat has no verified current project assignment; saved membership is retained.');
      }
      if (updatedAt) observation.updatedAt = updatedAt;
      observations.push(observation);
      counts[row.archived === 1 ? 'localArchived' : 'localActive']++;
    }
    coverage.localIndex = 'all indexed interactive top-level local chats, including explicit archived flags';
  } catch (error) { errors.push(errorFor('local_index', error)); }
  try {
    const rows = cachedRows(join(codexHome, 'sqlite', 'codex-dev.db'));
    for (const row of rows) {
      if (row.missing_candidate !== 0) {
        counts.chatgptMissingCandidatesSkipped++;
        exception('chatgpt', row.thread_id, row.display_title, 'possibly_missing', 'The local cache marks this chat as possibly missing; deletion is unconfirmed and saved metadata is retained.');
        continue;
      }
      if (row.pending_observed_title) {
        counts.chatgptPendingTitlesSkipped++;
        exception('chatgpt', row.thread_id, row.display_title, 'title_pending', 'The cache has a pending title change; saved metadata is retained until the title is stable.');
        continue;
      }
      const title = clean(row.display_title);
      const updatedAt = iso(row.source_updated_at);
      if (!clean(row.thread_id) || !title || title.length > 1000 || !updatedAt || Date.parse(updatedAt) > Date.parse(observedAt) + 5 * 60000) {
        counts.chatgptInvalidSkipped++;
        exception('chatgpt', row.thread_id, row.display_title, 'invalid_metadata', 'The cache has an unusable title or activity date; saved metadata is retained.');
        continue;
      }
      if (Date.parse(updatedAt) < cutoff) { counts.chatgptStaleSkipped++; continue; }
      const observation = { id: `chatgpt:chat:${row.thread_id}`, source: 'chatgpt', kind: 'chat', sourceId: row.thread_id, title,
        url: `https://chatgpt.com/c/${row.thread_id}`, updatedAt, observedAt: updatedAt, evidence: 'chatgpt_cache', outcome: 'found' };
      // NULL here is an explicit cached membership value, with its conservative
      // source timestamp, rather than the absence of a project field.
      if (own(row, 'project_id')) observation.projectId = row.project_id == null ? null : row.project_id;
      observations.push(observation);
      counts.chatgptRecent++;
    }
    coverage.chatgptCache = 'recent cached candidates; excludes missing candidates; not a complete account or archive inventory';
  } catch (error) { errors.push(errorFor('chatgpt_cache', error)); }
  return { observations, projectAliases, coverage, errors, counts, exceptions };
}
