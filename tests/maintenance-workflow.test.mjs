import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowSource = await readFile(new URL('../maintenance-workflow.js', import.meta.url), 'utf8');
const executeMaintenance = (0, eval)(workflowSource);
// Tests exercise requested pacing without actually sleeping for two seconds.
const runMaintenance = (tools, options = {}) => executeMaintenance(tools, {
  wait: async milliseconds => { assert.equal(milliseconds, 2000); }, ...options,
});
const copy = value => JSON.parse(JSON.stringify(value));
const textResponse = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const structuredResponse = value => ({ content: [], structuredContent: value });
const chat = (sourceId, fields = {}) => ({ id: `chatgpt:chat:${sourceId}`, source: 'chatgpt', sourceId, kind: 'chat', title: sourceId, ...fields });

function harness(config = {}) {
  const operations = [], observations = [], reads = [], calls = [], reports = [];
  const catalog = new Map((config.items ?? []).map(item => [item.id, copy(item)]));
  let revision = 4, audit = null, pending = [], processed = new Set(), outcomes = new Map(), lease = null, stale = config.staleFailures ?? 0;
  const response = value => structuredResponse({ value: copy(value) });
  const failures = (code, message) => ({ isError: true, content: [{ type: 'text', text: message }], _meta: { error: { code, message } } });
  const summarize = rows => {
    for (const row of rows) if (row.outcome === 'found' && row.source && row.sourceId) catalog.set(row.id, { ...catalog.get(row.id), ...row });
    observations.push(...copy(rows));
    return { added: 0, renamed: 0, moved: 0, statusChanged: 0, checked: rows.length, revision: ++revision };
  };
  const tools = {
    async mcp__chat_organizer__maintain_catalog({ request: payload }) {
      const { op, args = {} } = payload;
      operations.push({ op, args: copy(args), leaseToken: payload.leaseToken });
      config.onOperation?.(op, args);
      if (op === 'acquire') {
        if (config.busy) return response({ acquired: false, expiresAt: Date.now() + 60000 });
        lease = 'test-lease';
        return response({ acquired: true, token: lease, expiresAt: Date.now() + 60000 });
      }
      if (op === 'renew') {
        assert.equal(args.token, lease);
        return response({ renewed: true, token: lease, expiresAt: Date.now() + 60000 });
      }
      if (op === 'release') { assert.equal(args.token, lease); lease = null; return response({ released: true }); }
      if (op === 'recordRun') {
        assert.equal(payload.leaseToken, lease, 'run reports require the current maintenance lease');
        assert.ok(lease, 'run reports are recorded before releasing the lease');
        reports.push(copy(args.report));
        return response({ recorded: true });
      }
      if (op === 'collect') {
        if (config.collectError) return failures('COLLECT_ERROR', config.collectError);
        return response(config.collected ?? { observations: [], errors: [], coverage: {}, counts: {} });
      }
      if (op === 'verificationBatch') return response({items:[],pending:0,retryAfter:null});
      if (op === 'state') return response({ revision, audit, counts: {}, lastSync: null });
      if (op === 'apply' || op === 'auditApply') {
        assert.equal(payload.leaseToken, lease, 'writes require the current maintenance lease');
        if (stale-- > 0) { revision++; return failures('STALE_REVISION', 'The user changed the catalog.'); }
        assert.equal(args.expectedRevision, revision);
        if (op === 'apply') return response(summarize(args.observations));
        assert.equal(args.auditId, audit.id);
        for (const item of args.observations) {
          assert.ok(pending.some(p => p.id === item.id), 'audit applies only saved pending IDs');
          assert.equal(processed.has(item.id), false, 'audit checkpoint prevents duplicate probes');
          processed.add(item.id);
          outcomes.set(item.id, item.outcome);
          if (item.outcome === 'error') audit.errors++;
        }
        audit.processed = processed.size;
        if (audit.processed === audit.total) audit.completedAt = new Date().toISOString();
        return response({ sync: summarize(args.observations), audit });
      }
      if (op === 'begin') {
        if (!audit || (audit.completedAt && audit.day !== args.day)) {
          pending = [...catalog.values()].map(copy);
          processed = new Set();
          outcomes = new Map();
          audit = { id: 'audit-one', day: args.day, total: pending.length, processed: 0, errors: 0,
            completedAt: pending.length ? null : new Date().toISOString() };
        }
        return response(audit);
      }
      if (op === 'batch') {
        assert.equal(args.auditId, audit.id);
        return response({ audit, items: pending.filter(item => !processed.has(item.id)).slice(0, args.limit) });
      }
      if (op === 'defer') {
        assert.equal(args.auditId, audit.id);
        assert.equal(payload.leaseToken, lease, 'deferral requires the current maintenance lease');
        for (const id of args.retryIds ?? []) {
          assert.equal(outcomes.get(id), 'error', 'deferral retries only failed probes');
          processed.delete(id);
          outcomes.delete(id);
        }
        audit.processed = processed.size;
        audit.errors = [...outcomes.values()].filter(outcome => outcome === 'error').length;
        audit.completedAt = null;
        audit.retryAfter = args.retryAfter;
        audit.deferredReason = args.reason;
        return response(audit);
      }
      throw new Error('Unexpected local operation: ' + op);
    },
    async mcp__codex_app__list_projects(args) { calls.push(['projects', args]); return config.projectResponse ?? textResponse({ schemaVersion: 2, projects: config.projects ?? [] }); },
    async mcp__codex_app__list_threads(args) { calls.push(['sidebar', args]); return config.sidebarResponse ?? structuredResponse({ threads: config.sidebar ?? [], pinnedThreads: config.pinned ?? [] }); },
    async mcp__codex_app__list_archived_threads(args) {
      calls.push(['archives', copy(args)]);
      if (config.archiveFailure === args.source) return { isError: true, content: [{ type: 'text', text: 'Archive service temporarily unavailable' }] };
      if (config.archiveHandler) return config.archiveHandler(args);
      return textResponse({ threads: config.archives?.[args.source] ?? [], nextCursor: null });
    },
    async mcp__codex_app__read_thread(args) {
      reads.push(copy(args));
      return config.probe ? config.probe(args) : textResponse({ thread: { id: args.threadId, title: 'Renamed ' + args.threadId, updatedAt: 1792336237 }, turns: [], nextCursor: null });
    },
  };
  return { tools, operations, observations, reads, calls, reports, get audit() { return audit; }, get lease() { return lease; } };
}

