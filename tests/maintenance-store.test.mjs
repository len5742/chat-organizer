import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CatalogStore } from '../store.mjs';

const at = hour => `2026-10-18T${String(hour).padStart(2, '0')}:00:00.000Z`;
const chat = (sourceId, extra = {}) => ({ id: `chatgpt:chat:${sourceId}`, source: 'chatgpt', sourceId,
  kind: 'chat', title: `Chat ${sourceId}`, url: `https://chatgpt.com/c/${sourceId}`, ...extra });
const project = (sourceId, extra = {}) => ({ id: `chatgpt:project:${sourceId}`, source: 'chatgpt', sourceId,
  kind: 'project', title: `Project ${sourceId}`, ...extra });
const observation = (item, extra = {}) => ({ ...item, outcome: 'found', evidence: 'sidebar', observedAt: at(10), ...extra });
const lookup = (id, extra = {}) => ({ id, outcome: 'found', evidence: 'probe', observedAt: at(11), ...extra });
const item = (store, id) => store.snapshot().items.find(row => row.id === id);
const sync = (store, observations, extra = {}) => store.applySync({ observations,
  expectedRevision: store.snapshot().revision, coverage: 'Synthetic maintenance test', ...extra });
const withStore = fn => { const store = new CatalogStore(':memory:'); try { fn(store); } finally { store.close(); } };
const seed = (store, items) => store.importInventory({ items, coverage: 'Synthetic initial inventory' });
const roots = snapshot => snapshot.categories.filter(category => category.parentId === null).map(category => category.id);
const visibleFields = ({ lastCheckedAt, lastCheckError, ...entry }) => entry;
const withSharedStores = fn => {
  const work = tmpdir();
  const directory = mkdtempSync(join(work, 'maintenance-lease-'));
  const databasePath = join(directory, 'synthetic.sqlite');
  const first = new CatalogStore(databasePath), second = new CatalogStore(databasePath);
  try { fn(first, second); }
  finally {
    first.close(); second.close();
    assert.ok(resolve(directory).startsWith(resolve(work) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
};

test('a partial recent sync discovers a chat and retains every omitted chat and project', () => withStore(store => {
  const old = chat('old', { projectId: 'p' }), recent = chat('recent'), p = project('p');
  seed(store, [old, recent, p]);
  const oldBefore = item(store, old.id), projectBefore = item(store, p.id);
  const result = sync(store, [observation(recent, { title: 'Renamed recent chat' }), observation(chat('new'))]);
  assert.equal(result.added, 1);
  assert.equal(result.renamed, 1);
  assert.equal(store.snapshot().items.length, 4);
  assert.deepEqual(item(store, old.id), oldBefore);
  assert.deepEqual(item(store, p.id), projectBefore);
  assert.equal(item(store, 'chatgpt:chat:new').category, 'Uncategorized');
}));

test('renaming preserves category assignments, flame marks, project membership, and category order', () => withStore(store => {
  const c = chat('a', { projectId: 'p' });
  let state = seed(store, [c, project('p')]);
  state = store.setCategory({ id: c.id, category: 'Travel', expectedRevision: state.revision });
  state = store.setFocus({ id: c.id, focused: true, expectedRevision: state.revision });
  state = store.reorderCategories({ ids: roots(state).reverse(), expectedRevision: state.revision });
  const before = item(store, c.id);
  sync(store, [lookup(c.id, { title: 'A new title' })]);
  assert.deepEqual(store.snapshot().categories, state.categories);
  assert.deepEqual(visibleFields(item(store, c.id)), { ...visibleFields(before), title: 'A new title' });
}));

test('explicit no-project evidence clears membership and later evidence moves the same chat into a project', () => withStore(store => {
  const c = chat('member', { projectId: 'first' });
  seed(store, [c, project('first'), project('second')]);
  const omitted = sync(store, [lookup(c.id, { title: 'Still a member' })]);
  assert.equal(omitted.moved, 0);
  assert.equal(item(store, c.id).projectId, 'first');
  assert.equal(sync(store, [lookup(c.id, { evidence: 'sidebar', projectId: null, observedAt: at(12) })]).moved, 1);
  assert.equal(item(store, c.id).projectId, null);
  assert.equal(sync(store, [lookup(c.id, { evidence: 'sidebar', projectId: 'second', observedAt: at(13) })]).moved, 1);
  assert.equal(item(store, c.id).projectId, 'second');
}));

test('archiving hides a chat while retaining its organization; readable probes keep it archived and active evidence restores it', () => withStore(store => {
  const c = chat('saved', { projectId: 'p' });
  let state = seed(store, [c, project('p')]);
  state = store.setCategory({ id: c.id, category: 'Travel', expectedRevision: state.revision });
  store.setFocus({ id: c.id, focused: true, expectedRevision: state.revision });
  const before = item(store, c.id);
  sync(store, [lookup(c.id, { outcome: 'archived', evidence: 'archive_list' })]);
  assert.equal(item(store, c.id), undefined);
  assert.equal(store.maintenanceState().counts.archived, 1);
  sync(store, [lookup(c.id, { title: 'Renamed while archived', observedAt: at(12) })]);
  assert.equal(item(store, c.id), undefined, 'a readable archived chat is still archived');
  sync(store, [lookup(c.id, { evidence: 'sidebar', observedAt: at(13) })]);
  assert.deepEqual(visibleFields(item(store, c.id)), { ...visibleFields(before), title: 'Renamed while archived' });
  assert.equal(store.maintenanceState().counts.archived ?? 0, 0);
}));

test('not-found chats hide, missing projects retain their marker, and direct lookup restores organization', () => withStore(store => {
  const c=chat('missing',{projectId:'p'}),p=project('p');seed(store,[c,p]);
  store.setCategory({id:c.id,category:'Travel',expectedRevision:store.snapshot().revision});
  sync(store,[lookup(c.id,{outcome:'not_found'}),lookup(p.id,{outcome:'not_found',evidence:'project_list_complete'})]);
  assert.equal(item(store,c.id),undefined);assert.equal(item(store,p.id).availability,'not_found');
  assert.equal(store.db.prepare('SELECT category FROM catalog_items WHERE id=?').get(c.id).category,'Travel');
  sync(store,[lookup(c.id,{observedAt:at(12)}),lookup(p.id,{evidence:'project_list',observedAt:at(12)})]);
  assert.equal(item(store,c.id).availability,'available');assert.equal(item(store,c.id).category,'Travel');assert.equal(item(store,c.id).projectId,'p');
}));

test('older cache evidence cannot overwrite a newer title, project removal, or archive status', () => withStore(store => {
  const c = chat('older-cache', { projectId: 'p' });
  seed(store, [c, project('p')]);
  sync(store, [lookup(c.id, { evidence: 'sidebar', title: 'Current title', projectId: null, observedAt: at(12) })]);
  sync(store, [lookup(c.id, { outcome: 'archived', evidence: 'archive_list', observedAt: at(13) })]);
  const result = sync(store, [observation(c, { evidence: 'chatgpt_cache', observedAt: at(10) })]);
  assert.ok(result.stale > 0);
  assert.equal(item(store, c.id), undefined);
  sync(store, [lookup(c.id, { evidence: 'sidebar', observedAt: at(14) })]);
  assert.equal(item(store, c.id).title, 'Current title');
  assert.equal(item(store, c.id).projectId, null);
}));

test('a cache replay at the same timestamp cannot undo a confirmed archive or direct metadata', () => withStore(store => {
  const c = chat('same-time', { projectId: 'p' });
  seed(store, [c, project('p')]);
  sync(store, [lookup(c.id, { evidence: 'sidebar', title: 'Current title', projectId: null, observedAt: at(12) })]);
  sync(store, [lookup(c.id, { outcome: 'archived', evidence: 'archive_list', observedAt: at(12) })]);
  sync(store, [observation(c, { evidence: 'chatgpt_cache', observedAt: at(12) })]);
  assert.equal(item(store, c.id), undefined, 'cached active status cannot reverse simultaneous explicit archive evidence');
  sync(store, [lookup(c.id, { evidence: 'sidebar', observedAt: at(13) })]);
  assert.equal(item(store, c.id).title, 'Current title');
  assert.equal(item(store, c.id).projectId, null);
}));

test('a timeout preserves visible metadata and availability and a later success clears its error', () => withStore(store => {
  const c = chat('timeout', { projectId: 'p' });
  seed(store, [c, project('p')]);
  sync(store, [lookup(c.id)]);
  const before = item(store, c.id), revision = store.snapshot().revision;
  const result = sync(store, [lookup(c.id, { outcome: 'error', error: 'Timed out', observedAt: at(12), title: 'Untrusted partial title', projectId: null })]);
  assert.equal(result.errors, 1);
  assert.equal(result.revision, revision);
  assert.deepEqual(visibleFields(item(store, c.id)), visibleFields(before));
  assert.equal(item(store, c.id).lastCheckError, 'Timed out');
  sync(store, [lookup(c.id, { observedAt: at(13) })]);
  assert.equal(item(store, c.id).lastCheckError, null);
}));

test('an older failed response cannot overwrite a newer successful check', () => withStore(store => {
  const c = chat('late-error');
  seed(store, [c]);
  sync(store, [lookup(c.id, { title: 'Current title', observedAt: at(13) })]);
  const before = item(store, c.id);
  sync(store, [lookup(c.id, { outcome: 'error', error: 'Old timeout', observedAt: at(12) })]);
  assert.deepEqual(item(store, c.id), before);
}));

test('out-of-order failed responses keep the newest check time and error', () => withStore(store => {
  const c = chat('two-errors');
  seed(store, [c]);
  sync(store, [lookup(c.id, { observedAt: at(10) })]);
  sync(store, [lookup(c.id, { outcome: 'error', error: 'Newest timeout', observedAt: at(13) })]);
  const before = item(store, c.id);
  sync(store, [lookup(c.id, { outcome: 'error', error: 'Older timeout', observedAt: at(12) })]);
  assert.deepEqual(item(store, c.id), before);
}));

test('repeated successful checks update check metadata without bumping the visible catalog revision', () => withStore(store => {
  const c = chat('unchanged', { projectId: null, updatedAt: at(9) });
  seed(store, [c]);
  const revision = store.snapshot().revision;
  const first = sync(store, [observation(c)]);
  const second = sync(store, [observation(c, { observedAt: at(11) })]);
  assert.equal(first.revision, revision);
  assert.equal(second.revision, revision);
  assert.equal(second.renamed + second.moved + second.statusChanged + second.added, 0);
  assert.equal(item(store, c.id).lastCheckedAt, at(11));
}));

test('stale revision rejection and invalid later entries leave the entire sync atomic', () => withStore(store => {
  const c = chat('atomic');
  seed(store, [c]);
  const before = store.snapshot(), maintenance = store.maintenanceState();
  assert.throws(() => sync(store, [observation(chat('new')), lookup(c.id, { title: 'Wrong title' })],
    { expectedRevision: before.revision - 1 }), { code: 'STALE_REVISION' });
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.maintenanceState(), maintenance);
  assert.throws(() => sync(store, [observation(chat('new')), lookup(c.id, { sourceId: 'different-id', title: 'Wrong title' })]),
    { code: 'INVALID_ID' });
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.maintenanceState(), maintenance);
}));

test('partial inventories cannot supply not-found or archive conclusions', () => withStore(store => {
  const c = chat('partial');
  seed(store, [c]);
  const before = store.snapshot();
  for (const evidence of ['sidebar', 'chatgpt_cache', 'project_list', 'archive_list', 'local_index']) {
    assert.throws(() => sync(store, [lookup(c.id, { outcome: 'not_found', evidence })]), { code: 'INVALID_INPUT' });
  }
  for (const evidence of ['sidebar', 'chatgpt_cache', 'probe', 'project_list_complete']) {
    assert.throws(() => sync(store, [lookup(c.id, { outcome: 'archived', evidence })]), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(store.snapshot(), before);
}));

test('daily audit survives a restart, resumes pending IDs, excludes archives, and completes once per day', () => {
  const work = tmpdir();
  const directory = mkdtempSync(join(work, 'maintenance-store-'));
  const databasePath = join(directory, 'synthetic.sqlite');
  let store;
  try {
    store = new CatalogStore(databasePath);
    const hidden = chat('hidden');
    seed(store, [chat('a'), chat('b'), project('p'), hidden]);
    sync(store, [lookup(hidden.id, { outcome: 'archived', evidence: 'archive_list' })]);
    const audit = store.beginAudit({ day: '2026-10-18' });
    assert.equal(audit.total, 3);
    const first = store.auditBatch({ auditId: audit.id, limit: 1 }).items[0];
    store.applyAuditBatch({ auditId: audit.id, observations: [lookup(first.id)], expectedRevision: store.snapshot().revision });
    const saved = store.maintenanceState();
    store.close();
    store = new CatalogStore(databasePath);
    assert.deepEqual(store.maintenanceState(), saved);
    assert.equal(store.beginAudit({ day: '2026-10-19' }).id, audit.id, 'unfinished work resumes before creating another audit');
    const pending = store.auditBatch({ auditId: audit.id, limit: 100 }).items;
    assert.equal(pending.length, 2);
    assert.ok(pending.every(row => row.id !== hidden.id && row.id !== first.id));
    const completed = store.applyAuditBatch({ auditId: audit.id, observations: pending.map((row, index) => lookup(row.id,
      index ? { outcome: 'error', error: 'Temporary failure' } : {})), expectedRevision: store.snapshot().revision });
    assert.equal(completed.audit.processed, 3);
    assert.equal(completed.audit.errors, 1);
    assert.ok(completed.audit.completedAt);
    assert.equal(store.auditBatch({ auditId: audit.id }).items.length, 0);
    assert.deepEqual(store.beginAudit({ day: '2026-10-18' }), completed.audit);
    const tomorrow = store.beginAudit({ day: '2026-10-19' });
    assert.notEqual(tomorrow.id, audit.id);
    assert.equal(tomorrow.processed, 0);
    assert.equal(tomorrow.total, 3);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(resolve(work) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate, stale, or already-completed audit results cannot partially advance the queue', () => withStore(store => {
  const a = chat('a'), b = chat('b');
  seed(store, [a, b]);
  const audit = store.beginAudit({ day: '2026-10-18' });
  const before = store.snapshot();
  const duplicate = lookup(a.id, { title: 'Changed title' });
  assert.throws(() => store.applyAuditBatch({ auditId: audit.id, observations: [duplicate, duplicate], expectedRevision: before.revision }),
    { code: 'INVALID_AUDIT' });
  assert.equal(store.auditBatch({ auditId: audit.id }).items.length, 2);
  assert.deepEqual(store.snapshot(), before);
  assert.throws(() => store.applyAuditBatch({ auditId: audit.id, observations: [duplicate], expectedRevision: before.revision - 1 }),
    { code: 'STALE_REVISION' });
  assert.equal(store.maintenanceState().audit.processed, 0);
  store.applyAuditBatch({ auditId: audit.id, observations: [lookup(a.id)], expectedRevision: before.revision });
  const pending = store.auditBatch({ auditId: audit.id });
  assert.throws(() => store.applyAuditBatch({ auditId: audit.id, observations: [lookup(b.id), duplicate], expectedRevision: before.revision }),
    { code: 'INVALID_AUDIT' });
  assert.deepEqual(store.auditBatch({ auditId: audit.id }), pending);
}));

test('maintenance leases exclude another connection without changing saved organization or revision', () => withSharedStores((first, second) => {
  const c = chat('lease', { projectId: 'p' });
  let state = seed(first, [c, project('p')]);
  state = first.setCategory({ id: c.id, category: 'Travel', expectedRevision: state.revision });
  state = first.setFocus({ id: c.id, focused: true, expectedRevision: state.revision });
  state = first.reorderCategories({ ids: roots(state).reverse(), expectedRevision: state.revision });
  const maintenance = first.maintenanceState();
  const lease = first.acquireMaintenanceLease();
  assert.equal(lease.acquired, true);
  assert.equal(second.acquireMaintenanceLease().acquired, false);
  assert.equal(second.assertMaintenanceLease(lease.token).token, lease.token);
  assert.deepEqual(second.snapshot(), state);
  assert.deepEqual(second.maintenanceState(), maintenance);
  assert.deepEqual(first.releaseMaintenanceLease({ token: lease.token }), { released: true });
  const successor = second.acquireMaintenanceLease();
  assert.equal(successor.acquired, true);
  assert.notEqual(successor.token, lease.token);
  assert.deepEqual(first.snapshot(), state);
  assert.deepEqual(second.maintenanceState(), maintenance);
}));

test('an expired lease is rejected and its delayed release cannot remove a newer lease', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(14)) });
  withSharedStores((first, second) => {
    seed(first, [chat('expiration')]);
    const before = first.snapshot();
    const old = first.acquireMaintenanceLease({ ttlMs: 1000 });
    t.mock.timers.tick(1000);
    assert.throws(() => first.assertMaintenanceLease(old.token), { code: 'LEASE_LOST' });
    assert.throws(() => first.renewMaintenanceLease({ token: old.token }), { code: 'LEASE_LOST' });
    const current = second.acquireMaintenanceLease();
    assert.equal(current.acquired, true);
    assert.notEqual(current.token, old.token);
    assert.deepEqual(first.releaseMaintenanceLease({ token: old.token }), { released: false });
    assert.equal(second.assertMaintenanceLease(current.token).token, current.token);
    assert.equal(first.acquireMaintenanceLease().acquired, false);
    assert.deepEqual(first.snapshot(), before);
  });
});

