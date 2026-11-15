import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

const now = '2026-10-19T04:00:00Z';
const found = (id, title) => ({ id, source: 'chatgpt', sourceId: id.split(':').at(-1), kind: 'chat', title,
  outcome: 'found', evidence: 'sidebar', observedAt: now });
async function fixture(action, collector = async () => ({ observations: [], errors: [], counts: {}, coverage: {} })) {
  const dir = mkdtempSync(join(tmpdir(), 'organizer-gateway-'));
  const store = new CatalogStore(join(dir, 'catalog.sqlite'));
  const server = createOrganizerServer(store, 'stdio', { recentCollector: collector });
  const client = new Client({ name: 'maintenance-gateway-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const raw = request => client.callTool({ name: 'maintain_catalog', arguments: { request } });
    const run = async (op, args = {}, leaseToken) => {
      const result = await raw({ op, args, ...(leaseToken ? { leaseToken } : {}) });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(Object.keys(result.structuredContent), ['value']);
      return result.structuredContent.value;
    };
    await action({ client, store, raw, run });
  } finally { await client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('maintenance gateway advertises a bounded strict service operation and model-only visibility', async () => fixture(async ({ client }) => {
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === 'maintain_catalog');
  assert.ok(tool); assert.deepEqual(tool._meta.ui.visibility, ['model']);
  assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ['request']); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.outputSchema.additionalProperties, false); assert.deepEqual(tool.outputSchema.required, ['value']);
  const variants = tool.inputSchema.properties.request.anyOf || tool.inputSchema.properties.request.oneOf;
  assert.equal(variants.length, 15);
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false); assert.equal(variant.properties.args.additionalProperties, false);
    assert.deepEqual([...variant.required].sort(), ['args', 'op']);
  }
}));

test('maintenance gateway requires the current lease for every protected operation', async () => fixture(async ({ store, raw, run }) => {
  const initial = store.snapshot();
  const protectedRequests = [
    { op: 'apply', args: { observations: [], expectedRevision: initial.revision } },
    { op: 'begin', args: { day: '2026-10-19' } },
    { op: 'auditApply', args: { auditId: 'no-audit', observations: [], expectedRevision: initial.revision } },
    { op: 'recordRun', args: { report: { mode: 'recent', complete: true, errors: [] } } },
    {op:'deferVerification',args:{}},
    {op:'setHidden',args:{id:'chatgpt:chat:a',hidden:true,expectedRevision:initial.revision}},
    {op:'queueDeletionReview',args:{id:'chatgpt:chat:a',expectedRevision:initial.revision}},
    { op: 'defer', args: { auditId: 'no-audit', retryAfter: now, reason: 'test' } },
  ];
  for (const request of protectedRequests) {
    const result = await raw(request);
    assert.equal(result.isError, true); assert.equal(result._meta.error.code, 'LEASE_LOST');
    assert.equal(result.structuredContent, undefined);
  }
  const lease = await run('acquire');
  for (const request of protectedRequests) {
    const result = await raw({ ...request, leaseToken: 'wrong-token' });
    assert.equal(result.isError, true); assert.equal(result._meta.error.code, 'LEASE_LOST');
  }
  assert.deepEqual(store.snapshot(), initial);
  assert.equal((await run('acquire')).acquired, false);
  assert.equal((await run('release', { token: 'wrong-token' })).released, false);
  assert.equal((await run('acquire')).acquired, false);
  const wrongRenew = await raw({ op: 'renew', args: { token: 'wrong-token' } });
  assert.equal(wrongRenew._meta.error.code, 'LEASE_LOST');
  assert.equal((await run('renew', { token: lease.token })).token, lease.token);
  assert.equal((await run('release', { token: lease.token })).released, true);
  assert.equal((await run('acquire')).acquired, true);
}));

test('maintenance gateway preserves revision protection and emits structured catalog errors', async () => fixture(async ({ store, raw, run }) => {
  store.importInventory({ items: [{ id: 'chatgpt:chat:a', source: 'chatgpt', sourceId: 'a', title: 'Before', kind: 'chat' }], coverage: 'test' });
  const before = store.snapshot();
  const lease = await run('acquire');
  const stale = await raw({ op: 'apply', args: { observations: [found('chatgpt:chat:a', 'After')], expectedRevision: before.revision - 1 }, leaseToken: lease.token });
  assert.equal(stale.isError, true); assert.equal(stale._meta.error.code, 'STALE_REVISION');
  assert.equal(stale.structuredContent, undefined); assert.match(stale.content[0].text, /changed|Refresh/i);
  assert.deepEqual(store.snapshot(), before);
  const invalidAudit = await raw({ op: 'batch', args: { auditId: 'not-current' } });
  assert.equal(invalidAudit._meta.error.code, 'INVALID_AUDIT');
}));

