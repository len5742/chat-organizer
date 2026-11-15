import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve as resolvePath,sep} from 'node:path';
import {CatalogStore} from '../store.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-23T18:00:00Z');
const iso = time => new Date(time).toISOString();
const chat = (id='saved',extra={}) => ({id:'chatgpt:chat:'+id,source:'chatgpt',sourceId:id,
  kind:'chat',title:'Saved '+id,updatedAt:iso(NOW-HOUR),...extra});
const revision = store => store.snapshot().revision;
const history = (store,id) => ({...store.db.prepare('SELECT * FROM catalog_deletion_review WHERE item_id=?').get(id)});
const raw = store => store.db.prepare('SELECT * FROM catalog_items ORDER BY id').all();
const sync = (store,id,time,extra={}) => store.applySync({expectedRevision:revision(store),observations:[{
  id,observedAt:iso(time),evidence:'probe',outcome:'error',error:'Could not determine whether thread exists. Unavailable or failed hosts: durable',verificationFailure:'unresolved',...extra,
}]});
const queue = (store,id) => store.queueDeletionReview({id,expectedRevision:revision(store)});
const resolve = (store,id,action) => store.resolveDeletionReview({id,action,expectedRevision:revision(store)});
function fixture(fn,items=[chat()]) {
  const oldNow=Date.now; Date.now=()=>NOW; const store=new CatalogStore(':memory:');
  try {store.importInventory({items,coverage:'Isolated deletion-review regression'});return fn(store);}
  finally {store.close();Date.now=oldNow;}
}
function observed(store,id,time,extra={}) {
  const observation={id,observedAt:iso(time),evidence:'probe',outcome:'found',...extra};
  return store.applySync({expectedRevision:revision(store),observations:[observation]});
}

test('three spaced unresolved checks queue a chat while preserving raw organization and source availability',()=>fixture(store=>{
  const id=chat().id;
  store.setCategory({id,category:'Travel',expectedRevision:revision(store)});
  store.setFocus({id,focused:true,expectedRevision:revision(store)});
  const original=raw(store),start=revision(store);
  sync(store,id,NOW-18*HOUR);sync(store,id,NOW-12*HOUR);
  assert.equal(revision(store),start);assert.equal(store.snapshot().items[0].deletionReview,undefined);
  sync(store,id,NOW-6*HOUR);
  const item=store.snapshot().items[0];
  assert.deepEqual(item.deletionReview,{failureCount:3,firstFailedAt:iso(NOW-18*HOUR),lastFailedAt:iso(NOW-6*HOUR),queuedAt:iso(NOW-6*HOUR),reason:'repeated_failure'});
  assert.equal(item.category,'Travel');assert.equal(item.focused,true);assert.equal(item.availability,'available');
  assert.deepEqual(raw(store),original);assert.equal(revision(store),start+1);
  assert.equal(store.recentVerificationBatch().pending,0);
  assert.deepEqual(store.maintenanceState().deletionReviewItems,[{id,title:item.title,...item.deletionReview}]);
}));

test('duplicate, out-of-order and too-close probes cannot manufacture three checks',()=>fixture(store=>{
  const id=chat().id;
  sync(store,id,NOW-24*HOUR);sync(store,id,NOW-24*HOUR);sync(store,id,NOW-25*HOUR);
  assert.equal(history(store,id).failure_count,1);
  sync(store,id,NOW-23*HOUR);assert.equal(history(store,id).failure_count,1);
  sync(store,id,NOW-18*HOUR);assert.equal(history(store,id).failure_count,1,'six hours must follow the last real attempt');
  sync(store,id,NOW-12*HOUR);assert.equal(history(store,id).failure_count,2);
  sync(store,id,NOW-6*HOUR);assert.equal(history(store,id).failure_count,3);
}));

