import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore, validateItem, isProjectMember } from '../store.mjs';

const chat = (sourceId, extra = {}) => ({ id: `chatgpt:chat:${sourceId}`, source: 'chatgpt', sourceId, title: `Chat ${sourceId}`, kind: 'chat', url: `https://chatgpt.com/c/${sourceId}`, ...extra });
const project = (sourceId, extra = {}) => ({ id: `chatgpt:project:${sourceId}`, source: 'chatgpt', sourceId, title: `Project ${sourceId}`, kind: 'project', ...extra });
const codexChat = (sourceId, extra = {}) => ({ id: `codex:chat:${sourceId}`, source: 'codex', sourceId, title: `Local ${sourceId}`, kind: 'chat', url: `codex://threads/${sourceId}`, ...extra });
const withStore = fn => { const store = new CatalogStore(':memory:'); try { fn(store); } finally { store.close(); } };
const rootIds = snapshot => snapshot.categories.filter(category => category.parentId === null).map(category => category.id);

test('focus migration preserves prior rows, metadata, and deletion Undo without a revision change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-focus-migration-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE catalog_items (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, host_id TEXT,
      url TEXT, updated_at TEXT, category TEXT NOT NULL DEFAULT 'Uncategorized'
    ); CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE catalog_categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES catalog_categories(id), name_key TEXT NOT NULL
    );
    INSERT INTO catalog_categories VALUES ('Uncategorized', 'Uncategorized', NULL, 'uncategorized'), ('Travel', 'Travel', NULL, 'travel');
    INSERT INTO catalog_items (id,source,source_id,title,kind,category,project_id,updated_at) VALUES
      ('chatgpt:chat:old','chatgpt','old','Old chat','chat','Uncategorized','p','2026-10-17T12:00:00Z'),
      ('chatgpt:project:p','chatgpt','p','Project','project','Travel',NULL,NULL);`);
    const undo = { token: 'legacy-delete', label: 'Health', revision: 11,
      categories: [{ id: 'Health', name: 'Health', parentId: null }],
      assignments: [{ id: 'chatgpt:chat:old', category: 'Health' }], rootOrder: ['Health', 'Uncategorized', 'Travel'] };
    const metadata = { revision: '11', savedAt: '2026-10-17T13:00:00.000Z', categoriesVersion: '1',
      rootCategoryOrder: JSON.stringify(['Uncategorized', 'Travel']), undoDelete: JSON.stringify(undo),
      lastImport: JSON.stringify({ at: '2026-10-17T12:00:00Z', coverage: 'old import', count: 2 }),
      lastImportFingerprint: 'old-fingerprint', customMetadata: 'preserve me' };
    const insert = legacy.prepare('INSERT INTO catalog_meta VALUES (?, ?)');
    for (const [key, value] of Object.entries(metadata)) insert.run(key, value);
    const oldRows = legacy.prepare('SELECT * FROM catalog_items ORDER BY id').all().map(row => ({ ...row }));
    legacy.close();

    store = new CatalogStore(path);
    const migrated = store.snapshot();
    assert.equal(migrated.revision, 11);
    assert.equal(migrated.savedAt, metadata.savedAt);
    assert.deepEqual(Object.fromEntries(store.db.prepare('SELECT key, value FROM catalog_meta').all().map(row => [row.key, row.value])), metadata);
    assert.deepEqual(store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all().map(({ focused, web_conversation_id, chatgpt_project_id, ...row }) => { assert.equal(web_conversation_id,null); assert.equal(chatgpt_project_id,null); return row; }), oldRows);
    assert.ok(migrated.items.every(item => item.focused === false));
    const column = store.db.prepare('PRAGMA table_info(catalog_items)').all().find(column => column.name === 'focused');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, '0');
    assert.throws(() => store.db.prepare('UPDATE catalog_items SET focused = 2 WHERE kind = ?').run('chat'), /CHECK constraint/);
    assert.throws(() => store.db.prepare('UPDATE catalog_items SET focused = 1 WHERE kind = ?').run('project'), /CHECK constraint/);
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), migrated, 'repeated migration is a no-op');
    const restored = store.undoDeleteCategory({ token: undo.token, expectedRevision: migrated.revision });
    assert.equal(restored.items.find(item => item.kind === 'chat').category, 'Health');
    assert.ok(restored.items.every(item => item.focused === false));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('focus uses explicit booleans, is idempotent, and does not count as source activity', () => withStore(store => {
  const initial = store.importInventory({ items: [chat('a', { projectId: 'p', updatedAt: '2026-10-17T12:00:00Z' }), project('p')], coverage: 'focus samples' });
  const id = 'chatgpt:chat:a';
  assert.deepEqual(store.setFocus({ id, focused: false, expectedRevision: initial.revision }), initial);
  const marked = store.setFocus({ id, focused: true, expectedRevision: initial.revision });
  assert.equal(marked.revision, initial.revision + 1);
  assert.equal(marked.items.find(item => item.id === id).focused, true);
  assert.equal(marked.items.find(item => item.kind === 'project').focused, false);
  assert.deepEqual(marked.items.map(({ focused, ...item }) => item), initial.items.map(({ focused, ...item }) => item));
  assert.deepEqual(marked.lastImport, initial.lastImport);
  assert.deepEqual(store.setFocus({ id, focused: true, expectedRevision: marked.revision }), marked);
  assert.throws(() => store.setFocus({ id, focused: true, expectedRevision: initial.revision }), { code: 'STALE_REVISION' });
  for (const focused of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
    assert.throws(() => store.setFocus({ id, focused, expectedRevision: marked.revision }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => store.setFocus({ id, focused: false, expectedRevision: -1 }), { code: 'INVALID_REVISION' });
  assert.throws(() => store.setFocus({ id: 'chatgpt:chat:missing', focused: true, expectedRevision: marked.revision }), { code: 'NOT_FOUND' });
  for (const focused of [true, false]) {
    assert.throws(() => store.setFocus({ id: 'chatgpt:project:p', focused, expectedRevision: marked.revision }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(store.snapshot(), marked, 'all rejected changes leave the catalog intact');
  const cleared = store.setFocus({ id, focused: false, expectedRevision: marked.revision });
  assert.equal(cleared.revision, marked.revision + 1);
  assert.deepEqual(cleared.items, initial.items);
}));

test('focus persists across restart, metadata import, activity refresh, and category moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-focus-persist-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [chat('web', { focused: true }), codexChat('local', { projectId: 'p' }), project('p', { focused: true })], coverage: 'initial' });
    assert.ok(state.items.every(item => item.focused === false), 'imports cannot assign local focus, even for new chats');
    for (const id of ['chatgpt:chat:web', 'codex:chat:local']) state = store.setFocus({ id, focused: true, expectedRevision: state.revision });
    state = store.setCategory({ id: 'chatgpt:chat:web', category: 'Travel', expectedRevision: state.revision });
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), state);
    state = store.importInventory({ items: [chat('web', { title: 'New web title', focused: false, updatedAt: '2026-10-18T12:00:00Z' })], coverage: 'partial refresh' });
    assert.equal(state.items.find(item => item.sourceId === 'web').focused, true);
    assert.equal(state.items.find(item => item.sourceId === 'web').category, 'Travel');
    assert.equal(state.items.find(item => item.sourceId === 'local').focused, true, 'omitted chat retains focus');
    state = store.refreshLocalActivity({ records: [{ id: 'codex:chat:local', title: 'New local title', updatedAt: '2026-10-18T13:00:00Z' }], attempted: 1, checked: 1, unavailable: 0, expectedRevision: state.revision });
    assert.equal(state.items.find(item => item.sourceId === 'local').focused, true);
    assert.equal(state.items.find(item => item.sourceId === 'local').projectId, 'p');
    state = store.setCategory({ id: 'codex:chat:local', category: 'Health', expectedRevision: state.revision });
    assert.ok(state.items.filter(item => item.kind === 'chat').every(item => item.focused));
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), state);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('focus changes retain deletion Undo across restart and Undo retains current focus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-focus-undo-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [codexChat('a'), chat('b')], coverage: 'undo samples' });
    for (const id of ['codex:chat:a', 'chatgpt:chat:b']) state = store.setCategory({ id, category: 'Travel', expectedRevision: state.revision });
    state = store.setFocus({ id: 'codex:chat:a', focused: true, expectedRevision: state.revision });
    const deleted = store.deleteCategory({ id: 'Travel', expectedRevision: state.revision });
    assert.equal(deleted.items.find(item => item.id === 'codex:chat:a').focused, true);
    state = store.setFocus({ id: 'codex:chat:a', focused: false, expectedRevision: deleted.revision });
    state = store.setFocus({ id: 'chatgpt:chat:b', focused: true, expectedRevision: state.revision });
    assert.deepEqual(state.undoDelete, deleted.undoDelete);
    assert.deepEqual(store.setFocus({ id: 'chatgpt:chat:b', focused: true, expectedRevision: state.revision }), state);
    state = store.refreshLocalActivity({ records: [{ id: 'codex:chat:a', title: 'Changed source title' }], attempted: 1, checked: 1, unavailable: 0, expectedRevision: state.revision });
    store.close();
    store = new CatalogStore(path);
    const restored = store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: state.revision });
    assert.ok(restored.items.every(item => item.category === 'Travel'));
    assert.equal(restored.items.find(item => item.id === 'codex:chat:a').focused, false);
    assert.equal(restored.items.find(item => item.id === 'codex:chat:a').title, 'Changed source title');
    assert.equal(restored.items.find(item => item.id === 'chatgpt:chat:b').focused, true);
    assert.equal(restored.undoDelete, null);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('focus and category writers enforce the current revision across database connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-focus-race-'));
  const first = new CatalogStore(join(dir, 'catalog.sqlite'));
  const second = new CatalogStore(join(dir, 'catalog.sqlite'));
  try {
    const initial = first.importInventory({ items: [chat('a')], coverage: 'initial' });
    const focused = second.setFocus({ id: 'chatgpt:chat:a', focused: true, expectedRevision: initial.revision });
    assert.throws(() => first.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: initial.revision }), { code: 'STALE_REVISION' });
    assert.throws(() => first.setFocus({ id: 'chatgpt:chat:a', focused: false, expectedRevision: initial.revision }), { code: 'STALE_REVISION' });
    assert.deepEqual(first.snapshot(), focused);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('catalog and saved classification persist after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-test-'));
  const dbPath = join(dir, 'catalog.sqlite');
  try {
    const first = new CatalogStore(dbPath);
    const imported = first.importInventory({ items: [chat('a')], coverage: 'one sample' });
    const saved = first.setCategory({ id: 'chatgpt:chat:a', category: 'Health', expectedRevision: imported.revision });
    first.close();
    const reopened = new CatalogStore(dbPath);
    assert.deepEqual(reopened.snapshot(), saved);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reimports refresh metadata while preserving categories and omitted items', () => withStore(store => {
  const initial = store.importInventory({ items: [chat('a'), chat('b')], coverage: 'two available chats' });
  store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: initial.revision });
  const refreshed = store.importInventory({ items: [chat('a', { title: 'Renamed trip' })], coverage: 'partial: one available chat' });
  assert.equal(refreshed.items.length, 2);
  assert.equal(refreshed.items.find(item => item.sourceId === 'a').title, 'Renamed trip');
  assert.equal(refreshed.items.find(item => item.sourceId === 'a').category, 'Travel');
  assert.equal(refreshed.items.find(item => item.sourceId === 'b').category, 'Uncategorized');
  assert.deepEqual(refreshed.lastImport.coverage, 'partial: one available chat');
  assert.equal(refreshed.lastImport.count, 1);
  assert.deepEqual(store.importInventory({ items: [chat('a', { title: 'Renamed trip' })], coverage: 'partial: one available chat' }), refreshed);
}));

test('duplicate IDs reject the entire import before any item or metadata changes', () => withStore(store => {
  store.importInventory({ items: [chat('a')], coverage: 'initial' });
  const before = store.snapshot();
  assert.throws(() => store.importInventory({ items: [chat('new'), chat('a'), chat('a', { title: 'Duplicate' })], coverage: 'duplicate import' }), { code: 'DUPLICATE_ID' });
  assert.deepEqual(store.snapshot(), before);
}));

test('narrow metadata imports preserve known navigation, project association, activity date, and category', () => withStore(store => {
  const complete = chat('a', { projectId: 'project-a', hostId: 'local', updatedAt: '2026-10-17T12:00:00.000Z' });
  const initial = store.importInventory({ items: [complete], coverage: 'complete metadata for one chat' });
  store.setCategory({ id: complete.id, category: 'Travel', expectedRevision: initial.revision });
  const narrow = { id: complete.id, source: complete.source, sourceId: complete.sourceId, title: 'Updated title', kind: complete.kind };
  const refreshed = store.importInventory({ items: [narrow], coverage: 'title and identity only' });
  assert.deepEqual(refreshed.items[0], { ...complete, title: 'Updated title', category: 'Travel', effectiveUpdatedAt: complete.updatedAt, focused: false, availability:'available', lastCheckedAt:null, lastCheckError:null });
  const explicitNulls = store.importInventory({ items: [{ ...narrow, projectId: null, hostId: null, url: null, updatedAt: null }], coverage: 'unavailable optional metadata' });
  assert.deepEqual(explicitNulls.items[0], {...refreshed.items[0],projectId:null});
  const newer = store.importInventory({ items: [{ ...narrow, projectId: 'project-b', hostId: 'remote', url: 'https://chatgpt.com/c/updated', updatedAt: '2026-10-17T13:00:00.000Z' }], coverage: 'newer complete metadata' });
  assert.equal(newer.items[0].projectId, 'project-b');
  assert.equal(newer.items[0].hostId, 'remote');
  assert.equal(newer.items[0].url, 'https://chatgpt.com/c/updated');
  assert.equal(newer.items[0].updatedAt, '2026-10-17T13:00:00.000Z');
  assert.equal(newer.items[0].category, 'Travel');
}));

test('invalid items reject an entire import atomically', () => withStore(store => {
  const before = store.snapshot();
  assert.throws(() => store.importInventory({ items: [chat('new'), chat('bad', { url: 'https://example.org/' })], coverage: 'bad URL' }), { code: 'INVALID_URL' });
  assert.deepEqual(store.snapshot(), before);
}));

test('stale edits reject without overwriting the category', () => withStore(store => {
  const initial = store.importInventory({ items: [chat('a')], coverage: 'initial' });
  const saved = store.setCategory({ id: 'chatgpt:chat:a', category: 'Finance', expectedRevision: initial.revision });
  assert.throws(() => store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: initial.revision }), { code: 'STALE_REVISION' });
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(store.setCategory({ id: 'chatgpt:chat:a', category: 'Finance', expectedRevision: saved.revision }), saved);
}));

test('cross-connection writes enforce the latest revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-concurrency-'));
  const first = new CatalogStore(join(dir, 'catalog.sqlite'));
  const second = new CatalogStore(join(dir, 'catalog.sqlite'));
  try {
    const imported = first.importInventory({ items: [chat('a')], coverage: 'initial' });
    second.setCategory({ id: 'chatgpt:chat:a', category: 'Projects', expectedRevision: imported.revision });
    assert.throws(() => first.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: imported.revision }), { code: 'STALE_REVISION' });
    assert.equal(first.snapshot().items[0].category, 'Projects');
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('IDs and links are constrained to supported sources and schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://chatgpt.com.evil.test/c/a', 'https://evil.test/', 'https://user:pass@chatgpt.com/c/a', 'http://chatgpt.com/c/a', 'https://chatgpt.com:8443/c/a', 'codex://settings/anything']) {
    assert.throws(() => validateItem(chat('a', { url })), { code: 'INVALID_URL' }, url);
  }
  assert.equal(validateItem(chat('a')).url, 'https://chatgpt.com/c/a');
  assert.equal(validateItem({ id: 'codex:chat:abc', source: 'codex', sourceId: 'abc', title: 'Local work', kind: 'chat', url: 'codex://threads/abc' }).url, 'codex://threads/abc');
  assert.throws(() => validateItem(chat('a', { id: 'codex:chat:a' })), { code: 'INVALID_ID' });
});

test('unknown category and missing item are rejected without revision changes', () => withStore(store => {
  const initial = store.importInventory({ items: [chat('a')], coverage: 'initial' });
  assert.throws(() => store.setCategory({ id: 'chatgpt:chat:a', category: 'Made up', expectedRevision: initial.revision }), { code: 'INVALID_CATEGORY' });
  assert.throws(() => store.setCategory({ id: 'chatgpt:chat:missing', category: 'Health', expectedRevision: initial.revision }), { code: 'NOT_FOUND' });
  assert.deepEqual(store.snapshot(), initial);
}));

test('legacy catalog migrates once without changing saved assignments or revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-migration-'));
  const path = join(dir, 'catalog.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE catalog_items (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, host_id TEXT,
      url TEXT, updated_at TEXT, category TEXT NOT NULL DEFAULT 'Uncategorized'
    ); CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO catalog_meta VALUES ('revision', '7'), ('savedAt', '2026-10-17T12:00:00.000Z');
    INSERT INTO catalog_items (id,source,source_id,title,kind,category) VALUES ('chatgpt:chat:legacy','chatgpt','legacy','Legacy trip','chat','Travel');`);
    legacy.close();
    const migrated = new CatalogStore(path);
    const snapshot = migrated.snapshot();
    assert.equal(snapshot.revision, 7);
    assert.equal(snapshot.savedAt, '2026-10-17T12:00:00.000Z');
    assert.equal(snapshot.items[0].category, 'Travel');
    assert.deepEqual(snapshot.categories.map(category => category.id), ['Health', 'Travel', 'Finance', 'Uncategorized', 'Projects', 'Trash']);
    const deleted = migrated.deleteCategory({ id: 'Travel', expectedRevision: 7 });
    assert.equal(deleted.items[0].category, 'Uncategorized');
    migrated.close();
    const reopened = new CatalogStore(path);
    assert.deepEqual(reopened.snapshot(), deleted);
    assert.equal(reopened.snapshot().categories.some(category => category.id === 'Travel'), false);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new paths support three levels and reject excessive depth atomically', () => withStore(store => {
  const created = store.createCategoryPath({ parentId: null, names: ['Interests', 'Art', 'Painting'], expectedRevision: 0 });
  const interests = created.categories.find(category => category.name === 'Interests');
  const art = created.categories.find(category => category.name === 'Art');
  const painting = created.categories.find(category => category.name === 'Painting');
  assert.match(interests.id, /^category:/);
  assert.equal(interests.parentId, null);
  assert.equal(art.parentId, interests.id);
  assert.equal(painting.parentId, art.id);
  assert.equal(created.revision, 1);
  assert.throws(() => store.createCategoryPath({ parentId: painting.id, names: ['Oil'], expectedRevision: 1 }), { code: 'MAX_DEPTH' });
  assert.throws(() => store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy', 'Rome'], expectedRevision: 1 }), { code: 'MAX_DEPTH' });
  assert.deepEqual(store.snapshot(), created);
}));

