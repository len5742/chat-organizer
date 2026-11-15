import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const CATEGORIES = Object.freeze(['Uncategorized', 'Health', 'Travel', 'Finance', 'Projects', 'Trash']);
const SOURCES = new Set(['chatgpt', 'codex']);
const KINDS = new Set(['chat', 'project']);
const MAX_CATEGORY_DEPTH = 3;
const DEFAULT_CATEGORY_POSITION = new Map(CATEGORIES.map((id, index) => [id, index]));
const VERIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RESERVED_ROOT_NAMES = new Set(['priority', 'potentially deleted']);
const infrastructureFailure = text => /rate.?limit|too many requests|\b429\b|cooldown|permission|access denied|unauthori[sz]ed|forbidden|authentication|sign.?in|log.?in|network|fetch failed|timed?\s*out|timeout|ECONN|ENOTFOUND|DNS|\b50[0234]\b|service unavailable|server error|failed to (?:connect|fetch)/i.test(text);

function compareCategories(a, b) {
  return (DEFAULT_CATEGORY_POSITION.get(a.id) ?? Infinity) - (DEFAULT_CATEGORY_POSITION.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function initialRootOrder(rows) {
  const preferred = ['Health', 'Travel', 'Finance'];
  const oldOrder = [...rows].sort(compareCategories).map(row => row.id);
  return [...preferred.filter(id => oldOrder.includes(id)), ...oldOrder.filter(id => !preferred.includes(id))];
}

function categoryName(value) {
  const name = requiredText(value, 'Category name', 120).normalize('NFC');
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new CatalogError('INVALID_INPUT', 'Category names cannot contain control characters.');
  return name;
}

function nameKey(name) { return name.normalize('NFKC').toLocaleLowerCase('und'); }

function protectedCategory(category) {
  return category?.id === 'Uncategorized' || (category?.parentId === null && nameKey(category.name) === 'trash');
}

function timestamp(value) {
  const parsed = value === null || value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function latestDate(current, candidate) {
  return timestamp(candidate) > timestamp(current) ? candidate : current;
}

export function isProjectMember(project, item) {
  if (project.kind !== 'project' || item.kind !== 'chat') return false;
  if (item.projectId === project.sourceId && !(project.source === 'codex' && project.hostId && item.hostId && project.hostId !== item.hostId)) return true;
  return item.source === 'codex' && (project.projectAliases ?? []).some(alias => item.projectId === alias.sourceId && item.hostId === alias.hostId);
}

function withRecentActivity(items) {
  const membersByProject = new Map();
  for (const item of items) {
    if (item.kind !== 'chat' || item.projectId === null) continue;
    if (!membersByProject.has(item.projectId)) membersByProject.set(item.projectId, []);
    membersByProject.get(item.projectId).push(item);
  }
  return items.map(item => {
    let effectiveUpdatedAt = item.updatedAt;
    if (item.kind === 'project') {
      for (const member of [item.sourceId, ...(item.projectAliases ?? []).map(alias => alias.sourceId)].flatMap(id => membersByProject.get(id) ?? [])) {
        if (isProjectMember(item, member)) effectiveUpdatedAt = latestDate(effectiveUpdatedAt, member.updatedAt);
      }
    }
    return { ...item, effectiveUpdatedAt };
  }).sort((a, b) => {
    const aTime = timestamp(a.effectiveUpdatedAt), bTime = timestamp(b.effectiveUpdatedAt);
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  });
}

export class CatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'CatalogError'; this.code = code; }
}

function requiredText(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new CatalogError('INVALID_INPUT', `${field} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}

function optionalText(value, field, max = 500) {
  return value === undefined || value === null ? null : requiredText(value, field, max);
}

export function validateItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CatalogError('INVALID_INPUT', 'Each inventory item must be an object.');
  if (!SOURCES.has(input.source)) throw new CatalogError('INVALID_INPUT', 'Item source must be chatgpt or codex.');
  if (!KINDS.has(input.kind)) throw new CatalogError('INVALID_INPUT', 'Item kind must be chat or project.');
  const sourceId = requiredText(input.sourceId, 'sourceId', 300);
  const id = requiredText(input.id, 'id', 350);
  if (id !== `${input.source}:${input.kind}:${sourceId}`) throw new CatalogError('INVALID_ID', 'Item id must be source:kind:sourceId.');
  const item = {
    id, source: input.source, sourceId, kind: input.kind,
    title: requiredText(input.title, 'title', 1000),
    projectId: optionalText(input.projectId, 'projectId', 300),
    hostId: optionalText(input.hostId, 'hostId', 300),
    url: optionalText(input.url, 'url', 2000),
    updatedAt: optionalText(input.updatedAt, 'updatedAt', 100),
  };
  if (Object.hasOwn(input,'webConversationId')) {
    const value=optionalText(input.webConversationId,'webConversationId',100);
    if (value!==null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new CatalogError('INVALID_INPUT','Invalid verified web conversation ID.');
    if (value!==null && item.kind!=='chat') throw new CatalogError('INVALID_INPUT','Only chats can have a web conversation mapping.');
    item.webConversationId=value;
  }
  if (Object.hasOwn(input, 'chatgptProjectId')) {
    const value = optionalText(input.chatgptProjectId, 'chatgptProjectId', 100);
    if (item.kind !== 'project' || item.source !== 'codex' || (value !== null && (item.hostId !== 'local' || !/^g-p-[a-f0-9]{32}$/i.test(value)))) throw new CatalogError('INVALID_INPUT', 'Only a verified local project can map to a ChatGPT project.');
    item.chatgptProjectId = value;
  }
  Object.defineProperty(item, 'projectIdProvided', { value: Object.hasOwn(input, 'projectId') });
  if (item.updatedAt && !Number.isFinite(Date.parse(item.updatedAt))) throw new CatalogError('INVALID_INPUT', 'updatedAt must be a valid date.');
  if (item.url) {
    let url;
    try { url = new URL(item.url); } catch { throw new CatalogError('INVALID_URL', 'Item URL is invalid.'); }
    const isChatgpt = url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password;
    const isCodex = input.source === 'codex' && input.kind === 'chat' && url.protocol === 'codex:' && url.hostname === 'threads' && !url.port && !url.username && !url.password && /^\/[^/]+\/?$/.test(url.pathname);
    if (!isChatgpt && !isCodex) throw new CatalogError('INVALID_URL', 'Item URLs must use https://chatgpt.com or a codex://threads/ chat link.');
  }
  return item;
}

export class CatalogStore {
  constructor(databasePath) {
    if (databasePath !== ':memory:' && !isAbsolute(databasePath)) throw new CatalogError('INVALID_PATH', 'The catalog database path must be absolute.');
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_items (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT, host_id TEXT,
        url TEXT, updated_at TEXT, category TEXT NOT NULL DEFAULT 'Uncategorized',
        focused INTEGER NOT NULL DEFAULT 0 CHECK (focused IN (0, 1) AND (kind = 'chat' OR focused = 0))
      );
      CREATE TABLE IF NOT EXISTS catalog_hidden (
        item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
        hidden_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_deletion_review (
        item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
        first_failed_at TEXT, last_failed_at TEXT, last_attempt_at TEXT,
        queued_at TEXT, reason TEXT CHECK(reason IN ('repeated_failure','owner_request')),
        confirmed_deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_sync (
        item_id TEXT PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
        availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','not_found','archived')),
        last_checked_at TEXT, last_check_error TEXT, clocks TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS catalog_audit_queue (
        audit_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
        outcome TEXT, processed_at TEXT, PRIMARY KEY(audit_id,item_id)
      );
      INSERT OR IGNORE INTO catalog_meta (key, value) VALUES ('revision', '0');
      CREATE TABLE IF NOT EXISTS catalog_categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES catalog_categories(id), name_key TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS category_sibling_name ON catalog_categories(COALESCE(parent_id, ''), name_key);
    `);
    // This marker makes the fixed-category migration one-time, including after a
    // user deletes a default category. Existing assignments keep their old IDs.
    this.transaction(() => {
      // Focus belongs to this organizer, not the imported source metadata.
      // Adding the default in-place preserves saved rows, revisions, and undo.
      if (!this.db.prepare('PRAGMA table_info(catalog_items)').all().some(column => column.name === 'focused')) {
        this.db.exec("ALTER TABLE catalog_items ADD COLUMN focused INTEGER NOT NULL DEFAULT 0 CHECK (focused IN (0, 1) AND (kind = 'chat' OR focused = 0))");
      }
      if (!this.db.prepare('PRAGMA table_info(catalog_items)').all().some(column => column.name === 'web_conversation_id')) this.db.exec('ALTER TABLE catalog_items ADD COLUMN web_conversation_id TEXT');
      if (!this.db.prepare('PRAGMA table_info(catalog_items)').all().some(column => column.name === 'chatgpt_project_id')) this.db.exec('ALTER TABLE catalog_items ADD COLUMN chatgpt_project_id TEXT');
      if (!this.db.prepare('PRAGMA table_info(catalog_deletion_review)').all().some(column => column.name === 'confirmed_deleted_at')) this.db.exec('ALTER TABLE catalog_deletion_review ADD COLUMN confirmed_deleted_at TEXT');
      if (!this.meta('categoriesVersion')) {
        const insert = this.db.prepare('INSERT INTO catalog_categories (id, name, parent_id, name_key) VALUES (?, ?, NULL, ?)');
        for (const id of CATEGORIES) insert.run(id, id, nameKey(id));
        this.writeMeta('categoriesVersion', '1');
      }
      // Adopt a user's existing root Trash, including its generated ID. Adding
      // a missing root leaves item assignments, the stored order, and Undo intact.
      if (!this.db.prepare("SELECT id FROM catalog_categories WHERE parent_id IS NULL AND name_key = 'trash'").get()) {
        const undo = JSON.parse(this.meta('undoDelete') ?? 'null');
        const deletedTrash = undo?.categories?.find(category => category.parentId === null && nameKey(category.name) === 'trash');
        const preferredId = deletedTrash?.id ?? 'Trash';
        const id = this.category(preferredId) ? `category:${randomUUID()}` : preferredId;
        this.db.prepare("INSERT INTO catalog_categories (id, name, parent_id, name_key) VALUES (?, 'Trash', NULL, 'trash')").run(id);
      }
      // Persist the previous interface order once. This structural migration
      // leaves revisions, assignments, and any pending deletion undo intact.
      if (!this.meta('rootCategoryOrder')) {
        this.writeMeta('rootCategoryOrder', JSON.stringify(initialRootOrder(this.rootCategories())));
      }
    });
  }

  close() { this.db.close(); }
  meta(key) { return this.db.prepare('SELECT value FROM catalog_meta WHERE key = ?').get(key)?.value ?? null; }
  writeMeta(key, value) { this.db.prepare('INSERT INTO catalog_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  bumpRevision() {
    this.writeMeta('revision', Number(this.meta('revision')) + 1);
    this.writeMeta('savedAt', new Date().toISOString());
  }

  clearUndo() { this.db.prepare("DELETE FROM catalog_meta WHERE key = 'undoDelete'").run(); }

  assertRevision(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CatalogError('INVALID_REVISION', 'expectedRevision must be a nonnegative integer.');
    if (expectedRevision !== Number(this.meta('revision'))) throw new CatalogError('STALE_REVISION', 'The catalog changed. Refresh it before saving your change.');
  }

  category(id) {
    return this.db.prepare('SELECT id, name, parent_id AS parentId FROM catalog_categories WHERE id = ?').get(id);
  }

  rootCategories() {
    return this.db.prepare('SELECT id, name, parent_id AS parentId FROM catalog_categories WHERE parent_id IS NULL').all().map(row => ({ ...row }));
  }

  rootOrder() {
    const roots = this.rootCategories();
    const remaining = new Set(roots.map(category => category.id));
    const stored = JSON.parse(this.meta('rootCategoryOrder') ?? '[]');
    const ordered = [];
    for (const id of stored) {
      if (remaining.delete(id)) ordered.push(id);
    }
    // A still-running older version may add a root during an upgrade. Keep the
    // saved order and append those roots without changing data during a read.
    for (const category of roots.sort(compareCategories)) {
      if (remaining.delete(category.id)) ordered.push(category.id);
    }
    return ordered;
  }

  categories() {
    const rows = this.db.prepare('SELECT id, name, parent_id AS parentId FROM catalog_categories').all().map(row => ({ ...row }));
    const rootPositions = new Map(this.rootOrder().map((id, index) => [id, index]));
    const ordered = [];
    const walk = parentId => {
      const compare = parentId === null ? (a, b) => rootPositions.get(a.id) - rootPositions.get(b.id) : compareCategories;
      for (const row of rows.filter(candidate => candidate.parentId === parentId).sort(compare)) {
        ordered.push({ ...row, protected: protectedCategory(row) });
        walk(row.id);
      }
    };
    walk(null);
    return ordered;
  }

  categoryDepth(id) {
    let depth = 0;
    while (id !== null) {
      const category = this.category(id);
      if (!category) throw new CatalogError('INVALID_CATEGORY', 'That category is no longer available. Refresh the catalog.');
      depth += 1;
      if (depth > MAX_CATEGORY_DEPTH) throw new CatalogError('INVALID_CATEGORY', 'The category hierarchy is invalid.');
      id = category.parentId;
    }
    return depth;
  }

  assertNameAvailable(name, parentId, exceptId = null) {
    const duplicate = this.db.prepare('SELECT id FROM catalog_categories WHERE parent_id IS ? AND name_key = ?').get(parentId, nameKey(name));
    if (duplicate && duplicate.id !== exceptId) throw new CatalogError('DUPLICATE_CATEGORY', 'A category with that name already exists under this parent.');
  }

  snapshot(transport = 'stdio') {
    if (!this.db.isTransaction) {
      this.db.exec('BEGIN');
      try { const value = this.snapshot(transport); this.db.exec('COMMIT'); return value; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    const items = this.db.prepare(`SELECT id, source, source_id AS sourceId, title, kind,
      project_id AS projectId, host_id AS hostId, url, updated_at AS updatedAt, category, focused, web_conversation_id AS webConversationId, chatgpt_project_id AS chatgptProjectId
      FROM catalog_items ORDER BY title COLLATE NOCASE, id`).all().map(({webConversationId,chatgptProjectId,...row}) => ({ ...row, focused: row.kind === 'chat' && row.focused === 1, ...(webConversationId?{webConversationId}:{}), ...(chatgptProjectId?{chatgptProjectId}:{}) }));
    const sync = new Map(this.db.prepare('SELECT item_id,availability,last_checked_at,last_check_error FROM catalog_sync').all().map(row => [row.item_id,row]));
    const hidden = new Set(this.db.prepare('SELECT item_id FROM catalog_hidden').all().map(row => row.item_id));
    const deletionReviews = new Map(this.db.prepare(`SELECT item_id, failure_count AS failureCount,
      first_failed_at AS firstFailedAt, last_failed_at AS lastFailedAt, queued_at AS queuedAt, reason
      FROM catalog_deletion_review WHERE queued_at IS NOT NULL`).all().map(({item_id,...review}) => [item_id, review]));
    const canonical=new Map(items.filter(item=>item.source==='chatgpt'&&item.kind==='chat').map(item=>[item.sourceId,item]));
    const canonicalProjects = new Map(items.filter(item => item.source === 'chatgpt' && item.kind === 'project').map(item => [item.sourceId, item]));
    const hiddenProjectAliases = new Set(), projectAliases = new Map();
    for (const item of items) {
      if (hidden.has(item.id) || item.source !== 'codex' || item.kind !== 'project' || item.hostId !== 'local' || !item.chatgptProjectId) continue;
      const parent = canonicalProjects.get(item.chatgptProjectId);
      if (!parent || hidden.has(parent.id) || parent.category !== item.category || (sync.get(parent.id)?.availability ?? 'available') !== 'available' || (sync.get(item.id)?.availability ?? 'available') !== 'available') continue;
      hiddenProjectAliases.add(item.id);
      if (!projectAliases.has(parent.id)) projectAliases.set(parent.id, []);
      projectAliases.get(parent.id).push({sourceId:item.sourceId,hostId:item.hostId});
    }
    const visible = items.filter(item => {
      if (hidden.has(item.id) || hiddenProjectAliases.has(item.id)) return false;
      if (item.source === 'codex' && item.kind === 'project' && item.hostId === 'local' && item.chatgptProjectId && hidden.has(canonicalProjects.get(item.chatgptProjectId)?.id)) return false;
      const availability=sync.get(item.id)?.availability;
      if (availability==='archived'||(item.kind==='chat'&&availability==='not_found')) return false;
      const parent=item.source==='codex'&&item.webConversationId?canonical.get(item.webConversationId):null;
      if (!parent) return true;
      if (hidden.has(parent.id)) return false;
      const parentStatus=sync.get(parent.id)?.availability;
      return parentStatus!=='archived'&&parentStatus!=='not_found'&&(parent.category!==item.category||parent.focused!==item.focused);
    }).map(item => ({...item, ...(projectAliases.has(item.id) ? {projectAliases:projectAliases.get(item.id)} : {}),
      ...(deletionReviews.has(item.id) ? {deletionReview:deletionReviews.get(item.id)} : {}),
      availability: sync.get(item.id)?.availability ?? 'available', lastCheckedAt: sync.get(item.id)?.last_checked_at ?? null,
      lastCheckError: sync.get(item.id)?.last_check_error ?? null }));
    const lastImport = this.meta('lastImport');
    const undo = this.meta('undoDelete');
    const undoDelete = undo ? JSON.parse(undo) : null;
    return {
      items: withRecentActivity(visible), categories: this.categories(), revision: Number(this.meta('revision')),
      savedAt: this.meta('savedAt'), lastImport: lastImport ? JSON.parse(lastImport) : null,
      undoDelete: undoDelete ? { token: undoDelete.token, label: undoDelete.label } : null,
      connection: { serverVersion: '0.2.2', transport },
    };
  }

  reorderCategories({ ids, expectedRevision }, transport = 'stdio') {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 350)) {
      throw new CatalogError('INVALID_CATEGORY_ORDER', 'Provide every top-level category ID exactly once.');
    }
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const current = this.rootOrder();
      const valid = new Set(current);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !valid.has(id))) {
        throw new CatalogError('INVALID_CATEGORY_ORDER', 'The order must contain every top-level category exactly once, including Uncategorized and Trash.');
      }
      if (ids.some((id, index) => id !== current[index])) {
        this.writeMeta('rootCategoryOrder', JSON.stringify(ids));
        this.clearUndo();
        this.bumpRevision();
      }
      return this.snapshot(transport);
    });
  }

  setHidden({id, hidden, expectedRevision}, transport = 'stdio') {
    requiredText(id, 'id', 350);
    if (typeof hidden !== 'boolean') throw new CatalogError('INVALID_INPUT', 'Hidden must be an explicit boolean.');
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      if (!this.db.prepare('SELECT 1 FROM catalog_items WHERE id=?').get(id)) throw new CatalogError('NOT_FOUND', 'That item is not in the catalog.');
      const current = Boolean(this.db.prepare('SELECT 1 FROM catalog_hidden WHERE item_id=?').get(id));
      let changed = false;
      if (!hidden) {
        const at = new Date(Date.now()).toISOString();
        for (const peer of this.organizationGroup(id)) {
          if (!this.db.prepare('SELECT 1 FROM catalog_deletion_review WHERE item_id=? AND confirmed_deleted_at IS NOT NULL').get(peer.id)) continue;
          this.db.prepare('DELETE FROM catalog_hidden WHERE item_id=?').run(peer.id);
          this.db.prepare('UPDATE catalog_deletion_review SET confirmed_deleted_at=NULL,last_attempt_at=? WHERE item_id=?').run(at,peer.id);
          changed = true;
        }
      }
      if (current !== hidden) {
        if (hidden) this.db.prepare('INSERT INTO catalog_hidden(item_id,hidden_at) VALUES(?,?)').run(id,new Date().toISOString());
        else this.db.prepare('DELETE FROM catalog_hidden WHERE item_id=?').run(id);
        changed = true;
      }
      if (changed) { this.clearUndo(); this.bumpRevision(); }
      return this.snapshot(transport);
    });
  }

  organizationGroup(id) {
    const item = this.db.prepare('SELECT id, source, source_id, kind, category, focused, host_id, web_conversation_id, chatgpt_project_id FROM catalog_items WHERE id = ?').get(id);
    if (!item) throw new CatalogError('NOT_FOUND', 'That item is not in the catalog.');
    const projectId = item.kind === 'project' ? (item.source === 'chatgpt' ? item.source_id : item.host_id === 'local' ? item.chatgpt_project_id : null) : null;
    if (projectId) return this.db.prepare(`SELECT id, kind, category, focused FROM catalog_items WHERE kind = 'project'
      AND ((source = 'chatgpt' AND source_id = ?) OR (source = 'codex' AND host_id = 'local' AND chatgpt_project_id = ?))`).all(projectId, projectId);
    const webId = item.kind === 'chat' ? (item.source === 'chatgpt' ? item.source_id : item.web_conversation_id) : null;
    if (!webId) return [item];
    // Only an explicit, verified mapping links source records. Read physical
    // rows so hidden aliases receive the same organization as the visible chat.
    return this.db.prepare(`SELECT id, kind, category, focused FROM catalog_items WHERE kind = 'chat'
      AND ((source = 'chatgpt' AND source_id = ?) OR (source = 'codex' AND web_conversation_id = ?))`).all(webId, webId);
  }

  reviewableChat(id) {
    const row = this.db.prepare(`SELECT i.kind, COALESCE(s.availability,'available') AS availability
      FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id WHERE i.id=?`).get(id);
    if (!row) throw new CatalogError('NOT_FOUND', 'That item is not in the catalog.');
    if (row.kind !== 'chat') throw new CatalogError('INVALID_INPUT', 'Only chats can be reviewed for deletion.');
    if (row.availability !== 'available') throw new CatalogError('INVALID_INPUT', 'That chat is already archived or confirmed missing.');
  }

  queueDeletionReview({id, expectedRevision}, transport = 'stdio') {
    requiredText(id, 'id', 350);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      this.reviewableChat(id);
      const at = new Date(Date.now()).toISOString();
      let changed = Boolean(this.db.prepare('DELETE FROM catalog_hidden WHERE item_id=?').run(id).changes);
      for (const peer of this.organizationGroup(id)) {
        const confirmation = this.db.prepare('SELECT confirmed_deleted_at FROM catalog_deletion_review WHERE item_id=?').get(peer.id);
        if (confirmation?.confirmed_deleted_at) {
          const unhidden = this.db.prepare('DELETE FROM catalog_hidden WHERE item_id=?').run(peer.id);
          changed ||= Boolean(unhidden.changes);
          this.db.prepare('UPDATE catalog_deletion_review SET confirmed_deleted_at=NULL WHERE item_id=?').run(peer.id);
        }
        const eligible = this.db.prepare(`SELECT 1 FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id
          WHERE i.id=? AND COALESCE(s.availability,'available')='available'
          AND NOT EXISTS(SELECT 1 FROM catalog_hidden h WHERE h.item_id=i.id)`).get(peer.id);
        if (!eligible) continue;
        const prior = this.db.prepare('SELECT queued_at FROM catalog_deletion_review WHERE item_id=?').get(peer.id);
        if (prior?.queued_at) continue;
        this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,queued_at,reason) VALUES(?,?,'owner_request')
          ON CONFLICT(item_id) DO UPDATE SET queued_at=excluded.queued_at,reason=excluded.reason`).run(peer.id,at);
        changed = true;
      }
      if (changed) { this.clearUndo(); this.bumpRevision(); }
      return this.snapshot(transport);
    });
  }

  resolveDeletionReview({id, action, expectedRevision}, transport = 'stdio') {
    requiredText(id, 'id', 350);
    if (!['restore','confirm_deleted'].includes(action)) throw new CatalogError('INVALID_INPUT', 'Choose restore or confirm_deleted.');
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      this.reviewableChat(id);
      if (!this.db.prepare('SELECT 1 FROM catalog_deletion_review WHERE item_id=? AND queued_at IS NOT NULL').get(id)) {
        throw new CatalogError('INVALID_INPUT', 'That chat is not awaiting deletion review.');
      }
      const at = new Date(Date.now()).toISOString();
      for (const peer of this.organizationGroup(id)) {
        if (action === 'confirm_deleted') {
          this.db.prepare('INSERT OR IGNORE INTO catalog_hidden(item_id,hidden_at) VALUES(?,?)').run(peer.id,at);
        }
        this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,last_attempt_at,confirmed_deleted_at) VALUES(?,?,?)
          ON CONFLICT(item_id) DO UPDATE SET failure_count=0,first_failed_at=NULL,last_failed_at=NULL,
          last_attempt_at=excluded.last_attempt_at,queued_at=NULL,reason=NULL,confirmed_deleted_at=excluded.confirmed_deleted_at`)
          .run(peer.id,at,action === 'confirm_deleted' ? at : null);
      }
      this.clearUndo(); this.bumpRevision();
      return this.snapshot(transport);
    });
  }

  inheritLinkedOrganization(id) {
    const peers = this.organizationGroup(id).filter(item => item.id !== id);
    // New source records inherit an established group's choices. Existing
    // disagreements remain visible until an explicit organizer edit resolves them.
    if (peers.length && peers.every(item => item.category === peers[0].category && item.focused === peers[0].focused)) {
      this.db.prepare('UPDATE catalog_items SET category = ?, focused = ? WHERE id = ?').run(peers[0].category, peers[0].focused, id);
    }
    this.inheritLinkedReview(id);
  }

  inheritLinkedReview(id) {
    const group = this.organizationGroup(id);
    if (group[0].kind !== 'chat') return false;
    const rows = group.map(peer => ({id:peer.id,...this.db.prepare('SELECT * FROM catalog_deletion_review WHERE item_id=?').get(peer.id)}));
    const confirmation = rows.filter(row => row.confirmed_deleted_at).sort((a,b) => timestamp(b.confirmed_deleted_at)-timestamp(a.confirmed_deleted_at))[0];
    let changed = false;
    if (confirmation) {
      for (const peer of group) {
        const hidden = this.db.prepare('INSERT OR IGNORE INTO catalog_hidden(item_id,hidden_at) VALUES(?,?)').run(peer.id,confirmation.confirmed_deleted_at);
        changed ||= Boolean(hidden.changes);
        this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,last_attempt_at,confirmed_deleted_at) VALUES(?,?,?)
          ON CONFLICT(item_id) DO UPDATE SET failure_count=0,first_failed_at=NULL,last_failed_at=NULL,queued_at=NULL,reason=NULL,
          last_attempt_at=excluded.last_attempt_at,confirmed_deleted_at=excluded.confirmed_deleted_at`)
          .run(peer.id,confirmation.last_attempt_at,confirmation.confirmed_deleted_at);
      }
      return changed;
    }
    const queued = rows.filter(row => row.queued_at).sort((a,b) => timestamp(b.queued_at)-timestamp(a.queued_at))[0];
    if (!queued) return false;
    for (const peer of group) {
      const current = rows.find(row => row.id === peer.id);
      if (current.queued_at || this.db.prepare('SELECT 1 FROM catalog_hidden WHERE item_id=?').get(peer.id)
        || (this.db.prepare('SELECT availability FROM catalog_sync WHERE item_id=?').get(peer.id)?.availability ?? 'available') !== 'available') continue;
      this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,failure_count,first_failed_at,last_failed_at,last_attempt_at,queued_at,reason)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET failure_count=excluded.failure_count,
        first_failed_at=excluded.first_failed_at,last_failed_at=excluded.last_failed_at,last_attempt_at=excluded.last_attempt_at,
        queued_at=excluded.queued_at,reason=excluded.reason`)
        .run(peer.id,queued.failure_count,queued.first_failed_at,queued.last_failed_at,queued.last_attempt_at,queued.queued_at,queued.reason);
      changed = true;
    }
    return changed;
  }

  setCategory({ id, category, expectedRevision }, transport = 'stdio') {
    requiredText(id, 'id', 350);
    requiredText(category, 'category', 350);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      if (!this.category(category)) throw new CatalogError('INVALID_CATEGORY', 'Choose one of the provided categories.');
      const changed = this.organizationGroup(id).filter(item => item.category !== category);
      if (changed.length) {
        const update = this.db.prepare('UPDATE catalog_items SET category = ? WHERE id = ?');
        for (const item of changed) update.run(category, item.id);
        this.clearUndo();
        this.bumpRevision();
      }
      return this.snapshot(transport);
    });
  }

  setFocus({ id, focused, expectedRevision }, transport = 'stdio') {
    requiredText(id, 'id', 350);
    if (typeof focused !== 'boolean') throw new CatalogError('INVALID_INPUT', 'focused must be true or false.');
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const group = this.organizationGroup(id);
      if (group[0].kind !== 'chat') throw new CatalogError('INVALID_INPUT', 'Only chats can have a focus mark.');
      const changed = group.filter(item => Boolean(item.focused) !== focused);
      if (changed.length) {
        const rawUndo = this.meta('undoDelete');
        const undo = rawUndo ? JSON.parse(rawUndo) : null;
        const update = this.db.prepare('UPDATE catalog_items SET focused = ? WHERE id = ?');
        for (const item of changed) update.run(Number(focused), item.id);
        this.bumpRevision();
        // Focus leaves category assignments untouched, so their undo is safe.
        if (undo && undo.revision === expectedRevision) {
          undo.revision = Number(this.meta('revision'));
          this.writeMeta('undoDelete', JSON.stringify(undo));
        }
      }
      return this.snapshot(transport);
    });
  }

  createCategoryPath({ parentId, names, expectedRevision }, transport = 'stdio') {
    if (parentId !== null) requiredText(parentId, 'parentId', 350);
    if (!Array.isArray(names) || names.length < 1 || names.length > MAX_CATEGORY_DEPTH) throw new CatalogError('INVALID_INPUT', 'Provide one to three new category names.');
    names = names.map(categoryName);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      if (parentId === 'Uncategorized') throw new CatalogError('PROTECTED_CATEGORY', 'Uncategorized cannot contain subcategories.');
      if (parentId === null && RESERVED_ROOT_NAMES.has(nameKey(names[0]))) throw new CatalogError('PROTECTED_CATEGORY', 'That category name is reserved for an organizer view.');
      if (this.categoryDepth(parentId) + names.length > MAX_CATEGORY_DEPTH) throw new CatalogError('MAX_DEPTH', 'Use a category and up to two nested subcategories.');
      const rootOrder = this.rootOrder();
      const insert = this.db.prepare('INSERT INTO catalog_categories (id, name, parent_id, name_key) VALUES (?, ?, ?, ?)');
      for (const name of names) {
        this.assertNameAvailable(name, parentId);
        const id = `category:${randomUUID()}`;
        insert.run(id, name, parentId, nameKey(name));
        if (parentId === null) {
          rootOrder.push(id);
          this.writeMeta('rootCategoryOrder', JSON.stringify(rootOrder));
        }
        parentId = id;
      }
      this.clearUndo();
      this.bumpRevision();
      return this.snapshot(transport);
    });
  }

  renameCategory({ id, name, expectedRevision }, transport = 'stdio') {
    requiredText(id, 'id', 350);
    name = categoryName(name);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const category = this.category(id);
      if (!category) throw new CatalogError('INVALID_CATEGORY', 'That category is no longer available. Refresh the catalog.');
      if (protectedCategory(category)) throw new CatalogError('PROTECTED_CATEGORY', `${category.name} cannot be renamed.`);
      if (category.parentId === null && RESERVED_ROOT_NAMES.has(nameKey(name))) throw new CatalogError('PROTECTED_CATEGORY', 'That category name is reserved for an organizer view.');
      this.assertNameAvailable(name, category.parentId, id);
      if (name !== category.name) {
        this.db.prepare('UPDATE catalog_categories SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey(name), id);
        this.clearUndo();
        this.bumpRevision();
      }
      return this.snapshot(transport);
    });
  }

  deleteCategory({ id, expectedRevision }, transport = 'stdio') {
    requiredText(id, 'id', 350);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const category = this.category(id);
      if (!category) throw new CatalogError('INVALID_CATEGORY', 'That category is no longer available. Refresh the catalog.');
      if (protectedCategory(category)) throw new CatalogError('PROTECTED_CATEGORY', `${category.name} cannot be deleted.`);
      const rootOrder = this.rootOrder();
      const branch = [];
      const collect = categoryId => {
        branch.push({ ...this.category(categoryId) });
        for (const child of this.db.prepare('SELECT id FROM catalog_categories WHERE parent_id = ? ORDER BY id').all(categoryId)) collect(child.id);
      };
      collect(id);
      const assignments = [];
      const selectItems = this.db.prepare('SELECT id, category FROM catalog_items WHERE category = ? ORDER BY id');
      const rehome = this.db.prepare("UPDATE catalog_items SET category = 'Uncategorized' WHERE category = ?");
      const remove = this.db.prepare('DELETE FROM catalog_categories WHERE id = ?');
      for (const entry of branch) {
        assignments.push(...selectItems.all(entry.id).map(row => ({ ...row })));
        rehome.run(entry.id);
      }
      for (const entry of [...branch].reverse()) remove.run(entry.id);
      if (category.parentId === null) this.writeMeta('rootCategoryOrder', JSON.stringify(rootOrder.filter(rootId => rootId !== id)));
      this.bumpRevision();
      this.writeMeta('undoDelete', JSON.stringify({ token: randomUUID(), label: category.name, revision: Number(this.meta('revision')), categories: branch, assignments, rootOrder }));
      return this.snapshot(transport);
    });
  }

  undoDeleteCategory({ token, expectedRevision }, transport = 'stdio') {
    requiredText(token, 'token', 100);
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const raw = this.meta('undoDelete');
      const undo = raw ? JSON.parse(raw) : null;
      if (!undo || undo.token !== token) throw new CatalogError('UNDO_UNAVAILABLE', 'This deletion can no longer be undone.');
      if (undo.revision !== expectedRevision) throw new CatalogError('UNDO_CONFLICT', 'The catalog changed after this deletion; undo cannot safely restore it.');
      const insert = this.db.prepare('INSERT INTO catalog_categories (id, name, parent_id, name_key) VALUES (?, ?, ?, ?)');
      for (const category of undo.categories) {
        const existing = this.category(category.id);
        // A pre-upgrade deletion of Trash may still be waiting for Undo. Its
        // permanent root was recreated without reassigning any chats; reuse it.
        if (existing && category.parentId === null && nameKey(category.name) === 'trash' && existing.parentId === null && nameKey(existing.name) === 'trash') continue;
        if (existing) throw new CatalogError('UNDO_CONFLICT', 'A deleted category ID is already in use.');
        this.assertNameAvailable(category.name, category.parentId);
        if (this.categoryDepth(category.parentId) + 1 > MAX_CATEGORY_DEPTH) throw new CatalogError('UNDO_CONFLICT', 'The original category hierarchy cannot be restored.');
        insert.run(category.id, category.name, category.parentId, nameKey(category.name));
      }
      const lookup = this.db.prepare('SELECT category FROM catalog_items WHERE id = ?');
      const restore = this.db.prepare('UPDATE catalog_items SET category = ? WHERE id = ?');
      for (const assignment of undo.assignments) {
        if (lookup.get(assignment.id)?.category !== 'Uncategorized') throw new CatalogError('UNDO_CONFLICT', 'An affected item has changed; undo cannot safely restore it.');
        restore.run(assignment.category, assignment.id);
      }
      // Older undo records have no position data. Their roots used the fixed
      // interface order, which can be reconstructed after restoring the branch.
      const restoredOrder = undo.rootOrder ?? (undo.categories.some(category => category.parentId === null) ? initialRootOrder(this.rootCategories()) : this.rootOrder());
      this.writeMeta('rootCategoryOrder', JSON.stringify(restoredOrder));
      this.clearUndo();
      this.bumpRevision();
      return this.snapshot(transport);
    });
  }

  refreshLocalActivity({ records, attempted, checked, unavailable, expectedRevision }, transport = 'stdio') {
    if (!Array.isArray(records) || records.length > 20000 ||
      ![attempted, checked, unavailable].every(value => Number.isSafeInteger(value) && value >= 0) ||
      attempted !== checked + unavailable || records.length > checked) {
      throw new CatalogError('INVALID_INPUT', 'The activity refresh result is invalid.');
    }
    const seen = new Set();
    const validated = records.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new CatalogError('INVALID_INPUT', 'Each activity record must be an object.');
      const id = requiredText(record.id, 'id', 350);
      if (seen.has(id)) throw new CatalogError('DUPLICATE_ID', 'The activity refresh contains duplicate item IDs.');
      seen.add(id);
      const title = optionalText(record.title, 'title', 1000);
      const updatedAt = optionalText(record.updatedAt, 'updatedAt', 100);
      if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) throw new CatalogError('INVALID_INPUT', 'updatedAt must be a valid date.');
      return { id, title, updatedAt };
    });
    return this.transaction(() => {
      this.assertRevision(expectedRevision);
      const lookup = this.db.prepare('SELECT source, kind, host_id AS hostId, title, updated_at AS updatedAt FROM catalog_items WHERE id = ?');
      const update = this.db.prepare('UPDATE catalog_items SET title = ?, updated_at = ? WHERE id = ?');
      let updated = 0;
      for (const record of validated) {
        const current = lookup.get(record.id);
        if (!current || current.source !== 'codex' || current.kind !== 'chat' || (current.hostId && current.hostId !== 'local')) {
          throw new CatalogError('INVALID_INPUT', 'Activity refresh can only update existing local app chats.');
        }
        const title = record.title ?? current.title;
        const updatedAt = latestDate(current.updatedAt, record.updatedAt);
        if (title !== current.title || updatedAt !== current.updatedAt) {
          update.run(title, updatedAt, record.id);
          updated += 1;
        }
      }
      if (updated) {
        const rawUndo = this.meta('undoDelete');
        const undo = rawUndo ? JSON.parse(rawUndo) : null;
        this.bumpRevision();
        // Only titles and source dates changed, so category deletion undo is
        // still safe. Advance its guard along with this metadata-only revision.
        if (undo && undo.revision === expectedRevision) {
          undo.revision = Number(this.meta('revision'));
          this.writeMeta('undoDelete', JSON.stringify(undo));
        }
      }
      return { ...this.snapshot(transport), activityRefresh: {
        attempted, checked, updated, unavailable,
        limitation: 'Web chat dates need an assistant refresh.',
      } };
    });
  }

  maintenanceState() {
    const counts = this.db.prepare(`SELECT COALESCE(s.availability,'available') AS availability,COUNT(*) AS count
      FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id GROUP BY 1`).all();
    const snapshot = this.snapshot();
    return {revision:Number(this.meta('revision')),visibleItems:snapshot.items.length,
      deletionReviewItems:snapshot.items.filter(item => item.deletionReview).map(item => ({id:item.id,title:item.title,...item.deletionReview})),
      counts:Object.fromEntries(counts.map(row=>[row.availability,row.count])),
      recentVerificationRetryAfter:this.meta('recentVerificationRetryAfter'),
      lastSync:JSON.parse(this.meta('lastSync') ?? 'null'),audit:JSON.parse(this.meta('dailyAudit') ?? 'null'),
      lastRecentRun:JSON.parse(this.meta('lastRecentRun') ?? 'null'),lastDailyRun:JSON.parse(this.meta('lastDailyRun') ?? 'null')};
  }

  recentVerificationBatch({observedIds=[],limit=8}={}) {
    if (!Array.isArray(observedIds)||observedIds.length>20000||observedIds.some(id=>typeof id!=='string')||!Number.isSafeInteger(limit)||limit<1||limit>8) throw new CatalogError('INVALID_INPUT','Invalid recent verification request.');
    const seen=new Set(observedIds), now=Date.now(), cutoff=now-30*86400000;
    const candidates=this.db.prepare(`SELECT i.id,i.source,i.source_id AS sourceId,i.kind,i.title,i.host_id AS hostId,i.updated_at AS updatedAt,i.web_conversation_id AS webConversationId,COALESCE(s.availability,'available') AS availability,s.clocks,
      COALESCE(r.failure_count,0) AS failureCount,r.last_attempt_at AS lastAttemptAt
      FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id LEFT JOIN catalog_deletion_review r ON r.item_id=i.id
      WHERE i.kind='chat' AND COALESCE(s.availability,'available')='available' AND r.queued_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM catalog_hidden h WHERE h.item_id=i.id)`).all().map(row=>{
      const clocks=JSON.parse(row.clocks??'{}');return {...row,verifiedAt:Math.max(clocks.verification??0,timestamp(row.lastAttemptAt)),untitled:row.source==='codex'&&row.title===row.sourceId&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.title)};
    }).filter(row=>(timestamp(row.updatedAt)>=cutoff||row.failureCount>0)&&!(row.source==='codex'&&row.webConversationId)&&(row.untitled||row.failureCount>0||!seen.has(row.id))&&row.verifiedAt<=now-VERIFICATION_INTERVAL_MS)
      .sort((a,b)=>Number(b.untitled)-Number(a.untitled)||a.verifiedAt-b.verifiedAt||timestamp(b.updatedAt)-timestamp(a.updatedAt)||a.id.localeCompare(b.id));
    const retryAfter=this.meta('recentVerificationRetryAfter');
    return {items:retryAfter&&Date.parse(retryAfter)>now?[]:candidates.slice(0,limit).map(({clocks,verifiedAt,untitled,failureCount,lastAttemptAt,...row})=>row),pendingItems:candidates.map(({id,title,availability})=>({id,title,availability})),pending:candidates.length,retryAfter:retryAfter&&Date.parse(retryAfter)>now?retryAfter:null};
  }

  deferRecentVerification() {
    const retryAfter=new Date(Date.now()+60*60*1000).toISOString();this.writeMeta('recentVerificationRetryAfter',retryAfter);return {retryAfter};
  }

  recordMaintenanceRun(report) {
    if(!report||typeof report!=='object'||Array.isArray(report)||!['recent','daily'].includes(report.mode)) throw new CatalogError('INVALID_INPUT','Run mode must be recent or daily.');
    const compact={mode:report.mode,recordedAt:new Date().toISOString()};
    for(const key of ['dryRun','complete','paused']) if(Object.hasOwn(report,key)) {
      if(typeof report[key]!=='boolean') throw new CatalogError('INVALID_INPUT','Invalid run flag.');
      compact[key]=report[key];
    }
    for(const key of ['elapsedSeconds','added','renamed','moved','statusChanged','checked','probeCalls','batches','projectCount','observations','visibleItems','exceptionsOmitted']) if(Object.hasOwn(report,key)) {
      if(typeof report[key]!=='number'||!Number.isFinite(report[key])||report[key]<0||(key!=='elapsedSeconds'&&!Number.isSafeInteger(report[key]))) throw new CatalogError('INVALID_INPUT','Invalid run count.');
      compact[key]=report[key];
    }
    if(Object.hasOwn(report,'skipped')) compact.skipped=requiredText(report.skipped,'Run skip reason',500);
    if(Object.hasOwn(report,'deferred')) compact.deferred=requiredText(report.deferred,'Run defer reason',500);
    if(Object.hasOwn(report,'errors')) {
      if(!Array.isArray(report.errors)) throw new CatalogError('INVALID_INPUT','Run errors must be an array.');
      compact.errors=report.errors.map(error=>{
        if(!error||typeof error!=='object'||Array.isArray(error)) throw new CatalogError('INVALID_INPUT','Invalid run error.');
        const detail={};
        for(const key of ['source','code','message']) if(Object.hasOwn(error,key)) detail[key]=requiredText(error[key],'Run error '+key,key==='message'?500:100);
        return detail;
      });
    }
    if(Object.hasOwn(report,'sources')) {
      if(!report.sources||typeof report.sources!=='object'||Array.isArray(report.sources)) throw new CatalogError('INVALID_INPUT','Invalid run source counts.');
      compact.sources=Object.fromEntries(Object.entries(report.sources).map(([key,value])=>{
        if(!key||key.length>100||!Number.isSafeInteger(value)||value<0) throw new CatalogError('INVALID_INPUT','Invalid run source count.');
        return [key,value];
      }));
    }
    if(Object.hasOwn(report,'exceptions')) {
      const reasons=new Set(['verification_failed','verification_pending','project_membership_unverified','possibly_missing','title_pending','invalid_metadata','untitled','not_found','potentially_deleted']);
      if(!Array.isArray(report.exceptions)||report.exceptions.length>1000)throw new CatalogError('INVALID_INPUT','Invalid named exceptions.');
      const savedTitle=this.db.prepare('SELECT title FROM catalog_items WHERE id=?');
      compact.exceptions=report.exceptions.map(item=>{
        if(!item||typeof item!=='object'||Array.isArray(item)||!reasons.has(item.reason)||Object.keys(item).some(key=>!['id','title','reason','detail'].includes(key)))throw new CatalogError('INVALID_INPUT','Invalid named exception.');
        const id=requiredText(item.id,'Exception ID',350);
        if(!/^(chatgpt|codex):(chat|project):.+$/.test(id))throw new CatalogError('INVALID_INPUT','Invalid exception identity.');
        return {id,title:optionalText(item.title,'Exception title',1000)??savedTitle.get(id)?.title??null,reason:item.reason,detail:requiredText(item.detail,'Exception detail',500)};
      });
    }
    if(Object.hasOwn(report,'audit')) {
      const audit=report.audit;
      if(audit===null)compact.audit=null;
      else {
        if(!audit||typeof audit!=='object'||Array.isArray(audit)) throw new CatalogError('INVALID_INPUT','Invalid run audit.');
        compact.audit={};
        for(const key of ['id','day','startedAt']) compact.audit[key]=requiredText(audit[key],'Run audit '+key,100);
        compact.audit.completedAt=optionalText(audit.completedAt,'Run audit completion',100);
        if(Object.hasOwn(audit,'retryAfter')) compact.audit.retryAfter=optionalText(audit.retryAfter,'Run audit retry time',100);
        if(Object.hasOwn(audit,'deferReason')) compact.audit.deferReason=optionalText(audit.deferReason,'Run audit defer reason',500);
        for(const key of ['total','processed','errors']) {
          if(!Number.isSafeInteger(audit[key])||audit[key]<0) throw new CatalogError('INVALID_INPUT','Invalid run audit count.');
          compact.audit[key]=audit[key];
        }
      }
    }
    const encoded=JSON.stringify(compact);
    if(encoded.length>2000000) throw new CatalogError('INVALID_INPUT','Run report must not exceed 2000000 characters.');
    return this.transaction(()=>{
      this.writeMeta(report.mode==='recent'?'lastRecentRun':'lastDailyRun',encoded);
      return compact;
    });
  }

  acquireMaintenanceLease({ttlMs=300000}={}) {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>1800000) throw new CatalogError('INVALID_INPUT','Invalid maintenance lease duration.');
    return this.transaction(()=>{
      const previous=JSON.parse(this.meta('maintenanceLease')??'null');
      if(previous && previous.expiresAt>Date.now())return {acquired:false,expiresAt:previous.expiresAt};
      const lease={token:randomUUID(),expiresAt:Date.now()+ttlMs};
      this.writeMeta('maintenanceLease',JSON.stringify(lease));return {acquired:true,...lease};
    });
  }

  assertMaintenanceLease(token) {
    const lease=JSON.parse(this.meta('maintenanceLease')??'null');
    if(!token||lease?.token!==token||lease.expiresAt<=Date.now())throw new CatalogError('LEASE_LOST','The maintenance run no longer holds its lease.');
    return lease;
  }

  renewMaintenanceLease({token}) {
    return this.transaction(()=>{
      const lease=this.assertMaintenanceLease(token);lease.expiresAt=Date.now()+300000;
      this.writeMeta('maintenanceLease',JSON.stringify(lease));return lease;
    });
  }

  releaseMaintenanceLease({token}) {
    return this.transaction(()=>{
      const lease=JSON.parse(this.meta('maintenanceLease')??'null');
      if(lease?.token===token)this.writeMeta('maintenanceLease','null');
      return {released:lease?.token===token};
    });
  }

  applyDeletionReviewObservation(obs, current, availability, previousVerification, statusAccepted) {
    if (current.kind !== 'chat') return false;
    const time = Date.parse(obs.observedAt);
    const prior = this.db.prepare('SELECT * FROM catalog_deletion_review WHERE item_id=?').get(obs.id);
    const group = this.organizationGroup(obs.id);
    const latestGroupAction = Math.max(...group.map(peer => {
      const row = this.db.prepare('SELECT last_attempt_at,queued_at FROM catalog_deletion_review WHERE item_id=?').get(peer.id);
      return Math.max(timestamp(row?.last_attempt_at),timestamp(row?.queued_at));
    }));
    const direct = ['probe','local_lookup'].includes(obs.evidence);
    const newerAttempt = time > latestGroupAction && time > previousVerification;
    const resolved = (direct && obs.outcome === 'found' && newerAttempt)
      || (statusAccepted && ['archived','not_found'].includes(obs.outcome) && time >= latestGroupAction);
    if (resolved) {
      let changed = false;
      for (const peer of this.organizationGroup(obs.id)) {
        const review = this.db.prepare('SELECT * FROM catalog_deletion_review WHERE item_id=?').get(peer.id);
        if (time < timestamp(review?.last_attempt_at)) continue;
        changed ||= Boolean(review?.queued_at);
        this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,last_attempt_at) VALUES(?,?)
          ON CONFLICT(item_id) DO UPDATE SET failure_count=0,first_failed_at=NULL,last_failed_at=NULL,
          last_attempt_at=excluded.last_attempt_at,queued_at=NULL,reason=NULL`).run(peer.id,obs.observedAt);
      }
      return changed;
    }
    if (!direct || !newerAttempt || availability !== 'available'
      || this.db.prepare('SELECT 1 FROM catalog_hidden WHERE item_id=?').get(obs.id)) return false;
    const spaced = time - Math.max(timestamp(prior?.last_attempt_at), previousVerification) >= VERIFICATION_INTERVAL_MS;
    const countFailure = obs.evidence === 'probe' && obs.outcome === 'error'
      && obs.verificationFailure === 'unresolved' && !infrastructureFailure(obs.error) && spaced && !prior?.queued_at;
    const failureCount = (prior?.failure_count ?? 0) + Number(countFailure);
    const firstFailedAt = countFailure ? prior?.first_failed_at ?? obs.observedAt : prior?.first_failed_at ?? null;
    const lastFailedAt = countFailure ? obs.observedAt : prior?.last_failed_at ?? null;
    this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,failure_count,first_failed_at,last_failed_at,last_attempt_at)
      VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET failure_count=excluded.failure_count,
      first_failed_at=excluded.first_failed_at,last_failed_at=excluded.last_failed_at,last_attempt_at=excluded.last_attempt_at`)
      .run(obs.id,failureCount,firstFailedAt,lastFailedAt,obs.observedAt);
    if (!countFailure || failureCount < 3) return false;
    // These peer IDs represent the same verified conversation, so the review
    // carries the actual triggering checks to its canonical visible entry.
    for (const peer of this.organizationGroup(obs.id)) {
      const eligible = this.db.prepare(`SELECT 1 FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id
        WHERE i.id=? AND COALESCE(s.availability,'available')='available'
        AND NOT EXISTS(SELECT 1 FROM catalog_hidden h WHERE h.item_id=i.id)`).get(peer.id);
      if (!eligible) continue;
      this.db.prepare(`INSERT INTO catalog_deletion_review(item_id,failure_count,first_failed_at,last_failed_at,last_attempt_at,queued_at,reason)
        VALUES(?,?,?,?,?,?,'repeated_failure') ON CONFLICT(item_id) DO UPDATE SET
        failure_count=excluded.failure_count,first_failed_at=excluded.first_failed_at,last_failed_at=excluded.last_failed_at,
        last_attempt_at=excluded.last_attempt_at,queued_at=COALESCE(catalog_deletion_review.queued_at,excluded.queued_at),
        reason=COALESCE(catalog_deletion_review.reason,excluded.reason)`)
        .run(peer.id,failureCount,firstFailedAt,lastFailedAt,obs.observedAt,obs.observedAt);
    }
    return true;
  }

  applySync({observations,expectedRevision,mode='recent',coverage=''}) {
    if (!Array.isArray(observations) || observations.length>20000) throw new CatalogError('INVALID_INPUT','Invalid observation batch.');
    const allowedEvidence = new Set(['sidebar','project_list','project_list_complete','local_index','chatgpt_cache','probe','archive_list','local_lookup','owner_confirmation']);
    const validated = observations.map(raw=>{
      if (!raw || typeof raw!=='object') throw new CatalogError('INVALID_INPUT','Invalid observation.');
      const id=requiredText(raw.id,'id',350),observedAt=requiredText(raw.observedAt,'observedAt',100);
      if (!/^(chatgpt|codex):(chat|project):.+$/.test(id) || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt)>Date.now()+300000) throw new CatalogError('INVALID_INPUT','Invalid observation identity or timestamp.');
      if (!allowedEvidence.has(raw.evidence) || !['found','not_found','archived','error'].includes(raw.outcome)) throw new CatalogError('INVALID_INPUT','Invalid observation evidence.');
      if (raw.outcome==='not_found' && !['probe','local_lookup','project_list_complete'].includes(raw.evidence)) throw new CatalogError('INVALID_INPUT','Not found requires an individual lookup or complete project listing.');
      if (raw.outcome==='archived' && !['archive_list','local_index','owner_confirmation'].includes(raw.evidence)) throw new CatalogError('INVALID_INPUT','Archived requires explicit archive evidence.');
      if (raw.evidence === 'owner_confirmation' && raw.outcome !== 'archived') throw new CatalogError('INVALID_INPUT','Owner archive confirmation only supports archived status.');
      if (Object.hasOwn(raw,'verificationFailure') && (raw.verificationFailure !== 'unresolved' || raw.evidence !== 'probe' || raw.outcome !== 'error')) throw new CatalogError('INVALID_INPUT','Unresolved verification requires a failed individual probe.');
      const result={...raw,id,observedAt:new Date(observedAt).toISOString()};
      if (Object.hasOwn(raw,'title')) result.title=requiredText(raw.title,'title',1000);
      for (const key of ['projectId','hostId','url','updatedAt','webConversationId','chatgptProjectId']) if (Object.hasOwn(raw,key)) result[key]=optionalText(raw[key],key,key==='url'?2000:300);
      if (Object.hasOwn(result,'webConversationId') && result.webConversationId!==null && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(result.webConversationId)) throw new CatalogError('INVALID_INPUT','Invalid verified web conversation ID.');
      if (Object.hasOwn(result,'chatgptProjectId') && raw.evidence !== 'project_list') throw new CatalogError('INVALID_INPUT','Project backing requires an explicit project listing.');
      if (result.updatedAt && !Number.isFinite(Date.parse(result.updatedAt))) throw new CatalogError('INVALID_INPUT','Invalid source date.');
      if (raw.outcome==='error') result.error=requiredText(raw.error ?? 'Lookup failed','error',500);
      return result;
    });
    const action=()=>{
      this.assertRevision(expectedRevision);
      const summary={revision:expectedRevision,added:0,renamed:0,moved:0,statusChanged:0,unchanged:0,errors:0,stale:0,checked:0};
      const lookup=this.db.prepare('SELECT * FROM catalog_items WHERE id=?');
      let changed=false;
      for (const obs of validated) {
        let current=lookup.get(obs.id);
        if (!current) {
          if (obs.outcome!=='found') {summary.unchanged++;continue;}
          const item=validateItem(obs);
          this.db.prepare(`INSERT INTO catalog_items(id,source,source_id,title,kind,project_id,host_id,url,updated_at,web_conversation_id,chatgpt_project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(item.id,item.source,item.sourceId,item.title,item.kind,item.projectId,item.hostId,item.url,item.updatedAt,item.webConversationId??null,item.chatgptProjectId??null);
          this.inheritLinkedOrganization(item.id);
          current=lookup.get(obs.id);summary.added++;changed=true;
        } else {
          if ((obs.source && obs.source!==current.source)||(obs.kind && obs.kind!==current.kind)||(obs.sourceId && obs.sourceId!==current.source_id)) throw new CatalogError('INVALID_ID','Observation identity does not match the saved item.');
          // Validate URL and optional metadata using the existing invariant checks.
          validateItem({id:current.id,source:current.source,sourceId:current.source_id,kind:current.kind,title:obs.title ?? current.title,hostId:Object.hasOwn(obs,'hostId')?obs.hostId:current.host_id,...(Object.hasOwn(obs,'chatgptProjectId')?{chatgptProjectId:obs.chatgptProjectId}:{}),...(Object.hasOwn(obs,'webConversationId')?{webConversationId:obs.webConversationId}:{}),...(Object.hasOwn(obs,'url')?{url:obs.url}:{})});
        }
        const saved=this.db.prepare('SELECT * FROM catalog_sync WHERE item_id=?').get(obs.id);
        const clocks=JSON.parse(saved?.clocks ?? '{}');
        let availability=saved?.availability ?? 'available',lastCheckedAt=saved?.last_checked_at ?? null,lastError=saved?.last_check_error ?? null;
        const time=Date.parse(obs.observedAt);
        const previousVerification=clocks.verification??-Infinity;
        let itemChanged=false,accepted=false;
        if (obs.outcome==='found') {
          const updates={};
          for (const [key,column] of [['title','title'],['projectId','project_id'],['hostId','host_id'],['url','url'],['updatedAt','updated_at'],['webConversationId','web_conversation_id'],['chatgptProjectId','chatgpt_project_id']]) {
            if (!Object.hasOwn(obs,key)) continue;
            // Untitled remote chats are listed with their ID. Keep a recovered
            // description until the source supplies a real title.
            if (key==='title' && current.source==='codex' && obs.title===current.source_id
              && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(obs.title)
              && current.title!==current.source_id) continue;
            // Historical imports predate field clocks. Their saved activity
            // date still bounds how old a cache observation may be on first sync.
            if (obs.evidence==='chatgpt_cache' && clocks[key]===undefined && time<=timestamp(current.updated_at)) {summary.stale++;continue;}
            if (time < (clocks[key] ?? -Infinity)) {summary.stale++;continue;}
            // An unchanged replay from a cache must not override a direct observation at the same timestamp.
            if (time === clocks[key] && obs.evidence==='chatgpt_cache') continue;
            const value=key==='updatedAt'?latestDate(current.updated_at,obs.updatedAt):obs[key];
            if (current[column]!==value) {updates[column]=value;itemChanged=true;if(key==='title')summary.renamed++;if(key==='projectId')summary.moved++;}
            clocks[key]=time;accepted=true;
          }
          if (Object.keys(updates).length) this.db.prepare(`UPDATE catalog_items SET ${Object.keys(updates).map(key=>key+'=?').join(',')} WHERE id=?`).run(...Object.values(updates),obs.id);
          if (Object.hasOwn(updates,'web_conversation_id') && this.inheritLinkedReview(obs.id)) itemChanged=true;
        }
        if (obs.evidence==='probe' && time>=(clocks.verification??-Infinity)) {clocks.verification=time;accepted=true;}
        const weakMissingReplay=current.kind==='chat'&&availability==='not_found'&&obs.outcome==='found'&&!['probe','local_lookup'].includes(obs.evidence);
        let statusAccepted=false;
        if (!weakMissingReplay && obs.outcome!=='error' && time >= (clocks.status ?? -Infinity) && !(time===clocks.status&&obs.evidence==='chatgpt_cache')) {
            // A readable archived conversation is still archived; probes do not report archive state.
            const next=obs.outcome==='archived'?'archived':obs.outcome==='not_found'?'not_found':
              availability==='archived'&&obs.evidence==='probe'?'archived':'available';
            if(next!==availability) {availability=next;summary.statusChanged++;itemChanged=true;}
            clocks.status=time;accepted=true;statusAccepted=true;
        }
        if(time >= (clocks.check ?? clocks.status ?? -Infinity) && !(time===clocks.check&&obs.evidence==='chatgpt_cache')) {
          lastError=obs.outcome==='error'?obs.error:null;
          if(obs.outcome==='error')summary.errors++;
          lastCheckedAt=obs.observedAt;clocks.check=time;accepted=true;summary.checked++;
        } else summary.stale++;
        if (accepted) this.db.prepare(`INSERT INTO catalog_sync(item_id,availability,last_checked_at,last_check_error,clocks) VALUES(?,?,?,?,?)
          ON CONFLICT(item_id) DO UPDATE SET availability=excluded.availability,last_checked_at=excluded.last_checked_at,last_check_error=excluded.last_check_error,clocks=excluded.clocks`)
          .run(obs.id,availability,lastCheckedAt,lastError,JSON.stringify(clocks));
        if (this.applyDeletionReviewObservation(obs,current,availability,previousVerification,statusAccepted)) itemChanged=true;
        if(itemChanged) changed=true;else summary.unchanged++;
      }
      if(changed) {this.clearUndo();this.bumpRevision();}
      summary.revision=Number(this.meta('revision'));
      this.writeMeta('lastSync',JSON.stringify({at:new Date().toISOString(),mode,coverage,...summary}));
      return summary;
    };
    return this.db.isTransaction?action():this.transaction(action);
  }

  beginAudit({day}) {
    if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CatalogError('INVALID_INPUT','Audit day must be YYYY-MM-DD.');
    return this.transaction(()=>{
      const previous=JSON.parse(this.meta('dailyAudit')??'null');
      if(previous && (!previous.completedAt || previous.day===day)) return previous;
      const id=randomUUID(),startedAt=new Date().toISOString();
      this.db.prepare('DELETE FROM catalog_audit_queue').run();
      this.db.prepare(`INSERT INTO catalog_audit_queue(audit_id,item_id) SELECT ?,i.id FROM catalog_items i LEFT JOIN catalog_sync s ON s.item_id=i.id
        WHERE COALESCE(s.availability,'available')='available' AND NOT EXISTS(SELECT 1 FROM catalog_hidden h WHERE h.item_id=i.id)
        AND NOT EXISTS(SELECT 1 FROM catalog_deletion_review r WHERE r.item_id=i.id AND r.queued_at IS NOT NULL)`).run(id);
      const audit={id,day,startedAt,completedAt:null,total:this.db.prepare('SELECT count(*) AS n FROM catalog_audit_queue WHERE audit_id=?').get(id).n,processed:0,errors:0,retryAfter:null,deferReason:null};
      if(!audit.total)audit.completedAt=startedAt;
      this.writeMeta('dailyAudit',JSON.stringify(audit));return audit;
    });
  }

  auditBatch({auditId,limit=40}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new CatalogError('INVALID_INPUT','Audit batch limit must be 1 to 100.');
    const audit=JSON.parse(this.meta('dailyAudit')??'null');
    if(!audit || audit.id!==auditId) throw new CatalogError('INVALID_AUDIT','Audit is no longer current.');
    const items=this.db.prepare(`SELECT i.id,i.source,i.source_id AS sourceId,i.kind,i.title,i.host_id AS hostId,COALESCE(s.availability,'available') AS availability
      FROM catalog_audit_queue q JOIN catalog_items i ON i.id=q.item_id LEFT JOIN catalog_sync s ON s.item_id=i.id
      WHERE q.audit_id=? AND q.outcome IS NULL ORDER BY i.id LIMIT ?`).all(auditId,limit).map(row=>({...row}));
    return {audit,items};
  }

  deferAudit({auditId,retryAfter,reason,retryIds=[]}) {
    auditId=requiredText(auditId,'Audit ID',100);
    retryAfter=requiredText(retryAfter,'Audit retry time',100);
    if(!Number.isFinite(Date.parse(retryAfter))) throw new CatalogError('INVALID_INPUT','Audit retry time must be a valid timestamp.');
    retryAfter=new Date(retryAfter).toISOString();
    reason=requiredText(reason,'Audit defer reason',500);
    if(!Array.isArray(retryIds)||retryIds.length>20000||retryIds.some(id=>typeof id!=='string'||!id||id.length>350)||new Set(retryIds).size!==retryIds.length) throw new CatalogError('INVALID_INPUT','Invalid audit retry IDs.');
    return this.transaction(()=>{
      const audit=JSON.parse(this.meta('dailyAudit')??'null');
      if(!audit||audit.id!==auditId) throw new CatalogError('INVALID_AUDIT','Audit is no longer current.');
      const errorRow=this.db.prepare("SELECT 1 FROM catalog_audit_queue WHERE audit_id=? AND item_id=? AND outcome='error'");
      for(const id of retryIds) if(!errorRow.get(auditId,id)) throw new CatalogError('INVALID_AUDIT','Only failed items in the current audit can be retried.');
      const reset=this.db.prepare('UPDATE catalog_audit_queue SET outcome=NULL,processed_at=NULL WHERE audit_id=? AND item_id=?');
      for(const id of retryIds) reset.run(auditId,id);
      audit.processed=this.db.prepare('SELECT count(*) AS n FROM catalog_audit_queue WHERE audit_id=? AND outcome IS NOT NULL').get(auditId).n;
      audit.errors=this.db.prepare("SELECT count(*) AS n FROM catalog_audit_queue WHERE audit_id=? AND outcome='error'").get(auditId).n;
      if(audit.processed<audit.total)audit.completedAt=null;
      audit.retryAfter=retryAfter;audit.deferReason=reason;
      this.writeMeta('dailyAudit',JSON.stringify(audit));return audit;
    });
  }

  applyAuditBatch({auditId,observations,expectedRevision}) {
    return this.transaction(()=>{
      const audit=JSON.parse(this.meta('dailyAudit')??'null');
      if(!audit||audit.id!==auditId||audit.completedAt) throw new CatalogError('INVALID_AUDIT','Audit is no longer pending.');
      const seen=new Set();
      for(const item of observations) {
        if(seen.has(item.id)||!this.db.prepare('SELECT 1 FROM catalog_audit_queue WHERE audit_id=? AND item_id=? AND outcome IS NULL').get(auditId,item.id)) throw new CatalogError('INVALID_AUDIT','Item is not pending in this audit.');
        seen.add(item.id);
      }
      const sync=this.applySync({observations,expectedRevision,mode:'daily',coverage:'Individual saved-ID audit; archive status supplied separately.'});
      const update=this.db.prepare('UPDATE catalog_audit_queue SET outcome=?,processed_at=? WHERE audit_id=? AND item_id=?');
      for(const obs of observations)update.run(obs.outcome,new Date().toISOString(),auditId,obs.id);
      audit.processed=this.db.prepare('SELECT count(*) AS n FROM catalog_audit_queue WHERE audit_id=? AND outcome IS NOT NULL').get(auditId).n;
      audit.errors=this.db.prepare("SELECT count(*) AS n FROM catalog_audit_queue WHERE audit_id=? AND outcome='error'").get(auditId).n;
      if(audit.processed===audit.total){audit.completedAt=new Date().toISOString();audit.retryAfter=null;audit.deferReason=null;}
      this.writeMeta('dailyAudit',JSON.stringify(audit));return {sync,audit};
    });
  }

  importFirstInventory({ items, coverage }, transport = 'stdio') {
    return this.importInventory({ items, coverage, firstImportOnly: true }, transport);
  }

  importInventory({ items, coverage, firstImportOnly = false }, transport = 'stdio') {
    if (!Array.isArray(items) || items.length > 20000) throw new CatalogError('INVALID_INPUT', 'items must be an array of at most 20000 entries.');
    coverage = requiredText(coverage, 'coverage', 2000);
    const validated = items.map(validateItem);
    const ids = new Set();
    for (const item of validated) {
      if (ids.has(item.id)) throw new CatalogError('DUPLICATE_ID', 'The import contains duplicate item IDs. No items were imported.');
      ids.add(item.id);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ coverage, items: [...validated].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({...item,projectIdProvided:item.projectIdProvided})) })).digest('hex');
    return this.transaction(() => {
      if (firstImportOnly && (Number(this.meta('revision')) !== 0 || this.db.prepare('SELECT COUNT(*) AS count FROM catalog_items').get().count !== 0)) {
        throw new CatalogError('CATALOG_NOT_EMPTY', 'Export import requires a fresh catalog at revision 0 with no saved records. Choose a new private data directory.');
      }
      if (this.meta('lastImportFingerprint') === fingerprint) return this.snapshot(transport);
      const upsert = this.db.prepare(`INSERT INTO catalog_items (id, source, source_id, title, kind, project_id, host_id, url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source, source_id=excluded.source_id,
        title=excluded.title, kind=excluded.kind, project_id=CASE WHEN ? THEN excluded.project_id ELSE catalog_items.project_id END,
        host_id=COALESCE(excluded.host_id, catalog_items.host_id), url=COALESCE(excluded.url, catalog_items.url),
        updated_at=excluded.updated_at`);
      const previousDate = this.db.prepare('SELECT updated_at AS updatedAt FROM catalog_items WHERE id = ?');
      for (const item of validated) {
        const previous = previousDate.get(item.id);
        const updatedAt = latestDate(previous?.updatedAt ?? null, item.updatedAt);
        upsert.run(item.id, item.source, item.sourceId, item.title, item.kind, item.projectId, item.hostId, item.url, updatedAt, item.projectIdProvided ? 1 : 0);
        if (Object.hasOwn(item,'webConversationId')) this.db.prepare('UPDATE catalog_items SET web_conversation_id=? WHERE id=?').run(item.webConversationId,item.id);
        if (Object.hasOwn(item,'chatgptProjectId')) this.db.prepare('UPDATE catalog_items SET chatgpt_project_id=? WHERE id=?').run(item.chatgptProjectId,item.id);
        if (!previous) this.inheritLinkedOrganization(item.id);
        else if (Object.hasOwn(item,'webConversationId')) this.inheritLinkedReview(item.id);
      }
      this.writeMeta('lastImport', JSON.stringify({ at: new Date().toISOString(), coverage, count: validated.length }));
      this.writeMeta('lastImportFingerprint', fingerprint);
      this.clearUndo();
      this.bumpRevision();
      return this.snapshot(transport);
    });
  }
}

export function defaultDatabasePath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const configured = env.CHAT_ORGANIZER_DATA_DIR;
  if (configured) {
    if (!isAbsolute(configured)) throw new CatalogError('MISSING_DATA_DIR', 'CHAT_ORGANIZER_DATA_DIR must name an absolute private catalog directory.');
    return resolve(configured, 'catalog.sqlite');
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : resolve(home, 'AppData', 'Local');
    return resolve(base, 'ChatOrganizer', 'catalog', 'catalog.sqlite');
  }
  if (platform === 'darwin') return resolve(home, 'Library', 'Application Support', 'ChatOrganizer', 'catalog', 'catalog.sqlite');
  const base = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : resolve(home, '.local', 'share');
  return resolve(base, 'chat-organizer', 'catalog', 'catalog.sqlite');
}