test('listings preserve a streak, actual successful lookup resets it, and stale success cannot reset newer failure',()=>fixture(store=>{
  const id=chat().id;
  sync(store,id,NOW-30*HOUR);sync(store,id,NOW-24*HOUR);
  observed(store,id,NOW-23*HOUR,{evidence:'sidebar',title:'A listing still knows the title'});
  observed(store,id,NOW-22*HOUR,{evidence:'chatgpt_cache',title:'Cached title'});
  assert.equal(history(store,id).failure_count,2);
  observed(store,id,NOW-25*HOUR);assert.equal(history(store,id).failure_count,2);
  observed(store,id,NOW-18*HOUR,{evidence:'local_lookup'});assert.equal(history(store,id).failure_count,0);
  sync(store,id,NOW-12*HOUR);assert.equal(history(store,id).failure_count,1);
  sync(store,id,NOW-6*HOUR);sync(store,id,NOW);
  assert.ok(store.snapshot().items[0].deletionReview);
  observed(store,id,NOW+1);assert.equal(store.snapshot().items[0].deletionReview,undefined);
  assert.equal(history(store,id).failure_count,0);
}));

test('rate limits, permission failures, network failures and unclassified errors never count as unresolved evidence',()=>fixture(store=>{
  const id=chat().id;
  const messages=['429 Too many requests','Permission denied','Network fetch failed','Connection timed out','503 Service unavailable'];
  messages.forEach((error,index)=>sync(store,id,NOW-(40-index*6)*HOUR,{error}));
  assert.equal(history(store,id).failure_count,0);
  observed(store,id,NOW-6*HOUR,{outcome:'error',error:'No rollout found'});
  assert.equal(history(store,id).failure_count,0);
  sync(store,id,NOW);assert.equal(history(store,id).failure_count,1);
}));

test('failed candidates survive the recent cutoff and sidebar listing until their actual lookup resolves',()=>fixture(store=>{
  const id=chat().id;
  sync(store,id,NOW-7*HOUR);
  store.db.prepare('UPDATE catalog_items SET updated_at=? WHERE id=?').run(iso(NOW-31*24*HOUR),id);
  assert.deepEqual(store.recentVerificationBatch({observedIds:[id]}).items.map(item=>item.id),[id]);
  observed(store,id,NOW-1);assert.equal(store.recentVerificationBatch({observedIds:[id]}).pending,0);
}));

test('restoring review resets its history and enforces a fresh six-hour interval',()=>fixture(store=>{
  const id=chat().id;store.setCategory({id,category:'Travel',expectedRevision:revision(store)});
  store.setFocus({id,focused:true,expectedRevision:revision(store)});
  const original=raw(store);queue(store,id);
  const review=store.snapshot().items[0].deletionReview;
  assert.equal(review.failureCount,0);assert.equal(review.reason,'owner_request');
  const start=revision(store);const restored=resolve(store,id,'restore');
  assert.equal(restored.revision,start+1);assert.equal(restored.items[0].deletionReview,undefined);
  assert.equal(history(store,id).failure_count,0);assert.equal(history(store,id).last_attempt_at,iso(NOW));
  assert.equal(store.recentVerificationBatch().pending,0);assert.deepEqual(raw(store),original);
  Date.now=()=>NOW+6*HOUR;assert.equal(store.recentVerificationBatch().pending,1);
}));

test('owner queuing unhides the selected chat without fabricating failures or changing archived/missing records',()=>fixture(store=>{
  const id=chat().id;store.setHidden({id,hidden:true,expectedRevision:revision(store)});
  assert.equal(store.snapshot().items.length,0);const original=raw(store);
  queue(store,id);assert.equal(store.snapshot().items[0].deletionReview.reason,'owner_request');
  assert.equal(history(store,id).failure_count,0);assert.deepEqual(raw(store),original);
  const before=store.snapshot();assert.deepEqual(queue(store,id),before,'queue is idempotent');
  assert.throws(()=>store.queueDeletionReview({id,expectedRevision:0}),{code:'STALE_REVISION'});
}));

test('confirming deletion hides all exact verified aliases and preserves source rows, unrelated same-title chat and hidden choices',()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId,{title:'Same title'});
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias',title:'Same title',webConversationId:webId});
  const other=chat('unrelated',{title:'Same title'});
  fixture(store=>{
    store.setCategory({id:canonical.id,category:'Travel',expectedRevision:revision(store)});
    store.setFocus({id:canonical.id,focused:true,expectedRevision:revision(store)});const original=raw(store);
    queue(store,canonical.id);assert.equal(history(store,alias.id).reason,'owner_request');
    resolve(store,canonical.id,'confirm_deleted');
    assert.deepEqual(store.snapshot().items.map(item=>item.id),[other.id]);assert.deepEqual(raw(store),original);
    assert.equal(store.db.prepare('SELECT count(*) n FROM catalog_hidden').get().n,2);
    observed(store,alias.id,NOW+1);assert.deepEqual(store.snapshot().items.map(item=>item.id),[other.id]);
  },[canonical,alias,other]);
});