test('duplicate sibling names ignore case and normalized Unicode but allow different parents', () => withStore(store => {
  const created = store.createCategoryPath({ parentId: 'Travel', names: [' Café '], expectedRevision: 0 });
  const cafe = created.categories.find(category => category.name === 'Café');
  assert.ok(cafe);
  assert.throws(() => store.createCategoryPath({ parentId: 'Travel', names: ['CAFE\u0301'], expectedRevision: created.revision }), { code: 'DUPLICATE_CATEGORY' });
  assert.throws(() => store.createCategoryPath({ parentId: null, names: ['ＴＲＡＶＥＬ', 'Europe'], expectedRevision: created.revision }), { code: 'DUPLICATE_CATEGORY' });
  assert.deepEqual(store.snapshot(), created);
  const otherParent = store.createCategoryPath({ parentId: 'Health', names: ['Café'], expectedRevision: created.revision });
  assert.equal(otherParent.categories.filter(category => category.name === 'Café').length, 2);
  const rename = store.renameCategory({ id: cafe.id, name: 'CAFÉ', expectedRevision: otherParent.revision });
  assert.equal(rename.categories.find(category => category.id === cafe.id).name, 'CAFÉ');
}));

test('rename preserves stable IDs, nested assignments, and descendant links', () => withStore(store => {
  let state = store.importInventory({ items: [chat('trip')], coverage: 'one trip' });
  state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: state.revision });
  const europe = state.categories.find(category => category.name === 'Europe');
  const italy = state.categories.find(category => category.name === 'Italy');
  state = store.setCategory({ id: 'chatgpt:chat:trip', category: italy.id, expectedRevision: state.revision });
  state = store.renameCategory({ id: europe.id, name: 'European travel', expectedRevision: state.revision });
  assert.equal(state.items[0].category, italy.id);
  assert.equal(state.categories.find(category => category.id === italy.id).parentId, europe.id);
  assert.equal(state.categories.find(category => category.id === europe.id).name, 'European travel');
  assert.throws(() => store.renameCategory({ id: 'Health', name: 'Travel', expectedRevision: state.revision }), { code: 'DUPLICATE_CATEGORY' });
  assert.deepEqual(store.renameCategory({ id: europe.id, name: ' European travel ', expectedRevision: state.revision }), state);
}));

