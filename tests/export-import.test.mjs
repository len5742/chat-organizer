import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CatalogStore } from '../store.mjs';
import { importExport, readExport } from '../scripts/import-export.mjs';

const uuid = number => '11111111-1111-4111-8111-' + String(number).padStart(12, '0');
const conversation = (number, extra = {}) => ({ id: uuid(number), title: 'Sample conversation ' + number, create_time: 1700000000, update_time: 1700000060, ...extra });

async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-organizer-export-test-'));
  const input = join(directory, 'export');
  const data = join(directory, 'catalog');
  await mkdir(input);
  const json = async (name, value) => {
    const file = join(input, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  try { await action({ directory, input, data, database: join(data, 'catalog.sqlite'), json }); }
  finally {
    const rel = relative(tmpdir(), directory);
    assert.ok(rel && !rel.startsWith('..' + sep) && !rel.includes(sep), 'remove only this temporary fixture');
    await rm(directory, { recursive: true, force: true });
  }
}

async function absent(path) {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}

test('first export import stores whitelisted metadata and leaves source content out of the catalog', async () => fixture(async ({ input, data, database, json }) => {
  await json('conversations.json', [
    conversation(1, { project_id: 'historic-project', category: 'Finance', focused: true, mapping: { private: { message: 'PRIVATE SOURCE BODY MUST NOT BE STORED' } } }),
    { conversation_id: uuid(2), title: 'Second chat', create_time: '2024-01-02T03:04:05Z', update_time: 1704164705000 },
  ]);
  await json('user.json', { content: 'UNRELATED FILE MUST NOT BE READ' });
  const result = await importExport({ inputPath: input, dataDir: data });
  assert.equal(result.imported, 2);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.warnings, []);
  const store = new CatalogStore(database);
  try {
    const saved = store.snapshot();
    assert.equal(saved.items.length, 2);
    assert.ok(saved.items.every(item => item.category === 'Uncategorized' && item.focused === false && item.projectId === null));
    assert.equal(saved.items.find(item => item.sourceId === uuid(1)).updatedAt, '2023-11-14T22:14:20.000Z');
    assert.equal(saved.items.find(item => item.sourceId === uuid(2)).updatedAt, '2024-01-02T03:05:05.000Z');
    assert.ok(saved.items.every(item => item.url === 'https://chatgpt.com/c/' + item.sourceId));
    const dump = ['catalog_items', 'catalog_meta'].map(table => JSON.stringify(store.db.prepare('SELECT * FROM ' + table).all())).join('');
    assert.doesNotMatch(dump, /PRIVATE SOURCE BODY|UNRELATED FILE|historic-project/);
  } finally { store.close(); }
}));

test('numbered parts handle wrapper arrays, archived flags and identical duplicate metadata deterministically', async () => fixture(async ({ input, data, json }) => {
  await json('conversations-0.json', [conversation(1), conversation(2, { is_archived: true })]);
  await json('conversations-1.json', { conversations: [conversation(1, { mapping: { differentMessages: true } }), conversation(3)] });
  const result = await importExport({ inputPath: input, dataDir: data });
  assert.equal(result.files, 2);
  assert.equal(result.sourceRecords, 4);
  assert.equal(result.duplicateRecords, 1);
  assert.equal(result.archivedSkipped, 1);
  assert.equal(result.imported, 2);
}));

