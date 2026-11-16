import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CatalogStore} from '../store.mjs';

const run=(0,eval)(await readFile(new URL('../trash-archive-workflow.js',import.meta.url),'utf8'));
const webId='g-p-00000000000000000000000000000006';
const chat=(id,extra={})=>({id:'chatgpt:chat:'+id,source:'chatgpt',sourceId:id,kind:'chat',title:id,...extra});
const project=(id='p',extra={})=>({id:'chatgpt:project:'+id,source:'chatgpt',sourceId:id,kind:'project',title:'Project '+id,...extra});
const local=(id,extra={})=>({id:'codex:chat:'+id,source:'codex',sourceId:id,kind:'chat',title:id,hostId:'local',...extra});
const response=value=>({structuredContent:value,content:[]});
const move=(s,id,category)=>s.setCategory({id,category,expectedRevision:s.snapshot().revision});
function fixture(items) {
  const store=new CatalogStore(':memory:');store.importInventory({items,coverage:'Synthetic project Trash archive fixture'});
  const before=store.snapshot();
  const state=before.categories.some(x=>x.name==='Trash'&&x.parentId===null)?before:store.createCategoryPath({parentId:null,names:['Trash'],expectedRevision:before.revision});
  const trash=state.categories.find(x=>x.name==='Trash'&&x.parentId===null).id;
  for(const p of items.filter(x=>x.kind==='project'))move(store,p.id,trash);
  return {store,trash};
}
function confirm(store) {const p=store.previewTrashArchive();return store.startTrashArchive({ids:p.items.map(x=>x.id),projectIds:p.projects.map(x=>x.id),expectedRevision:p.revision});}
const nativeSuccess=async args=>response({archived:true,threadId:args.threadId});
const services={state:'trashArchiveState',claim:'claimTrashArchive',record:'recordTrashArchive',finish:'finishTrashArchive'};
const tools=(s,archive=nativeSuccess)=>({mcp__chat_organizer__manage_trash_archive:async({request:{op,args}})=>response({value:s[services[op]](args)}),...(archive?{mcp__codex_app__set_thread_archived:archive}:{})});
const options=batch=>({batchId:batch.batchId,wait:async()=>{}});
const archiveKnown=(s,id)=>s.applySync({observations:[{id,evidence:'archive_list',outcome:'archived',observedAt:new Date().toISOString()}],expectedRevision:s.snapshot().revision});

test('mixed direct and cross-category project members archive individually and organizer-only project removal preserves metadata',async()=>{
  const p=project(),a=chat('a',{projectId:'p'}),b=chat('b'),other=chat('other');const {store,trash}=fixture([p,a,b,other]);
  try {
    move(store,a.id,'Travel');move(store,b.id,trash);store.setFocus({id:a.id,focused:true,expectedRevision:store.snapshot().revision});
    const raw=store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all(),categories=store.categories(),calls=[];
    const preview=store.previewTrashArchive();assert.equal(preview.items.length,2);assert.equal(preview.projects[0].chatIds.length,1);
    const batch=confirm(store),result=await run(tools(store,async args=>{calls.push(args.threadId);return nativeSuccess(args);}),options(batch));
    assert.deepEqual(calls.sort(),['a','b']);assert.equal(result.counts.archived,2);assert.equal(result.counts.projectsRemoved,1);assert.equal(result.status,'completed');
    assert.deepEqual(store.snapshot().items.map(x=>x.id),[other.id]);assert.deepEqual(store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all(),raw);assert.deepEqual(store.categories(),categories);
    assert.equal(store.db.prepare('SELECT availability FROM catalog_sync WHERE item_id=?').get(p.id),undefined,'Project source status was not archived');
    await run(tools(store,async()=>{throw Error('must not repeat');}),options(batch));assert.equal(store.snapshot().items.length,1);
  }finally{store.close();}
});