test('Uncategorized cannot be renamed, deleted, or given children', () => withStore(store => {
  const before = store.snapshot();
  assert.throws(() => store.renameCategory({ id: 'Uncategorized', name: 'Misc', expectedRevision: 0 }), { code: 'PROTECTED_CATEGORY' });
  assert.throws(() => store.deleteCategory({ id: 'Uncategorized', expectedRevision: 0 }), { code: 'PROTECTED_CATEGORY' });
  assert.throws(() => store.createCategoryPath({ parentId: 'Uncategorized', names: ['Child'], expectedRevision: 0 }), { code: 'PROTECTED_CATEGORY' });
  assert.deepEqual(store.snapshot(), before);
}));

test('deleting a subtree rehomes all its items and durable undo restores exact IDs and assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-undo-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [chat('root'), chat('child'), chat('grandchild'), chat('unrelated'), chat('unassigned')], coverage: 'five samples' });
    state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: state.revision });
    const europe = state.categories.find(category => category.name === 'Europe');
    const italy = state.categories.find(category => category.name === 'Italy');
    for (const [sourceId, category] of [['root', 'Travel'], ['child', europe.id], ['grandchild', italy.id], ['unrelated', 'Health']]) {
      state = store.setCategory({ id: `chatgpt:chat:${sourceId}`, category, expectedRevision: state.revision });
    }
    const original = state;
    const deleted = store.deleteCategory({ id: 'Travel', expectedRevision: state.revision });
    assert.equal(deleted.categories.some(category => ['Travel', europe.id, italy.id].includes(category.id)), false);
    assert.equal(deleted.items.filter(item => item.category === 'Uncategorized').length, 4);
    assert.equal(deleted.items.find(item => item.sourceId === 'unrelated').category, 'Health');
    assert.equal(deleted.undoDelete.label, 'Travel');
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), deleted);
    assert.throws(() => store.undoDeleteCategory({ token: 'wrong', expectedRevision: deleted.revision }), { code: 'UNDO_UNAVAILABLE' });
    assert.throws(() => store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: deleted.revision - 1 }), { code: 'STALE_REVISION' });
    assert.deepEqual(store.snapshot(), deleted);
    const undone = store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: deleted.revision });
    assert.deepEqual(undone.categories, original.categories);
    assert.deepEqual(undone.items, original.items);
    assert.equal(undone.undoDelete, null);
    assert.equal(undone.revision, deleted.revision + 1);
    assert.throws(() => store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: undone.revision }), { code: 'UNDO_UNAVAILABLE' });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deleting a middle branch keeps its parent and sibling branches', () => withStore(store => {
  let state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: 0 });
  const europe = state.categories.find(category => category.name === 'Europe');
  state = store.createCategoryPath({ parentId: 'Travel', names: ['Asia'], expectedRevision: state.revision });
  const deleted = store.deleteCategory({ id: europe.id, expectedRevision: state.revision });
  assert.ok(deleted.categories.find(category => category.id === 'Travel'));
  assert.ok(deleted.categories.find(category => category.name === 'Asia'));
  assert.equal(deleted.categories.some(category => ['Europe', 'Italy'].includes(category.name)), false);
}));

