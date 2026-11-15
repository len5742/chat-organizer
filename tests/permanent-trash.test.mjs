import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../store.mjs';

const chat = id => ({ id: `chatgpt:chat:${id}`, source: 'chatgpt', sourceId: id, title: `Example ${id}`, kind: 'chat' });
const roots = value => value.categories.filter(category => category.parentId === null).map(category => category.id);
const revision = store => store.snapshot().revision;
const fixture = action => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-organizer-trash-'));
  const path = join(directory, 'catalog.sqlite');
  let store = new CatalogStore(path);
  try { action(() => store, () => { store.close(); store = new CatalogStore(path); return store; }); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
};

test('fresh Trash is protected from rename and deletion but keeps a movable position', () => fixture(getStore => {
  const store = getStore();
  let state = store.importInventory({ items: [chat('trash'), chat('other')], coverage: 'fictional preservation fixture' });
  state = store.setCategory({ id: 'chatgpt:chat:trash', category: 'Trash', expectedRevision: state.revision });
  state = store.setFocus({ id: 'chatgpt:chat:trash', focused: true, expectedRevision: state.revision });
  assert.deepEqual(state.categories.find(category => category.id === 'Trash'), { id: 'Trash', name: 'Trash', parentId: null, protected: true });
  for (const action of [
    () => store.renameCategory({ id: 'Trash', name: 'Archive later', expectedRevision: state.revision }),
    () => store.deleteCategory({ id: 'Trash', expectedRevision: state.revision }),
  ]) assert.throws(action, { code: 'PROTECTED_CATEGORY' });
  assert.deepEqual(store.snapshot(), state);
  const ids = ['Trash', ...roots(state).filter(id => id !== 'Trash')];
  const moved = store.reorderCategories({ ids, expectedRevision: state.revision });
  assert.deepEqual(roots(moved), ids);
  assert.deepEqual(moved.items, state.items);
  assert.equal(moved.items.find(item => item.id === 'chatgpt:chat:trash').availability, 'available');
  assert.equal(moved.items.find(item => item.id === 'chatgpt:chat:trash').focused, true);
}));

test('upgrade adopts an existing root Trash ID and retains its children, items, flags and order', () => fixture((getStore, reopen) => {
  let store = getStore();
  store.db.prepare("DELETE FROM catalog_categories WHERE id = 'Trash'").run();
  let state = store.createCategoryPath({ parentId: null, names: ['tRaSh', 'Review later'], expectedRevision: 0 });
  const trash = state.categories.find(category => category.name === 'tRaSh');
  const child = state.categories.find(category => category.name === 'Review later');
  state = store.importInventory({ items: [chat('root'), chat('child')], coverage: 'fictional existing Trash fixture' });
  state = store.setCategory({ id: 'chatgpt:chat:root', category: trash.id, expectedRevision: state.revision });
  state = store.setCategory({ id: 'chatgpt:chat:child', category: child.id, expectedRevision: state.revision });
  state = store.setFocus({ id: 'chatgpt:chat:root', focused: true, expectedRevision: state.revision });
  state = store.reorderCategories({ ids: [trash.id, ...roots(state).filter(id => id !== trash.id)], expectedRevision: state.revision });
  const rows = store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all();
  const metadata = store.db.prepare('SELECT * FROM catalog_meta ORDER BY key').all();
  store = reopen();
  assert.deepEqual(store.snapshot(), state);
  assert.deepEqual(store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all(), rows);
  assert.deepEqual(store.db.prepare('SELECT * FROM catalog_meta ORDER BY key').all(), metadata);
  assert.equal(store.snapshot().categories.filter(category => category.parentId === null && category.name.toLowerCase() === 'trash').length, 1);
  assert.throws(() => store.deleteCategory({ id: trash.id, expectedRevision: state.revision }), { code: 'PROTECTED_CATEGORY' });
  assert.throws(() => store.renameCategory({ id: trash.id, name: 'Old trash', expectedRevision: state.revision }), { code: 'PROTECTED_CATEGORY' });
  assert.deepEqual(store.snapshot(), state);
}));

