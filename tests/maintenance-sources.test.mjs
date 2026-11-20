import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectRecentSources, normalizeProjectPath, resolveLocalProject } from '../maintenance-sources.mjs';

const now = new Date('2026-10-18T20:00:00.000Z');
const seconds = now.getTime() / 1000;
const projects = [
  { projectId: 'p1', projectKind: 'local', path: 'D:\\Projects\\One', hostId: 'local' },
  { projectId: 'p2', projectKind: 'local', path: 'D:\\Projects\\Two' },
  { projectId: 'cloud', projectKind: 'chatgpt' },
];

async function fixture(t, { state = {}, local = [], cache = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'organizer-sources-'));
  t.after(async () => {
    const target = resolve(home);
    assert.ok(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'));
    await rm(target, { recursive: true, force: true });
  });
  await mkdir(join(home, 'sqlite'));
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify(state));
  const localDb = new DatabaseSync(join(home, 'state_5.sqlite'));
  localDb.exec(`CREATE TABLE threads (id TEXT, source TEXT, title TEXT, name TEXT, cwd TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, agent_path TEXT,
    thread_source TEXT, history_mode TEXT, parent_thread_id TEXT, ephemeral INTEGER)`);
  const insertLocal = localDb.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of local) insertLocal.run(row.id, row.source ?? 'vscode', row.title ?? 'Initial prompt', row.name ?? 'Current title',
    row.cwd ?? 'D:\\Projects\\One', row.updated_at ?? seconds - 200, row.updated_at_ms ?? null, row.archived ?? 0,
    row.agent_path ?? null, row.thread_source ?? 'user', row.history_mode ?? 'paginated', row.parent_thread_id ?? null, row.ephemeral ?? 0);
  localDb.close();
  const cacheDb = new DatabaseSync(join(home, 'sqlite', 'codex-dev.db'));
  cacheDb.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT,
    source_kind TEXT, source_updated_at REAL, project_id TEXT, missing_candidate INTEGER, pending_observed_title INTEGER)`);
  const insertCache = cacheDb.prepare('INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?)');
  for (const row of cache) insertCache.run(row.host ?? 'account-one', row.id, row.title ?? 'Cached title', row.source_kind ?? 'chatgpt',
    row.updated_at ?? seconds - 100, row.project_id ?? null, row.missing_candidate ?? 0, row.pending_observed_title ?? 0);
  cacheDb.close();
  return home;
}

test('membership follows explicit moves in and out before exact path fallback', () => {
  const row = { id: 'chat', cwd: 'D:\\Projects\\One' };
  assert.equal(resolveLocalProject(row, { 'thread-project-assignments': { chat: { projectId: 'p2' } } }, projects), 'p2');
  assert.equal(resolveLocalProject(row, { 'projectless-thread-ids': ['chat'] }, projects), null);
  assert.equal(resolveLocalProject(row, { 'thread-project-assignments': { chat: { projectId: 'cloud', projectOrigin: 'chatgpt' } } }, projects), 'cloud');
  assert.equal(resolveLocalProject(row, {}, projects), 'p1');
  assert.equal(resolveLocalProject({ ...row, cwd: 'D:\\Projects\\One\\subfolder' }, {}, projects), undefined);
  assert.equal(resolveLocalProject(row, { 'thread-project-assignments': { chat: { projectId: 'removed' } } }, projects), undefined);
  assert.equal(resolveLocalProject(row, { 'thread-project-assignments': { chat: { projectId: 'p2', hostId: 'remote' } } }, projects), undefined);
  assert.equal(resolveLocalProject(row, undefined, projects), undefined);
  assert.equal(resolveLocalProject(row, {}, [...projects, { projectId: 'duplicate', projectKind: 'local', path: row.cwd }]), undefined);
});

test('path matching recognizes exact alternate spellings and never empty paths', () => {
  assert.equal(normalizeProjectPath('\\\\?\\D:\\Projects\\One\\'), '/mnt/d/projects/one');
  assert.equal(normalizeProjectPath('D:/Projects/One'), normalizeProjectPath('/mnt/d/Projects/One'));
  assert.equal(normalizeProjectPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me');
  assert.equal(normalizeProjectPath(undefined), undefined);
  assert.equal(resolveLocalProject({ id: 'x' }, {}, [{ projectId: 'missing-path', projectKind: 'local' }]), undefined);
});

test('local snapshot includes explicit archives and excludes agent and ephemeral rows', async t => {
  const home = await fixture(t, {
    state: { 'projectless-thread-ids': ['out'], 'thread-project-assignments': { moved: { projectId: 'p2' } } },
    local: [{ id: 'moved' }, { id: 'out' }, { id: 'archived', archived: 1 },
      { id: 'agent', source: '{"subagent":{"other":"guardian"}}' }, { id: 'nested', agent_path: '/root/child' },
      { id: 'child', parent_thread_id: 'moved' }, { id: 'ephemeral', ephemeral: 1 }, { id: 'hidden', history_mode: 'ephemeral' }],
  });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.equal(result.errors.length, 0);
  assert.equal(result.counts.localActive, 2);
  assert.equal(result.counts.localArchived, 1);
  assert.equal(result.counts.localFiltered, 4);
  assert.deepEqual(result.observations.map(row => row.sourceId).sort(), ['archived', 'moved', 'out']);
  assert.equal(result.observations.find(row => row.sourceId === 'out').projectId, null);
  assert.equal(result.observations.find(row => row.sourceId === 'moved').projectId, 'p2');
  assert.equal(result.observations.find(row => row.sourceId === 'archived').outcome, 'archived');
  assert.ok(result.observations.every(row => row.observedAt === now.toISOString()));
});

test('cache uses source freshness and never turns missing, expired, or invalid candidates into deletion evidence', async t => {
  const home = await fixture(t, { cache: [
    { id: 'in', project_id: 'cloud' }, { id: 'out' }, { id: 'missing', missing_candidate: 1 },
    { id: 'expired', updated_at: seconds - 31 * 86400 }, { id: 'pending', pending_observed_title: 1 },
    { id: 'future', updated_at: seconds + 3600 }, { id: 'local-cache', source_kind: 'codex' },
  ] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.observations.map(row => row.sourceId).sort(), ['in', 'out']);
  assert.equal(result.observations.find(row => row.sourceId === 'out').projectId, null);
  assert.equal(result.observations.find(row => row.sourceId === 'in').projectId, 'cloud');
  assert.ok(result.observations.every(row => row.observedAt === new Date((seconds - 100) * 1000).toISOString()));
  assert.ok(result.observations.every(row => row.observedAt < now.toISOString() && row.outcome === 'found'));
  assert.equal(result.counts.chatgptMissingCandidatesSkipped, 1);
  assert.equal(result.counts.chatgptStaleSkipped, 1);
  assert.equal(result.counts.chatgptPendingTitlesSkipped, 1);
  assert.equal(result.counts.chatgptInvalidSkipped, 1);
});

test('source failures preserve usable independent observations and do not invent absence', async t => {
  const home = await fixture(t, { local: [{ id: 'local' }], cache: [{ id: 'cached' }] });
  await writeFile(join(home, '.codex-global-state.json'), '{bad json');
  await writeFile(join(home, 'sqlite', 'codex-dev.db'), 'broken database');
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.errors.map(row => row.source).sort(), ['chatgpt_cache', 'local_membership']);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].sourceId, 'local');
  assert.equal(Object.hasOwn(result.observations[0], 'projectId'), false);
  assert.equal(result.observations[0].outcome, 'found');
  assert.equal(result.coverage.absenceIsDeletion, false);
});

test('read-only collection leaves database bytes unchanged and does not create missing databases', async t => {
  const home = await fixture(t, { local: [{ id: 'local' }], cache: [{ id: 'cached' }] });
  const paths = [join(home, 'state_5.sqlite'), join(home, 'sqlite', 'codex-dev.db'), join(home, '.codex-global-state.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  await collectRecentSources({ projects, now, codexHome: home });
  const after = await Promise.all(paths.map(path => readFile(path)));
  assert.deepEqual(after, before);
  const missingHome = join(home, 'missing');
  const missing = await collectRecentSources({ projects, now, codexHome: missingHome });
  assert.equal(missing.observations.length, 0);
  assert.equal(missing.errors.length, 3);
  await assert.rejects(access(missingHome));
});

test('multiple cached account partitions are reported as a source error', async t => {
  const home = await fixture(t, { cache: [{ id: 'one' }, { id: 'two', host: 'account-two' }] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.equal(result.observations.length, 0);
  assert.deepEqual(result.errors, [{ source: 'chatgpt_cache', code: 'multiple_accounts' }]);
});

test('the current app cache takes precedence over the older development cache', async t => {
  const home = await fixture(t, { cache: [{ id: 'current', title: 'Current app title' }] });
  await copyFile(join(home, 'sqlite', 'codex-dev.db'), join(home, 'sqlite', 'codex.db'));
  const old = new DatabaseSync(join(home, 'sqlite', 'codex-dev.db'));
  old.prepare('UPDATE local_thread_catalog SET display_title=?').run('Stale development title');
  old.close();
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.chatgptCacheFile, 'codex.db');
  assert.equal(result.observations[0].title, 'Current app title');
});

test('an unreadable current cache is reported instead of silently using stale development data', async t => {
  const home = await fixture(t, { cache: [{ id: 'stale' }] });
  await writeFile(join(home, 'sqlite', 'codex.db'), 'invalid current database');
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.equal(result.observations.length, 0);
  assert.deepEqual(result.errors.map(error => error.source), ['chatgpt_cache']);
});

test('collector names skipped cache exceptions without changing accepted observations or scope', async t => {
  const home = await fixture(t, { cache: [
    { id: 'accepted', title: 'Current cache title' },
    { id: 'missing', title: 'Possibly missing chat', missing_candidate: 1, pending_observed_title: 1 },
    { id: 'pending', title: 'Current title', pending_observed_title: 1 },
    { id: 'future', title: 'Future date', updated_at: seconds + 3600 },
    { id: 'blank', title: ' ' },
    { id: 'long', title: 'x'.repeat(1001) },
    { id: 'expired', title: 'Old cache', updated_at: seconds - 31 * 86400 },
    { id: '', title: 'No stable identity', updated_at: seconds + 3600 },
    { id: 'other-source', source_kind: 'codex' },
  ] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.observations.map(row => row.sourceId), ['accepted']);
  assert.equal(result.counts.chatgptRecent, 1);
  assert.equal(result.counts.chatgptMissingCandidatesSkipped, 1);
  assert.equal(result.counts.chatgptPendingTitlesSkipped, 1);
  assert.equal(result.counts.chatgptInvalidSkipped, 4);
  assert.equal(result.counts.chatgptStaleSkipped, 1);
  assert.deepEqual(result.exceptions.map(({ id, reason }) => ({ id, reason })), [
    { id: 'chatgpt:chat:missing', reason: 'possibly_missing' },
    { id: 'chatgpt:chat:pending', reason: 'title_pending' },
    { id: 'chatgpt:chat:future', reason: 'invalid_metadata' },
    { id: 'chatgpt:chat:blank', reason: 'invalid_metadata' },
    { id: 'chatgpt:chat:long', reason: 'invalid_metadata' },
  ]);
  assert.equal(result.exceptions[0].title, 'Possibly missing chat');
  assert.equal(result.exceptions.find(row => row.id.endsWith(':blank')).title, null);
  assert.equal(result.exceptions.find(row => row.id.endsWith(':long')).title.length, 1000);
  assert.ok(result.exceptions.every(row => row.detail.length <= 500 && Object.keys(row).sort().join(',') === 'detail,id,reason,title'));
  assert.equal(result.coverage.absenceIsDeletion, false);
  assert.deepEqual(result.errors, []);
});

test('collector names active and archived unknown membership and stable untitled rows', async t => {
  const home = await fixture(t, { local: [
    { id: 'active', cwd: 'D:\\Unknown', name: 'Active unassigned' },
    { id: 'archived', cwd: 'D:\\Unknown', name: 'Archived unassigned', archived: 1 },
    { id: 'untitled', name: ' ', title: '<environment_context>' },
    { id: '', name: ' ', title: '<environment_context>' },
    { id: 'filtered', parent_thread_id: 'active', cwd: 'D:\\Unknown' },
  ] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.equal(result.counts.localMembershipUnknown, 2);
  assert.equal(result.counts.localUntitled, 2);
  assert.equal(result.counts.localFiltered, 1);
  assert.deepEqual(result.observations.map(row => [row.sourceId, row.outcome, Object.hasOwn(row, 'projectId')]), [
    ['active', 'found', false], ['archived', 'archived', false],
  ]);
  assert.deepEqual(result.exceptions.map(({ id, title, reason }) => ({ id, title, reason })), [
    { id: 'codex:chat:active', title: 'Active unassigned', reason: 'project_membership_unverified' },
    { id: 'codex:chat:archived', title: 'Archived unassigned', reason: 'project_membership_unverified' },
    { id: 'codex:chat:untitled', title: null, reason: 'untitled' },
  ]);
  assert.match(result.exceptions[1].detail, /archived local chat/);
  assert.deepEqual(result.errors, []);
});

test('collector exposes an empty exception list for clean metadata', async t => {
  const home = await fixture(t, { local: [{ id: 'local' }], cache: [{ id: 'cache' }] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.observations.length, 2);
});

test('unusable cache dates become named exceptions without losing later valid rows', async t => {
  const home = await fixture(t, { cache: [
    { id: 'outside-timeclip', updated_at: 1e20, title: 'Unusable large date' },
    { id: 'expanded-year', updated_at: 253402300800000, title: 'Expanded year date' },
    { id: 'valid-after-invalid', title: 'Valid later cache record' },
  ] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.chatgptInvalidSkipped, 2);
  assert.equal(result.counts.chatgptRecent, 1);
  assert.deepEqual(result.observations.map(row => row.sourceId), ['valid-after-invalid']);
  assert.deepEqual(result.exceptions.map(({id, reason, title}) => ({id, reason, title})), [
    { id: 'chatgpt:chat:outside-timeclip', reason: 'invalid_metadata', title: 'Unusable large date' },
    { id: 'chatgpt:chat:expanded-year', reason: 'invalid_metadata', title: 'Expanded year date' },
  ]);
});

test('invalid optional local dates are omitted while observations and later records survive', async t => {
  const home = await fixture(t, { local: [
    { id: 'outside-timeclip', updated_at_ms: 1e20 },
    { id: 'expanded-year', updated_at_ms: 253402300800000 },
    { id: 'valid-after-invalid', updated_at_ms: now.getTime() - 1000 },
  ] });
  const result = await collectRecentSources({ projects, now, codexHome: home });
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.localActive, 3);
  assert.equal(result.observations.length, 3);
  assert.equal(Object.hasOwn(result.observations[0], 'updatedAt'), false);
  assert.equal(Object.hasOwn(result.observations[1], 'updatedAt'), false);
  assert.equal(result.observations[2].updatedAt, new Date(now.getTime() - 1000).toISOString());
  assert.deepEqual(result.exceptions, []);
});
