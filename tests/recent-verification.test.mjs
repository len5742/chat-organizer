import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

const require = createRequire(new URL('../server.mjs', import.meta.url));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { InMemoryTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/inMemory.js')));
const runMaintenance = (0, eval)(await readFile(new URL('../maintenance-workflow.js', import.meta.url), 'utf8'));
const response = value => ({ structuredContent: value, content: [] });
const userTurn = text => ({ items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] });
const recentTime = () => new Date(Date.now() - 60000).toISOString();
const chat = (number, extra = {}) => ({ id: 'chatgpt:chat:saved-' + String(number).padStart(2,'0'), source: 'chatgpt', sourceId: 'saved-' + String(number).padStart(2,'0'),
  kind: 'chat', title: 'Saved meaningful chat ' + number, updatedAt: recentTime(), ...extra });
const uuidChat = (extra = {}) => {
  const sourceId = '00000000-0000-4000-8000-000000000003';
  return { id: 'codex:chat:' + sourceId, source: 'codex', sourceId, hostId: 'durable', title: sourceId, kind: 'chat', updatedAt: recentTime(), ...extra };
};
async function fixture(items, action, config = {}) {
  const store = new CatalogStore(':memory:');
  store.importInventory({ items, coverage: 'Isolated recent verification fixture' });
  const trace = [], reads = [], operations = [], waits = [], calls = { collector: 0, lists: 0, status: 0 };
  let inFlight = 0, maxInFlight = 0;
  const server = createOrganizerServer(store, 'stdio', { recentCollector: async () => { calls.collector++; return { observations: config.observations || [], errors: [], counts: {}, coverage: {} }; } });
  const client = new Client({ name: 'recent-verification-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = {
      mcp__chat_organizer__get_connection_status: async () => {
        calls.status++; if (config.version) return response({ serverVersion: config.version });
        return client.callTool({ name: 'get_connection_status', arguments: {} });
      },
      mcp__chat_organizer__maintain_catalog: async args => { operations.push(args.request.op); return client.callTool({ name: 'maintain_catalog', arguments: args }); },
      mcp__codex_app__list_projects: async () => { calls.lists++; return response({ projects: [] }); },
      mcp__codex_app__list_threads: async () => { calls.lists++; return response({ threads: config.sidebar || [], pinnedThreads: [] }); },
      mcp__codex_app__list_archived_threads: async () => { calls.lists++; return response({ threads: [], nextCursor: null }); },
      mcp__codex_app__read_thread: async args => {
        reads.push(args); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); trace.push('read:' + args.threadId);
        try {
          await new Promise(resolve => setImmediate(resolve));
          if (config.read) return await config.read(args, reads.length);
          const row = items.find(item => item.sourceId === args.threadId);
          return response({ thread: { id: args.threadId, title: row?.title ?? null, updatedAt: Date.now()/1000 }, turns: [] });
        } finally { inFlight--; trace.push('response:' + args.threadId); }
      },
    };
    const run = options => runMaintenance(tools, { adapter: 'service', mode: 'recent', recentOnly: true,
      wait: async ms => { waits.push(ms); trace.push('wait:' + ms); }, ...options });
    await action({ store, client, tools, run, reads, operations, waits, trace, calls, maxInFlight: () => maxInFlight });
  } finally { await client.close(); await server.close(); store.close(); }
}

test('recent verification bounds each run to eight probes, rotates candidates, and never resumes the pending audit', async () => {
  const items = Array.from({length:13}, (_,index)=>chat(index));
  await fixture(items, async ({store,run,reads,operations,waits,trace,maxInFlight}) => {
    const audit = store.beginAudit({ day: '2026-10-19' });
    const first = await run();
    assert.equal(first.probeCalls, 8); assert.equal(reads.length, 8); assert.equal(first.sources.recentVerificationPending, 5);
    assert.equal(first.complete, true); assert.equal(first.audit, undefined);
    assert.deepEqual(store.maintenanceState().audit, audit);
    const firstIds = reads.map(read=>read.threadId);
    const second = await run();
    assert.equal(second.probeCalls, 5); assert.equal(reads.length, 13);
    assert.equal(new Set(reads.map(read=>read.threadId)).size, 13); assert.equal(reads.slice(8).some(read=>firstIds.includes(read.threadId)),false);
    const third = await run(); assert.equal(third.probeCalls, 0, 'Six-hour clocks prevent immediate repeat probes');
    assert.equal(maxInFlight(),1); assert.deepEqual(waits,Array(13).fill(2000));
    for(let i=0;i<trace.length;i+=3) {assert.match(trace[i],/^read:/);assert.match(trace[i+1],/^response:/);assert.equal(trace[i+2],'wait:2000');}
    for(const op of ['begin','batch','auditApply','defer']) assert.equal(operations.includes(op),false);
    assert.deepEqual(store.maintenanceState().audit,audit);
  });
});