test('recent sync accepts real text and structured app shapes and preserves explicit project removal', async () => {
  const cached = { ...chat('out'), title: 'Cache title', projectId: 'old-project', observedAt: '2026-10-17T20:00:00Z', evidence: 'chatgpt_cache', outcome: 'found' };
  const h = harness({ items: [chat('unlisted')], projects: [{ projectId: 'p1', projectKind: 'chatgpt', label: "User's project" }],
    collected: { observations: [cached], errors: [], coverage: {}, counts: { chatgptRecent: 1 } },
    sidebar: [{ id: 'out', kind: 'chatgpt', title: "User's new title", projectId: null, updatedAt: 1792336237 },
      { id: 'unknown-membership', kind: 'chatgpt', title: 'Title without membership' }],
    archives: { chatgpt: [{ id: 'archived', title: 'Archived conversation' }] } });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(result.complete, true);
  const newest = h.observations.filter(row => row.id === 'chatgpt:chat:out').at(-1);
  assert.equal(newest.title, "User's new title");
  assert.equal(newest.projectId, null);
  assert.equal(newest.updatedAt, new Date(1792336237 * 1000).toISOString());
  assert.equal(Object.hasOwn(h.observations.find(row => row.id.endsWith('unknown-membership')), 'projectId'), false);
  assert.equal(h.observations.find(row => row.id.endsWith(':archived')).outcome, 'archived');
  assert.ok(h.observations.findIndex(row => row.evidence === 'chatgpt_cache') < h.observations.findIndex(row => row.evidence === 'sidebar'));
  assert.equal(h.observations.some(row => row.id === 'chatgpt:chat:unlisted'), false);
  assert.equal(h.observations.some(row => row.outcome === 'not_found'), false);
  assert.equal(h.reads.length, 0);
  assert.equal(h.lease, null);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.reports[0], result);
});

