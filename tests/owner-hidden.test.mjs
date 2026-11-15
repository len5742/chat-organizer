import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {CatalogStore} from '../store.mjs';
import {createOrganizerServer} from '../server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const recent=new Date(Date.now()-3600000).toISOString();
const chat=(id='saved',extra={})=>({id:'codex:chat:'+id,source:'codex',sourceId:id,kind:'chat',hostId:'local',title:'Saved '+id,updatedAt:recent,...extra});
const fixture=fn=>{const s=new CatalogStore(':memory:');try{return fn(s);}finally{s.close();}};
const seed=(s,items)=>s.importInventory({items,coverage:'Isolated owner-hidden regression'});
const revision=s=>s.snapshot().revision;
const hide=(s,id,hidden=true)=>s.setHidden({id,hidden,expectedRevision:revision(s)});
const row=(s,id)=>({...s.db.prepare('SELECT * FROM catalog_items WHERE id=?').get(id)});
const status=(s,id)=>s.db.prepare('SELECT availability FROM catalog_sync WHERE item_id=?').get(id)?.availability??'available';
let tick=0;const observed=()=>new Date(Date.now()-10000+(++tick)).toISOString();
const sync=(s,observations)=>s.applySync({observations,expectedRevision:revision(s),mode:'recent',coverage:'Synthetic explicit evidence'});
const probe=(id,extra={})=>({id,observedAt:observed(),evidence:'probe',outcome:'found',...extra});
const organized=(s,c)=>{seed(s,[c]);s.setCategory({id:c.id,category:'Travel',expectedRevision:revision(s)});s.setFocus({id:c.id,focused:true,expectedRevision:revision(s)});};
test('owner hiding removes only the saved appearance without changing source status or organization',()=>fixture(s=>{
 const c=chat();organized(s,c);sync(s,[probe(c.id,{outcome:'error',error:'Source host unavailable'})]);const before=row(s,c.id),source=s.db.prepare('SELECT * FROM catalog_sync WHERE item_id=?').get(c.id);const count=s.maintenanceState().counts;
 const value=hide(s,c.id);assert.equal(value.items.length,0);assert.deepEqual(row(s,c.id),before);assert.deepEqual(s.db.prepare('SELECT * FROM catalog_sync WHERE item_id=?').get(c.id),source);assert.deepEqual(s.maintenanceState().counts,count);assert.equal(status(s,c.id),'available');assert.equal(s.db.prepare('SELECT count(*) n FROM catalog_items').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM catalog_hidden').get().n,1);
}));
test('owner hiding is idempotent, revision guarded, explicit boolean and exact-ID only',()=>fixture(s=>{
 const c=chat();seed(s,[c]);const start=revision(s),hidden=hide(s,c.id),savedAt=s.db.prepare('SELECT hidden_at FROM catalog_hidden WHERE item_id=?').get(c.id).hidden_at;assert.equal(hidden.revision,start+1);assert.deepEqual(hide(s,c.id),hidden);assert.equal(s.db.prepare('SELECT hidden_at FROM catalog_hidden WHERE item_id=?').get(c.id).hidden_at,savedAt);
 for(const hiddenValue of [undefined,null,0,1,'true',{},[]])assert.throws(()=>s.setHidden({id:c.id,hidden:hiddenValue,expectedRevision:hidden.revision}),{code:'INVALID_INPUT'});
 assert.throws(()=>s.setHidden({id:c.id,hidden:true,expectedRevision:start}),{code:'STALE_REVISION'});assert.throws(()=>s.setHidden({id:'codex:chat:missing',hidden:true,expectedRevision:hidden.revision}),{code:'NOT_FOUND'});assert.deepEqual(s.snapshot(),hidden);
 const restored=hide(s,c.id,false);assert.equal(restored.revision,hidden.revision+1);assert.equal(restored.items[0].id,c.id);assert.deepEqual(hide(s,c.id,false),restored);
}));
test('owner-hidden state survives metadata refresh, partial reimport and database reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'organizer-owner-hidden-'));const file=join(dir,'catalog.sqlite');let s;
 try{s=new CatalogStore(file);const c=chat();organized(s,c);hide(s,c.id);const hiddenAt=s.db.prepare('SELECT hidden_at FROM catalog_hidden WHERE item_id=?').get(c.id).hidden_at;
 sync(s,[probe(c.id,{evidence:'sidebar',title:'A fresh source title'})]);seed(s,[{...c,title:'Reimported source title'}]);assert.equal(s.snapshot().items.length,0);assert.equal(row(s,c.id).category,'Travel');assert.equal(row(s,c.id).focused,1);assert.equal(status(s,c.id),'available');s.close();s=new CatalogStore(file);assert.equal(s.snapshot().items.length,0);assert.equal(s.db.prepare('SELECT hidden_at FROM catalog_hidden WHERE item_id=?').get(c.id).hidden_at,hiddenAt);const restored=hide(s,c.id,false).items[0];assert.equal(restored.title,'Reimported source title');assert.equal(restored.category,'Travel');assert.equal(restored.focused,true);
 }finally{s?.close();const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep));await rm(target,{recursive:true,force:true});}
});
test('owner-hidden chats are excluded from recent verification without changing availability',()=>fixture(s=>{
 const a=chat('a'),b=chat('b');seed(s,[a,b]);assert.deepEqual(new Set(s.recentVerificationBatch({observedIds:[],limit:8}).items.map(x=>x.id)),new Set([a.id,b.id]));hide(s,a.id);assert.deepEqual(s.recentVerificationBatch({observedIds:[],limit:8}).items.map(x=>x.id),[b.id]);assert.equal(status(s,a.id),'available');
}));
test('hiding leaves an existing audit checkpoint and its queued rows byte-for-byte unchanged',()=>fixture(s=>{
 const a=chat('a'),b=chat('b');seed(s,[a,b]);const audit=s.beginAudit({day:'2026-10-20'}),meta=s.meta('dailyAudit'),rows=s.db.prepare('SELECT * FROM catalog_audit_queue ORDER BY item_id').all();hide(s,a.id);assert.equal(s.meta('dailyAudit'),meta);assert.deepEqual(s.db.prepare('SELECT * FROM catalog_audit_queue ORDER BY item_id').all(),rows);assert.ok(s.auditBatch({auditId:audit.id}).items.some(x=>x.id===a.id),'Preexisting queue is historical data, not rewritten by hiding');
}));
test('new audit queues exclude exact owner-hidden IDs and include restored records',()=>fixture(s=>{
 const a=chat('a'),b=chat('b'),c=chat('restored');seed(s,[a,b,c]);hide(s,a.id);hide(s,c.id);hide(s,c.id,false);const audit=s.beginAudit({day:'2026-10-20'});assert.equal(audit.total,2);assert.deepEqual(new Set(s.auditBatch({auditId:audit.id}).items.map(x=>x.id)),new Set([b.id,c.id]));
}));
test('owner confirmation accepts only archived status, preserves fields and atomically rejects every other outcome',()=>fixture(s=>{
 const a=chat('a'),b=chat('b');seed(s,[a,b]);s.setCategory({id:a.id,category:'Travel',expectedRevision:revision(s)});s.setFocus({id:a.id,focused:true,expectedRevision:revision(s)});const before=row(s,a.id);sync(s,[probe(a.id,{evidence:'owner_confirmation',outcome:'archived'})]);assert.equal(status(s,a.id),'archived');assert.deepEqual(row(s,a.id),before);assert.equal(s.snapshot().items.some(x=>x.id===a.id),false);
 for(const outcome of ['found','not_found','error']){const rev=revision(s),raw=s.db.prepare('SELECT * FROM catalog_sync ORDER BY item_id').all();assert.throws(()=>sync(s,[probe(b.id,{title:'Must not commit'}),probe(a.id,{evidence:'owner_confirmation',outcome,error:'Must be rejected'})]),{code:'INVALID_INPUT'});assert.equal(revision(s),rev);assert.equal(row(s,b.id).title,b.title);assert.deepEqual(s.db.prepare('SELECT * FROM catalog_sync ORDER BY item_id').all(),raw);}
}));
test('clearing owner-hidden state does not falsely restore a source-confirmed archive',()=>fixture(s=>{
 const c=chat();organized(s,c);hide(s,c.id);sync(s,[probe(c.id,{evidence:'owner_confirmation',outcome:'archived'})]);hide(s,c.id,false);assert.equal(status(s,c.id),'archived');assert.equal(s.snapshot().items.length,0);assert.equal(row(s,c.id).category,'Travel');assert.equal(row(s,c.id).focused,1);
}));
for(const kind of ['chat','project'])test('a hidden canonical '+kind+' keeps its verified alias hidden without changing either source record',()=>fixture(s=>{
 const webId=kind==='chat'?'00000000-0000-4000-8000-000000000005':'g-p-00000000000000000000000000000006';
 const web={id:'chatgpt:'+kind+':'+webId,source:'chatgpt',sourceId:webId,kind,title:'Canonical '+kind};const alias={id:'codex:'+kind+':alias',source:'codex',sourceId:'alias',kind,hostId:'local',title:'Alias '+kind,...(kind==='chat'?{webConversationId:webId}:{chatgptProjectId:webId})};seed(s,[web,alias]);s.setCategory({id:web.id,category:'Travel',expectedRevision:revision(s)});if(kind==='chat')s.setFocus({id:web.id,focused:true,expectedRevision:revision(s)});const originals=s.db.prepare('SELECT * FROM catalog_items ORDER BY id').all();hide(s,web.id);assert.equal(s.snapshot().items.length,0);assert.deepEqual(s.db.prepare('SELECT * FROM catalog_items ORDER BY id').all(),originals);assert.equal(s.db.prepare('SELECT count(*) n FROM catalog_hidden').get().n,1);assert.equal(status(s,alias.id),'available');sync(s,[probe(alias.id)]);assert.equal(s.snapshot().items.length,0);hide(s,web.id,false);assert.deepEqual(s.snapshot().items.map(x=>x.id),[web.id]);
}));
test('real MCP setHidden requires current lease and revision, preserves schema, and restores by exact ID',async()=>{
 const s=new CatalogStore(':memory:');const c=chat();organized(s,c);const initial=s.snapshot();const server=createOrganizerServer(s,'stdio');const client=new Client({name:'owner-hidden-fixture',version:'1.0.0'});const[ct,st]=InMemoryTransport.createLinkedPair();const call=(op,args,leaseToken)=>client.callTool({name:'maintain_catalog',arguments:{request:{op,args,...(leaseToken?{leaseToken}:{})}}});
 try{await server.connect(st);await client.connect(ct);let result=await call('setHidden',{id:c.id,hidden:true,expectedRevision:initial.revision});assert.equal(result.isError,true);assert.equal(result._meta.error.code,'LEASE_LOST');assert.equal(s.snapshot().items.length,1);const lease=(await call('acquire',{})).structuredContent.value;
 result=await call('setHidden',{id:c.id,hidden:true,expectedRevision:initial.revision},'wrong-token');assert.equal(result._meta.error.code,'LEASE_LOST');result=await call('setHidden',{id:c.id,hidden:true,expectedRevision:initial.revision-1},lease.token);assert.equal(result._meta.error.code,'STALE_REVISION');assert.equal(s.snapshot().items.length,1);
 result=await call('setHidden',{id:c.id,hidden:true,expectedRevision:initial.revision},lease.token);assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.value.items.length,0);const hiddenRevision=result.structuredContent.value.revision;assert.equal(status(s,c.id),'available');const inventory=await client.callTool({name:'get_inventory',arguments:{}});assert.ok(!inventory.isError);assert.equal(inventory.structuredContent.items.length,0);
 result=await call('setHidden',{id:c.id,hidden:false,expectedRevision:hiddenRevision},lease.token);assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.value.items[0].category,'Travel');assert.equal(result.structuredContent.value.items[0].focused,true);await call('release',{token:lease.token});result=await call('setHidden',{id:c.id,hidden:true,expectedRevision:revision(s)},lease.token);assert.equal(result._meta.error.code,'LEASE_LOST');
 }finally{await client.close();await server.close();s.close();}
});
