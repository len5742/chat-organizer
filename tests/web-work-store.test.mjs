import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStore } from '../store.mjs';

// Pure store regressions use separate in-memory catalogs. The live catalog,
// source conversations, and source files are never changed by these tests.
const webId = '00000000-0000-4000-8000-000000000005';
const cloudId = '00000000-0000-4000-8000-000000000003';
const web = { id: 'chatgpt:chat:' + webId, source: 'chatgpt', sourceId: webId, kind: 'chat', title: 'Compare sample notebook layouts', webConversationId: webId };
const cloud = { id: 'codex:chat:' + cloudId, source: 'codex', sourceId: cloudId, kind: 'chat', hostId: 'durable', title: 'Plan a sample notebook layout', webConversationId: webId };
const at = seconds => new Date(Date.UTC(2026, 9, 19, 0, 0, seconds)).toISOString();
const plain = item => { const { webConversationId, ...rest } = item; return rest; };
const fixture = action => { const store = new CatalogStore(':memory:'); try { return action(store); } finally { store.close(); } };
const snapshot = store => store.snapshot();
const apply = (store, observations) => store.applySync({ observations, expectedRevision: snapshot(store).revision, mode: 'recent', coverage: 'Controlled web Work regression observations' });
const rawOrganization = store => store.db.prepare('SELECT id,category,focused FROM catalog_items ORDER BY id').all().map(row => ({ ...row }));
function seedPair(store) {
  store.importInventory({ items: [web, cloud], coverage: 'Confirmed web Work pair fixture' });
}
function setCategory(store, id, category) { return store.setCategory({ id, category, expectedRevision: snapshot(store).revision }); }
function setFocus(store, id, focused) { return store.setFocus({ id, focused, expectedRevision: snapshot(store).revision }); }
function item(store, id) { return snapshot(store).items.find(row => row.id === id); }
// Model saved conflicts from before linked edits were atomic, or relationships
// established after two records had independently been organized.
function legacyConflict(store) {
  store.db.prepare('UPDATE catalog_items SET category = ?, focused = 1 WHERE id = ?').run('Travel', cloud.id);
}

test('web Work mapping hides an equivalent alias and retains both stable records', () => fixture(store => {
  seedPair(store);
  assert.deepEqual(snapshot(store).items.map(row => row.id), [web.id]);
  assert.equal(item(store, web.id).webConversationId, webId);
  assert.deepEqual(rawOrganization(store), [cloud.id, web.id].sort().map(id => ({ id, category: 'Uncategorized', focused: 0 })));
  setCategory(store, web.id, 'Travel'); setCategory(store, cloud.id, 'Travel');
  setFocus(store, web.id, true); setFocus(store, cloud.id, true);
  assert.deepEqual(snapshot(store).items.map(row => row.id), [web.id]);
  assert.deepEqual(rawOrganization(store), [cloud.id, web.id].sort().map(id => ({ id, category: 'Travel', focused: 1 })));
}));

test('legacy organization conflicts stay visible until explicit edits resolve each field', () => fixture(store => {
  seedPair(store); legacyConflict(store);
  assert.equal(snapshot(store).items.length, 2);
  setCategory(store, web.id, 'Travel');
  assert.equal(snapshot(store).items.length, 2, 'Category edit must retain a different focus choice');
  assert.equal(item(store, cloud.id).focused, true); assert.equal(item(store, web.id).focused, false);
  setFocus(store, web.id, true); assert.equal(snapshot(store).items.length, 1);
}));

