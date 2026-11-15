import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

test('the complete recent workflow saves through MCP from a caller with no shell or folder access', async () => {
  const run = (0, eval)(await readFile(new URL('../maintenance-workflow.js', import.meta.url), 'utf8'));
  const store = new CatalogStore(':memory:');
  const item = { id:'chatgpt:chat:saved', source:'chatgpt', sourceId:'saved', kind:'chat', title:'Old title', updatedAt:'2020-01-01T00:00:00Z' };
  let snapshot = store.importInventory({items:[item],coverage:'Synthetic service workflow fixture'});
  snapshot = store.setCategory({id:item.id,category:'Travel',expectedRevision:snapshot.revision});
  snapshot = store.setFocus({id:item.id,focused:true,expectedRevision:snapshot.revision});
  const before = store.snapshot();
  const server = createOrganizerServer(store,'stdio',{recentCollector:async({projects})=>{
    assert.equal(projects[0].label,undefined,'Unrelated app project fields are not forwarded');
    return {observations:[],errors:[],coverage:{scope:'synthetic'},counts:{}};
  }});
  const client = new Client({name:'read-only-host-fixture',version:'1.0.0'});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  const response=value=>({structuredContent:value,content:[]});
  const apiCalls=[];
  const tools = {
    exec_command:async()=>{throw new Error('Caller filesystem is read-only');},
    request_permissions:async()=>{throw new Error('Folder permission requests are unavailable');},
    mcp__chat_organizer__maintain_catalog:async args=>{
      apiCalls.push(args.request.op);
      return client.callTool({name:'maintain_catalog',arguments:args});
    },
    mcp__codex_app__list_projects:async()=>response({projects:[{projectId:'fixture-project',projectKind:'local',label:'Fixture project',path:'D:\\fixture'}]}),
    mcp__codex_app__list_threads:async()=>response({threads:[
      {id:'saved',kind:'chatgpt',title:'Updated title',projectId:null,updatedAt:1792385000},
      {id:'new',kind:'chatgpt',title:'New observed chat',projectId:null,updatedAt:1792385000}
    ],pinnedThreads:[]}),
    mcp__codex_app__list_archived_threads:async()=>response({threads:[],nextCursor:null})
  };
  try {
    await server.connect(st); await client.connect(ct);
    const report=await run(tools,{mode:'recent',recentOnly:true});
    assert.equal(report.complete,true);assert.deepEqual(report.errors,[]);assert.equal(report.probeCalls,0);
    const after=store.snapshot();
    const saved=after.items.find(row=>row.id===item.id);
    assert.equal(saved.title,'Updated title');assert.equal(saved.category,'Travel');assert.equal(saved.focused,true);
    assert.deepEqual(after.categories,before.categories);
    assert.deepEqual(after.undoDelete,before.undoDelete);
    assert.equal(after.items.find(row=>row.id==='chatgpt:chat:new').category,'Uncategorized');
    assert.equal(store.maintenanceState().lastRecentRun.complete,true);
    assert.equal(apiCalls[0],'acquire');assert.equal(apiCalls.at(-1),'release');
    assert.ok(apiCalls.includes('recordRun'));
    const lease=await client.callTool({name:'maintain_catalog',arguments:{request:{op:'acquire',args:{}}}});
    assert.equal(lease.structuredContent.value.acquired,true,'Workflow released its lease');
    await client.callTool({name:'maintain_catalog',arguments:{request:{op:'release',args:{token:lease.structuredContent.value.token}}}});
  } finally {await client.close();await server.close();store.close();}
});