test('renewal keeps the same run exclusive after its original lease deadline', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(15)) });
  withSharedStores((first, second) => {
    seed(first, [chat('renewal')]);
    const before = first.snapshot();
    const lease = first.acquireMaintenanceLease({ ttlMs: 1000 });
    t.mock.timers.tick(500);
    const renewed = first.renewMaintenanceLease({ token: lease.token });
    assert.equal(renewed.token, lease.token);
    assert.ok(renewed.expiresAt > lease.expiresAt);
    t.mock.timers.tick(501);
    assert.equal(second.assertMaintenanceLease(lease.token).token, lease.token);
    assert.equal(second.acquireMaintenanceLease().acquired, false);
    assert.deepEqual(second.snapshot(), before);
    assert.deepEqual(first.releaseMaintenanceLease({ token: lease.token }), { released: true });
    assert.equal(second.acquireMaintenanceLease().acquired, true);
  });
});

test('unknown lease tokens cannot renew, release, or impersonate an active maintenance run', () => withStore(store => {
  seed(store, [chat('unknown-token')]);
  const before = store.snapshot();
  const lease = store.acquireMaintenanceLease();
  for (const token of [null, '', 'different-run']) {
    assert.throws(() => store.assertMaintenanceLease(token), { code: 'LEASE_LOST' });
    assert.throws(() => store.renewMaintenanceLease({ token }), { code: 'LEASE_LOST' });
    assert.deepEqual(store.releaseMaintenanceLease({ token }), { released: false });
  }
  assert.equal(store.assertMaintenanceLease(lease.token).token, lease.token);
  assert.deepEqual(store.snapshot(), before);
}));