test('archive failure retains successful independent sync and reports incomplete coverage', async () => {
  const h = harness({ archiveFailure: 'chatgpt', sidebar: [{ id: 'visible', kind: 'chatgpt', title: 'Visible' }] });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(result.complete, false);
  assert.ok(result.errors.some(error => error.source === 'chatgpt_archives'));
  assert.equal(h.observations.length, 1);
  assert.equal(h.observations[0].outcome, 'found');
  assert.equal(h.observations.some(row => row.outcome === 'not_found' || row.outcome === 'archived'), false);
  assert.equal(h.lease, null);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].complete, false);
  assert.ok(h.reports[0].errors.some(error => error.source === 'chatgpt_archives'));
});

test('repeated archive cursor rejects the partial archive result', async () => {
  const h = harness({ archiveHandler: args => textResponse(args.source === 'chatgpt'
    ? { threads: [{ id: args.cursor ? 'second' : 'first' }], nextCursor: 'repeated' }
    : { threads: [], nextCursor: null }) });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(result.complete, false);
  assert.equal(h.calls.filter(([name, args]) => name === 'archives' && args.source === 'chatgpt').length, 2);
  assert.equal(h.observations.length, 0);
});

test('daily lookup uses exact saved IDs, handles mismatches and transient errors, and flags explicit missing replies', async () => {
  const h = harness({ items: [chat('renamed'), chat('mismatch'), chat('missing'), chat('timeout')], probe: async args => {
    if (args.threadId === 'mismatch') return textResponse({ thread: { id: 'different-id', title: 'Wrong conversation' } });
    if (args.threadId === 'missing') return { isError: true, content: [{ type: 'text', text: 'Conversation not found' }] };
    if (args.threadId === 'timeout') throw new Error('Request timed out');
    return structuredResponse({ thread: { id: args.threadId, title: 'Current name', updatedAt: 1792336237 } });
  } });
  const result = await runMaintenance(h.tools, { mode: 'daily' });
  const outcomes = new Map(h.observations.map(row => [row.id, row]));
  assert.equal(outcomes.get('chatgpt:chat:renamed').title, 'Current name');
  assert.equal(outcomes.get('chatgpt:chat:mismatch').outcome, 'error');
  assert.equal(outcomes.get('chatgpt:chat:mismatch').title, undefined);
  assert.equal(outcomes.get('chatgpt:chat:missing').outcome, 'not_found');
  assert.equal(outcomes.get('chatgpt:chat:timeout').outcome, 'error');
  assert.equal(result.probeCalls, 4);
  assert.equal(result.complete, false);
  assert.equal(result.audit.processed, 4);
  assert.ok(result.audit.completedAt);
  assert.ok(h.reads.every(args => args.turnLimit === 1 && args.includeOutputs === false && args.maxOutputCharsPerItem === 1));
  assert.equal(h.lease, null);
});

test('daily audit reuses direct local and archive evidence but individually probes cached ChatGPT records', async () => {
  const local = chat('local', { id: 'codex:chat:local', source: 'codex', hostId: 'local' });
  const h = harness({ items: [local, chat('cached'), chat('archived')],
    collected: { observations: [
      { ...local, observedAt: new Date().toISOString(), evidence: 'local_index', outcome: 'found' },
      { ...chat('cached'), observedAt: '2026-10-17T20:00:00Z', evidence: 'chatgpt_cache', outcome: 'found' },
    ], errors: [], coverage: {}, counts: {} },
    archives: { chatgpt: [{ id: 'archived' }] },
  });
  const result = await runMaintenance(h.tools, { mode: 'daily' });
  assert.equal(result.complete, true);
  assert.deepEqual(h.reads.map(args => args.threadId), ['cached']);
  const audited = h.operations.filter(row => row.op === 'auditApply').flatMap(row => row.args.observations);
  assert.equal(audited.find(row => row.id === local.id).evidence, 'local_index');
  assert.equal(audited.find(row => row.id === 'chatgpt:chat:archived').outcome, 'archived');
  assert.equal(audited.find(row => row.id === 'chatgpt:chat:cached').evidence, 'probe');
});

