import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CatalogStore} from '../store.mjs';
import {createOrganizerServer} from '../server.mjs';
const run=(0,eval)(await readFile(new URL('../maintenance-workflow.js',import.meta.url),'utf8'));
const response=value=>({structuredContent:value,content:[]});
const interval=6*60*60*1000+1;
const unresolved='Could not determine whether Codex thread exists. Unavailable or failed hosts: durable';
async function fixture(t,{message=unresolved}={}){
 const store=new CatalogStore(':memory:');
 const item={id:'chatgpt:chat:review-me',source:'chatgpt',sourceId:'review-me',kind:'chat',title:'Review this chat',updatedAt:new Date(Date.now()-60000).toISOString()};
 store.importInventory({items:[item],coverage:'Isolated review workflow'});
 store.setCategory({id:item.id,category:'Travel',expectedRevision:store.snapshot().revision});
 store.setFocus({id:item.id,focused:true,expectedRevision:store.snapshot().revision});
 const server=createOrganizerServer(store,'stdio',{recentCollector:async()=>({observations:[],exceptions:[],counts:{},errors:[],coverage:{}})});
 const client=new Client({name:'deletion-review-workflow',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 t.after(async()=>{await client.close();await server.close();store.close();});
 const reads=[],observations=[];
 const tools={
  mcp__chat_organizer__get_connection_status:()=>client.callTool({name:'get_connection_status',arguments:{}}),
  mcp__chat_organizer__maintain_catalog:args=>{if(args.request.op==='apply')observations.push(...args.request.args.observations);return client.callTool({name:'maintain_catalog',arguments:args});},
  mcp__codex_app__list_projects:async()=>response({projects:[]}),
  mcp__codex_app__list_threads:async()=>response({threads:[],pinnedThreads:[]}),
  mcp__codex_app__list_archived_threads:async()=>response({threads:[],nextCursor:null}),
  mcp__codex_app__read_thread:async args=>{reads.push(args);throw new Error(message);},
 };
 return{store,item,client,reads,observations,run:()=>run(tools,{mode:'recent',recentOnly:true,wait:async()=>{}}),
  operation:(op,args,leaseToken)=>client.callTool({name:'maintain_catalog',arguments:{request:{op,args,...(leaseToken?{leaseToken}:{})}}}),
  resolve:action=>client.callTool({name:'resolve_deletion_review',arguments:{id:item.id,action,expectedRevision:store.snapshot().revision}})};
}

test('three spaced actual unresolved checks queue a named review; queued entries stop probing and retain organization',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t);const before=f.store.snapshot();
 for(let n=1;n<=3;n++){
  const report=await f.run();assert.equal(report.complete,false,JSON.stringify(report));
  assert.equal(f.reads.length,n);assert.equal(f.observations.at(-1).verificationFailure,'unresolved');
  const saved=f.store.snapshot().items.find(x=>x.id===f.item.id);
  assert.equal(Boolean(saved.deletionReview),n===3);
  assert.equal(saved.category,'Travel');assert.equal(saved.focused,true);assert.equal(saved.availability,'available');
  if(n===3){assert.equal(saved.deletionReview.failureCount,3);assert.equal(report.sources.potentiallyDeleted,1);assert.ok(report.exceptions.some(x=>x.reason==='potentially_deleted'&&x.title===f.item.title));}
  const repeat=await f.run();assert.equal(repeat.probeCalls,0);assert.equal(f.reads.length,n);
  t.mock.timers.tick(interval);
 }
 const queued=await f.run();assert.equal(queued.probeCalls,0);assert.equal(f.reads.length,3);
 assert.equal(queued.exceptions.filter(x=>x.reason==='potentially_deleted').length,1);
 assert.deepEqual(f.store.snapshot().categories,before.categories);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get().n,1);
 const restored=await f.resolve('restore');assert.notEqual(restored.isError,true,JSON.stringify(restored));
 assert.equal(restored.structuredContent.items[0].deletionReview,undefined);assert.equal(restored.structuredContent.items[0].category,'Travel');
 assert.equal((await f.run()).probeCalls,0,'Restoring has a six-hour verification delay');
 t.mock.timers.tick(interval);await f.run();assert.equal(f.reads.length,4);assert.equal(f.store.snapshot().items[0].deletionReview,undefined);
});

for(const message of ['429 Too many requests','Permission denied while reading this conversation','Network connection timed out','Unexpected internal service error'])test('system/access failure is reported without becoming deletion review: '+message,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await fixture(t,{message});
 for(let n=0;n<3;n++){await f.run();t.mock.timers.tick(interval);}
 assert.equal(f.reads.length,3);assert.ok(f.observations.every(x=>!x.verificationFailure));
 assert.equal(f.store.snapshot().items[0].deletionReview,undefined);
});

test('explicit source deletion is named once and excluded from later refresh checks',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await fixture(t,{message:'conversation_deleted'});
 const first=await f.run();assert.equal(first.complete,true);assert.equal(first.exceptions[0].reason,'not_found');
 assert.equal(f.store.snapshot().items.length,0);assert.equal(f.store.maintenanceState().counts.not_found,1);
 t.mock.timers.tick(interval);assert.equal((await f.run()).probeCalls,0);assert.equal(f.reads.length,1);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM catalog_items').get().n,1);
});

test('review gateway requires lease and current revision; owner can restore hidden entry and confirm it through UI tool',async t=>{
 const f=await fixture(t);f.store.setHidden({id:f.item.id,hidden:true,expectedRevision:f.store.snapshot().revision});
 const noLease=await f.operation('queueDeletionReview',{id:f.item.id,expectedRevision:f.store.snapshot().revision});
 assert.equal(noLease.isError,true);assert.equal(noLease._meta.error.code,'LEASE_LOST');assert.equal(f.store.snapshot().items.length,0);
 const lease=(await f.operation('acquire',{})).structuredContent.value;
 try{
  const stale=await f.operation('queueDeletionReview',{id:f.item.id,expectedRevision:0},lease.token);assert.equal(stale.isError,true);assert.equal(stale._meta.error.code,'STALE_REVISION');
  const queued=await f.operation('queueDeletionReview',{id:f.item.id,expectedRevision:f.store.snapshot().revision},lease.token);assert.notEqual(queued.isError,true,JSON.stringify(queued));
  const value=queued.structuredContent.value.items[0];assert.equal(value.deletionReview.failureCount,0);assert.equal(value.deletionReview.reason,'owner_request');
  const state=await f.client.callTool({name:'get_maintenance_state',arguments:{}});assert.equal(state.structuredContent.deletionReviewItems[0].title,f.item.title);
  const confirmed=await f.resolve('confirm_deleted');assert.notEqual(confirmed.isError,true,JSON.stringify(confirmed));assert.equal(confirmed.structuredContent.items.length,0);
  assert.equal(f.store.maintenanceState().counts.available,1,'Owner confirmation is an organizer preference, not invented source evidence');
  const raw=f.store.db.prepare('SELECT category,focused,title FROM catalog_items WHERE id=?').get(f.item.id);assert.equal(raw.category,'Travel');assert.equal(raw.focused,1);assert.equal(raw.title,f.item.title);
 }finally{await f.operation('release',{token:lease.token});}
});
