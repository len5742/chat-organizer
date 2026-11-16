import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CatalogStore} from '../store.mjs';
const run=(0,eval)(await readFile(new URL('../trash-archive-workflow.js',import.meta.url),'utf8'));
const response=value=>({structuredContent:value,content:[]});
const chat=id=>({id:'chatgpt:chat:'+id,source:'chatgpt',sourceId:id,title:id,kind:'chat'});
function fixture({emptyOnly=false}={}) {
  const store=new CatalogStore(':memory:');
  const project={id:'chatgpt:project:p',source:'chatgpt',sourceId:'p',title:'Empty project',kind:'project'};
  store.importInventory({items:emptyOnly?[project]:[chat('a'),chat('b'),project],coverage:'Synthetic stop fixture'});
  let state=store.snapshot();if(!state.categories.some(x=>x.name==='Trash'&&x.parentId===null))state=store.createCategoryPath({parentId:null,names:['Trash'],expectedRevision:state.revision});
  const trash=state.categories.find(x=>x.name==='Trash'&&x.parentId===null).id;
  for(const item of state.items)store.setCategory({id:item.id,category:trash,expectedRevision:store.snapshot().revision});
  const preview=store.previewTrashArchive(),batch=store.startTrashArchive({ids:preview.items.map(x=>x.id),projectIds:preview.projects.map(x=>x.id),expectedRevision:preview.revision});
  const api=archive=>({mcp__chat_organizer__manage_trash_archive:async({request:{op,args}})=>response({value:store[{state:'trashArchiveState',claim:'claimTrashArchive',record:'recordTrashArchive',finish:'finishTrashArchive'}[op]](args)}),mcp__codex_app__set_thread_archived:archive});
  return {store,batch,api};
}
const options=batch=>({batchId:batch.batchId,wait:async()=>{}});

test('stop before queued worker starts performs no source calls or project cleanup and is idempotent',async()=>{
  const {store,batch,api}=fixture();
  try {
    const before=store.snapshot(),stopped=store.stopTrashArchive({batchId:batch.batchId});
    assert.equal(stopped.status,'stopped');assert.ok(stopped.stopRequestedAt);assert.equal(stopped.counts.skipped,2);assert.equal(stopped.counts.projectsRetained,1);
    assert.deepEqual(store.stopTrashArchive({batchId:batch.batchId}),stopped);
    let calls=0;const result=await run(api(async()=>{calls++;return response({archived:true});}),options(batch));
    assert.equal(calls,0);assert.equal(result.status,'stopped');assert.equal(result.complete,false);assert.deepEqual(store.snapshot(),before);
    assert.equal(store.previewTrashArchive().activeBatch,null);assert.equal(store.previewTrashArchive().items.length,2);
    assert.equal(store.claimTrashArchive({batchId:batch.batchId}).claimed,false);assert.equal(store.finishTrashArchive({batchId:batch.batchId}).status,'stopped');
  }finally{store.close();}
});

test('stop during source request completes that one request and preserves all remaining chats and projects',async()=>{
  const {store,batch,api}=fixture();
  try {
    let enteredResolve,archiveResolve,calls=0;
    const entered=new Promise(resolve=>{enteredResolve=resolve;});
    const worker=run(api(async()=>{calls++;enteredResolve();return new Promise(resolve=>{archiveResolve=resolve;});}),options(batch));
    await entered;const stopping=store.stopTrashArchive({batchId:batch.batchId});
    assert.equal(stopping.status,'running');assert.equal(stopping.counts.processing,1);assert.equal(stopping.counts.pending,1);
    assert.equal(store.stopTrashArchive({batchId:batch.batchId}).stopRequestedAt,stopping.stopRequestedAt);
    assert.equal(store.claimTrashArchive({batchId:batch.batchId}).reason,'stopping');assert.equal(store.finishTrashArchive({batchId:batch.batchId}).status,'running');
    archiveResolve(response({archived:true,threadId:'a'}));const result=await worker;
    assert.equal(calls,1);assert.equal(result.status,'stopped');assert.equal(result.counts.archived,1);assert.equal(result.counts.skipped,1);assert.equal(result.counts.projectsRemoved,0);
    assert.deepEqual(store.snapshot().items.map(x=>x.id).sort(),['chatgpt:chat:b','chatgpt:project:p']);
    const preview=store.previewTrashArchive();assert.deepEqual(preview.items.map(x=>x.id),['chatgpt:chat:b']);assert.equal(preview.projects.length,1);
    const next=store.startTrashArchive({ids:preview.items.map(x=>x.id),projectIds:preview.projects.map(x=>x.id),expectedRevision:preview.revision});assert.notEqual(next.batchId,batch.batchId);
  }finally{store.close();}
});

test('an uncertain in-flight response after stop stays visible and excluded from blind retry',async()=>{
  const {store,batch,api}=fixture();
  try {
    let enteredResolve,archiveReject;
    const entered=new Promise(resolve=>{enteredResolve=resolve;});
    const worker=run(api(async()=>{enteredResolve();return new Promise((resolve,reject)=>{archiveReject=reject;});}),options(batch));
    await entered;store.stopTrashArchive({batchId:batch.batchId});archiveReject(new Error('Transport timeout'));
    const result=await worker;assert.equal(result.status,'stopped');assert.equal(result.counts.unknown,1);assert.equal(result.counts.skipped,1);assert.equal(store.snapshot().items.length,3);
    const preview=store.previewTrashArchive();assert.deepEqual(preview.items.map(x=>x.id),['chatgpt:chat:b']);assert.match(preview.skipped[0].reason,/uncertain/);
  }finally{store.close();}
});

test('stopping an empty-project-only batch prevents delayed organizer cleanup',async()=>{
  const {store,batch,api}=fixture({emptyOnly:true});
  try {
    store.stopTrashArchive({batchId:batch.batchId});
    const result=await run(api(undefined),options(batch));assert.equal(result.status,'stopped');assert.equal(result.counts.projectsRetained,1);assert.equal(store.snapshot().items.length,1);
    store.finishTrashArchive({batchId:batch.batchId});assert.equal(store.snapshot().items.length,1);
  }finally{store.close();}
});