test('daily project absence is not treated as missing when the source or remote host is unavailable', async () => {
  const h = harness({ items: [
    { id: 'chatgpt:project:cloud', source: 'chatgpt', sourceId: 'cloud', kind: 'project', title: 'Cloud project' },
    { id: 'codex:project:remote', source: 'codex', sourceId: 'remote', kind: 'project', title: 'Remote project', hostId: 'remote' },
  ], sidebarResponse: textResponse({ threads: [], pinnedThreads: [], unavailableSources: ['chatgpt'], unavailableHosts: ['remote'] }) });
  const result = await runMaintenance(h.tools, { mode: 'daily' });
  assert.equal(result.complete, false);
  assert.equal(h.reads.length, 0);
  assert.equal(h.observations.length, 2);
  assert.ok(h.observations.every(row => row.outcome === 'error'));
});

test('a manual recent-only update refreshes metadata without probing or restarting the pending weekly audit', async () => {
  const h = harness({ items: [chat('old-one'), chat('old-two')], sidebar: [{ id: 'recent', kind: 'chatgpt', title: 'Current recent title' }] });
  const paused = await runMaintenance(h.tools, { mode: 'daily', maxRunMs: -1 });
  const auditBefore = copy(h.audit), operationsBefore = h.operations.length;
  const result = await runMaintenance(h.tools, { mode: 'recent', recentOnly: true });
  assert.equal(result.complete, true);
  assert.equal(result.paused, undefined);
  assert.equal(result.probeCalls, 0);
  assert.equal(result.audit, undefined);
  assert.deepEqual(h.audit, auditBefore);
  assert.ok(h.observations.some(row => row.id === 'chatgpt:chat:recent' && row.title === 'Current recent title'));
  assert.equal(h.operations.slice(operationsBefore).some(row => ['begin', 'batch', 'auditApply', 'defer'].includes(row.op)), false);
  assert.equal(h.reports.at(-1).complete, true);
  assert.equal(h.lease, null);
  assert.equal(paused.audit.processed, 0);
});

test('a recent run resumes the existing daily checkpoint after a time limit', async () => {
  const h = harness({ items: [chat('one'), chat('two')] });
  const paused = await runMaintenance(h.tools, { mode: 'daily', maxRunMs: -1 });
  assert.equal(paused.paused, true);
  assert.equal(paused.audit.processed, 0);
  assert.equal(h.reads.length, 0);
  const resumed = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.audit.id, paused.audit.id);
  assert.equal(resumed.audit.processed, 2);
  assert.equal(h.reads.length, 2);
  assert.equal(h.operations.filter(row => row.op === 'auditApply').length, 1);
  assert.equal(h.lease, null);
});

test('repeated probe errors checkpoint processed IDs and resume remaining work without duplicate calls', async () => {
  let recovering = false;
  const h = harness({ items: Array.from({ length: 11 }, (_, i) => chat('chat-' + i)), probe: args => {
    if (!recovering) throw new Error('Network temporarily unavailable');
    return textResponse({ thread: { id: args.threadId, title: args.threadId } });
  } });
  const first = await runMaintenance(h.tools, { mode: 'daily' });
  assert.equal(first.paused, true);
  assert.equal(first.audit.processed, 8);
  assert.equal(h.reads.length, 8);
  recovering = true;
  const second = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(second.audit.processed, 11);
  assert.ok(second.audit.completedAt);
  assert.equal(second.audit.errors, 8);
  assert.equal(new Set(h.reads.map(args => args.threadId)).size, 11);
  assert.equal(h.reads.length, 11);
});