test('undo survives no-ops and failures but expires on successful category changes or imports', () => {
  for (const mutate of [
    (store, state) => store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: state.revision }),
    (store, state) => store.renameCategory({ id: 'Travel', name: 'Trips', expectedRevision: state.revision }),
    (store, state) => store.createCategoryPath({ parentId: null, names: ['New'], expectedRevision: state.revision }),
    store => store.importInventory({ items: [chat('new')], coverage: 'new item' }),
  ]) withStore(store => {
    let state = store.importInventory({ items: [chat('a')], coverage: 'initial' });
    state = store.deleteCategory({ id: 'Health', expectedRevision: state.revision });
    const token = state.undoDelete.token;
    assert.deepEqual(store.setCategory({ id: 'chatgpt:chat:a', category: 'Uncategorized', expectedRevision: state.revision }), state);
    assert.deepEqual(store.renameCategory({ id: 'Travel', name: 'Travel', expectedRevision: state.revision }), state);
    assert.deepEqual(store.importInventory({ items: [chat('a')], coverage: 'initial' }), state);
    assert.throws(() => store.createCategoryPath({ parentId: null, names: ['Travel'], expectedRevision: state.revision }), { code: 'DUPLICATE_CATEGORY' });
    assert.deepEqual(store.snapshot(), state);
    const changed = mutate(store, state);
    assert.equal(changed.undoDelete, null);
    assert.throws(() => store.undoDeleteCategory({ token, expectedRevision: changed.revision }), { code: 'UNDO_UNAVAILABLE' });
  });
});

