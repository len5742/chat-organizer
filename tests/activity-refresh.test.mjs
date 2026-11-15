import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLocalChat, mapLocalActivity, readLocalActivity, resolveCodexExecutable } from '../activity-refresh.mjs';

const chat = (sourceId, extra = {}) => ({ id: `codex:chat:${sourceId}`, sourceId, source: 'codex', kind: 'chat', ...extra });
const timestamp = Date.parse('2026-10-17T13:00:00.000Z') / 1000;

function fakeProcess(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = 0;
  child.requests = [];
  child.kill = () => { child.kills += 1; child.emit('exit', 0); return true; };
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString());
    child.requests.push(message);
    queueMicrotask(() => handle(message, response => {
      if (!child.stdout.destroyed) child.stdout.write(JSON.stringify({ id: message.id, ...response }) + '\n');
    }, child));
    callback();
  } });
  return child;
}

test('only correctly identified saved local chats are eligible', () => {
  assert.equal(isLocalChat(chat('a')), true);
  assert.equal(isLocalChat(chat('a', { hostId: null })), true);
  assert.equal(isLocalChat(chat('a', { hostId: 'local' })), true);
  for (const extra of [{ hostId: 'remote' }, { hostId: '' }, { source: 'chatgpt' }, { kind: 'project' }, { id: 'mismatch' }]) {
    assert.equal(isLocalChat(chat('a', extra)), false);
  }
  assert.equal(isLocalChat(null), false);
});

test('metadata mapping preserves source identity and only returns a valid title and updated date', () => {
  assert.deepEqual(mapLocalActivity(chat('a'), {
    id: 'a', name: ' Refreshed title ', updatedAt: timestamp,
    recencyAt: timestamp + 999, projectId: null, preview: 'Must not become the title.',
  }), { id: 'codex:chat:a', title: 'Refreshed title', updatedAt: '2026-10-17T13:00:00.000Z' });
  assert.deepEqual(mapLocalActivity(chat('a'), { id: 'a', name: '', updatedAt: 'bad' }), { id: 'codex:chat:a' });
  assert.deepEqual(mapLocalActivity(chat('a'), { id: 'a', name: 'a'.repeat(1001), updatedAt: Infinity }), { id: 'codex:chat:a' });
  assert.deepEqual(mapLocalActivity(chat('a'), { id: 'a', updatedAt: -1 }), { id: 'codex:chat:a' });
  assert.equal(mapLocalActivity(chat('a'), { id: 'wrong', updatedAt: timestamp }), null);
});

test('installation discovery follows app updates and ignores unrelated folders', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'organizer-activity-test-'));
  try {
    const root = join(folder, 'OpenAI', 'Codex', 'bin');
    const old = join(root, '1111111111111111', 'codex.exe');
    const latest = join(root, '2222222222222222', 'codex.exe');
    const unrelated = join(root, 'unrelated-folder', 'codex.exe');
    for (const path of [old, latest, unrelated]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'test placeholder, never executed');
    }
    await utimes(old, 1000, 1000);
    await utimes(latest, 2000, 2000);
    await utimes(unrelated, 3000, 3000);
    assert.equal(await resolveCodexExecutable({ localAppData: folder, override: '' }), latest);
    assert.equal(await resolveCodexExecutable({ executablePath: old, localAppData: folder }), old);
    await assert.rejects(resolveCodexExecutable({ executablePath: 'relative.exe' }));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('refresh uses metadata-only reads, limits concurrency, and closes the child after mixed results', async () => {
  let active = 0;
  let maximumActive = 0;
  const child = fakeProcess((message, reply) => {
    if (message.method === 'initialize') return reply({ result: {} });
    if (message.method !== 'thread/read') return;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    setTimeout(() => {
      active -= 1;
      if (message.params.threadId === 'c') reply({ error: { code: -32600, message: 'Unavailable' } });
      else reply({ result: { thread: { id: message.params.threadId, name: `Name ${message.params.threadId}`, updatedAt: timestamp, projectId: null } } });
    }, 5);
  });
  let launch;
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => chat(id));
  items.push(chat('a'), chat('remote', { hostId: 'remote' }), chat('web', { source: 'chatgpt' }));
  const result = await readLocalActivity(items, {
    resolveExecutable: async () => 'known-executable',
    spawnProcess: (...args) => { launch = args; return child; },
  });
  assert.deepEqual({ attempted: result.attempted, checked: result.checked, unavailable: result.unavailable }, { attempted: 6, checked: 5, unavailable: 1 });
  assert.deepEqual(result.records.map(row => row.id), ['a', 'b', 'd', 'e', 'f'].map(id => `codex:chat:${id}`));
  assert.equal(maximumActive, 4);
  assert.deepEqual(launch[1], ['app-server', '--listen', 'stdio://']);
  assert.equal(launch[2].windowsHide, true);
  assert.deepEqual(child.requests.map(request => request.method), ['initialize', 'initialized', ...Array(6).fill('thread/read')]);
  assert.ok(child.requests.filter(request => request.method === 'thread/read').every(request => request.params.includeTurns === false));
  assert.ok(result.records.every(record => !('projectId' in record)));
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('unavailable executable and empty eligibility leave metadata untouched', async () => {
  const unavailable = await readLocalActivity([chat('a')], { resolveExecutable: async () => { throw new Error('Missing executable'); } });
  assert.deepEqual(unavailable, { records: [], attempted: 1, checked: 0, unavailable: 1 });
  assert.deepEqual(await readLocalActivity([chat('a', { source: 'chatgpt' })], {
    resolveExecutable: () => { throw new Error('Should not be called'); },
  }), { records: [], attempted: 0, checked: 0, unavailable: 0 });
});

test('spawn errors are handled and child streams are cleaned up', async () => {
  const child = fakeProcess((message, reply, processHandle) => processHandle.emit('error', new Error('Spawn failed')));
  const result = await readLocalActivity([chat('a')], { resolveExecutable: async () => 'missing', spawnProcess: () => child });
  assert.deepEqual(result, { records: [], attempted: 1, checked: 0, unavailable: 1 });
  assert.equal(child.kills, 1);
  assert.equal(child.stdout.destroyed, true);
});

test('overall deadline covers a stalled resolver or process and releases pending work', async () => {
  let spawned = false;
  const resolution = await readLocalActivity([chat('a')], {
    timeoutMs: 20,
    resolveExecutable: () => new Promise(() => {}),
    spawnProcess: () => { spawned = true; },
  });
  assert.equal(resolution.unavailable, 1);
  assert.equal(spawned, false);
  const child = fakeProcess(() => {});
  const start = Date.now();
  const result = await readLocalActivity([chat('a')], {
    timeoutMs: 20, resolveExecutable: async () => 'known', spawnProcess: () => child,
  });
  assert.equal(result.unavailable, 1);
  assert.ok(Date.now() - start < 1000);
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.stdout.destroyed, true);
});