test('daily probing caps requests at 80 with one active read while retaining direct local evidence', async () => {
  const local = chat('local', { id: 'codex:chat:local', source: 'codex', hostId: 'local' });
  let active = 0, maximumActive = 0;
  const h = harness({ items: [local, ...Array.from({ length: 84 }, (_, i) => chat('old-' + i))],
    collected: { observations: [{ ...local, observedAt: new Date().toISOString(), evidence: 'local_index', outcome: 'found' }], errors: [], counts: {}, coverage: {} },
    probe: async args => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return textResponse({ thread: { id: args.threadId, title: args.threadId } });
    },
  });
  const first = await runMaintenance(h.tools, { mode: 'daily' });
  assert.equal(first.probeCalls, 80);
  assert.equal(h.reads.length, 80);
  assert.equal(maximumActive, 1);
  assert.equal(first.paused, true);
  assert.ok(first.deferred);
  assert.equal(first.complete, true, 'scheduled request cap is an ordinary continuation, not an attention failure');
  assert.deepEqual(first.errors, []);
  assert.equal(first.audit.processed, 81);
  assert.equal(first.audit.completedAt, null);
  const second = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(second.probeCalls, 4);
  assert.equal(second.audit.processed, 85);
  assert.ok(second.audit.completedAt);
  assert.equal(new Set(h.reads.map(row => row.threadId)).size, 84);
  assert.equal(h.reads.length, 84);
});

test('rate limiting stops immediately, defers the failed ID, keeps recents active, and retries only after cooldown', async () => {
  let limited = true;
  const config = { items: [chat('limited'), chat('successful'), chat('recent'), chat('remaining')], sidebar: [], probe: async args => {
    if (limited && args.threadId === 'limited') return { isError: true, content: [{ type: 'text', text: '429 Too Many Requests: rate limit reached' }] };
    return textResponse({ thread: { id: args.threadId, title: args.threadId } });
  } };
  const h = harness(config);
  const waits = [];
  const wait = async milliseconds => { waits.push(milliseconds); };
  const started = Date.now();
  const first = await runMaintenance(h.tools, { mode: 'daily', wait });
  assert.equal(first.probeCalls, 1);
  assert.equal(first.paused, true);
  assert.ok(first.deferred);
  assert.equal(first.complete, true);
  assert.deepEqual(first.errors, []);
  assert.equal(first.audit.processed, 0);
  assert.equal(first.audit.errors, 0);
  const delay = Date.parse(first.audit.retryAfter) - started;
  assert.ok(delay >= 59 * 60000 && delay <= 61 * 60000);
  const deferred = h.operations.find(row => row.op === 'defer');
  assert.deepEqual(deferred.args.retryIds, ['chatgpt:chat:limited']);
  assert.equal(h.observations.find(row => row.id === 'chatgpt:chat:limited').outcome, 'error');
  assert.deepEqual(waits, [2000]);
  config.sidebar.push({ id: 'recent', kind: 'chatgpt', title: 'Recent rename during cooldown' });
  const coolingDown = await runMaintenance(h.tools, { mode: 'recent', wait });
  assert.equal(coolingDown.complete, true);
  assert.ok(coolingDown.deferred);
  assert.equal(coolingDown.probeCalls, 0);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(waits, [2000], 'cooldown does not trigger probe pacing waits');
  assert.equal(h.observations.find(row => row.title === 'Recent rename during cooldown').evidence, 'sidebar');
  limited = false;
  h.audit.retryAfter = new Date(Date.now() - 1000).toISOString();
  const resumed = await runMaintenance(h.tools, { mode: 'recent', wait });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.probeCalls, 4);
  assert.ok(resumed.audit.completedAt);
  assert.equal(h.reads.filter(row => row.threadId === 'limited').length, 2);
  assert.equal(h.reads.filter(row => row.threadId === 'successful').length, 1);
  assert.equal(h.reads.length, 5);
  assert.deepEqual(waits, [2000, 2000, 2000, 2000, 2000]);
  assert.equal(h.observations.some(row => row.outcome === 'not_found'), false);
});