test('only the latest branch deletion is undoable', () => withStore(store => {
  const first = store.deleteCategory({ id: 'Health', expectedRevision: 0 });
  const second = store.deleteCategory({ id: 'Finance', expectedRevision: first.revision });
  assert.notEqual(first.undoDelete.token, second.undoDelete.token);
  assert.throws(() => store.undoDeleteCategory({ token: first.undoDelete.token, expectedRevision: second.revision }), { code: 'UNDO_UNAVAILABLE' });
  const restored = store.undoDeleteCategory({ token: second.undoDelete.token, expectedRevision: second.revision });
  assert.ok(restored.categories.find(category => category.id === 'Finance'));
  assert.equal(restored.categories.some(category => category.id === 'Health'), false);
}));

test('undo fails atomically if an affected item was changed by an older or external writer', () => withStore(store => {
  const imported = store.importInventory({ items: [chat('a')], coverage: 'initial' });
  const assigned = store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: imported.revision });
  const deleted = store.deleteCategory({ id: 'Travel', expectedRevision: assigned.revision });
  store.db.prepare("UPDATE catalog_items SET category = 'Health' WHERE id = 'chatgpt:chat:a'").run();
  const before = store.snapshot();
  assert.throws(() => store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: deleted.revision }), { code: 'UNDO_CONFLICT' });
  assert.deepEqual(store.snapshot(), before, 'partial restored categories must roll back');
}));

test('nested categories survive partial imports with the same assigned IDs', () => withStore(store => {
  let state = store.importInventory({ items: [chat('a'), chat('b')], coverage: 'initial' });
  state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: state.revision });
  const italy = state.categories.find(category => category.name === 'Italy');
  state = store.setCategory({ id: 'chatgpt:chat:a', category: italy.id, expectedRevision: state.revision });
  const imported = store.importInventory({ items: [chat('b', { title: 'Refreshed B' })], coverage: 'partial' });
  assert.deepEqual(imported.categories, state.categories);
  assert.equal(imported.items.find(item => item.sourceId === 'a').category, italy.id);
  assert.equal(imported.items.length, 2);
}));

test('invalid and stale category changes leave the catalog untouched', () => withStore(store => {
  const state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe'], expectedRevision: 0 });
  for (const operation of [
    () => store.createCategoryPath({ parentId: null, names: ['New'], expectedRevision: 0 }),
    () => store.renameCategory({ id: 'Health', name: 'Wellness', expectedRevision: 0 }),
    () => store.deleteCategory({ id: 'Health', expectedRevision: 0 }),
  ]) assert.throws(operation, { code: 'STALE_REVISION' });
  assert.throws(() => store.createCategoryPath({ parentId: 'missing', names: ['New'], expectedRevision: state.revision }), { code: 'INVALID_CATEGORY' });
  assert.throws(() => store.createCategoryPath({ parentId: null, names: [], expectedRevision: state.revision }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.createCategoryPath({ parentId: null, names: ['Valid', '  '], expectedRevision: state.revision }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.renameCategory({ id: 'Travel', name: 'x\ny', expectedRevision: state.revision }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.renameCategory({ id: 'missing', name: 'Valid', expectedRevision: state.revision }), { code: 'INVALID_CATEGORY' });
  assert.throws(() => store.deleteCategory({ id: 'missing', expectedRevision: state.revision }), { code: 'INVALID_CATEGORY' });
  assert.deepEqual(store.snapshot(), state);
}));

test('root reordering persists without changing nested categories or item assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-order-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [chat('a'), chat('b')], coverage: 'ordering samples' });
    state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: state.revision });
    const italy = state.categories.find(category => category.name === 'Italy');
    state = store.createCategoryPath({ parentId: 'Travel', names: ['Asia'], expectedRevision: state.revision });
    state = store.setCategory({ id: 'chatgpt:chat:a', category: italy.id, expectedRevision: state.revision });
    const nested = state.categories.filter(category => category.parentId !== null);
    const requested = ['Projects', 'Uncategorized', 'Travel', 'Finance', 'Health', 'Trash'];
    const reordered = store.reorderCategories({ ids: requested, expectedRevision: state.revision });
    assert.deepEqual(rootIds(reordered), requested);
    assert.deepEqual(reordered.categories.filter(category => category.parentId !== null), nested);
    assert.deepEqual(reordered.items, state.items);
    assert.equal(reordered.revision, state.revision + 1);
    assert.deepEqual(reordered.lastImport, state.lastImport);
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), reordered);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('root order requires an exact permutation and rejects stale writes atomically', () => withStore(store => {
  const state = store.createCategoryPath({ parentId: 'Travel', names: ['Europe'], expectedRevision: 0 });
  const roots = rootIds(state);
  const child = state.categories.find(category => category.name === 'Europe').id;
  for (const ids of [
    [], roots.slice(1), roots.filter(id => id !== 'Uncategorized'),
    [...roots, 'extra'], [...roots, roots[0]], [...roots.slice(1), child],
    [...roots.slice(1), roots[1]], [null, ...roots.slice(1)], 'Travel',
  ]) {
    assert.throws(() => store.reorderCategories({ ids, expectedRevision: state.revision }), { code: 'INVALID_CATEGORY_ORDER' });
    assert.deepEqual(store.snapshot(), state);
  }
  assert.throws(() => store.reorderCategories({ ids: [...roots].reverse(), expectedRevision: 0 }), { code: 'STALE_REVISION' });
  assert.throws(() => store.reorderCategories({ ids: roots, expectedRevision: -1 }), { code: 'INVALID_REVISION' });
  assert.deepEqual(store.snapshot(), state);
}));