test('maintenance gateway rejects filesystem, code, tool, collector overrides and oversized inputs', async () => fixture(async ({ client, raw, store }) => {
  const before = store.snapshot();
  const invalid = [
    { op: 'exec', args: { code: 'anything' } },
    { op: 'state', args: {}, path: 'D:/elsewhere/catalog.sqlite' },
    { op: 'state', args: { path: 'D:/elsewhere/catalog.sqlite' } },
    { op: 'collect', args: { projects: [], codexHome: 'D:/elsewhere' } },
    { op: 'collect', args: { projects: [], now: now } },
    { op: 'collect', args: { projects: [], tool: 'read_thread' } },
    { op: 'collect', args: { projects: [{ projectId: 'p', projectKind: 'local', code: 'bad' }] } },
    { op: 'collect', args: { projects: [{ projectId: 'p', projectKind: 'local', rootPathAliases: [{ alias: 'D:/valid', file: 'bad' }] }] } },
    { op: 'acquire', args: { ttlMs: 1800001 } },
    { op: 'apply', args: { expectedRevision: 0, observations: [found('chatgpt:chat:a', 'x'.repeat(1001))] } },
    { op: 'recordRun', args: { report: { mode: 'recent', recordedAt: now } } },
  ];
  for (const request of invalid) assert.equal((await raw(request)).isError, true, JSON.stringify(request).slice(0,200));
  const extraTop = await client.callTool({ name: 'maintain_catalog', arguments: { request: { op: 'state', args: {} }, file: 'bad' } });
  assert.equal(extraTop.isError, true); assert.deepEqual(store.snapshot(), before);
}));

test('maintenance gateway collects only supplied project metadata using the configured source collector', async () => {
  const calls = [];
  const projects = [{ projectId: 'p', projectKind: 'local', hostId: 'local', path: 'D:/project', rootPaths: ['D:/project'], rootPathAliases: [{ alias: '/mnt/d/project' }] }];
  await fixture(async ({ run }) => {
    const collected = await run('collect', { projects });
    assert.equal(collected.counts.local, 1); assert.deepEqual(calls, [{ projects }]);
  }, async args => { calls.push(args); return { observations: [found('chatgpt:chat:a', 'Collected')], errors: [], counts: { local: 1 }, coverage: { bounded: true } }; });
});

test('maintenance gateway completes a recent update in a temporary database and preserves organization', async () => {
  const observations = [found('chatgpt:chat:a', 'Current title'), found('chatgpt:chat:b', 'New chat')];
  await fixture(async ({ store, run }) => {
    const imported = store.importInventory({ items: [{ id: 'chatgpt:chat:a', source: 'chatgpt', sourceId: 'a', title: 'Old title', kind: 'chat' }], coverage: 'test' });
    const categorized = store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: imported.revision });
    const organized = store.setFocus({ id: 'chatgpt:chat:a', focused: true, expectedRevision: categorized.revision });
    const lease = await run('acquire');
    const collected = await run('collect', { projects: [] }, lease.token);
    const state = await run('state', {}, lease.token);
    const applied = await run('apply', { observations: collected.observations, expectedRevision: state.revision, mode: 'recent', coverage: 'Explicit recent metadata test' }, lease.token);
    assert.equal(applied.added, 1); assert.equal(applied.renamed, 1);
    const report = await run('recordRun', { report: { mode: 'recent', complete: true, errors: [], added: applied.added, renamed: applied.renamed, sources: collected.counts } }, lease.token);
    assert.ok(report.recordedAt); assert.equal((await run('state')).lastRecentRun.recordedAt, report.recordedAt);
    const after = store.snapshot();
    assert.deepEqual(after.categories, organized.categories);
    assert.equal(after.items.find(item => item.id === 'chatgpt:chat:a').category, 'Travel');
    assert.equal(after.items.find(item => item.id === 'chatgpt:chat:a').focused, true);
    assert.equal(after.items.find(item => item.id === 'chatgpt:chat:a').title, 'Current title');
    assert.equal((await run('release', { token: lease.token })).released, true);
  }, async () => ({ observations, errors: [], counts: { local: 2 }, coverage: { bounded: true } }));
});

test('maintenance gateway checkpoints an audit, requeues a failed lookup and completes after retry', async () => fixture(async ({ store, run }) => {
  store.importInventory({ items: [{ id: 'chatgpt:chat:a', source: 'chatgpt', sourceId: 'a', title: 'Saved chat', kind: 'chat' }], coverage: 'test' });
  const lease = await run('acquire');
  const audit = await run('begin', { day: '2026-10-19' }, lease.token);
  assert.equal(audit.total, 1);
  const batch = await run('batch', { auditId: audit.id, limit: 40 }, lease.token);
  assert.equal(batch.items[0].id, 'chatgpt:chat:a');
  const first = await run('auditApply', { auditId: audit.id, observations: [{ id: 'chatgpt:chat:a', observedAt: now, evidence: 'probe', outcome: 'error', error: 'rate limit' }], expectedRevision: (await run('state')).revision }, lease.token);
  assert.equal(first.audit.errors, 1);
  const deferred = await run('defer', { auditId: audit.id, retryAfter: '2026-10-19T05:00:00Z', reason: 'Source cooldown', retryIds: ['chatgpt:chat:a'] }, lease.token);
  assert.equal(deferred.completedAt, null); assert.equal(deferred.processed, 0); assert.equal(deferred.errors, 0);
  assert.equal((await run('batch', { auditId: audit.id })).items.length, 1);
  const retried = await run('auditApply', { auditId: audit.id, observations: [{ id: 'chatgpt:chat:a', observedAt: now, evidence: 'probe', outcome: 'found' }], expectedRevision: (await run('state')).revision }, lease.token);
  assert.ok(retried.audit.completedAt); assert.equal(retried.audit.processed, 1); assert.equal(retried.audit.retryAfter, null);
}));

test('maintenance gateway hides private unexpected errors while preserving MCP error shape', async () => {
  await fixture(async ({ raw }) => {
    const result = await raw({ op: 'collect', args: { projects: [] } });
    assert.equal(result.isError, true); assert.equal(result._meta.error.code, 'INTERNAL_ERROR');
    assert.equal(result.structuredContent, undefined); assert.doesNotMatch(result.content[0].text, /private location/);
  }, async () => { throw new Error('private location details'); });
});