test('each serial probe renews its lease and awaits two seconds after successful and failed responses', async () => {
  const events = [];
  const h = harness({ items: [chat('success'), chat('error'), chat('missing')],
    onOperation: op => { if (op === 'renew') events.push('renew'); },
    probe: async args => {
      events.push('request:' + args.threadId);
      await Promise.resolve();
      events.push('response:' + args.threadId);
      if (args.threadId === 'error') throw new Error('Temporary connection problem');
      if (args.threadId === 'missing') return { isError: true, content: [{ type: 'text', text: 'Conversation not found' }] };
      return textResponse({ thread: { id: args.threadId, title: 'Found title' } });
    },
  });
  const result = await runMaintenance(h.tools, { mode: 'daily', wait: async milliseconds => {
    events.push('wait:' + milliseconds);
    await new Promise(resolve => setImmediate(resolve));
    events.push('wait-complete');
  } });
  const expected = ['success', 'error', 'missing'].flatMap(id => ['renew', 'request:' + id, 'response:' + id, 'wait:2000', 'wait-complete']);
  assert.deepEqual(events.slice(0, expected.length), expected);
  assert.ok(events.slice(expected.length).every(event => event === 'renew'), 'remaining renewals protect writes');
  assert.equal(result.probeCalls, 3);
  assert.equal(h.operations.filter(row => row.op === 'renew').length, 4, 'three probe renewals and one audit-write renewal');
  assert.equal(h.observations.find(row => row.id === 'chatgpt:chat:success').outcome, 'found');
  assert.equal(h.observations.find(row => row.id === 'chatgpt:chat:error').outcome, 'error');
  assert.equal(h.observations.find(row => row.id === 'chatgpt:chat:missing').outcome, 'not_found');
});

test('direct local, project, and archive checks require no probe pacing wait', async () => {
  const local = chat('local', { id: 'codex:chat:local', source: 'codex', hostId: 'local' });
  const project = { id: 'chatgpt:project:project', source: 'chatgpt', sourceId: 'project', kind: 'project', title: 'Project' };
  const h = harness({ items: [local, project, chat('archived')],
    collected: { observations: [{ ...local, observedAt: new Date().toISOString(), evidence: 'local_index', outcome: 'found' }], errors: [], counts: {}, coverage: {} },
    projects: [{ projectId: 'project', projectKind: 'chatgpt', label: 'Project' }],
    archives: { chatgpt: [{ id: 'archived' }] },
  });
  let waits = 0;
  const result = await runMaintenance(h.tools, { mode: 'daily', wait: async () => { waits++; } });
  assert.equal(result.complete, true);
  assert.equal(result.probeCalls, 0);
  assert.equal(h.reads.length, 0);
  assert.equal(waits, 0);
});

test('optimistic revision retry rereads current revision and applies the same observations once', async () => {
  const h = harness({ staleFailures: 1, sidebar: [{ id: 'visible', kind: 'chatgpt', title: 'Visible' }] });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(result.complete, true);
  const applies = h.operations.filter(row => row.op === 'apply');
  assert.equal(applies.length, 2);
  assert.ok(applies[1].args.expectedRevision > applies[0].args.expectedRevision);
  assert.deepEqual(applies[1].args.observations, applies[0].args.observations);
  assert.equal(h.observations.length, 1);
});

test('dry run collects evidence without acquiring a lease or changing catalog or audit state', async () => {
  const h = harness({ sidebar: [{ id: 'visible', kind: 'chatgpt', title: 'Visible' }] });
  const result = await runMaintenance(h.tools, { mode: 'daily', dryRun: true });
  assert.equal(result.complete, true);
  assert.equal(result.observations, 1);
  assert.equal(h.observations.length, 0);
  assert.equal(h.audit, null);
  assert.equal(h.reports.length, 0);
  assert.deepEqual(h.operations.map(row => row.op), ['collect']);
});

test('an occupied maintenance lease skips before any inventory read or catalog mutation', async () => {
  const h = harness({ busy: true });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.ok(result.skipped);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
  assert.equal(h.observations.length, 0);
  assert.equal(h.reports.length, 0);
  assert.deepEqual(h.operations.map(row => row.op), ['acquire']);
});

test('inventory parse failure releases the maintenance lease and never applies partial data', async () => {
  const h = harness({ sidebarResponse: { content: [{ type: 'text', text: 'not JSON' }] } });
  const result = await runMaintenance(h.tools, { mode: 'recent' });
  assert.equal(result.complete, false);
  assert.equal(h.observations.length, 0);
  assert.equal(h.lease, null);
  assert.deepEqual(h.operations.map(row => row.op), ['acquire', 'state', 'recordRun', 'release']);
});