test('identical root order preserves pending undo and a changed order expires it', () => withStore(store => {
  const deleted = store.deleteCategory({ id: 'Finance', expectedRevision: 0 });
  const ids = rootIds(deleted);
  assert.deepEqual(store.reorderCategories({ ids, expectedRevision: deleted.revision }), deleted);
  const changed = store.reorderCategories({ ids: [...ids].reverse(), expectedRevision: deleted.revision });
  assert.equal(changed.revision, deleted.revision + 1);
  assert.equal(changed.undoDelete, null);
  assert.throws(() => store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: changed.revision }), { code: 'UNDO_UNAVAILABLE' });
}));

test('renaming keeps root position, new roots append, and deletion undo restores the original position', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-order-undo-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.reorderCategories({ ids: ['Projects', 'Travel', 'Uncategorized', 'Health', 'Finance', 'Trash'], expectedRevision: 0 });
    state = store.renameCategory({ id: 'Travel', name: 'Z trips', expectedRevision: state.revision });
    assert.deepEqual(rootIds(state), ['Projects', 'Travel', 'Uncategorized', 'Health', 'Finance', 'Trash']);
    state = store.createCategoryPath({ parentId: null, names: ['A new category', 'Child'], expectedRevision: state.revision });
    const added = state.categories.find(category => category.name === 'A new category');
    assert.deepEqual(rootIds(state), ['Projects', 'Travel', 'Uncategorized', 'Health', 'Finance', 'Trash', added.id]);
    const desired = ['Projects', added.id, 'Travel', 'Uncategorized', 'Health', 'Finance', 'Trash'];
    state = store.reorderCategories({ ids: desired, expectedRevision: state.revision });
    const original = state;
    const deleted = store.deleteCategory({ id: added.id, expectedRevision: state.revision });
    assert.deepEqual(rootIds(deleted), desired.filter(id => id !== added.id));
    store.close();
    store = new CatalogStore(path);
    const restored = store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: deleted.revision });
    assert.deepEqual(rootIds(restored), desired);
    assert.deepEqual(restored.categories, original.categories);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ordering migration matches the previous UI and preserves legacy pending undo exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-order-migration-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [chat('a')], coverage: 'legacy order fixture' });
    state = store.setCategory({ id: 'chatgpt:chat:a', category: 'Finance', expectedRevision: state.revision });
    state = store.createCategoryPath({ parentId: null, names: ['Zulu'], expectedRevision: state.revision });
    state = store.createCategoryPath({ parentId: null, names: ['Alpha', 'Child'], expectedRevision: state.revision });
    const alpha = state.categories.find(category => category.name === 'Alpha').id;
    const zulu = state.categories.find(category => category.name === 'Zulu').id;
    const deleted = store.deleteCategory({ id: 'Finance', expectedRevision: state.revision });
    // Reproduce the v0.1.4 persisted format: no root-order metadata and no
    // positional information in the pending deletion record.
    const legacyUndo = JSON.parse(store.meta('undoDelete'));
    delete legacyUndo.rootOrder;
    store.writeMeta('undoDelete', JSON.stringify(legacyUndo));
    store.db.prepare("DELETE FROM catalog_meta WHERE key = 'rootCategoryOrder'").run();
    const rawUndo = store.meta('undoDelete');
    store.close();
    store = new CatalogStore(path);
    const migrated = store.snapshot();
    assert.deepEqual(rootIds(migrated), ['Health', 'Travel', 'Uncategorized', 'Projects', 'Trash', alpha, zulu]);
    assert.equal(migrated.revision, deleted.revision);
    assert.equal(migrated.savedAt, deleted.savedAt);
    assert.deepEqual(migrated.items, deleted.items);
    assert.deepEqual(migrated.undoDelete, deleted.undoDelete);
    assert.equal(store.meta('undoDelete'), rawUndo);
    const restored = store.undoDeleteCategory({ token: migrated.undoDelete.token, expectedRevision: migrated.revision });
    assert.deepEqual(rootIds(restored), ['Health', 'Travel', 'Finance', 'Uncategorized', 'Projects', 'Trash', alpha, zulu]);
    assert.equal(restored.items[0].category, 'Finance');
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('items sort by source activity descending with alphabetical and ID ties and undated entries last', () => withStore(store => {
  const state = store.importInventory({ items: [
    chat('missing-z', { title: 'Zulu' }),
    chat('tie-b', { title: 'Same', updatedAt: '2026-10-17T12:00:00Z' }),
    chat('older', { title: 'A oldest', updatedAt: '2026-10-15T13:00:00Z' }),
    chat('newest', { title: 'Z newest', updatedAt: '2026-10-17T06:00:00-07:00' }),
    chat('missing-a', { title: 'Alpha' }),
    chat('tie-a', { title: 'same', updatedAt: '2026-10-17T05:00:00-07:00' }),
    chat('tie-first', { title: 'Alpha tie', updatedAt: '2026-10-17T12:00:00Z' }),
  ], coverage: 'activity ordering sample' });
  assert.deepEqual(state.items.map(item => item.sourceId), ['newest', 'tie-first', 'tie-a', 'tie-b', 'older', 'missing-a', 'missing-z']);
  for (const item of state.items) assert.equal(item.effectiveUpdatedAt, item.updatedAt);
  assert.equal(state.items.at(-1).effectiveUpdatedAt, null);
  assert.deepEqual(store.snapshot(), state, 'reading must not record new activity');
}));