test('recent verification uses an explicit native name instead of a returned message preview', async () => {
  const item = uuidChat();
  const description = 'Compare the sample notebook layouts for a planning session.';
  await fixture([item], async ({store,run,reads,waits}) => {
    const result=await run();
    assert.equal(result.probeCalls,1);
    assert.deepEqual(reads[0],{threadId:item.sourceId,hostId:'durable',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:600});
    assert.equal(store.snapshot().items[0].title,description);assert.equal(store.snapshot().items[0].hostId,'durable');
    assert.deepEqual(waits,[2000]);
  },{sidebar:[{id:item.sourceId,kind:'codex',hostId:'durable',title:item.sourceId,updatedAt:Date.now()/1000}],read:async args=>response({thread:{id:args.threadId,name:description,title:'An unrelated message preview…'},turns:[userTurn('Please continue checking the latest update to this issue.'),userTurn('yes')]})});
});

test('recent verification does not derive a description from scaffolding or generic short acknowledgments', async () => {
  const item=uuidChat();
  await fixture([item],async ({store,run,reads})=>{
    const result=await run();assert.equal(result.probeCalls,1);assert.equal(reads[0].turnLimit,1);
    assert.equal(store.snapshot().items[0].title,item.sourceId);assert.equal(result.sources.inferredDescriptions??0,0);
  },{read:async args=>response({thread:{id:args.threadId,title:null},turns:[userTurn('test again'),userTurn('yes'),userTurn('# AGENTS.md These are framework instructions and not the real subject'),userTurn('<environment_context>This is execution context for the workspace.</environment_context>'),userTurn('{"cwd":"example execution context"}')]})});
});

test('unnamed durable discoveries are deferred without adding UUID rows or membership warnings', async () => {
  const candidate = uuidChat();
  await fixture([], async ({ store, run, reads }) => {
    const result = await run();
    assert.equal(result.complete, true);
    assert.equal(result.sources.unnamedRemoteSkipped, 1);
    assert.equal(result.sources.sidebarMembershipUnverified, 0);
    assert.equal(store.snapshot().items.length, 0);
    assert.deepEqual(result.exceptions, []);
    assert.deepEqual(reads, []);
  }, { sidebar: [{ id: candidate.sourceId, kind: 'codex', hostId: 'durable', title: candidate.sourceId, projectId: null }] });
});

for (const title of ['A message preview that was truncated…', '[@Example](plugin://example)', 'A complete first user message']) {
  test('a message preview cannot overwrite a saved name: ' + title, async () => {
    const item = uuidChat({ title: 'Saved source name' });
    await fixture([item], async ({ store, run }) => {
      await run();
      assert.equal(store.snapshot().items[0].title, item.title);
    }, { read: async args => response({ thread: { id: args.threadId, title, preview: title }, turns: [userTurn(title)] }) });
  });
}

test('recent verification never replaces an existing useful title with a newly inferred description',async()=>{
  const item=uuidChat({title:'Existing recovered notification description'});
  await fixture([item],async({store,run,reads})=>{
    await run();assert.equal(reads[0].turnLimit,1);assert.equal(store.snapshot().items[0].title,item.title);
  },{read:async args=>response({thread:{id:args.threadId,title:null},turns:[userTurn('A different request from later in the conversation would be a bad title.')]})});
});

