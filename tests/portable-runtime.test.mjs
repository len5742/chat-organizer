import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore, defaultDatabasePath } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

test('private catalog defaults are independent of the repository and accept an absolute override', () => {
  const home = resolve('synthetic-home');
  const local = resolve('synthetic-local-app-data');
  const data = resolve('synthetic-data');
  assert.equal(defaultDatabasePath({ env: {}, platform: 'win32', home }), resolve(home, 'AppData', 'Local', 'ChatOrganizer', 'catalog', 'catalog.sqlite'));
  assert.equal(defaultDatabasePath({ env: { LOCALAPPDATA: local }, platform: 'win32', home }), resolve(local, 'ChatOrganizer', 'catalog', 'catalog.sqlite'));
  assert.equal(defaultDatabasePath({ env: {}, platform: 'darwin', home }), resolve(home, 'Library', 'Application Support', 'ChatOrganizer', 'catalog', 'catalog.sqlite'));
  assert.equal(defaultDatabasePath({ env: {}, platform: 'linux', home }), resolve(home, '.local', 'share', 'chat-organizer', 'catalog', 'catalog.sqlite'));
  assert.equal(defaultDatabasePath({ env: { XDG_DATA_HOME: data }, platform: 'linux', home }), resolve(data, 'chat-organizer', 'catalog', 'catalog.sqlite'));
  assert.equal(defaultDatabasePath({ env: { CHAT_ORGANIZER_DATA_DIR: data }, platform: 'win32', home }), resolve(data, 'catalog.sqlite'));
  assert.throws(() => defaultDatabasePath({ env: { CHAT_ORGANIZER_DATA_DIR: 'relative-folder' }, home }), { code: 'MISSING_DATA_DIR' });
});

test('installed workflow can be retrieved and initialize an empty catalog through the service', async () => {
  const store = new CatalogStore(':memory:');
  const server = createOrganizerServer(store, 'stdio', {
    recentCollector: async () => ({ observations: [], errors: [], coverage: { localIndex: 'synthetic' }, counts: {} }),
  });
  const client = new Client({ name: 'portable-onboarding-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = store.snapshot();
    const definition = (await client.listTools()).tools.find(tool => tool.name === 'get_maintenance_workflow');
    assert.equal(definition.annotations.readOnlyHint, true);
    const workflow = await client.callTool({ name: 'get_maintenance_workflow', arguments: {} });
    assert.equal(workflow.isError, undefined);
    assert.equal(workflow.structuredContent.version, '0.2.2');
    assert.equal(workflow.structuredContent.source, await readFile(new URL('../maintenance-workflow.js', import.meta.url), 'utf8'));
    assert.deepEqual(store.snapshot(), before);
    const response = value => ({ structuredContent: value, content: [] });
    const tools = {
      mcp__chat_organizer__get_connection_status: args => client.callTool({ name: 'get_connection_status', arguments: args }),
      mcp__chat_organizer__maintain_catalog: args => client.callTool({ name: 'maintain_catalog', arguments: args }),
      mcp__codex_app__list_projects: async () => response({ projects: [] }),
      mcp__codex_app__list_threads: async () => response({ threads: [{ id: 'first-observed-chat', kind: 'chatgpt', title: 'A first sample chat', projectId: null, updatedAt: Date.now() }], pinnedThreads: [] }),
      mcp__codex_app__list_archived_threads: async () => response({ threads: [], nextCursor: null }),
    };
    const runMaintenance = (0, eval)(workflow.structuredContent.source);
    const report = await runMaintenance(tools, { mode: 'recent', recentOnly: true });
    assert.equal(report.complete, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.visibleItems, 1);
    const saved = store.snapshot().items[0];
    assert.equal(saved.title, 'A first sample chat');
    assert.equal(saved.category, 'Uncategorized');
    assert.equal(store.maintenanceState().lastRecentRun.complete, true);
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

test('public plugin identity and maintenance namespace agree', async () => {
  const readJson = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
  const [pkg, plugin, mcp] = await Promise.all([readJson('package.json'), readJson('plugin.json'), readJson('mcp.json')]);
  assert.equal(pkg.name, 'chat-organizer');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.extensions['com.openai'].interface.displayName, 'Chat Organizer');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['chat_organizer']);
  const workflow = await readFile(new URL('../maintenance-workflow.js', import.meta.url), 'utf8');
  assert.match(workflow, /tools\.mcp__chat_organizer__maintain_catalog/);
  assert.match(workflow, /tools\.mcp__chat_organizer__get_connection_status/);
});