test('project activity uses newest source or member date including cross-source membership', () => withStore(store => {
  const state = store.importInventory({ items: [
    project('g-shared', { updatedAt: '2026-10-10T12:00:00Z', hostId: 'cloud' }),
    chat('cloud-child', { projectId: 'g-shared', updatedAt: '2026-10-14T12:00:00Z' }),
    codexChat('work-child', { projectId: 'g-shared', hostId: 'local', updatedAt: '2026-10-17T12:00:00Z' }),
    project('own-newer', { updatedAt: '2026-10-18T12:00:00Z' }),
    chat('old-child', { projectId: 'own-newer', updatedAt: '2026-10-13T12:00:00Z' }),
    project('undated'),
    chat('undated-child', { projectId: 'undated' }),
    chat('unrelated', { projectId: 'other', updatedAt: '2026-10-20T12:00:00Z' }),
  ], coverage: 'cross-source project activity' });
  const shared = state.items.find(item => item.sourceId === 'g-shared');
  assert.equal(shared.updatedAt, '2026-10-10T12:00:00Z');
  assert.equal(shared.effectiveUpdatedAt, '2026-10-17T12:00:00Z');
  assert.equal(state.items.find(item => item.sourceId === 'own-newer').effectiveUpdatedAt, '2026-10-18T12:00:00Z');
  assert.equal(state.items.find(item => item.sourceId === 'undated').effectiveUpdatedAt, null);
  assert.ok(isProjectMember(shared, state.items.find(item => item.sourceId === 'work-child')));
  assert.equal(isProjectMember(shared, state.items.find(item => item.sourceId === 'unrelated')), false);
}));

test('local project membership excludes known host mismatches and accepts missing host metadata', () => withStore(store => {
  const localProject = project('local-project', { id: 'codex:project:local-project', source: 'codex', hostId: 'local' });
  let state = store.importInventory({ items: [
    localProject,
    codexChat('local-child', { projectId: 'local-project', hostId: 'local', updatedAt: '2026-10-15T12:00:00Z' }),
    codexChat('remote-child', { projectId: 'local-project', hostId: 'remote', updatedAt: '2026-10-20T12:00:00Z' }),
    chat('unknown-host-child', { projectId: 'local-project', updatedAt: '2026-10-17T12:00:00Z' }),
  ], coverage: 'host-aware membership' });
  const result = state.items.find(item => item.kind === 'project');
  assert.equal(result.updatedAt, null);
  assert.equal(result.effectiveUpdatedAt, '2026-10-17T12:00:00Z');
  assert.equal(isProjectMember(result, state.items.find(item => item.sourceId === 'remote-child')), false);
  assert.equal(isProjectMember(result, state.items.find(item => item.sourceId === 'unknown-host-child')), true);
  state = store.importInventory({ items: [codexChat('local-child', { projectId: 'local-project', hostId: 'local', updatedAt: '2026-10-18T12:00:00Z' })], coverage: 'new local activity' });
  assert.equal(state.items.find(item => item.kind === 'project').effectiveUpdatedAt, '2026-10-18T12:00:00Z');
}));

test('stale and partial imports cannot regress source dates or count a refresh as activity', () => withStore(store => {
  let state = store.importInventory({ items: [chat('a', { updatedAt: '2026-10-17T12:00:00Z' })], coverage: 'initial' });
  state = store.setCategory({ id: 'chatgpt:chat:a', category: 'Travel', expectedRevision: state.revision });
  state = store.importInventory({ items: [chat('a', { title: 'Refreshed title', updatedAt: '2026-10-16T12:00:00Z' })], coverage: 'stale source date' });
  assert.equal(state.items[0].title, 'Refreshed title');
  assert.equal(state.items[0].updatedAt, '2026-10-17T12:00:00Z');
  assert.equal(state.items[0].effectiveUpdatedAt, '2026-10-17T12:00:00Z');
  assert.equal(state.items[0].category, 'Travel');
  state = store.importInventory({ items: [chat('a')], coverage: 'date unavailable during refresh' });
  assert.equal(state.items[0].updatedAt, '2026-10-17T12:00:00Z');
  state = store.importInventory({ items: [chat('a', { updatedAt: '2026-10-17T05:00:00-07:00' })], coverage: 'same instant with a different offset' });
  assert.equal(state.items[0].updatedAt, '2026-10-17T12:00:00Z');
  state = store.importInventory({ items: [chat('a', { updatedAt: '2026-10-17T06:00:00-07:00' })], coverage: 'new activity' });
  assert.equal(state.items[0].updatedAt, '2026-10-17T06:00:00-07:00');
  assert.equal(state.items[0].effectiveUpdatedAt, '2026-10-17T06:00:00-07:00');
}));