test('upgrade appends a missing Trash without changing existing items, revision, stored order or unrelated Undo', () => fixture((getStore, reopen) => {
  let store = getStore();
  let state = store.importInventory({ items: [chat('a')], coverage: 'fictional missing Trash fixture' });
  state = store.setCategory({ id: 'chatgpt:chat:a', category: 'Finance', expectedRevision: state.revision });
  state = store.deleteCategory({ id: 'Finance', expectedRevision: state.revision });
  store.db.prepare("DELETE FROM catalog_categories WHERE id = 'Trash'").run();
  store.writeMeta('rootCategoryOrder', JSON.stringify(roots(state).filter(id => id !== 'Trash')));
  const before = store.snapshot();
  const metadata = store.db.prepare('SELECT * FROM catalog_meta ORDER BY key').all();
  store = reopen();
  const after = store.snapshot();
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(roots(after), [...roots(before), 'Trash']);
  assert.equal(after.revision, before.revision);
  assert.equal(after.savedAt, before.savedAt);
  assert.deepEqual(after.undoDelete, before.undoDelete);
  assert.deepEqual(store.db.prepare('SELECT * FROM catalog_meta ORDER BY key').all(), metadata);
  assert.deepEqual(reopen().snapshot(), after, 'reopening remains idempotent');
  store = getStore();
  const undone = store.undoDeleteCategory({ token: before.undoDelete.token, expectedRevision: after.revision });
  assert.equal(undone.items[0].category, 'Finance');
  assert.ok(undone.categories.some(category => category.id === 'Trash' && category.protected));
}));

test('an occupied legacy Trash ID is preserved and a separate permanent Trash is created', () => fixture((getStore, reopen) => {
  let store = getStore();
  store.importInventory({ items: [chat('a')], coverage: 'fictional ID collision fixture' });
  store.setCategory({ id: 'chatgpt:chat:a', category: 'Trash', expectedRevision: revision(store) });
  store.db.prepare("UPDATE catalog_categories SET name = 'Old category', name_key = 'old category' WHERE id = 'Trash'").run();
  const before = store.snapshot();
  store = reopen();
  const after = store.snapshot();
  const trash = after.categories.find(category => category.name === 'Trash');
  assert.notEqual(trash.id, 'Trash');
  assert.equal(trash.protected, true);
  assert.equal(after.categories.find(category => category.id === 'Trash').name, 'Old category');
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(roots(after), [...roots(before), trash.id]);
}));

test('an outstanding legacy Trash deletion can still be undone explicitly after upgrade', () => fixture((getStore, reopen) => {
  let store = getStore();
  let state = store.createCategoryPath({ parentId: 'Trash', names: ['Later'], expectedRevision: 0 });
  const child = state.categories.find(category => category.name === 'Later');
  state = store.importInventory({ items: [chat('a')], coverage: 'fictional legacy Trash Undo' });
  state = store.setCategory({ id: 'chatgpt:chat:a', category: child.id, expectedRevision: state.revision });
  state = store.setFocus({ id: 'chatgpt:chat:a', focused: true, expectedRevision: state.revision });
  const undo = { token: 'legacy-trash-delete', label: 'Trash', revision: state.revision + 1,
    categories: [store.category('Trash'), store.category(child.id)],
    assignments: [{ id: 'chatgpt:chat:a', category: child.id }], rootOrder: roots(state) };
  store.transaction(() => {
    store.db.prepare("UPDATE catalog_items SET category = 'Uncategorized' WHERE id = 'chatgpt:chat:a'").run();
    store.db.prepare('DELETE FROM catalog_categories WHERE id = ?').run(child.id);
    store.db.prepare("DELETE FROM catalog_categories WHERE id = 'Trash'").run();
    store.writeMeta('rootCategoryOrder', JSON.stringify(roots(state).filter(id => id !== 'Trash')));
    store.bumpRevision();
    store.writeMeta('undoDelete', JSON.stringify(undo));
  });
  const before = store.snapshot();
  store = reopen();
  assert.deepEqual(store.snapshot().items, before.items, 'upgrade does not undo an old user action');
  assert.deepEqual(store.snapshot().undoDelete, before.undoDelete);
  const restored = store.undoDeleteCategory({ token: undo.token, expectedRevision: before.revision });
  assert.equal(restored.items[0].category, child.id);
  assert.equal(restored.items[0].focused, true);
  assert.deepEqual(roots(restored), undo.rootOrder);
  assert.equal(restored.categories.find(category => category.id === 'Trash').protected, true);
}));
