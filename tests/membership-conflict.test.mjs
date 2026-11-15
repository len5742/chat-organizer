import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CatalogStore } from '../store.mjs';
import { createOrganizerServer } from '../server.mjs';

const run=(0,eval)(await readFile(new URL('../maintenance-workflow.js',import.meta.url),'utf8'));
for(const scenario of ['assigned','unknown','explicitly-projectless']) {
  test(`project membership conflict: ${scenario} local evidence survives a contradictory sidebar and a repeated run`,async()=>{
    const store=new CatalogStore(':memory:');
    const item={id:'codex:chat:fixture',source:'codex',sourceId:'fixture',kind:'chat',title:'Saved chat',hostId:'local',projectId:'p'};
    const project={id:'codex:project:p',source:'codex',sourceId:'p',kind:'project',title:'Saved project',hostId:'local'};
    let saved=store.importInventory({items:[project,item],coverage:'Synthetic membership-conflict fixture'});
    saved=store.setCategory({id:item.id,category:'Travel',expectedRevision:saved.revision});
    saved=store.setFocus({id:item.id,focused:true,expectedRevision:saved.revision});
    const before=store.snapshot();
    const explicit=scenario==='explicitly-projectless';
    const server=createOrganizerServer(store,'stdio',{recentCollector:async()=>({
      observations:[{...item,evidence:'local_index',outcome:'found',observedAt:new Date(Date.now()-55).toISOString(),
        ...(scenario==='assigned'?{projectId:'p'}:explicit?{projectId:null}:{})}].map(row=>{
          if(scenario==='unknown')delete row.projectId;return row;
        }),errors:[],counts:{},coverage:{}
    })});
    const client=new Client({name:'membership-conflict',version:'1'});
    const [ct,st]=InMemoryTransport.createLinkedPair();
    const response=value=>({structuredContent:value,content:[]});
    const tools={
      exec_command:async()=>{throw new Error('No host filesystem writes');},
      mcp__chat_organizer__maintain_catalog:args=>client.callTool({name:'maintain_catalog',arguments:args}),
      mcp__codex_app__list_projects:async()=>response({projects:[{projectId:'p',projectKind:'local',label:'Saved project'}]}),
      mcp__codex_app__list_threads:async()=>response({threads:[{id:'fixture',kind:'codex',hostId:'local',title:item.title,status:'notLoaded',projectId:explicit?'p':null}],pinnedThreads:[]}),
      mcp__codex_app__list_archived_threads:async()=>response({threads:[],nextCursor:null})
    };
    try {
      await server.connect(st);await client.connect(ct);
      for(let i=0;i<2;i++) {
        const report=await run(tools,{mode:'recent',recentOnly:true});
        assert.equal(report.complete,true);
        assert.equal(report.moved,explicit&&i===0?1:0);
        const after=store.snapshot();const chat=after.items.find(row=>row.id===item.id);
        assert.equal(chat.projectId,explicit?null:'p');
        assert.equal(chat.category,'Travel');assert.equal(chat.focused,true);
        assert.deepEqual(after.categories,before.categories);assert.deepEqual(after.undoDelete,before.undoDelete);
      }
    }finally{await client.close();await server.close();store.close();}
  });
}