test('verified project and chat aliases deduplicate actions and hide only approved project representations',async()=>{
  const p=project(webId),pa={id:'codex:project:backing',source:'codex',sourceId:'backing',kind:'project',title:p.title,hostId:'local',chatgptProjectId:webId};
  const conversation='00000000-0000-4000-8000-000000000005',a=chat(conversation,{projectId:webId}),aa=local('alias',{projectId:'backing',webConversationId:conversation}),old=local('old',{projectId:webId});
  const {store}=fixture([p,pa,a,aa,old]);
  try {
    const preview=store.previewTrashArchive();assert.equal(preview.projects.length,1);assert.equal(preview.projects[0].aliasIds.length,2);assert.equal(preview.items.length,2);
    const calls=[];const result=await run(tools(store,async args=>{calls.push(args);return nativeSuccess(args);}),options(confirm(store)));
    assert.equal(calls.length,2);assert.equal(calls.filter(x=>x.threadId===conversation).length,1);assert.equal(result.counts.projectsRemoved,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM catalog_hidden').get().count,2);assert.equal(store.snapshot().items.length,0);
  }finally{store.close();}
});

test('same project identifier on unrelated sources does not authorize archive and blocks project removal',async()=>{
  const p=project('collision'),wrong=local('wrong',{projectId:'collision'});const {store}=fixture([p,wrong]);
  try {
    const preview=store.previewTrashArchive();assert.equal(preview.items.length,0);assert.equal(preview.skipped[0].id,wrong.id);
    const result=await run(tools(store,null),options(confirm(store)));assert.equal(result.counts.projectsRetained,1);assert.equal(store.snapshot().items.length,2);
  }finally{store.close();}
});

test('same project identifier on a different Codex host cannot enter the approved batch',async()=>{
  const p={id:'codex:project:same',source:'codex',sourceId:'same',kind:'project',title:'Local project',hostId:'local'};
  const a=local('a',{projectId:'same'}),remote=local('remote',{projectId:'same',hostId:'durable'});const {store}=fixture([p,a,remote]);
  try {
    const preview=store.previewTrashArchive();assert.deepEqual(preview.items.map(x=>x.id),[a.id]);
    const calls=[];const result=await run(tools(store,async args=>{calls.push(args.threadId);return nativeSuccess(args);}),options(confirm(store)));
    assert.deepEqual(calls,['a']);assert.equal(result.counts.projectsRemoved,1);assert.deepEqual(store.snapshot().items.map(x=>x.id),[remote.id]);
  }finally{store.close();}
});

test('project moved out after confirmation blocks inherited members but preserves independently approved Trash chat actions',async()=>{
  const p=project(),a=chat('a',{projectId:'p'}),b=chat('b',{projectId:'p'});const {store,trash}=fixture([p,a,b]);
  try {
    move(store,b.id,trash);const batch=confirm(store);move(store,p.id,'Travel');const calls=[];
    const result=await run(tools(store,async args=>{calls.push(args.threadId);return nativeSuccess(args);}),options(batch));
    assert.deepEqual(calls,['b']);assert.equal(result.counts.projectsRetained,1);assert.equal(result.counts.skipped,1);assert.ok(store.snapshot().items.some(x=>x.id===a.id));
  }finally{store.close();}
});

test('chat reassignment after confirmation rescues it even when it is still rendered under the same project',async()=>{
  const p=project(),a=chat('a',{projectId:'p'});const {store}=fixture([p,a]);
  try {
    const batch=confirm(store);move(store,a.id,'Health');let called=false;
    const result=await run(tools(store,async()=>{called=true;return response({archived:true});}),options(batch));
    assert.equal(called,false);assert.equal(result.counts.skipped,1);assert.equal(result.counts.projectsRetained,1);assert.match(result.projects[0].detail,/member assignments changed/);
  }finally{store.close();}
});

test('new project members after confirmation are never archived and prevent organizer project removal',async()=>{
  const p=project(),a=chat('a',{projectId:'p'});const {store}=fixture([p,a]);
  try {
    const batch=confirm(store),newcomer=chat('new',{projectId:'p'});store.importInventory({items:[newcomer],coverage:'New member after confirmation'});
    const calls=[];const result=await run(tools(store,async args=>{calls.push(args.threadId);return nativeSuccess(args);}),options(batch));
    assert.deepEqual(calls,['a']);assert.equal(result.counts.projectsRetained,1);assert.match(result.projects[0].detail,/membership.*changed/);
    assert.ok(store.snapshot().items.some(x=>x.id===newcomer.id));assert.ok(store.snapshot().items.some(x=>x.id===p.id));
  }finally{store.close();}
});

test('failed or uncertain member archive retains the project',async()=>{
  const p=project(),a=chat('a',{projectId:'p'});const {store}=fixture([p,a]);
  try {
    const result=await run(tools(store,async()=>({isError:true,content:[{type:'text',text:'Source chat cannot be archived.'}]})),options(confirm(store)));
    assert.equal(result.counts.failed,1);assert.equal(result.counts.projectsRetained,1);assert.equal(store.snapshot().items.length,2);
  }finally{store.close();}
});

for(const kind of ['hidden','not_found'])test(kind+' unarchived member prevents project hiding even when all visible archive attempts succeed',async()=>{
  const p=project(),a=chat('a',{projectId:'p'}),b=chat('b',{projectId:'p'});const {store}=fixture([p,a,b]);
  try {
    if(kind==='hidden')store.setHidden({id:b.id,hidden:true,expectedRevision:store.snapshot().revision});
    else store.applySync({observations:[{id:b.id,evidence:'probe',outcome:'not_found',observedAt:new Date().toISOString()}],expectedRevision:store.snapshot().revision});
    const result=await run(tools(store),options(confirm(store)));assert.equal(result.counts.archived,1);assert.equal(result.counts.projectsRetained,1);assert.ok(store.snapshot().items.some(x=>x.id===p.id));
  }finally{store.close();}
});

test('already archived members count toward cleanup and a project-only batch needs no native archive tool',async()=>{
  const p=project(),a=chat('a',{projectId:'p'});const {store}=fixture([p,a]);
  try {
    archiveKnown(store,a.id);const preview=store.previewTrashArchive();assert.equal(preview.items.length,0);assert.equal(preview.projects[0].alreadyArchivedCount,1);
    const result=await run(tools(store,null),options(confirm(store)));assert.equal(result.counts.archived,0);assert.equal(result.counts.projectsRemoved,1);assert.equal(store.snapshot().items.length,0);
  }finally{store.close();}
});

test('empty project confirmation removes only organizer entry; cancel and stale preview protect it',async()=>{
  const p=project();const {store}=fixture([p]);
  try {
    const before=store.snapshot(),preview=store.previewTrashArchive();move(store,p.id,'Travel');
    assert.throws(()=>store.startTrashArchive({ids:[],projectIds:[p.id],expectedRevision:preview.revision}),{code:'STALE_REVISION'});
    move(store,p.id,before.categories.find(x=>x.name==='Trash').id);const canceled=confirm(store);store.cancelTrashArchive({batchId:canceled.batchId});
    await run(tools(store,null),options(canceled));store.finishTrashArchive({batchId:canceled.batchId});assert.equal(store.snapshot().items.length,1);
    const next=confirm(store);const result=await run(tools(store,null),options(next));assert.equal(result.counts.projectsRemoved,1);assert.equal(store.snapshot().items.length,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM catalog_items').get().count,1);assert.throws(()=>store.cancelTrashArchive({batchId:next.batchId}),{code:'ARCHIVE_STARTED'});
  }finally{store.close();}
});

test('legacy saved batches cannot gain project scope when resumed by the upgraded workflow',async()=>{
  const p=project(),a=chat('a',{projectId:'p'});const {store}=fixture([p,a]);
  try {
    const preview=store.previewTrashArchive(),item=preview.items[0];
    const batch={batchId:'11111111-1111-4111-8111-111111111111',status:'pending',createdAt:new Date().toISOString(),finishedAt:null,items:[{id:item.id,title:item.title,source:item.source,sourceId:item.sourceId,hostId:item.hostId,aliasIds:item.aliasIds,targetKey:item.targetKey,outcome:'pending'}],skipped:[]};
    store.saveTrashArchiveBatch(batch);let called=false;
    const result=await run(tools(store,async()=>{called=true;return response({archived:true});}),options(batch));
    assert.equal(called,false);assert.equal(result.counts.skipped,1);assert.equal(result.counts.projectsRemoved,0);assert.equal(store.snapshot().items.length,2);
  }finally{store.close();}
});
