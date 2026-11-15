import { lstat, open, readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CatalogError, CatalogStore, defaultDatabasePath, validateItem } from '../store.mjs';

export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_RECORDS = 100000;
const MAX_ACTIVE_CHATS = 20000;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function fail(code, message) {
  throw new CatalogError(code, message);
}

async function inputFiles(inputPath) {
  const selected = resolve(inputPath);
  const details = await lstat(selected);
  if (details.isFile()) {
    if (extname(selected).toLowerCase() !== '.json') fail('UNSUPPORTED_EXPORT', 'Select an extracted JSON file or export folder. Extract ZIP archives before importing.');
    return [selected];
  }
  if (!details.isDirectory()) fail('UNSUPPORTED_EXPORT', 'Select a regular JSON file or an extracted export directory.');
  const entries = await readdir(selected, { withFileTypes: true });
  const candidates = entries.filter(entry => /^conversations.*\.json$/i.test(entry.name));
  if (candidates.some(entry => !entry.isFile())) fail('UNSUPPORTED_EXPORT', 'Conversation JSON entries must be regular files directly inside the selected folder.');
  const single = candidates.filter(entry => /^conversations\.json$/i.test(entry.name));
  const parts = candidates.filter(entry => /^conversations-\d+\.json$/i.test(entry.name));
  if (candidates.length !== single.length + parts.length || single.length > 1 || single.length && parts.length) {
    fail('AMBIGUOUS_EXPORT', 'The folder must contain conversations.json or numbered conversations-N.json parts, with no mixed or ambiguous conversation files.');
  }
  if (single.length) return [join(selected, single[0].name)];
  if (!parts.length) fail('UNSUPPORTED_EXPORT', 'No conversations.json or numbered conversations-N.json files were found directly inside this folder.');
  const ordered = parts.map(entry => ({ name: entry.name, index: Number(entry.name.match(/-(\d+)\.json$/i)[1]) })).sort((a, b) => a.index - b.index);
  const first = ordered[0].index;
  if (![0, 1].includes(first) || ordered.some((part, index) => !Number.isSafeInteger(part.index) || part.index !== first + index)) {
    fail('INCOMPLETE_EXPORT', 'Numbered conversation parts must start at 0 or 1 and continue without gaps or duplicate part numbers.');
  }
  return ordered.map(part => join(selected, part.name));
}

function timestamp(value) {
  if (value === undefined || value === null) return { date: null, invalid: false };
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) milliseconds = Math.abs(value) < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string') {
    const match = ISO_DATE.exec(value);
    if (!match) return { date: null, invalid: true };
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return { date: null, invalid: true };
    milliseconds = Date.parse(value);
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return { date: null, invalid: true };
  return { date: date.toISOString(), invalid: false };
}

function metadata(record, location) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_RECORD', location + ' must be a conversation object.');
  const ids = [record.id, record.conversation_id].filter(value => value !== undefined && value !== null);
  if (!ids.length || ids.some(value => typeof value !== 'string' || !UUID.test(value)) || new Set(ids.map(value => value.toLowerCase())).size !== 1) {
    fail('INVALID_RECORD', location + ' must have a valid UUID in id or conversation_id. If both fields exist, they must agree.');
  }
  if (record.is_archived !== undefined && record.is_archived !== null && typeof record.is_archived !== 'boolean') fail('INVALID_RECORD', location + ' has an invalid is_archived flag.');
  const sourceId = ids[0].toLowerCase();
  const originalTitle = typeof record.title === 'string' ? record.title.trim() : '';
  const title = originalTitle ? originalTitle.slice(0, 1000) : 'Untitled chat';
  const updated = timestamp(record.update_time), created = timestamp(record.create_time);
  const updatedAt = updated.date ?? created.date;
  const item = {
    id: 'chatgpt:chat:' + sourceId, source: 'chatgpt', sourceId, kind: 'chat', title,
    url: 'https://chatgpt.com/c/' + sourceId, updatedAt,
  };
  validateItem(item);
  return {
    item, archived: record.is_archived === true,
    duplicateKey: JSON.stringify([sourceId, record.title ?? null, record.update_time ?? null, record.create_time ?? null, record.is_archived ?? false]),
    warnings: {
      missingTitles: originalTitle ? 0 : 1,
      truncatedTitles: originalTitle.length > 1000 ? 1 : 0,
      invalidDates: Number(updated.invalid) + Number(created.invalid),
      missingDates: updatedAt ? 0 : 1,
    },
  };
}

