import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CatalogStore } from '../store.mjs';

for (const cacheAge of ['older', 'equal']) {
  test(`first sync preserves imported metadata against ${cacheAge} cache evidence and accepts a current sidebar change`, () => {
    const store = new CatalogStore(':memory:');
    try {
      const now = Date.now();
      const savedDate = new Date(now - 300000).toISOString();
      const cacheDate = new Date(now - (cacheAge === 'older' ? 600000 : 300000)).toISOString();
      const currentDate = new Date(now - 1000).toISOString();
      const saved = { id: 'chatgpt:chat:imported', source: 'chatgpt', sourceId: 'imported', kind: 'chat',
        title: 'Current imported title', projectId: 'current-project', updatedAt: savedDate };
      let state = store.importInventory({ items: [saved], coverage: 'Synthetic historical import' });
      state = store.setCategory({ id: saved.id, category: 'Travel', expectedRevision: state.revision });
      state = store.setFocus({ id: saved.id, focused: true, expectedRevision: state.revision });
      const before = state.items[0];
      const cached = store.applySync({ observations: [{ ...saved, title: 'Stale cached title',
        projectId: 'old-project', updatedAt: cacheDate, observedAt: cacheDate, evidence: 'chatgpt_cache', outcome: 'found' }],
        expectedRevision: state.revision });
      const retained = store.snapshot().items[0];
      assert.equal(cached.renamed, 0);
      assert.equal(cached.moved, 0);
      assert.ok(cached.stale >= 2);
      assert.equal(cached.revision, state.revision);
      for (const field of ['id', 'title', 'projectId', 'updatedAt', 'category', 'focused']) assert.equal(retained[field], before[field], field);
      assert.equal(retained.availability, 'available', 'Legacy active entries remain available');

      // A live rename or move need not advance the source activity date.
      const refreshed = store.applySync({ observations: [{ ...saved, title: 'Current sidebar title',
        projectId: null, observedAt: currentDate, evidence: 'sidebar', outcome: 'found' }], expectedRevision: cached.revision });
      const after = store.snapshot().items[0];
      assert.equal(refreshed.renamed, 1);
      assert.equal(refreshed.moved, 1);
      assert.equal(after.title, 'Current sidebar title');
      assert.equal(after.projectId, null);
      for (const field of ['id', 'updatedAt', 'category', 'focused']) assert.equal(after[field], before[field], field);
      assert.equal(after.availability, 'available');
    } finally { store.close(); }
  });
}