test('category moves and reopening preserve source dates and derived project activity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-activity-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    const imported = store.importInventory({ items: [
      project('g-project'),
      codexChat('a', { projectId: 'g-project', updatedAt: '2026-10-17T12:00:00Z' }),
    ], coverage: 'project and member activity' });
    const moved = store.setCategory({ id: 'codex:chat:a', category: 'Finance', expectedRevision: imported.revision });
    const dates = snapshot => snapshot.items.map(({ id, updatedAt, effectiveUpdatedAt }) => ({ id, updatedAt, effectiveUpdatedAt }));
    assert.deepEqual(dates(moved), dates(imported));
    const deleted = store.deleteCategory({ id: 'Finance', expectedRevision: moved.revision });
    assert.deepEqual(dates(deleted), dates(imported));
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.snapshot(), deleted);
    const restored = store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: deleted.revision });
    assert.deepEqual(dates(restored), dates(imported));
    assert.equal(restored.items.find(item => item.id === 'codex:chat:a').category, 'Finance');
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('local activity refresh updates only source title and newer date, preserving assignments and metadata', () => withStore(store => {
  let state = store.importInventory({ items: [
    project('g-project'),
    codexChat('a', { projectId: 'g-project', hostId: 'local', updatedAt: '2026-10-17T12:00:00Z' }),
    codexChat('unavailable', { title: 'Known title', updatedAt: '2026-10-16T12:00:00Z' }),
  ], coverage: 'refresh samples' });
  state = store.setCategory({ id: 'codex:chat:a', category: 'Travel', expectedRevision: state.revision });
  const original = state.items.find(item => item.id === 'codex:chat:a');
  const result = store.refreshLocalActivity({
    records: [{ id: original.id, title: 'New source title', updatedAt: '2026-10-18T12:00:00Z', projectId: 'ignored', hostId: 'ignored', url: 'ignored', category: 'ignored' }],
    attempted: 2, checked: 1, unavailable: 1, expectedRevision: state.revision,
  });
  assert.deepEqual(result.items.find(item => item.id === original.id), { ...original, title: 'New source title', updatedAt: '2026-10-18T12:00:00Z', effectiveUpdatedAt: '2026-10-18T12:00:00Z' });
  assert.deepEqual(result.items.find(item => item.id === 'codex:chat:unavailable'), state.items.find(item => item.id === 'codex:chat:unavailable'));
  assert.equal(result.items.find(item => item.kind === 'project').effectiveUpdatedAt, '2026-10-18T12:00:00Z');
  assert.deepEqual(result.categories, state.categories);
  assert.deepEqual(result.lastImport, state.lastImport);
  assert.equal(result.revision, state.revision + 1);
  assert.deepEqual(result.activityRefresh, { attempted: 2, checked: 1, updated: 1, unavailable: 1, limitation: 'Web chat dates need an assistant refresh.' });
  assert.equal(Object.hasOwn(store.snapshot(), 'activityRefresh'), false);
}));

test('unchanged, stale-date, missing-date, and unavailable activity refreshes do not bump revision', () => withStore(store => {
  const state = store.importInventory({ items: [codexChat('a', { updatedAt: '2026-10-17T12:00:00Z' })], coverage: 'initial' });
  for (const payload of [
    { records: [{ id: 'codex:chat:a', title: 'Local a', updatedAt: '2026-10-17T12:00:00Z' }], attempted: 1, checked: 1, unavailable: 0 },
    { records: [{ id: 'codex:chat:a', updatedAt: '2026-10-16T12:00:00Z' }], attempted: 1, checked: 1, unavailable: 0 },
    { records: [{ id: 'codex:chat:a' }], attempted: 1, checked: 1, unavailable: 0 },
    { records: [], attempted: 1, checked: 0, unavailable: 1 },
    { records: [], attempted: 0, checked: 0, unavailable: 0 },
  ]) {
    const { activityRefresh, ...result } = store.refreshLocalActivity({ ...payload, expectedRevision: state.revision });
    assert.deepEqual(result, state);
    assert.equal(activityRefresh.updated, 0);
  }
}));

test('metadata refresh keeps deletion Undo valid across its revision change and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-refresh-undo-'));
  const path = join(dir, 'catalog.sqlite');
  let store;
  try {
    store = new CatalogStore(path);
    let state = store.importInventory({ items: [codexChat('a', { updatedAt: '2026-10-17T12:00:00Z' })], coverage: 'initial' });
    state = store.setCategory({ id: 'codex:chat:a', category: 'Travel', expectedRevision: state.revision });
    const deleted = store.deleteCategory({ id: 'Travel', expectedRevision: state.revision });
    const refreshed = store.refreshLocalActivity({ records: [{ id: 'codex:chat:a', title: 'Refreshed after deletion', updatedAt: '2026-10-18T12:00:00Z' }], attempted: 1, checked: 1, unavailable: 0, expectedRevision: deleted.revision });
    assert.deepEqual(refreshed.undoDelete, deleted.undoDelete);
    assert.equal(refreshed.revision, deleted.revision + 1);
    store.close();
    store = new CatalogStore(path);
    const restored = store.undoDeleteCategory({ token: deleted.undoDelete.token, expectedRevision: refreshed.revision });
    assert.equal(restored.items[0].category, 'Travel');
    assert.equal(restored.items[0].title, 'Refreshed after deletion');
    assert.equal(restored.items[0].updatedAt, '2026-10-18T12:00:00Z');
    assert.equal(restored.undoDelete, null);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('activity refresh rejects stale, invalid, nonlocal, duplicate, and unknown records atomically', () => withStore(store => {
  const state = store.importInventory({ items: [codexChat('a'), codexChat('remote', { hostId: 'remote' }), chat('web'), project('g-project')], coverage: 'validation samples' });
  const payload = { records: [{ id: 'codex:chat:a', title: 'New title' }], attempted: 1, checked: 1, unavailable: 0, expectedRevision: state.revision };
  assert.throws(() => store.refreshLocalActivity({ ...payload, expectedRevision: state.revision - 1 }), { code: 'STALE_REVISION' });
  for (const invalid of ['codex:chat:remote', 'chatgpt:chat:web', 'chatgpt:project:g-project', 'codex:chat:missing']) {
    assert.throws(() => store.refreshLocalActivity({ ...payload, records: [...payload.records, { id: invalid, title: 'Invalid target' }], attempted: 2, checked: 2 }), { code: 'INVALID_INPUT' });
    assert.deepEqual(store.snapshot(), state, 'the preceding valid update must roll back');
  }
  assert.throws(() => store.refreshLocalActivity({ ...payload, records: [payload.records[0], payload.records[0]], attempted: 2, checked: 2 }), { code: 'DUPLICATE_ID' });
  assert.throws(() => store.refreshLocalActivity({ ...payload, attempted: 3 }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.refreshLocalActivity({ ...payload, records: [{ id: 'codex:chat:a', updatedAt: 'invalid date' }] }), { code: 'INVALID_INPUT' });
  assert.deepEqual(store.snapshot(), state);
}));

