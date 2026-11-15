import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogStore,isProjectMember} from '../store.mjs';
const webId='g-p-00000000000000000000000000000006';
const web={id:'chatgpt:project:'+webId,source:'chatgpt',sourceId:webId,kind:'project',title:'Same named project'};
const alias={id:'codex:project:local-backing',source:'codex',sourceId:'local-backing',hostId:'local',kind:'project',title:web.title,chatgptProjectId:webId};
const chat=(id,projectId,extra={})=>({id:'codex:chat:'+id,source:'codex',sourceId:id,kind:'chat',hostId:'local',title:id,projectId,...extra});
const fixture=fn=>{const s=new CatalogStore(':memory:');try{fn(s);}finally{s.close();}};
const seed=(s,items)=>s.importInventory({items,coverage:'Isolated project alias regression'});
const move=(s,id,category)=>s.setCategory({id,category,expectedRevision:s.snapshot().revision});
const sync=(s,observations)=>s.applySync({observations,expectedRevision:s.snapshot().revision});
const obs=(item,extra={})=>({...item,evidence:'project_list',outcome:'found',observedAt:new Date().toISOString(),...extra});
const rows=s=>s.db.prepare('SELECT * FROM catalog_items ORDER BY id').all().map(x=>({...x}));
test('verified project backing combines old and new memberships, activity and one saved project appearance',()=>fixture(s=>{
 seed(s,[web,alias,chat('old',webId,{updatedAt:'2026-10-18T01:00:00Z'}),chat('new',alias.sourceId,{updatedAt:'2026-10-20T01:00:00Z'}),chat('remote',alias.sourceId,{hostId:'durable'})]);
 const snap=s.snapshot(),p=snap.items.find(x=>x.id===web.id);assert.equal(snap.items.length,4);assert.equal(rows(s).length,5);
 assert.deepEqual(p.projectAliases,[{sourceId:alias.sourceId,hostId:'local'}]);
 assert.deepEqual(snap.items.filter(x=>isProjectMember(p,x)).map(x=>x.sourceId).sort(),['new','old']);assert.equal(p.effectiveUpdatedAt,'2026-10-20T01:00:00Z');
 assert.equal(rows(s).find(x=>x.source_id==='new').project_id,alias.sourceId);
 assert.equal(isProjectMember(p,{...chat('unknown',alias.sourceId),hostId:null}),false);
}));
test('a mapped project later observed on a different host cannot edit the local group',()=>fixture(s=>{
 seed(s,[web,alias]);sync(s,[obs({id:alias.id,hostId:'durable'})]);move(s,alias.id,'Travel');
 assert.equal(rows(s).find(x=>x.id===alias.id).category,'Travel');assert.equal(rows(s).find(x=>x.id===web.id).category,'Uncategorized');assert.equal(s.snapshot().items.length,2);
}));
test('matching titles and paths never merge unmapped project records',()=>fixture(s=>{
 const unmapped={...alias};delete unmapped.chatgptProjectId;seed(s,[web,unmapped]);assert.equal(s.snapshot().items.length,2);assert.ok(s.snapshot().items.every(x=>!x.projectAliases));
}));
test('mapping existing records preserves category conflicts until an explicit edit, which updates both identities atomically',()=>fixture(s=>{
 const unmapped={...alias};delete unmapped.chatgptProjectId;seed(s,[web,unmapped,chat('member',alias.sourceId)]);move(s,web.id,'Travel');
 s.setFocus({id:'codex:chat:member',focused:true,expectedRevision:s.snapshot().revision});const before=rows(s);
 sync(s,[obs(alias)]);assert.equal(s.snapshot().items.length,3);assert.equal(rows(s).find(x=>x.id===alias.id).category,'Uncategorized');
 const rev=s.snapshot().revision;assert.throws(()=>s.setCategory({id:alias.id,category:'Travel',expectedRevision:rev-1}),{code:'STALE_REVISION'});
 move(s,alias.id,'Travel');assert.equal(s.snapshot().revision,rev+1);assert.equal(s.snapshot().items.length,2);
 move(s,web.id,'Health');assert.ok(rows(s).filter(x=>x.kind==='project').every(x=>x.category==='Health'));
 const m=rows(s).find(x=>x.kind==='chat');assert.equal(m.focused,1);assert.equal(m.project_id,alias.sourceId);assert.deepEqual(m,before.find(x=>x.kind==='chat'));
 const noOp=s.snapshot().revision;move(s,web.id,'Health');assert.equal(s.snapshot().revision,noOp);
}));
for(const way of ['import','sync'])test('new mapped project inherits an established category through '+way,()=>fixture(s=>{
 seed(s,[web]);move(s,web.id,'Travel');if(way==='import')seed(s,[alias]);else sync(s,[obs(alias)]);
 assert.equal(s.snapshot().items.length,1);assert.equal(rows(s).find(x=>x.id===alias.id).category,'Travel');
}));
test('omitted and older mapping observations retain the known link; explicit unlink restores independent display',()=>fixture(s=>{
 seed(s,[web,alias]);const unmapped={...alias};delete unmapped.chatgptProjectId;
 seed(s,[unmapped]);assert.equal(s.snapshot().items.length,1);const time=new Date().toISOString();sync(s,[obs(alias,{observedAt:time})]);
 sync(s,[obs(unmapped)]);assert.equal(s.snapshot().items.length,1);
 sync(s,[obs(alias,{chatgptProjectId:null,observedAt:new Date(Date.parse(time)-1000).toISOString()})]);assert.equal(s.snapshot().items.length,1);
 sync(s,[obs(alias,{chatgptProjectId:null,observedAt:new Date(Date.now()+1).toISOString()})]);assert.equal(s.snapshot().items.length,2);
}));
test('missing canonical stays visible as separate projects and cannot absorb alias members; archived alias drops from membership',()=>fixture(s=>{
 seed(s,[web,alias,chat('member',alias.sourceId)]);sync(s,[{id:web.id,outcome:'not_found',evidence:'project_list_complete',observedAt:new Date().toISOString()}]);
 assert.equal(s.snapshot().items.filter(x=>x.kind==='project').length,2);assert.ok(!s.snapshot().items.find(x=>x.id===web.id).projectAliases);
 sync(s,[{id:alias.id,outcome:'archived',evidence:'archive_list',observedAt:new Date().toISOString()}]);assert.equal(s.snapshot().items.filter(x=>x.kind==='project').length,1);
}));
test('category deletion and undo retain all physical assignments and links',()=>fixture(s=>{
 seed(s,[web,alias]);move(s,web.id,'Travel');const d=s.deleteCategory({id:'Travel',expectedRevision:s.snapshot().revision});assert.equal(d.items.length,1);
 const restored=s.undoDeleteCategory({token:d.undoDelete.token,expectedRevision:d.revision});assert.equal(restored.items.length,1);assert.ok(rows(s).every(x=>x.category==='Travel'));
}));
test('invalid project mapping identity, host and evidence are rejected without changing rows',()=>fixture(s=>{
 seed(s,[web,alias]);const before=rows(s);
 for(const bad of [{...alias,chatgptProjectId:'bad'}, {...alias,hostId:'durable'}, {...web,chatgptProjectId:webId}, {...chat('bad',null),chatgptProjectId:webId}])assert.throws(()=>seed(s,[bad]),{code:'INVALID_INPUT'});
 assert.throws(()=>sync(s,[obs(alias,{evidence:'sidebar'})]),{code:'INVALID_INPUT'});assert.deepEqual(rows(s),before);
}));
