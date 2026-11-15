import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStore } from '../store.mjs';

const webId = '00000000-0000-4000-8000-000000000005';
const web = {id:'chatgpt:chat:'+webId,source:'chatgpt',sourceId:webId,kind:'chat',title:'Compare sample notebook layouts'};
const alias = n => ({id:'codex:chat:alias-'+n,source:'codex',sourceId:'alias-'+n,kind:'chat',title:web.title,webConversationId:webId,hostId:'durable'});
const fixture = action => {const store=new CatalogStore(':memory:');try{action(store);}finally{store.close();}};
const snap = s => s.snapshot();
const rows = s => s.db.prepare('SELECT id, category, focused FROM catalog_items ORDER BY id').all().map(x=>({...x}));
const seed = (s,items) => s.importInventory({items,coverage:'Linked identity regression fixture'});
const category = (s,id,value) => s.setCategory({id,category:value,expectedRevision:snap(s).revision});
const focus = (s,id,value) => s.setFocus({id,focused:value,expectedRevision:snap(s).revision});

for(const target of [web.id,alias(1).id]) test('explicit edits through '+target+' update the verified group once',()=>fixture(s=>{
  const unrelated={...alias(9)};delete unrelated.webConversationId;
  seed(s,[web,alias(1),alias(2),unrelated]);
  let revision=snap(s).revision;
  category(s,target,'Travel');assert.equal(snap(s).revision,++revision);
  focus(s,target,true);assert.equal(snap(s).revision,++revision);
  for(const row of rows(s)) assert.deepEqual({category:row.category,focused:row.focused},row.id===unrelated.id?{category:'Uncategorized',focused:0}:{category:'Travel',focused:1});
  assert.deepEqual(new Set(snap(s).items.map(x=>x.id)),new Set([web.id,unrelated.id]));
  category(s,target,'Uncategorized');focus(s,target,false);
  assert.equal(snap(s).items.length,2);
  revision=snap(s).revision;category(s,target,'Uncategorized');focus(s,target,false);assert.equal(snap(s).revision,revision);
}));

test('same-value edits repair peers, reject stale revisions atomically, and preserve other fields',()=>fixture(s=>{
  seed(s,[web,alias(1)]);
  s.db.prepare('UPDATE catalog_items SET category=?,focused=1 WHERE id=?').run('Travel',alias(1).id);
  const revision=snap(s).revision,before=rows(s);
  assert.throws(()=>s.setCategory({id:web.id,category:'Uncategorized',expectedRevision:revision-1}),{code:'STALE_REVISION'});
  assert.deepEqual(rows(s),before);
  category(s,web.id,'Uncategorized');assert.equal(snap(s).revision,revision+1);
  assert.equal(rows(s).find(x=>x.id===alias(1).id).focused,1);
  focus(s,web.id,false);assert.equal(snap(s).revision,revision+2);assert.equal(snap(s).items.length,1);
}));

test('category branch deletion and undo retain every linked assignment and subsequent focus edits',()=>fixture(s=>{
  seed(s,[web,alias(1)]);
  let state=s.createCategoryPath({parentId:'Travel',names:['Subgroup'],expectedRevision:snap(s).revision});
  const subgroup=state.categories.find(x=>x.name==='Subgroup').id;
  category(s,web.id,subgroup);
  state=s.deleteCategory({id:subgroup,expectedRevision:snap(s).revision});
  assert.ok(rows(s).every(x=>x.category==='Uncategorized'));
  focus(s,alias(1).id,true);state=snap(s);assert.ok(state.undoDelete);
  s.undoDeleteCategory({token:state.undoDelete.token,expectedRevision:state.revision});
  assert.ok(rows(s).every(x=>x.category===subgroup&&x.focused===1));assert.equal(snap(s).items.length,1);
}));

test('a repair-only category edit clears deletion undo',()=>fixture(s=>{
  seed(s,[web,alias(1)]);
  s.db.prepare('UPDATE catalog_items SET category=? WHERE id=?').run('Travel',alias(1).id);
  s.deleteCategory({id:'Health',expectedRevision:snap(s).revision});assert.ok(snap(s).undoDelete);
  category(s,web.id,'Uncategorized');assert.equal(snap(s).undoDelete,null);
}));

for(const arrival of ['import','sync']) test('absent canonical and later aliases inherit established choices through '+arrival,()=>fixture(s=>{
  seed(s,[alias(1),alias(2)]);category(s,alias(1).id,'Travel');focus(s,alias(2).id,true);
  const add = item => arrival==='import'?seed(s,[item]):s.applySync({observations:[{...item,evidence:'probe',outcome:'found',observedAt:new Date().toISOString()}],expectedRevision:snap(s).revision,mode:'recent',coverage:'Late linked record'});
  add(web);add(alias(3));
  assert.ok(rows(s).every(x=>x.category==='Travel'&&x.focused===1));
  assert.deepEqual(snap(s).items.map(x=>x.id),[web.id]);
}));

test('hidden unavailable aliases share edits and retain availability after restoration',()=>fixture(s=>{
  seed(s,[web,alias(1)]);
  const apply=outcome=>s.applySync({observations:[{id:alias(1).id,evidence:'probe',outcome,observedAt:new Date(Date.now()+(outcome==='found'?1:0)).toISOString()}],expectedRevision:snap(s).revision,mode:'recent'});
  apply('not_found');category(s,web.id,'Travel');focus(s,web.id,true);
  assert.equal(s.db.prepare('SELECT availability FROM catalog_sync WHERE item_id=?').get(alias(1).id).availability,'not_found');
  apply('found');assert.equal(snap(s).items.length,1);assert.ok(rows(s).every(x=>x.category==='Travel'&&x.focused===1));
}));
