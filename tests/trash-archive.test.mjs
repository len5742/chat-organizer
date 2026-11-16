import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

const run = (0,eval)(await readFile(new URL('../trash-archive-workflow.js',import.meta.url),'utf8'));
const chat = (id,extra={}) => ({id:'chatgpt:chat:'+id,source:'chatgpt',sourceId:id,title:id,kind:'chat',...extra});
const response = value => ({structuredContent:value,content:[]});
const error = text => ({isError:true,content:[{type:'text',text}]});
const move = (store,id,category) => store.setCategory({id,category,expectedRevision:store.snapshot().revision});
function fixture(items=[chat('a'),chat('b'),chat('other')],database=':memory:') {
  const store=new CatalogStore(database);
  store.importInventory({items,coverage:'Synthetic Trash archive fixture'});
  let state=store.snapshot(); if (!state.categories.some(category=>category.name==='Trash'&&category.parentId===null)) state=store.createCategoryPath({parentId:null,names:['Trash'],expectedRevision:state.revision});
  const trash=state.categories.find(category=>category.name==='Trash').id;
  for (const item of items.filter(item=>item.sourceId!=='other')) move(store,item.id,trash);
  return {store,trash};
}
function confirmed(store,ids) {
  const preview=store.previewTrashArchive();
  return store.startTrashArchive({ids:ids??preview.items.map(item=>item.id),expectedRevision:preview.revision});
}
function service(store) {
  const names={preview:'previewTrashArchive',start:'startTrashArchive',state:'trashArchiveState',claim:'claimTrashArchive',record:'recordTrashArchive',finish:'finishTrashArchive',cancel:'cancelTrashArchive'};
  return async ({request:{op,args}}) => response({value:store[names[op]](args)});
}
function tools(store,archive) {return {mcp__chat_organizer__manage_trash_archive:service(store),mcp__codex_app__set_thread_archived:archive};}
const options=batch=>({batchId:batch.batchId,wait:async()=>{}});

test('confirmed archive acknowledgments hide only chosen sources, preserve original metadata, and cannot replay',async()=>{
  const {store}=fixture();
  try {
    store.setFocus({id:chat('a').id,focused:true,expectedRevision:store.snapshot().revision});
    const rows=store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all();
    const categories=store.categories(),before=store.snapshot(),batch=confirmed(store,[chat('a').id]);
    const calls=[];
    const api=tools(store,async args=>{calls.push(args);return response({archived:true,threadId:args.threadId});});
    const report=await run(api,options(batch));
    assert.equal(report.status,'completed');assert.equal(report.counts.archived,1);
    assert.deepEqual(calls,[{archived:true,source:'chatgpt',threadId:'a'}]);
    assert.deepEqual(store.snapshot().items.map(item=>item.sourceId).sort(),['b','other']);
    assert.deepEqual(store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all(),rows);
    assert.deepEqual(store.categories(),categories);assert.deepEqual(store.snapshot().undoDelete,before.undoDelete);
    await run(api,options(batch));assert.equal(calls.length,1);
    assert.equal(store.previewTrashArchive().items.length,1);
  } finally {store.close();}
});

test('preview includes nested assignments and project members but start requires explicit project approval',()=>{
  const p={id:'chatgpt:project:p',source:'chatgpt',sourceId:'p',title:'Project',kind:'project'};
  const {store,trash}=fixture([p,chat('a'),chat('other',{projectId:'p'})]);
  try {
    const state=store.createCategoryPath({parentId:trash,names:['Later'],expectedRevision:store.snapshot().revision});
    move(store,chat('a').id,state.categories.find(category=>category.name==='Later').id);
    const preview=store.previewTrashArchive();
    assert.deepEqual(preview.items.map(item=>item.id),[chat('a').id,chat('other').id]);
    assert.deepEqual(preview.projects.map(item=>item.id),[p.id]);
    assert.deepEqual(preview.items.find(item=>item.id===chat('other').id).projectTitles,['Project']);
    assert.throws(()=>store.startTrashArchive({ids:preview.items.map(item=>item.id),expectedRevision:preview.revision}),{code:'TRASH_CHANGED'});
  } finally {store.close();}
});

test('batch scope is immutable and moved targets are skipped immediately before claim',async()=>{
  const {store,trash}=fixture();
  try {
    const batch=confirmed(store);move(store,chat('a').id,'Travel');move(store,chat('other').id,trash);
    const calls=[];
    const result=await run(tools(store,async args=>{calls.push(args.threadId);return response({archived:true});}),options(batch));
    assert.deepEqual(calls,['b']);assert.equal(result.counts.skipped,1);assert.equal(result.counts.total,2);
    assert.equal(store.snapshot().items.find(item=>item.sourceId==='a').category,'Travel');
    assert.equal(store.snapshot().items.find(item=>item.sourceId==='other').category,trash);
  } finally {store.close();}
});