test('compact last-run metrics survive reopening and preserve catalog data, revision, Undo, and audit progress', () => {
  const work = tmpdir();
  const directory = mkdtempSync(join(work, 'maintenance-run-'));
  const path = join(directory, 'synthetic.sqlite');
  let store = new CatalogStore(path);
  try {
    assert.equal(store.maintenanceState().lastRecentRun, null);
    assert.equal(store.maintenanceState().lastDailyRun, null);
    const saved = { id: 'chatgpt:chat:metrics', source: 'chatgpt', sourceId: 'metrics', kind: 'chat', title: 'Saved chat' };
    let state = store.importInventory({ items: [saved], coverage: 'Synthetic metrics test' });
    state = store.setCategory({ id: saved.id, category: 'Travel', expectedRevision: state.revision });
    state = store.setFocus({ id: saved.id, focused: true, expectedRevision: state.revision });
    state = store.deleteCategory({ id: 'Travel', expectedRevision: state.revision });
    const audit = store.beginAudit({ day: '2026-10-18' });
    const before = store.snapshot(), maintenance = store.maintenanceState();
    const recent = store.recordMaintenanceRun({ mode: 'recent', dryRun: false, complete: true, elapsedSeconds: 12.75,
      added: 0, renamed: 1, moved: 0, statusChanged: 0, checked: 40, probeCalls: 0, batches: 2, projectCount: 3,
      observations: 40, errors: [], sources: { localActive: 2, chatgptRecent: 38 }, ignoredInventory: [saved] });
    const daily = store.recordMaintenanceRun({ mode: 'daily', dryRun: false, complete: false, paused: true, deferred: 'Resume after the cooldown',
      elapsedSeconds: 45, probeCalls: 20, errors: [{ source: 'probe', code: 'TIMEOUT', message: 'Retry needed' }], audit });
    assert.equal(Object.hasOwn(recent, 'ignoredInventory'), false);
    assert.equal(daily.deferred, 'Resume after the cooldown');
    assert.ok(Number.isFinite(Date.parse(recent.recordedAt)));
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(store.auditBatch({ auditId: audit.id }).audit, audit);
    const expected = { ...maintenance, lastRecentRun: recent, lastDailyRun: daily };
    assert.deepEqual(store.maintenanceState(), expected);
    store.close();
    store = new CatalogStore(path);
    assert.deepEqual(store.maintenanceState(), expected);
    assert.deepEqual(store.snapshot(), before);

    for (const report of [{ mode: 'weekly' }, { mode: 'recent', checked: -1 }, { mode: 'daily', complete: 'yes' },
      { mode: 'recent', errors: Array.from({ length: 4000 }, () => ({ message: 'x'.repeat(500) })) }]) {
      assert.throws(() => store.recordMaintenanceRun(report), { code: 'INVALID_INPUT' });
      assert.deepEqual(store.maintenanceState(), expected);
      assert.deepEqual(store.snapshot(), before);
    }
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(resolve(work) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('audit deferral requeues only errors atomically and preserves saved organization and revision', () => {
  const store = new CatalogStore(':memory:');
  try {
    const items = ['done', 'failed', 'pending'].map(sourceId => ({ id: `chatgpt:chat:${sourceId}`,
      source: 'chatgpt', sourceId, kind: 'chat', title: sourceId, projectId: 'saved-project' }));
    let state = store.importInventory({ items, coverage: 'Synthetic retry test' });
    state = store.setCategory({ id: items[1].id, category: 'Travel', expectedRevision: state.revision });
    state = store.setFocus({ id: items[1].id, focused: true, expectedRevision: state.revision });
    const audit = store.beginAudit({ day: '2026-10-18' });
    assert.equal(audit.retryAfter, null);
    assert.equal(audit.deferReason, null);
    const observedAt = new Date(Date.now() - 1000).toISOString();
    store.applyAuditBatch({ auditId: audit.id, expectedRevision: state.revision, observations: [
      { id: items[0].id, evidence: 'probe', outcome: 'found', observedAt },
      { id: items[1].id, evidence: 'probe', outcome: 'error', error: 'Rate limited', observedAt },
    ] });
    const before = store.snapshot(), beforeBatch = store.auditBatch({ auditId: audit.id });
    const retryAfter = new Date(Date.now() + 3600000).toISOString();
    for (const retryIds of [[items[1].id, 'chatgpt:chat:unknown'], [items[1].id, items[0].id], [items[2].id]]) {
      assert.throws(() => store.deferAudit({ auditId: audit.id, retryAfter, reason: 'Rate limit cooldown', retryIds }), { code: 'INVALID_AUDIT' });
      assert.deepEqual(store.auditBatch({ auditId: audit.id }), beforeBatch);
      assert.deepEqual(store.snapshot(), before);
    }
    const deferred = store.deferAudit({ auditId: audit.id, retryAfter, reason: 'Rate limit cooldown', retryIds: [items[1].id] });
    assert.equal(deferred.processed, 1);
    assert.equal(deferred.errors, 0);
    assert.equal(deferred.completedAt, null);
    assert.equal(deferred.retryAfter, retryAfter);
    assert.equal(deferred.deferReason, 'Rate limit cooldown');
    assert.deepEqual(store.auditBatch({ auditId: audit.id }).items.map(item => item.id).sort(), [items[1].id, items[2].id].sort());
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(store.beginAudit({ day: '2026-10-19' }), deferred, 'A pending audit resumes with its cooldown');
    const recorded = store.recordMaintenanceRun({ mode: 'daily', complete: true, paused: true, deferred: 'Cooldown', audit: deferred });
    assert.equal(recorded.audit.retryAfter, retryAfter);
    assert.equal(recorded.audit.deferReason, 'Rate limit cooldown');
    assert.deepEqual(store.snapshot(), before);
  } finally { store.close(); }
});

test('a completed current audit can retry its errors and clears deferral when it completes again', () => {
  const store = new CatalogStore(':memory:');
  try {
    const saved = { id: 'chatgpt:chat:retry-complete', source: 'chatgpt', sourceId: 'retry-complete', kind: 'chat', title: 'Saved title' };
    const state = store.importInventory({ items: [saved], coverage: 'Synthetic completed audit retry' });
    const audit = store.beginAudit({ day: '2026-10-18' });
    const failed = store.applyAuditBatch({ auditId: audit.id, expectedRevision: state.revision, observations: [
      { id: saved.id, evidence: 'probe', outcome: 'error', error: 'Rate limited', observedAt: new Date(Date.now() - 2000).toISOString() },
    ] });
    assert.ok(failed.audit.completedAt);
    assert.equal(failed.audit.errors, 1);
    const before = store.snapshot();
    const reopened = store.deferAudit({ auditId: audit.id, retryAfter: new Date(Date.now() - 1000).toISOString(),
      reason: 'Retry the failed lookup', retryIds: [saved.id] });
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.processed, 0);
    assert.equal(reopened.errors, 0);
    assert.deepEqual(store.snapshot(), before);
    const completed = store.applyAuditBatch({ auditId: audit.id, expectedRevision: state.revision, observations: [
      { id: saved.id, evidence: 'probe', outcome: 'found', observedAt: new Date().toISOString() },
    ] });
    assert.ok(completed.audit.completedAt);
    assert.equal(completed.audit.retryAfter, null);
    assert.equal(completed.audit.deferReason, null);
    assert.equal(completed.audit.errors, 0);
    assert.equal(store.snapshot().revision, state.revision);
    const tomorrow = store.beginAudit({ day: '2026-10-19' });
    assert.throws(() => store.deferAudit({ auditId: audit.id, retryAfter: new Date().toISOString(), reason: 'Old audit', retryIds: [] }), { code: 'INVALID_AUDIT' });
    assert.deepEqual(store.maintenanceState().audit, tomorrow);
  } finally { store.close(); }
});