test('web Work mapping survives omitted fields in partial synchronization and imports', () => fixture(store => {
  seedPair(store); setCategory(store, cloud.id, 'Travel'); setFocus(store, cloud.id, true);
  const beforeOrganization = rawOrganization(store);
  apply(store, [{ id: cloud.id, title: 'Better actual source title', evidence: 'sidebar', outcome: 'found', observedAt: at(1) },
    { id: web.id, evidence: 'probe', outcome: 'found', observedAt: at(1) }]);
  assert.equal(store.db.prepare('SELECT web_conversation_id FROM catalog_items WHERE id=?').get(cloud.id).web_conversation_id, webId); assert.equal(item(store, web.id).webConversationId, webId);
  store.importInventory({ items: [{ ...plain(cloud), title: 'Partial import title' }], coverage: 'Partial import without relationship metadata' });
  assert.equal(store.db.prepare('SELECT web_conversation_id FROM catalog_items WHERE id=?').get(cloud.id).web_conversation_id, webId); assert.equal(item(store, web.id).webConversationId, webId);
  assert.deepEqual(rawOrganization(store), beforeOrganization);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM catalog_items').get().n, 2);
}));

test('web Work mapping validation rejects invalid IDs atomically on import and synchronization', () => fixture(store => {
  seedPair(store);
  const before = snapshot(store), beforeOrganization = rawOrganization(store);
  const invalidValues = ['not-a-uuid', 'https://chatgpt.com/c/' + webId, webId + '?hostId=local', '', 42, {}];
  for (const value of invalidValues) {
    assert.throws(() => store.importInventory({ items: [{ ...web, title: 'Must not be committed' }, { ...cloud, webConversationId: value }], coverage: 'Invalid mapping import' }));
    assert.deepEqual(snapshot(store), before); assert.deepEqual(rawOrganization(store), beforeOrganization);
    assert.throws(() => apply(store, [{ id: web.id, title: 'Must not be committed', evidence: 'sidebar', outcome: 'found', observedAt: at(1) },
      { id: cloud.id, webConversationId: value, evidence: 'sidebar', outcome: 'found', observedAt: at(1) }]));
    assert.deepEqual(snapshot(store), before); assert.deepEqual(rawOrganization(store), beforeOrganization);
  }
}));

test('unknown durable chats and same-title chats never acquire an inferred web Work mapping', () => fixture(store => {
  const otherId = '00000000-0000-4000-8000-000000000001';
  store.importInventory({ items: [plain(web), plain(cloud), { ...plain(cloud), id: 'codex:chat:' + otherId, sourceId: otherId }], coverage: 'Unmapped same-title durable records' });
  assert.equal(snapshot(store).items.length, 3);
  for (const row of snapshot(store).items.filter(row => row.source === 'codex')) assert.equal(Object.hasOwn(row, 'webConversationId'), false);
  assert.equal(item(store, cloud.id).hostId, 'durable');
}));

test('mapped alias remains visible when its canonical web record has not been imported', () => fixture(store => {
  store.importInventory({ items: [cloud], coverage: 'Known web destination with no canonical catalog row yet' });
  assert.deepEqual(snapshot(store).items.map(row => row.id), [cloud.id]);
  assert.equal(item(store, cloud.id).webConversationId, webId);
}));

for (const outcome of ['not_found', 'archived']) {
  test('canonical web chat ' + outcome + ' suppresses the mapped alias even when organization differs', () => fixture(store => {
    seedPair(store); legacyConflict(store);
    const beforeOrganization = rawOrganization(store);
    apply(store, [{ id: web.id, evidence: outcome === 'archived' ? 'archive_list' : 'probe', outcome, observedAt: at(1) }]);
    assert.deepEqual(snapshot(store).items, []);
    apply(store, [{ id: cloud.id, evidence: 'probe', outcome: 'found', observedAt: at(2) }]);
    assert.deepEqual(snapshot(store).items, [], 'Readable cloud alias must not bypass canonical deletion or archive state');
    assert.deepEqual(rawOrganization(store), beforeOrganization);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM catalog_items').get().n, 2);
  }));
}