test('verified web Work aliases are archived once and both catalog representations hide',async()=>{
  const id='00000000-0000-4000-8000-000000000005',web=chat(id);
  const alias={id:'codex:chat:local-alias',source:'codex',sourceId:'local-alias',title:'Alias',kind:'chat',webConversationId:id,hostId:'durable'};
  const {store}=fixture([web,alias,chat('other')]);
  try {
    const preview=store.previewTrashArchive();assert.equal(preview.items.length,1);assert.equal(preview.items[0].aliasIds.length,2);
    let count=0;
    await run(tools(store,async args=>{count++;assert.deepEqual(args,{source:'chatgpt',threadId:id,archived:true});return response({archived:true,conversationId:id});}),options(confirmed(store)));
    assert.equal(count,1);assert.deepEqual(store.snapshot().items.map(item=>item.sourceId),['other']);
  } finally {store.close();}
});

test('alias assignment conflicts block archiving instead of expanding the selected scope',()=>{
  const id='00000000-0000-4000-8000-000000000005',web=chat(id);
  const alias={id:'codex:chat:alias',source:'codex',sourceId:'alias',title:'Alias',kind:'chat',webConversationId:id};
  const {store}=fixture([web,alias]);
  try {
    store.db.prepare('UPDATE catalog_items SET category=? WHERE id=?').run('Travel',alias.id);
    const preview=store.previewTrashArchive();assert.equal(preview.items.length,0);assert.match(preview.skipped[0].reason,/outside.*Trash/);
  } finally {store.close();}
});

test('failed source actions remain visible and other eligible targets can complete',async()=>{
  const {store}=fixture();
  try {
    const batch=confirmed(store);
    const result=await run(tools(store,async args=>args.threadId==='a'?error('This thread cannot be archived.'):response({archived:true})),options(batch));
    assert.equal(result.counts.failed,1);assert.equal(result.counts.archived,1);assert.equal(result.status,'needs_attention');
    assert.deepEqual(store.snapshot().items.map(item=>item.sourceId).sort(),['a','other']);
  } finally {store.close();}
});

for (const ack of [{}, {archived:false}, {archived:true,threadId:'different'}]) test('ambiguous or mismatched acknowledgment stays visible and stops the batch: '+JSON.stringify(ack),async()=>{
  const {store}=fixture();
  try {
    const before=store.snapshot();let count=0;
    const result=await run(tools(store,async()=>{count++;return response(ack);}),options(confirmed(store)));
    assert.equal(count,1);assert.equal(result.counts.unknown,1);assert.equal(result.counts.skipped,1);
    assert.deepEqual(store.snapshot(),before);assert.equal(store.previewTrashArchive().items.length,1);
    assert.match(store.previewTrashArchive().skipped[0].reason,/uncertain/);
  } finally {store.close();}
});

test('rate-limit failures stop with remaining targets honestly unattempted',async()=>{
  const {store}=fixture();
  try {
    let count=0;
    const result=await run(tools(store,async()=>{count++;return error('429 rate limit');}),options(confirmed(store)));
    assert.equal(count,1);assert.equal(result.counts.failed,1);assert.equal(result.counts.skipped,1);
    assert.equal(result.counts.pending,0);assert.equal(store.snapshot().items.length,3);
  } finally {store.close();}
});

test('in-flight source call blocks concurrent workflow and does not expose claim token in state',async()=>{
  const {store}=fixture();
  try {
    let resolveArchive,calledResolve,calls=0;
    const called=new Promise(resolve=>{calledResolve=resolve;});
    const batch=confirmed(store),api=tools(store,async()=>{if (++calls > 1) return error('Access denied');calledResolve();return new Promise(resolve=>{resolveArchive=resolve;});});
    const first=run(api,options(batch));await called;
    const second=await run(api,options(batch));assert.match(second.blocked,/already in progress/);
    assert.equal(second.counts.processing,1);assert.ok(second.items.every(item=>!Object.hasOwn(item,'claimToken')));
    assert.throws(()=>store.cancelTrashArchive({batchId:batch.batchId}),{code:'ARCHIVE_STARTED'});
    resolveArchive(response({archived:true}));
    await first;
  } finally {store.close();}
});

test('in-flight uncertainty survives store restart and prevents blind retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'organizer-trash-')),database=join(directory,'catalog.sqlite');
  let store;
  try {
    ({store}=fixture([chat('a')],database));const batch=confirmed(store);store.claimTrashArchive({batchId:batch.batchId});store.close();
    store=new CatalogStore(database);let called=false;
    const result=await run(tools(store,async()=>{called=true;return response({archived:true});}),options(batch));
    assert.equal(called,false);assert.match(result.blocked,/outcome is unknown/);assert.equal(store.snapshot().items.length,1);
  } finally {store?.close();await rm(directory,{recursive:true,force:true});}
});