test('warnings explain default titles, shortened titles and invalid or absent dates', async () => fixture(async ({ data, json }) => {
  const file = await json('sample.json', [
    conversation(1, { title: '', update_time: 'not a date' }),
    conversation(2, { title: 'x'.repeat(1001), update_time: '2024-02-30T10:00:00Z', create_time: null }),
    { id: uuid(3) },
  ]);
  const prepared = await readExport(file);
  assert.equal(prepared.counts.missingTitles, 2);
  assert.equal(prepared.counts.truncatedTitles, 1);
  assert.equal(prepared.counts.invalidDates, 2);
  assert.equal(prepared.counts.missingDates, 2);
  assert.equal(prepared.items[0].updatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(prepared.items[1].title.length, 1000);
  assert.equal(prepared.items[2].title, 'Untitled chat');
  const result = await importExport({ inputPath: file, dataDir: data });
  assert.equal(result.warnings.length, 4);
}));

for (const invalid of [
  { id: 'bad-id', title: 'Invalid identifier' },
  { title: 'Missing identifier' },
  { id: uuid(1), conversation_id: uuid(2), title: 'Conflicting identifiers' },
  { id: uuid(1), is_archived: 'true' },
  null,
]) test('malformed records reject the whole import before creating catalog files: ' + JSON.stringify(invalid), async () => fixture(async ({ data, json }) => {
  const file = await json('input.json', [conversation(4), invalid]);
  await assert.rejects(importExport({ inputPath: file, dataDir: data }), { code: 'INVALID_RECORD' });
  await absent(data);
}));

test('conflicting duplicate metadata in a later part prevents every write', async () => fixture(async ({ input, data, json }) => {
  await json('conversations-1.json', [conversation(1)]);
  await json('conversations-2.json', [conversation(1, { title: 'Different title' })]);
  await assert.rejects(importExport({ inputPath: input, dataDir: data }), { code: 'CONFLICTING_DUPLICATE' });
  await absent(data);
}));

test('duplicate differences beyond the title length limit still reject the import', async () => fixture(async ({ data, json }) => {
  const file = await json('input.json', [conversation(1, { title: 'x'.repeat(1000) + 'a' }), conversation(1, { title: 'x'.repeat(1000) + 'b' })]);
  await assert.rejects(importExport({ inputPath: file, dataDir: data }), { code: 'CONFLICTING_DUPLICATE' });
  await absent(data);
}));

for (const [names, code] of [
  [['conversations.json', 'conversations-0.json'], 'AMBIGUOUS_EXPORT'],
  [['conversations-1.json', 'conversations-3.json'], 'INCOMPLETE_EXPORT'],
  [['conversations-1.json', 'conversations-01.json'], 'INCOMPLETE_EXPORT'],
  [['conversations-3.json'], 'INCOMPLETE_EXPORT'],
  [['conversations-x.json'], 'AMBIGUOUS_EXPORT'],
  [['unrelated.json'], 'UNSUPPORTED_EXPORT'],
]) test('directory validation rejects incomplete or ambiguous inputs: ' + names.join(', '), async () => fixture(async ({ input, data, json }) => {
  for (const name of names) await json(name, [conversation(1)]);
  await assert.rejects(importExport({ inputPath: input, dataDir: data }), { code });
  await absent(data);
}));

test('directory selection never searches child folders for export files', async () => fixture(async ({ input, data }) => {
  const nested = join(input, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'conversations.json'), JSON.stringify([conversation(1)]));
  await assert.rejects(importExport({ inputPath: input, dataDir: data }), { code: 'UNSUPPORTED_EXPORT' });
  await absent(data);
}));

test('file and aggregate size bounds are checked before parsing or catalog writes', async () => fixture(async ({ input, json }) => {
  const one = await json('conversations-0.json', [conversation(1)]);
  await json('conversations-1.json', [conversation(2)]);
  const bytes = (await stat(one)).size;
  await assert.rejects(readExport(one, { maxBytes: bytes - 1 }), { code: 'EXPORT_TOO_LARGE' });
  await assert.rejects(readExport(input, { maxBytes: bytes + 1 }), { code: 'EXPORT_TOO_LARGE' });
}));