test('conclusively missing chats hide while missing projects remain visible with their marker', () => fixture(store => {
  const project = { id: 'codex:project:missing-project', source: 'codex', sourceId: 'missing-project', kind: 'project', title: 'Missing project' };
  store.importInventory({ items: [plain(web), project], coverage: 'Missing chat and project fixture' });
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'not_found', observedAt: at(1) },
    { id: project.id, evidence: 'project_list_complete', outcome: 'not_found', observedAt: at(1) }]);
  assert.equal(item(store, web.id), undefined);
  assert.equal(item(store, project.id).availability, 'not_found');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM catalog_items').get().n, 2);
}));

test('transient verification errors preserve visible chats and their saved organization', () => fixture(store => {
  store.importInventory({ items: [plain(web)], coverage: 'Visible chat error fixture' });
  setCategory(store, web.id, 'Health'); setFocus(store, web.id, true);
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'error', error: 'Could not determine whether Codex thread exists. Unavailable or failed hosts: durable', observedAt: at(1) }]);
  const row = item(store, web.id);
  assert.equal(row.availability, 'available'); assert.equal(row.category, 'Health'); assert.equal(row.focused, true);
  assert.match(row.lastCheckError, /Unavailable or failed hosts/);
}));

test('weak found observations cannot revive a missing chat; direct probes restore saved organization', () => fixture(store => {
  store.importInventory({ items: [plain(web)], coverage: 'Hidden chat restoration fixture' });
  setCategory(store, web.id, 'Health'); setFocus(store, web.id, true);
  const beforeOrganization = rawOrganization(store);
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'not_found', observedAt: at(1) }]);
  let clock = 2;
  for (const evidence of ['sidebar', 'chatgpt_cache', 'local_index']) {
    apply(store, [{ id: web.id, evidence, outcome: 'found', observedAt: at(clock++) }]);
    assert.equal(item(store, web.id), undefined, evidence + ' must not revive the chat');
  }
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'error', error: 'Permission denied', observedAt: at(clock++) }]);
  assert.equal(item(store, web.id), undefined, 'An error must not undo a confirmed missing state');
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'found', observedAt: at(clock++) }]);
  assert.equal(item(store, web.id).availability, 'available');
  assert.equal(item(store, web.id).category, 'Health'); assert.equal(item(store, web.id).focused, true);
  assert.deepEqual(rawOrganization(store), beforeOrganization);
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'not_found', observedAt: at(clock++) }]);
  apply(store, [{ id: web.id, evidence: 'local_lookup', outcome: 'found', observedAt: at(clock++) }]);
  assert.equal(item(store, web.id).availability, 'available'); assert.deepEqual(rawOrganization(store), beforeOrganization);
}));

test('restoring a canonical web record restores the visible pair according to preserved organization', () => fixture(store => {
  seedPair(store); legacyConflict(store);
  const beforeOrganization = rawOrganization(store);
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'not_found', observedAt: at(1) }]);
  assert.equal(snapshot(store).items.length, 0);
  apply(store, [{ id: web.id, evidence: 'probe', outcome: 'found', observedAt: at(2) }]);
  assert.equal(snapshot(store).items.length, 2, 'Different organization is retained after restoration');
  assert.equal(item(store, cloud.id).category, 'Travel'); assert.equal(item(store, cloud.id).focused, true);
  assert.deepEqual(rawOrganization(store), beforeOrganization);
}));

test('UUID fallback cannot overwrite a recovered cloud description or its confirmed web mapping', () => fixture(store => {
  seedPair(store); legacyConflict(store);
  apply(store, [{ id: cloud.id, title: cloudId, evidence: 'sidebar', outcome: 'found', observedAt: at(1) }]);
  assert.equal(item(store, cloud.id).title, cloud.title); assert.equal(item(store, cloud.id).webConversationId, webId);
  apply(store, [{ id: cloud.id, title: 'Real source title arrived later', evidence: 'probe', outcome: 'found', observedAt: at(2) }]);
  assert.equal(item(store, cloud.id).title, 'Real source title arrived later'); assert.equal(item(store, cloud.id).webConversationId, webId);
}));