test('preflight confirmation rejects stale scope, and cancel is only allowed before source work',()=>{
  const {store}=fixture();
  try {
    const preview=store.previewTrashArchive();move(store,chat('a').id,'Travel');
    assert.throws(()=>store.startTrashArchive({ids:preview.items.map(item=>item.id),expectedRevision:preview.revision}),{code:'STALE_REVISION'});
    const batch=confirmed(store),before=store.snapshot();
    assert.throws(()=>confirmed(store),{code:'ARCHIVE_BUSY'});
    const result=store.cancelTrashArchive({batchId:batch.batchId});assert.equal(result.canceled,true);assert.equal(result.counts.skipped,1);
    assert.deepEqual(store.snapshot(),before);assert.equal(store.claimTrashArchive({batchId:batch.batchId}).claimed,false);
  } finally {store.close();}
});

test('explicit recovery closes a stalled batch without repeating source work, and review requires fresh confirmation',()=>{
  const {store}=fixture();
  try {
    const batch=confirmed(store),claim=store.claimTrashArchive({batchId:batch.batchId}),before=store.snapshot();
    assert.throws(()=>store.abandonTrashArchive({batchId:batch.batchId}),{code:'REVIEW_REQUIRED'});
    const abandoned=store.abandonTrashArchive({batchId:batch.batchId,userConfirmed:true});
    assert.equal(abandoned.status,'needs_attention');assert.equal(abandoned.counts.unknown,1);assert.equal(abandoned.counts.skipped,1);
    assert.equal(store.previewTrashArchive().activeBatch,null);assert.equal(store.previewTrashArchive().items.length,1);
    assert.throws(()=>store.reviewTrashArchive({batchId:batch.batchId,id:claim.item.id}),{code:'REVIEW_REQUIRED'});
    store.reviewTrashArchive({batchId:batch.batchId,id:claim.item.id,confirmedActive:true});
    assert.equal(store.previewTrashArchive().items.length,2);assert.deepEqual(store.snapshot(),before);
    const next=confirmed(store);assert.notEqual(next.batchId,batch.batchId);assert.equal(next.counts.pending,2);
  } finally {store.close();}
});

test('an explicitly abandoned in-flight action can still save its late genuine acknowledgment',()=>{
  const {store}=fixture([chat('a')]);
  try {
    const batch=confirmed(store),claim=store.claimTrashArchive({batchId:batch.batchId});
    store.abandonTrashArchive({batchId:batch.batchId,userConfirmed:true});
    assert.throws(()=>store.recordTrashArchive({batchId:batch.batchId,id:claim.item.id,claimToken:'wrong',outcome:'archived'}),{code:'INVALID_CLAIM'});
    const result=store.recordTrashArchive({batchId:batch.batchId,id:claim.item.id,claimToken:claim.claimToken,outcome:'archived'});
    assert.equal(result.counts.archived,1);assert.equal(result.counts.unknown,0);assert.equal(store.snapshot().items.length,0);
    assert.equal(store.finishTrashArchive({batchId:batch.batchId}).status,'completed');
  } finally {store.close();}
});

test('local Codex source uses its saved host and no deletion tool is called',async()=>{
  const local={id:'codex:chat:local',source:'codex',sourceId:'local',title:'Local',kind:'chat',hostId:'local'};
  const {store}=fixture([local]);
  try {
    const api=tools(store,async args=>{assert.deepEqual(args,{source:'codex',hostId:'local',threadId:'local',archived:true});return response({archived:true});});
    api.mcp__codex_app__delete_thread=async()=>{throw new Error('Deletion must never be used');};
    const result=await run(api,options(confirmed(store)));assert.equal(result.counts.archived,1);
  } finally {store.close();}
});

test('MCP tool returns portable workflow and validates request shapes without touching source chats',async()=>{
  const {store}=fixture([chat('a')]);const server=createOrganizerServer(store),client=new Client({name:'trash-fixture',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);await client.connect(ct);
    const call=request=>client.callTool({name:'manage_trash_archive',arguments:{request}});
    const preview=(await call({op:'preview',args:{}})).structuredContent.value;
    assert.equal(preview.items.length,1);
    const wf=(await call({op:'workflow',args:{}})).structuredContent.value.source;
    assert.equal(wf,await readFile(new URL('../trash-archive-workflow.js',import.meta.url),'utf8'));
    const invalid=await call({op:'start',args:{ids:[chat('a').id],expectedRevision:preview.revision,delete:true}});
    assert.equal(invalid.isError,true);assert.equal(store.trashArchiveState(),null);
    const batch=(await call({op:'start',args:{ids:[chat('a').id],expectedRevision:preview.revision}})).structuredContent.value;
    const report=await run({mcp__chat_organizer__manage_trash_archive:args=>client.callTool({name:'manage_trash_archive',arguments:args}),mcp__codex_app__set_thread_archived:async()=>response({archived:true})},options(batch));
    assert.equal(report.counts.archived,1);
  } finally {await client.close();await server.close();store.close();}
});
