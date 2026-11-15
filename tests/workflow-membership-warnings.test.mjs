import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CatalogStore} from '../store.mjs';
import {createOrganizerServer} from '../server.mjs';

const run=(0,eval)(await readFile(new URL('../maintenance-workflow.js',import.meta.url),'utf8'));
const response=value=>({structuredContent:value,content:[]});
const projectId='photo-project';
const chatId='codex:chat:photo-task';

async function fixture({localProject=projectId,sidebarHost='local',sidebarProject=null,outcome='found'}={}){
 const store=new CatalogStore(':memory:');
 let snapshot=store.importInventory({items:[
  {id:'codex:project:'+projectId,source:'codex',sourceId:projectId,kind:'project',title:'Photo project',hostId:'local'},
  {id:chatId,source:'codex',sourceId:'photo-task',kind:'chat',title:'Photo task',hostId:'local',projectId,updatedAt:'2020-01-01T00:00:00.000Z'}
 ],coverage:'Isolated membership warning regression'});
 snapshot=store.setCategory({id:chatId,category:'Travel',expectedRevision:snapshot.revision});
 store.setFocus({id:chatId,focused:true,expectedRevision:snapshot.revision});
 const before=store.snapshot();
 const collected={id:chatId,source:'codex',sourceId:'photo-task',kind:'chat',title:'Photo task',hostId:'local',observedAt:new Date().toISOString(),evidence:'local_index',outcome,
  ...(localProject==='unknown'?{}:{projectId:localProject})};
 const server=createOrganizerServer(store,'stdio',{recentCollector:async()=>({observations:[collected],errors:[],counts:{},coverage:{}})});
 const client=new Client({name:'membership-warning-regression',version:'1.0.0'});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 const calls=[];
 const tools={
  mcp__chat_organizer__maintain_catalog:args=>{calls.push(args.request.op);return client.callTool({name:'maintain_catalog',arguments:args});},
  mcp__codex_app__list_projects:async()=>response({projects:[{projectId,projectKind:'local',hostId:'local',label:'Photo project',path:'D:\\fixture'}]}),
  mcp__codex_app__list_threads:async()=>response({threads:[{id:'photo-task',kind:'codex',title:'Photo task',hostId:sidebarHost,projectId:sidebarProject}],pinnedThreads:[]}),
  mcp__codex_app__list_archived_threads:async({source})=>response({threads:outcome==='archived'&&source==='codex'?[{id:'photo-task',title:'Photo task'}]:[],nextCursor:null}),
  mcp__codex_app__read_thread:async()=>{throw Error('Membership fixture must not read source chats');}
 };
 try{
  await server.connect(st);await client.connect(ct);
  const report=await run(tools,{mode:'recent',recentOnly:true,verifyRecent:false});
  assert.equal(report.complete,true,JSON.stringify(report.errors));assert.deepEqual(report.errors,[]);
  assert.equal(report.probeCalls,0);assert.equal(calls[0],'acquire');assert.equal(calls.at(-1),'release');
  assert.ok(!calls.some(op=>['begin','batch','auditApply'].includes(op)));
  assert.deepEqual(store.snapshot().categories,before.categories);
  const row=store.db.prepare('SELECT project_id AS projectId, category, focused FROM catalog_items WHERE id=?').get(chatId);
  assert.equal(row.category,'Travel');assert.equal(row.focused,1);
  const savedReport=store.maintenanceState().lastRecentRun;
  assert.deepEqual(savedReport.exceptions,report.exceptions,'Saved report matches the returned warnings');
  assert.equal(savedReport.sources.sidebarMembershipUnverified,report.sources.sidebarMembershipUnverified);
  return {report,row};
 }finally{await client.close();await server.close();store.close();}
}

for(const outcome of ['found','archived'])test('confirmed '+outcome+' local project suppresses an empty-sidebar warning and preserves assignment',async()=>{
 const {report,row}=await fixture({outcome});
 assert.equal(row.projectId,projectId);
 assert.equal(report.sources.sidebarMembershipUnverified,0);
 assert.deepEqual(report.exceptions,[]);
});

test('unresolved local and sidebar membership still warns and retains saved assignment',async()=>{
 const {report,row}=await fixture({localProject:'unknown'});
 assert.equal(row.projectId,projectId);
 assert.equal(report.sources.sidebarMembershipUnverified,1);
 assert.equal(report.exceptions.length,1);
 assert.equal(report.exceptions[0].id,chatId);
 assert.equal(report.exceptions[0].title,'Photo task');
 assert.equal(report.exceptions[0].reason,'project_membership_unverified');
});

for(const sidebarHost of ['durable',null])test('local evidence does not suppress the warning for '+(sidebarHost??'unknown')+' sidebar host',async()=>{
 const {report,row}=await fixture({sidebarHost});
 assert.equal(row.projectId,projectId);
 assert.equal(report.sources.sidebarMembershipUnverified,1);
 assert.equal(report.exceptions.length,1);
 assert.equal(report.exceptions[0].reason,'project_membership_unverified');
});

for(const sidebarProject of [null,projectId])test('explicit projectless state is preserved with '+(sidebarProject===null?'empty':'stale assigned')+' sidebar membership',async()=>{
 const {report,row}=await fixture({localProject:null,sidebarProject});
 assert.equal(row.projectId,null);
 assert.equal(report.sources.sidebarMembershipUnverified,0);
 assert.deepEqual(report.exceptions,[]);
});
