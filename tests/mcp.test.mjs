import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer, startHttpServer } from '../server.mjs';

test('manual updater exposes read-only status to the app and serves the current and stable UI resources', async () => {
  const store = new CatalogStore(':memory:');
  const server = createOrganizerServer(store);
  const client = new Client({ name: 'manual-update-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const statusTool = tools.find(tool => tool.name === 'get_maintenance_state');
    assert.deepEqual(statusTool._meta.ui.visibility, ['model', 'app']);
    assert.equal(statusTool.annotations.readOnlyHint, true);
    const before = store.snapshot();
    const first = await client.callTool({ name: 'get_maintenance_state', arguments: {} });
    const second = await client.callTool({ name: 'get_maintenance_state', arguments: {} });
    assert.deepEqual(first.structuredContent, second.structuredContent);
    assert.deepEqual(store.snapshot(), before, 'Status polling preserves organization, revision, and Undo');
    const openTool = tools.find(tool => tool.name === 'open_organizer');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://chat-organizer/v0.2.5/index.html');
    const current = await client.readResource({ uri: openTool._meta.ui.resourceUri });
    const previous = await client.readResource({ uri: 'ui://chat-organizer/index.html' });
    assert.equal(previous.contents[0].text, current.contents[0].text);
    assert.match(current.contents[0].text, /id="update-now"/);
    assert.match(current.contents[0].text, /id="update-status"/);
    const status = await client.callTool({ name: 'get_connection_status', arguments: {} });
    assert.equal(status.structuredContent.serverVersion, '0.2.5');
    assert.equal(status.structuredContent.serverName, 'chat-organizer');
  } finally { await client.close(); await server.close(); store.close(); }
});

test('focus tool exposes an explicit boolean API and preserves focus through category Undo and imports', async () => {
  const store = new CatalogStore(':memory:');
  const item = { id: 'chatgpt:chat:focus', source: 'chatgpt', sourceId: 'focus', title: 'Focus chat', kind: 'chat', updatedAt: '2026-10-17T12:00:00Z' };
  const imported = store.importInventory({ items: [item, { id: 'chatgpt:project:p', source: 'chatgpt', sourceId: 'p', title: 'Project', kind: 'project' }], coverage: 'synthetic focus samples' });
  const server = createOrganizerServer(store);
  const client = new Client({ name: 'focus-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const tool = tools.find(tool => tool.name === 'set_item_focus');
    assert.deepEqual(tool._meta.ui.visibility, ['model', 'app']);
    assert.equal(tool.inputSchema.properties.focused.type, 'boolean');
    assert.deepEqual([...tool.inputSchema.required].sort(), ['expectedRevision', 'focused', 'id']);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    const callFocus = args => client.callTool({ name: 'set_item_focus', arguments: { id: item.id, ...args } });
    const marked = await callFocus({ focused: true, expectedRevision: imported.revision });
    assert.equal(marked.isError, undefined);
    assert.equal(marked.structuredContent.items.find(row => row.id === item.id).focused, true);
    assert.equal(marked.structuredContent.items.find(row => row.kind === 'project').focused, false);
    assert.equal(marked.structuredContent.items.find(row => row.id === item.id).updatedAt, item.updatedAt);
    const same = await callFocus({ focused: true, expectedRevision: marked.structuredContent.revision });
    assert.deepEqual(same.structuredContent, marked.structuredContent);
    const stale = await callFocus({ focused: false, expectedRevision: imported.revision });
    assert.equal(stale.isError, true);
    assert.equal(stale._meta.error.code, 'STALE_REVISION');
    assert.equal(stale.structuredContent, undefined);
    for (const focused of ['true', 1, null]) {
      const invalid = await callFocus({ focused, expectedRevision: marked.structuredContent.revision });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent, undefined);
    }
    const project = await callFocus({ id: 'chatgpt:project:p', focused: true, expectedRevision: marked.structuredContent.revision });
    assert.equal(project.isError, true);
    assert.equal(project._meta.error.code, 'INVALID_INPUT');
    assert.deepEqual(store.snapshot(), marked.structuredContent);
    const moved = await client.callTool({ name: 'set_item_category', arguments: { id: item.id, category: 'Travel', expectedRevision: marked.structuredContent.revision } });
    const deleted = await client.callTool({ name: 'delete_category', arguments: { id: 'Travel', expectedRevision: moved.structuredContent.revision } });
    const cleared = await callFocus({ focused: false, expectedRevision: deleted.structuredContent.revision });
    assert.deepEqual(cleared.structuredContent.undoDelete, deleted.structuredContent.undoDelete);
    const undone = await client.callTool({ name: 'undo_delete_category', arguments: { token: deleted.structuredContent.undoDelete.token, expectedRevision: cleared.structuredContent.revision } });
    assert.equal(undone.isError, undefined);
    assert.equal(undone.structuredContent.items.find(row => row.id === item.id).category, 'Travel');
    assert.equal(undone.structuredContent.items.find(row => row.id === item.id).focused, false);
    const remarked = await callFocus({ focused: true, expectedRevision: undone.structuredContent.revision });
    const refreshed = await client.callTool({ name: 'import_inventory', arguments: { items: [{ ...item, title: 'Refreshed focus chat', focused: false }], coverage: 'partial source refresh' } });
    assert.equal(refreshed.isError, undefined);
    assert.equal(refreshed.structuredContent.items.find(row => row.id === item.id).focused, true);
    assert.equal(refreshed.structuredContent.items.find(row => row.id === item.id).title, 'Refreshed focus chat');
    assert.equal(refreshed.structuredContent.revision, remarked.structuredContent.revision + 1);
  } finally { await client.close(); await server.close(); store.close(); }
});

test('official MCP client connects over stdio, discovers tools, saves, and reads UI resource', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-organizer-stdio-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], env: { ...process.env, CHAT_ORGANIZER_DATA_DIR: dir }, stderr: 'pipe' });
  const client = new Client({ name: 'connection-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['apply_audit_batch', 'apply_sync_batch', 'begin_daily_audit', 'collect_recent_metadata', 'create_category_path', 'delete_category', 'get_audit_batch', 'get_connection_status', 'get_inventory', 'get_maintenance_state', 'get_maintenance_workflow', 'import_inventory', 'maintain_catalog', 'manage_trash_archive', 'open_organizer', 'refresh_local_activity', 'rename_category', 'reorder_categories', 'resolve_deletion_review', 'set_item_category', 'set_item_focus', 'undo_delete_category']);
    const maintenanceFields = {
      get_maintenance_workflow: ['version', 'source'],
      maintain_catalog: ['value'],
      manage_trash_archive: ['value'],
      get_maintenance_state: ['revision', 'counts', 'lastSync', 'audit', 'lastRecentRun', 'lastDailyRun'],
      collect_recent_metadata: ['observations', 'coverage', 'errors', 'counts'],
      apply_sync_batch: ['revision', 'added', 'renamed', 'moved', 'statusChanged', 'unchanged', 'errors', 'stale', 'checked'],
      begin_daily_audit: ['id', 'day', 'startedAt', 'completedAt', 'total', 'processed', 'errors'],
      get_audit_batch: ['audit', 'items'], apply_audit_batch: ['sync', 'audit'],
    };
    for (const tool of tools.tools) {
      assert.equal(tool.outputSchema?.type, 'object', `${tool.name} must declare its structured output`);
      assert.equal(tool.outputSchema.additionalProperties, false);
      if (tool.name === 'get_connection_status') {
        assert.deepEqual([...tool.outputSchema.required].sort(), ['catalogRevision', 'instanceId', 'ok', 'serverName', 'serverVersion', 'startedAt', 'transport']);
      } else if (maintenanceFields[tool.name]) {
        assert.deepEqual([...tool.outputSchema.required].sort(), maintenanceFields[tool.name].sort());
      } else {
        const required = ['categories', 'connection', 'items', 'lastImport', 'revision', 'savedAt', 'undoDelete'];
        if (tool.name === 'refresh_local_activity') required.push('activityRefresh');
        assert.deepEqual([...tool.outputSchema.required].sort(), required.sort());
        assert.equal(tool.outputSchema.properties.items.type, 'array');
        assert.equal(tool.outputSchema.properties.items.items.properties.id.type, 'string');
        assert.ok(tool.outputSchema.properties.items.items.required.includes('effectiveUpdatedAt'));
        assert.ok(tool.outputSchema.properties.items.items.required.includes('focused'));
        for (const field of ['availability', 'lastCheckedAt', 'lastCheckError']) assert.ok(tool.outputSchema.properties.items.items.required.includes(field));
        assert.equal(tool.outputSchema.properties.items.items.properties.focused.type, 'boolean');
        assert.equal(tool.outputSchema.properties.categories.items.properties.id.type, 'string');
        assert.equal(tool.outputSchema.properties.categories.items.additionalProperties, false);
      }
    }
    const openTool = tools.tools.find(t => t.name === 'open_organizer');
    const maintenanceTool = tools.tools.find(t => t.name === 'get_maintenance_state');
    assert.deepEqual(maintenanceTool._meta.ui.visibility, ['model', 'app']);
    assert.equal(maintenanceTool.annotations.readOnlyHint, true);
    const maintenanceBefore = await client.callTool({ name: 'get_maintenance_state', arguments: {} });
    const maintenanceAgain = await client.callTool({ name: 'get_maintenance_state', arguments: {} });
    assert.deepEqual(maintenanceAgain.structuredContent, maintenanceBefore.structuredContent, 'Polling update status does not change saved catalog state');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://chat-organizer/v0.2.5/index.html');
    assert.equal(openTool._meta['openai/outputTemplate'], openTool._meta.ui.resourceUri);
    assert.equal(openTool.annotations.readOnlyHint, true);
    const status = await client.callTool({ name: 'get_connection_status', arguments: {} });
    assert.equal(status.structuredContent.ok, true);
    assert.equal(status.structuredContent.serverVersion, '0.2.5');
    assert.equal(status.structuredContent.serverName, 'chat-organizer');
    assert.equal(status.structuredContent.transport, 'stdio');
    const imported = await client.callTool({ name: 'import_inventory', arguments: { items: [{ id: 'chatgpt:chat:test', source: 'chatgpt', sourceId: 'test', title: 'Connection test', kind: 'chat', url: 'https://chatgpt.com/c/test' }], coverage: 'synthetic test item' } });
    assert.equal(imported.isError, undefined);
    const saved = await client.callTool({ name: 'set_item_category', arguments: { id: 'chatgpt:chat:test', category: 'Health', expectedRevision: imported.structuredContent.revision } });
    assert.equal(saved.structuredContent.items[0].category, 'Health');
    const stale = await client.callTool({ name: 'set_item_category', arguments: { id: 'chatgpt:chat:test', category: 'Finance', expectedRevision: imported.structuredContent.revision } });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent, undefined, 'Errors must not violate the declared success schema');
    assert.equal(stale._meta.error.code, 'STALE_REVISION');
    assert.match(stale.content[0].text, /Refresh/);
    const duplicateImport = await client.callTool({ name: 'import_inventory', arguments: { items: [
      { id: 'chatgpt:chat:new', source: 'chatgpt', sourceId: 'new', title: 'New', kind: 'chat' },
      { id: 'chatgpt:chat:new', source: 'chatgpt', sourceId: 'new', title: 'Duplicate', kind: 'chat' },
    ], coverage: 'duplicate test' } });
    assert.equal(duplicateImport.isError, true);
    assert.equal(duplicateImport.structuredContent, undefined);
    assert.equal(duplicateImport._meta.error.code, 'DUPLICATE_ID');
    const opened = await client.callTool({ name: 'open_organizer', arguments: {} });
    assert.deepEqual(opened.structuredContent, saved.structuredContent);
    const resource = await client.readResource({ uri: 'ui://chat-organizer/v0.2.5/index.html' });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /<html[\s>]/i);
    assert.match(resource.contents[0].text, /category-popover/);
    const stableResource = await client.readResource({ uri: 'ui://chat-organizer/index.html' });
    assert.equal(stableResource.contents[0].text, resource.contents[0].text);
    const path = await client.callTool({ name: 'create_category_path', arguments: { parentId: 'Travel', names: ['Europe', 'Italy'], expectedRevision: saved.structuredContent.revision } });
    assert.equal(path.isError, undefined);
    const europe = path.structuredContent.categories.find(category => category.name === 'Europe');
    const italy = path.structuredContent.categories.find(category => category.name === 'Italy');
    assert.equal(italy.parentId, europe.id);
    const assigned = await client.callTool({ name: 'set_item_category', arguments: { id: 'chatgpt:chat:test', category: italy.id, expectedRevision: path.structuredContent.revision } });
    assert.equal(assigned.structuredContent.items[0].category, italy.id);
    const renamed = await client.callTool({ name: 'rename_category', arguments: { id: europe.id, name: 'European trips', expectedRevision: assigned.structuredContent.revision } });
    assert.equal(renamed.structuredContent.categories.find(category => category.id === europe.id).name, 'European trips');
    const deleted = await client.callTool({ name: 'delete_category', arguments: { id: europe.id, expectedRevision: renamed.structuredContent.revision } });
    assert.equal(deleted.structuredContent.items[0].category, 'Uncategorized');
    assert.equal(deleted.structuredContent.undoDelete.label, 'European trips');
    const undone = await client.callTool({ name: 'undo_delete_category', arguments: { token: deleted.structuredContent.undoDelete.token, expectedRevision: deleted.structuredContent.revision } });
    assert.deepEqual(undone.structuredContent.items, renamed.structuredContent.items);
    assert.deepEqual(undone.structuredContent.categories, renamed.structuredContent.categories);
    assert.equal(undone.structuredContent.undoDelete, null);
    const rootOrder = undone.structuredContent.categories.filter(category => category.parentId === null).map(category => category.id).reverse();
    const reordered = await client.callTool({ name: 'reorder_categories', arguments: { ids: rootOrder, expectedRevision: undone.structuredContent.revision } });
    assert.equal(reordered.isError, undefined);
    assert.deepEqual(reordered.structuredContent.categories.filter(category => category.parentId === null).map(category => category.id), rootOrder);
    assert.deepEqual(reordered.structuredContent.items, undone.structuredContent.items);
    const invalidOrder = await client.callTool({ name: 'reorder_categories', arguments: { ids: rootOrder.slice(1), expectedRevision: reordered.structuredContent.revision } });
    assert.equal(invalidOrder.isError, true);
    assert.equal(invalidOrder._meta.error.code, 'INVALID_CATEGORY_ORDER');
  } finally { await client.close(); await transport.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP MCP endpoint works only on loopback with accepted host/origin', async () => {
  const store = new CatalogStore(':memory:');
  const server = await startHttpServer(store, 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'http-connection-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  try {
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const untrustedHostStatus = await new Promise((resolve, reject) => {
      const request = httpGet(`${base}/health`, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject);
    });
    assert.equal(untrustedHostStatus, 403);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: 'https://evil.test' } })).status, 403);
    await client.connect(transport);
    const status = await client.callTool({ name: 'get_connection_status', arguments: {} });
    assert.equal(status.structuredContent.ok, true);
    assert.equal(status.structuredContent.transport, 'http');
    const inventory = await client.callTool({ name: 'get_inventory', arguments: {} });
    assert.deepEqual(inventory.structuredContent.items, []);
  } finally { await client.close(); await transport.close(); await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('refresh activity tool returns its report and rechecks revision across the async source read', async () => {
  const store = new CatalogStore(':memory:');
  const imported = store.importInventory({ items: [{ id: 'codex:chat:local', source: 'codex', sourceId: 'local', title: 'Before refresh', kind: 'chat', hostId: 'local', updatedAt: '2026-10-17T12:00:00Z' }], coverage: 'local sample' });
  let calls = 0;
  let readStarted, finishRead;
  let mode = 'success';
  const activityReader = async items => {
    calls += 1;
    assert.equal(items[0].sourceId, 'local');
    if (mode === 'throw') throw new Error('Private transport failure detail');
    if (mode === 'race') {
      readStarted();
      await new Promise(resolve => { finishRead = resolve; });
    }
    return { records: [{ id: 'codex:chat:local', title: 'After refresh', updatedAt: '2026-10-18T12:00:00Z' }], attempted: 1, checked: 1, unavailable: 0 };
  };
  const server = createOrganizerServer(store, 'stdio', { activityReader });
  const client = new Client({ name: 'refresh-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const refreshed = await client.callTool({ name: 'refresh_local_activity', arguments: { expectedRevision: imported.revision } });
    assert.equal(refreshed.isError, undefined);
    assert.equal(refreshed.structuredContent.activityRefresh.updated, 1);
    assert.equal(refreshed.structuredContent.items[0].updatedAt, '2026-10-18T12:00:00Z');
    assert.equal(calls, 1);
    const staleBeforeRead = await client.callTool({ name: 'refresh_local_activity', arguments: { expectedRevision: imported.revision } });
    assert.equal(staleBeforeRead.isError, true);
    assert.equal(staleBeforeRead._meta.error.code, 'STALE_REVISION');
    assert.equal(staleBeforeRead.structuredContent, undefined);
    assert.equal(calls, 1, 'stale requests should not launch a source read');

    mode = 'race';
    const started = new Promise(resolve => { readStarted = resolve; });
    const pending = client.callTool({ name: 'refresh_local_activity', arguments: { expectedRevision: refreshed.structuredContent.revision } });
    await started;
    const changed = store.setCategory({ id: 'codex:chat:local', category: 'Travel', expectedRevision: refreshed.structuredContent.revision });
    finishRead();
    const staleAfterRead = await pending;
    assert.equal(staleAfterRead.isError, true);
    assert.equal(staleAfterRead._meta.error.code, 'STALE_REVISION');
    assert.deepEqual(store.snapshot(), changed);

    mode = 'throw';
    const failed = await client.callTool({ name: 'refresh_local_activity', arguments: { expectedRevision: changed.revision } });
    assert.equal(failed.isError, true);
    assert.equal(failed._meta.error.code, 'INTERNAL_ERROR');
    assert.equal(failed.structuredContent, undefined);
    assert.doesNotMatch(failed.content[0].text, /Private transport/);
    assert.deepEqual(store.snapshot(), changed);
  } finally { await client.close(); await server.close(); store.close(); }
});