test('the service adapter completes recent updates without shell writes or folder permission requests', async () => {
  const h=harness({sidebar:[{id:'current',kind:'chatgpt',title:'Current service title'}]});
  const dispatch=h.tools.mcp__chat_organizer__maintain_catalog;
  let shellCalls=0,permissions=0,serviceCalls=0;
  h.tools.exec_command=async()=>{shellCalls++;throw new Error('Read-only hosting chat cannot execute database writes');};
  h.tools.request_permissions=async()=>{permissions++;throw new Error('No folder grants should be requested');};
  h.tools.mcp__chat_organizer__maintain_catalog=async args=>{
    serviceCalls++;
    return dispatch(args);
  };
  const result=await executeMaintenance(h.tools,{mode:'recent',recentOnly:true});
  assert.equal(result.complete,true);assert.ok(serviceCalls>0);assert.equal(shellCalls,0);assert.equal(permissions,0);
  assert.ok(h.observations.some(row=>row.title==='Current service title'));assert.equal(h.lease,null);
});

test('missing service support asks for a restart without attempting legacy shell writes', async () => {
  const h=harness();
  delete h.tools.mcp__chat_organizer__maintain_catalog;
  h.tools.exec_command=async()=>{throw new Error('A shell fallback must never run');};
  await assert.rejects(executeMaintenance(h.tools,{mode:'recent',recentOnly:true}),/Fully quit and reopen Codex/);
  assert.equal(h.operations.length,0);assert.equal(h.calls.length,0);
});

test('service errors keep their codes so revision conflicts can be retried without CLI fallback', async () => {
  const h=harness({staleFailures:1,sidebar:[{id:'current',kind:'chatgpt',title:'Service title'}]});
  h.tools.exec_command=async()=>{throw new Error('No CLI fallback');};
  const result=await executeMaintenance(h.tools,{mode:'recent',recentOnly:true});
  assert.equal(result.complete,true);
  assert.equal(h.operations.filter(row=>row.op==='apply').length,2);
  assert.equal(h.observations.length,1);
});

test('unsupported CLI adapter is rejected before any operations', async () => {
  const h=harness();
  await assert.rejects(executeMaintenance(h.tools,{adapter:'cli'}),/only the organizer service adapter/);
  assert.equal(h.operations.length,0);assert.equal(h.calls.length,0);
});

test('missing native tools are reported before acquiring the catalog lease', async () => {
  const h=harness();
  delete h.tools.mcp__codex_app__list_projects;
  await assert.rejects(executeMaintenance(h.tools),/native app tools are unavailable: mcp__codex_app__list_projects/);
  assert.equal(h.operations.length,0);assert.equal(h.calls.length,0);
});

test('service access failure does not request host permissions or read sources', async () => {
  const h=harness();let attempts=0;
  h.tools.mcp__chat_organizer__maintain_catalog=async()=>{
    attempts++;
    return {isError:true,content:[{type:'text',text:'The catalog is read-only.'}],_meta:{error:{code:'CATALOG_ACCESS_REQUIRED'}}};
  };
  h.tools.request_permissions=async()=>{throw new Error('No host permission escalation');};
  await assert.rejects(runMaintenance(h.tools),error=>error.code==='CATALOG_ACCESS_REQUIRED');
  assert.equal(attempts,1);assert.equal(h.calls.length,0);assert.equal(h.observations.length,0);assert.equal(h.lease,null);
});

test('a writable catalog does not request more permissions', async () => {
  const h=harness();let requested=false;
  h.tools.request_permissions=async()=>{requested=true;throw new Error('Unnecessary permission request');};
  const result=await runMaintenance(h.tools,{mode:'recent',recentOnly:true});
  assert.equal(result.complete,true);assert.equal(requested,false);
});

test('unexpected workflow failure records an actionable failed run and releases its lease', async () => {
  const h = harness({ collectError: 'Local metadata source is unreadable' });
  await assert.rejects(runMaintenance(h.tools, { mode: 'recent' }), /Local metadata source is unreadable/);
  assert.equal(h.observations.length, 0);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].complete, false);
  assert.deepEqual(h.reports[0].errors, [{ source: 'workflow', message: 'Local metadata source is unreadable' }]);
  assert.equal(h.lease, null);
  assert.deepEqual(h.operations.map(row => row.op), ['acquire', 'collect', 'state', 'recordRun', 'release']);
});