test('UUID fallback titles cannot replace a recovered Codex description; real source titles still apply', () => withStore(store => {
 const sourceId='00000000-0000-4000-8000-000000000002';
 const c={id:'codex:chat:'+sourceId,source:'codex',sourceId,kind:'chat',title:sourceId,hostId:'durable'};
 let state=seed(store,[c]);
 state=store.setCategory({id:c.id,category:'Travel',expectedRevision:state.revision});
 state=store.setFocus({id:c.id,focused:true,expectedRevision:state.revision});
 const repaired=sync(store,[lookup(c.id,{title:'Compare sample drawing tools'})]);
 assert.equal(repaired.renamed,1);
 for(const evidence of ['sidebar','probe']) {
  const result=sync(store,[{id:c.id,sourceId,evidence,outcome:'found',observedAt:at(12),title:sourceId}]);
  assert.equal(result.renamed,0); assert.equal(item(store,c.id).title,'Compare sample drawing tools');
  assert.equal(item(store,c.id).category,'Travel'); assert.equal(item(store,c.id).focused,true);
 }
 const renamed=sync(store,[lookup(c.id,{title:'Actual new source title',observedAt:at(13)})]);
 assert.equal(renamed.renamed,1); assert.equal(item(store,c.id).title,'Actual new source title');
}));
