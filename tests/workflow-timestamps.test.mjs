import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CatalogStore} from '../store.mjs';
import {createOrganizerServer} from '../server.mjs';

const run=(0,eval)(await readFile(new URL('../maintenance-workflow.js',import.meta.url),'utf8'));
const response=value=>({structuredContent:value,content:[]});
async function fixture({dates,sidebar=true,daily=false}){
 const store=new CatalogStore(':memory:');
 const savedDate=sidebar?'2020-01-01T00:00:00.000Z':new Date(Date.now()-60000).toISOString();
 const items=dates.map((value,index)=>({id:'chatgpt:chat:date-'+index,source:'chatgpt',sourceId:'date-'+index,kind:'chat',title:'Saved title '+index,updatedAt:savedDate}));
 let snapshot=store.importInventory({items,coverage:'Isolated native timestamp regression'});
 snapshot=store.setCategory({id:items[0].id,category:'Travel',expectedRevision:snapshot.revision});
 store.setFocus({id:items[0].id,focused:true,expectedRevision:snapshot.revision});
 const before=store.snapshot();
 const server=createOrganizerServer(store,'stdio',{recentCollector:async()=>({observations:[],errors:[],counts:{},coverage:{}})});
 const client=new Client({name:'native-timestamp-regression',version:'1.0.0'});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const tools={
  mcp__chat_organizer__maintain_catalog:args=>client.callTool({name:'maintain_catalog',arguments:args}),
  mcp__codex_app__list_projects:async()=>response({projects:[]}),
  mcp__codex_app__list_threads:async()=>response({pinnedThreads:sidebar?items.map((item,i)=>({id:item.sourceId,kind:item.source,title:'Updated title '+i,updatedAt:dates[i]})):[],threads:[]}),
  mcp__codex_app__list_archived_threads:async()=>response({threads:[],nextCursor:null}),
  mcp__codex_app__read_thread:async({threadId})=>{const index=items.findIndex(item=>item.sourceId===threadId);return response({thread:{id:threadId,title:'Updated title '+index,updatedAt:dates[index]},turns:[]});}
 };
 try{
  await server.connect(st);await client.connect(ct);
  const report=await run(tools,{mode:daily?'daily':'recent',recentOnly:!daily,wait:async()=>{}});
  assert.equal(report.complete,true,JSON.stringify(report.errors));assert.deepEqual(report.errors,[]);
  const after=store.snapshot();assert.deepEqual(after.categories,before.categories);
  assert.deepEqual(after.items.map(({id,category,focused})=>({id,category,focused})).sort((a,b)=>a.id.localeCompare(b.id)),before.items.map(({id,category,focused})=>({id,category,focused})).sort((a,b)=>a.id.localeCompare(b.id)));
  return {report,rows:items.map(item=>after.items.find(row=>row.id===item.id)),savedDate};
 }finally{await client.close();await server.close();store.close();}
}

test('mixed pinned/sidebar Unix seconds and milliseconds pass actual MCP validation',async()=>{
 const timestamp=1790573640000;
 const {rows,report}=await fixture({dates:[timestamp/1000,timestamp,timestamp/1000+.123,timestamp+123]});
 assert.deepEqual(rows.map(row=>row.updatedAt),['2026-09-28T05:34:00.000Z','2026-09-28T05:34:00.000Z','2026-09-28T05:34:00.123Z','2026-09-28T05:34:00.123Z']);
 assert.equal(report.probeCalls,0);assert.deepEqual(rows.map(row=>row.title),['Updated title 0','Updated title 1','Updated title 2','Updated title 3']);
});

for(const daily of [false,true])test((daily?'full audit':'bounded recent probe')+' normalizes milliseconds through actual MCP validation',async()=>{
 const timestamp=Date.now();const {rows,report}=await fixture({dates:[timestamp],sidebar:false,daily});
 assert.equal(rows[0].updatedAt,new Date(timestamp).toISOString());assert.equal(report.probeCalls,1);
 if(daily)assert.ok(report.audit.completedAt);
});

test('unusable optional dates preserve saved activity and still synchronize valid titles',async()=>{
 const {rows,savedDate}=await fixture({dates:[NaN,Infinity,null,undefined,1e20,253402300800000,-62167219200001,'not a date']});
 assert.ok(rows.every(row=>row.updatedAt===savedDate));assert.ok(rows.every((row,i)=>row.title==='Updated title '+i));
});