test('recent verification hides an explicitly missing chat while retaining its record and organization',async()=>{
  const item=chat(1);
  await fixture([item],async({store,run,reads,waits})=>{
    store.setCategory({id:item.id,category:'Travel',expectedRevision:store.snapshot().revision});
    store.setFocus({id:item.id,focused:true,expectedRevision:store.snapshot().revision});
    const result=await run();assert.equal(result.complete,true);assert.equal(reads[0].turnLimit,1);assert.deepEqual(waits,[2000]);
    assert.equal(store.snapshot().items.length,0);
    const raw=store.db.prepare('SELECT id,category,focused FROM catalog_items WHERE id=?').get(item.id);
    assert.deepEqual({...raw},{id:item.id,category:'Travel',focused:1});
    assert.equal(store.maintenanceState().counts.not_found,1);
  },{read:async()=>{throw new Error('Conversation not found');}});
});

for(const message of ['Could not determine whether Codex thread exists. Unavailable or failed hosts: durable','Permission denied while reading this conversation','No rollout found for this remote thread']) {
  test('recent verification stops on an ambiguous source failure and preserves visibility: '+message,async()=>{
    const item=uuidChat();
    await fixture([item,chat(2),chat(3)],async({store,run,reads,waits})=>{
      const result=await run();assert.equal(result.complete,false);assert.equal(reads.length,1);assert.deepEqual(waits,[2000]);
      assert.equal(store.snapshot().items.length,3);assert.equal(store.maintenanceState().counts.not_found??0,0);
      assert.equal(result.errors.length,1);assert.equal(result.errors[0].source,'recent_verification');
      assert.ok(store.snapshot().items.some(row=>row.lastCheckError===message));
    },{read:async()=>{throw new Error(message);}});
  });
}

test('recent verification persists a one-hour rate-limit cooldown and suppresses individual source reads on the next invocation',async()=>{
  await fixture([chat(1),chat(2)],async({store,run,reads,operations,waits})=>{
    const before=Date.now();const first=await run();
    assert.equal(first.complete,false);assert.equal(reads.length,1);assert.ok(operations.includes('deferVerification'));
    const cooldown=store.maintenanceState().recentVerificationRetryAfter;
    assert.ok(Date.parse(cooldown)>=before+3599000);assert.ok(Date.parse(cooldown)<=Date.now()+3601000);
    assert.match(first.deferred,/cooldown/);assert.deepEqual(waits,[2000]);
    const second=await run();assert.equal(second.probeCalls,0);assert.equal(reads.length,1);assert.match(second.deferred,/cooldown/);
    assert.equal(store.snapshot().items.length,2);assert.equal(store.maintenanceState().recentVerificationRetryAfter,cooldown);
  },{read:async()=>{throw new Error('429 Too many requests');}});
});

test('recent verification excludes old, observed well-named, and mapped cloud aliases while prioritizing untitled recent cloud chats',async()=>{
  const untitled=uuidChat(), mapped=uuidChat({id:'codex:chat:00000000-0000-4000-8000-000000000001',sourceId:'00000000-0000-4000-8000-000000000001',title:'Mapped cloud alias',webConversationId:'00000000-0000-4000-8000-000000000005'});
  const known=chat(2),old=chat(3,{updatedAt:new Date(Date.now()-31*86400000).toISOString()});
  await fixture([untitled,mapped,known,old,chat(4)],async({store,run,reads})=>{
    const queue=store.recentVerificationBatch({observedIds:[known.id,untitled.id],limit:8});
    assert.equal(queue.items[0].id,untitled.id);assert.equal(queue.items.length,2);
    await run();assert.equal(reads[0].threadId,untitled.sourceId);
    assert.deepEqual(new Set(reads.map(read=>read.threadId)),new Set([untitled.sourceId,'saved-04']));
  },{sidebar:[{id:known.sourceId,kind:'chatgpt',title:known.title,updatedAt:Date.now()/1000}]});
});

for (const version of ['0.1.17','0.1.18','0.1.22','0.1.25','0.2.4']) test('recent verification preflight rejects service version '+version+' before a lease or any source reads',async()=>{
  await fixture([chat(1)],async({run,operations,reads,calls,store})=>{
    await assert.rejects(run(),/Fully quit and reopen Codex.*0\.2\.5/);
    assert.deepEqual(operations,[]);assert.equal(reads.length,0);assert.equal(calls.lists,0);assert.equal(calls.collector,0);assert.equal(calls.status,1);
    assert.equal(store.maintenanceState().lastRecentRun,null);
  },{version});
});