test('a queued alias shares check evidence with its canonical entry and an actual successful alias lookup restores the group',()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId);
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias',webConversationId:webId});
  fixture(store=>{
    sync(store,alias.id,NOW-18*HOUR);sync(store,alias.id,NOW-12*HOUR);sync(store,alias.id,NOW-6*HOUR);
    const visible=store.snapshot().items;assert.equal(visible.length,1);assert.equal(visible[0].id,canonical.id);
    assert.equal(visible[0].deletionReview.failureCount,3);
    observed(store,alias.id,NOW);assert.equal(store.snapshot().items[0].deletionReview,undefined);
    assert.equal(history(store,canonical.id).failure_count,0);
  },[canonical,alias]);
});

test('confirmed not_found, archives, owner-hidden and queued items leave recent checks and new audit queues',()=>{
  const items=['missing','archived','hidden','queued','normal'].map(id=>chat(id));
  fixture(store=>{
    observed(store,items[0].id,NOW-8*HOUR,{outcome:'not_found'});
    observed(store,items[1].id,NOW-8*HOUR,{evidence:'archive_list',outcome:'archived'});
    store.setHidden({id:items[2].id,hidden:true,expectedRevision:revision(store)});queue(store,items[3].id);
    assert.deepEqual(store.recentVerificationBatch().items.map(item=>item.id),[items[4].id]);
    assert.equal(store.beginAudit({day:'2026-10-23'}).total,1);
    for(const id of items.slice(0,2).map(item=>item.id))assert.throws(()=>queue(store,id),{code:'INVALID_INPUT'});
    observed(store,items[3].id,NOW,{evidence:'archive_list',outcome:'archived'});
    assert.equal(history(store,items[3].id).queued_at,null);
  },items);
});

test('review mutations validate revisions, kind, actions and review existence; reserved root cannot be duplicated',()=>fixture(store=>{
  const id=chat().id;
  assert.throws(()=>resolve(store,id,'confirm_deleted'),{code:'INVALID_INPUT'});
  assert.throws(()=>store.resolveDeletionReview({id,action:'delete',expectedRevision:revision(store)}),{code:'INVALID_INPUT'});
  for(const name of ['Potentially deleted','POTENTIALLY DELETED']) {
    assert.throws(()=>store.createCategoryPath({parentId:null,names:[name],expectedRevision:revision(store)}),{code:'PROTECTED_CATEGORY'});
    assert.throws(()=>store.renameCategory({id:'Travel',name,expectedRevision:revision(store)}),{code:'PROTECTED_CATEGORY'});
  }
  const project={id:'chatgpt:project:p',source:'chatgpt',sourceId:'p',kind:'project',title:'Project'};
  store.importInventory({items:[project],coverage:'Isolated project'});
  assert.throws(()=>queue(store,project.id),{code:'INVALID_INPUT'});
  assert.throws(()=>store.applySync({expectedRevision:revision(store),observations:[{
    id,observedAt:iso(NOW),evidence:'sidebar',outcome:'error',error:'Unresolved',verificationFailure:'unresolved',
  }]}),{code:'INVALID_INPUT'});
}));

for(const method of ['import','sync'])for(const decision of ['queued','confirmed'])test(`${method} inherits ${decision} review state when a canonical record appears after its verified alias`,()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId);
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias',webConversationId:webId});
  fixture(store=>{
    queue(store,alias.id);if(decision==='confirmed')resolve(store,alias.id,'confirm_deleted');
    if(method==='import')store.importInventory({items:[canonical],coverage:'Late canonical discovery'});
    else observed(store,canonical.id,NOW-1,{...canonical,evidence:'sidebar'});
    const visible=store.snapshot().items;
    if(decision==='queued'){
      assert.equal(visible.length,1);assert.equal(visible[0].id,canonical.id);assert.equal(visible[0].deletionReview.reason,'owner_request');
      resolve(store,canonical.id,'restore');assert.equal(store.snapshot().items[0].deletionReview,undefined);
    }else{
      assert.equal(visible.length,0);assert.ok(history(store,canonical.id).confirmed_deleted_at);
      queue(store,canonical.id);assert.equal(store.snapshot().items.length,1);assert.ok(store.snapshot().items[0].deletionReview);
      assert.equal(history(store,alias.id).confirmed_deleted_at,null);
      resolve(store,canonical.id,'restore');assert.equal(store.snapshot().items.length,1);
    }
  },[alias]);
});