export async function readExport(inputPath, { maxBytes = MAX_EXPORT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_EXPORT_BYTES) fail('INVALID_INPUT', 'Invalid export byte limit.');
  const files = await inputFiles(inputPath);
  const records = new Map();
  const counts = { files: files.length, sourceRecords: 0, duplicateRecords: 0, archivedSkipped: 0, activeChats: 0, missingTitles: 0, truncatedTitles: 0, invalidDates: 0, missingDates: 0 };
  let bytesRead = 0;
  for (const file of files) {
    const handle = await open(file, 'r');
    let content;
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > maxBytes || bytesRead + details.size > maxBytes) fail('EXPORT_TOO_LARGE', 'Conversation JSON files must fit within 256 MiB in total.');
      content = await handle.readFile();
    } finally { await handle.close(); }
    bytesRead += content.length;
    if (content.length > maxBytes || bytesRead > maxBytes) fail('EXPORT_TOO_LARGE', 'Conversation JSON files must fit within 256 MiB in total.');
    let parsed;
    try { parsed = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { fail('INVALID_JSON', basename(file) + ' contains invalid JSON.'); }
    const conversations = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? parsed.conversations : undefined;
    if (!Array.isArray(conversations)) fail('UNSUPPORTED_EXPORT', basename(file) + ' must contain a conversation array or an object with a conversations array.');
    counts.sourceRecords += conversations.length;
    if (counts.sourceRecords > MAX_EXPORT_RECORDS) fail('EXPORT_TOO_LARGE', 'At most 100,000 source conversation records can be validated in one import.');
    for (const [index, record] of conversations.entries()) {
      const row = metadata(record, basename(file) + ' record ' + (index + 1));
      const previous = records.get(row.item.id);
      if (previous) {
        if (previous.duplicateKey !== row.duplicateKey) fail('CONFLICTING_DUPLICATE', 'Conflicting export metadata was found for conversation ' + row.item.sourceId + '.');
        counts.duplicateRecords++;
      } else records.set(row.item.id, row);
    }
  }
  const items = [];
  for (const row of records.values()) {
    for (const [key, value] of Object.entries(row.warnings)) counts[key] += value;
    if (row.archived) counts.archivedSkipped++;
    else items.push(row.item);
  }
  if (items.length > MAX_ACTIVE_CHATS) fail('EXPORT_TOO_LARGE', 'This catalog supports an initial import of at most 20,000 active chats.');
  counts.activeChats = items.length;
  return { items, counts, bytesRead };
}

async function requireFreshFile(databasePath) {
  let details;
  try { details = await lstat(databasePath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!details.isFile()) fail('INVALID_CATALOG', 'The target catalog must be a regular database file or a new private data directory.');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    if (!tables.has('catalog_meta') || !tables.has('catalog_items')) fail('INVALID_CATALOG', 'The selected data directory contains an unsupported database. Choose a new private data directory.');
    const revision = db.prepare("SELECT value FROM catalog_meta WHERE key='revision'").get()?.value;
    const count = db.prepare('SELECT COUNT(*) AS count FROM catalog_items').get().count;
    if (revision !== '0' || count !== 0) fail('CATALOG_NOT_EMPTY', 'Export import requires a fresh catalog at revision 0 with no saved records. Choose a new private data directory.');
  } finally { db.close(); }
}

export async function importExport({ inputPath, dataDir, env = process.env } = {}) {
  if (typeof inputPath !== 'string' || !inputPath) fail('INVALID_INPUT', 'An extracted export folder or JSON file is required.');
  if (dataDir !== undefined && (typeof dataDir !== 'string' || !isAbsolute(dataDir))) fail('INVALID_INPUT', '--data-dir must be an absolute private directory.');
  const databasePath = defaultDatabasePath({ env: dataDir ? { ...env, CHAT_ORGANIZER_DATA_DIR: dataDir } : env });
  const prepared = await readExport(inputPath);
  await requireFreshFile(databasePath);
  const store = new CatalogStore(databasePath);
  try {
    const saved = store.importFirstInventory({ items: prepared.items, coverage: 'Initial ChatGPT export metadata. Explicit archived records skipped; current project membership and archive state require Update now.' });
    const warnings = Object.entries(prepared.counts).filter(([key, count]) => ['missingTitles', 'truncatedTitles', 'invalidDates', 'missingDates'].includes(key) && count > 0).map(([kind, count]) => ({ kind, count }));
    return { ok: true, databasePath, revision: saved.revision, imported: saved.items.length, ...prepared.counts, warnings };
  } finally { store.close(); }
}

const HELP = `Import ChatGPT export metadata into a fresh Chat Organizer catalog.

Usage
  node scripts/import-export.mjs <export-folder-or-JSON> [--data-dir <absolute-directory>]
  node scripts/import-export.mjs --help

Select an extracted conversations.json file, a JSON conversation array, or a folder
with conversations.json or contiguous conversations-N.json parts starting at 0 or 1.
ZIP archives must be extracted first. Maximum total JSON size is 256 MiB.

The catalog must have revision 0 and no saved records. Active chats start in
Uncategorized. Explicit archived records are skipped. The default private catalog
directory or CHAT_ORGANIZER_DATA_DIR applies unless --data-dir is supplied.
`;

export async function main(args = process.argv.slice(2)) {
  args = args.filter(value => value !== '--');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return; }
  let inputPath, dataDir;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--data-dir') {
      if (dataDir !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) fail('INVALID_INPUT', '--data-dir requires one absolute directory.');
      dataDir = args[++index];
    } else if (value.startsWith('-') || inputPath !== undefined) fail('INVALID_INPUT', 'Use one export path and an optional --data-dir. Run --help for usage.');
    else inputPath = value;
  }
  console.log(JSON.stringify(await importExport({ inputPath, dataDir }), null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || 'EXPORT_IMPORT_FAILED', message: error.message }));
    process.exitCode = 1;
  });
}