test('unsupported JSON shape, invalid JSON and a relative data override fail without a catalog', async () => fixture(async ({ data, json }) => {
  const unsupported = await json('unsupported.json', { messages: [] });
  await assert.rejects(importExport({ inputPath: unsupported, dataDir: data }), { code: 'UNSUPPORTED_EXPORT' });
  await writeFile(unsupported, '{');
  await assert.rejects(importExport({ inputPath: unsupported, dataDir: data }), { code: 'INVALID_JSON' });
  const valid = await json('valid.json', [conversation(1)]);
  await assert.rejects(importExport({ inputPath: valid, dataDir: 'relative-directory' }), { code: 'INVALID_INPUT' });
  await absent(data);
}));

test('a service-created empty catalog permits a first import, then refuses a repeated import', async () => fixture(async ({ data, database, json }) => {
  new CatalogStore(database).close();
  const file = await json('input.json', [conversation(1)]);
  await importExport({ inputPath: file, dataDir: data });
  const before = await readFile(database);
  await assert.rejects(importExport({ inputPath: file, dataDir: data }), { code: 'CATALOG_NOT_EMPTY' });
  assert.deepEqual(await readFile(database), before);
}));

test('first import refuses physical hidden records even when visible inventory is empty', async () => fixture(async ({ data, database, json }) => {
  const store = new CatalogStore(database);
  try {
    store.importInventory({ items: [{ id: 'chatgpt:chat:' + uuid(1), source: 'chatgpt', sourceId: uuid(1), kind: 'chat', title: 'Existing saved chat' }], coverage: 'synthetic' });
    store.db.prepare('INSERT INTO catalog_hidden(item_id, hidden_at) VALUES (?, ?)').run('chatgpt:chat:' + uuid(1), new Date().toISOString());
    store.db.prepare("UPDATE catalog_meta SET value='0' WHERE key='revision'").run();
    assert.equal(store.snapshot().items.length, 0);
  } finally { store.close(); }
  const file = await json('input.json', [conversation(2)]);
  await assert.rejects(importExport({ inputPath: file, dataDir: data }), { code: 'CATALOG_NOT_EMPTY' });
}));

test('an edited empty catalog refuses first import on its revision', async () => fixture(async ({ data, database, json }) => {
  const store = new CatalogStore(database);
  store.createCategoryPath({ parentId: null, names: ['Custom category'], expectedRevision: 0 });
  assert.equal(store.snapshot().items.length, 0);
  store.close();
  const file = await json('input.json', [conversation(1)]);
  await assert.rejects(importExport({ inputPath: file, dataDir: data }), { code: 'CATALOG_NOT_EMPTY' });
}));

test('two connections cannot both claim the first import after observing an empty catalog', async () => fixture(async ({ database }) => {
  const first = new CatalogStore(database), second = new CatalogStore(database);
  const row = number => ({ id: 'chatgpt:chat:' + uuid(number), source: 'chatgpt', sourceId: uuid(number), kind: 'chat', title: 'Synthetic chat' });
  try {
    assert.equal(first.snapshot().revision, 0);
    assert.equal(second.snapshot().revision, 0);
    first.importFirstInventory({ items: [row(1)], coverage: 'synthetic' });
    assert.throws(() => second.importFirstInventory({ items: [row(2)], coverage: 'synthetic' }), { code: 'CATALOG_NOT_EMPTY' });
    assert.equal(first.snapshot().items.length, 1);
    assert.equal(first.snapshot().items[0].sourceId, uuid(1));
  } finally { first.close(); second.close(); }
}));

test('CLI help and the pnpm argument separator work without connecting to source chats', async () => fixture(async ({ directory, data, json }) => {
  const script = fileURLToPath(new URL('../scripts/import-export.mjs', import.meta.url));
  const help = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, '--help'], { encoding: 'utf8', windowsHide: true, cwd: directory });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /fresh Chat Organizer catalog/);
  await absent(data);
  const file = await json('input.json', [conversation(1)]);
  const imported = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, '--', file, '--data-dir', data], { encoding: 'utf8', windowsHide: true, cwd: directory });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, 1);
}));