test('learning an exact mapping on an existing record applies its established review decision without merging organization conflicts',()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId);
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias'});
  fixture(store=>{
    store.setCategory({id:alias.id,category:'Travel',expectedRevision:revision(store)});queue(store,canonical.id);
    observed(store,alias.id,NOW-1,{evidence:'sidebar',webConversationId:webId});
    assert.equal(store.snapshot().items.length,2);assert.equal(store.snapshot().items.every(item=>Boolean(item.deletionReview)),true);
    assert.equal(store.snapshot().items.find(item=>item.id===alias.id).category,'Travel');
    resolve(store,canonical.id,'confirm_deleted');assert.equal(store.snapshot().items.length,0);
  },[canonical,alias]);
});

test('failure history, queued review and owner-confirmed removal survive database reopen and partial reimport',()=>{
  const oldNow=Date.now;Date.now=()=>NOW;
  const dir=mkdtempSync(join(tmpdir(),'organizer-deletion-review-')),path=join(dir,'catalog.sqlite');let store;
  try{
    store=new CatalogStore(path);const items=[chat('streak'),chat('queued'),chat('confirmed')];
    store.importInventory({items,coverage:'Persistent review fixture'});
    sync(store,items[0].id,NOW-12*HOUR);queue(store,items[1].id);queue(store,items[2].id);resolve(store,items[2].id,'confirm_deleted');
    const before=store.db.prepare('SELECT * FROM catalog_deletion_review ORDER BY item_id').all();store.close();store=new CatalogStore(path);
    assert.deepEqual(store.db.prepare('SELECT * FROM catalog_deletion_review ORDER BY item_id').all(),before);
    store.importInventory({items:[{...items[0],title:'Fresh title'}],coverage:'Partial metadata import'});
    assert.equal(history(store,items[0].id).failure_count,1);assert.ok(store.snapshot().items.find(item=>item.id===items[1].id).deletionReview);
    assert.equal(store.snapshot().items.some(item=>item.id===items[2].id),false);
  }finally{store?.close();Date.now=oldNow;const target=resolvePath(dir);assert.ok(target.startsWith(resolvePath(tmpdir())+sep));rmSync(target,{recursive:true,force:true});}
});

test('explicit unhide revokes confirmed deletion across verified aliases and late discovery cannot rehide the restored chat',()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId);
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias',webConversationId:webId});
  fixture(store=>{
    queue(store,alias.id);resolve(store,alias.id,'confirm_deleted');
    store.setHidden({id:alias.id,hidden:false,expectedRevision:revision(store)});
    assert.equal(history(store,alias.id).confirmed_deleted_at,null);
    store.importInventory({items:[canonical],coverage:'Late restored canonical'});
    assert.deepEqual(store.snapshot().items.map(item=>item.id),[canonical.id]);
    queue(store,canonical.id);resolve(store,canonical.id,'confirm_deleted');
    store.setHidden({id:alias.id,hidden:false,expectedRevision:revision(store)});
    assert.deepEqual(store.snapshot().items.map(item=>item.id),[canonical.id]);
    assert.equal(history(store,canonical.id).confirmed_deleted_at,null);
  },[alias]);
});

test('a delayed successful lookup cannot erase a newer owner review or newer verified-alias check',()=>{
  const webId='00000000-0000-4000-8000-000000000005';const canonical=chat(webId);
  const alias=chat('alias',{id:'codex:chat:alias',source:'codex',sourceId:'alias',webConversationId:webId});
  fixture(store=>{
    queue(store,canonical.id);observed(store,canonical.id,NOW-1);assert.ok(store.snapshot().items[0].deletionReview);
    resolve(store,canonical.id,'restore');
    Date.now=()=>NOW+7*HOUR;sync(store,alias.id,NOW+6*HOUR);
    observed(store,canonical.id,NOW+5*HOUR);assert.equal(history(store,alias.id).failure_count,1);
    assert.equal(history(store,canonical.id).last_attempt_at,iso(NOW));
  },[canonical,alias]);
});
