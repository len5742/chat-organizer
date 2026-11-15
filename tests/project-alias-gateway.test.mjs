import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {CatalogStore} from '../store.mjs';
import {createOrganizerServer} from '../server.mjs';
const require=createRequire(new URL('../server.mjs', import.meta.url));
const{Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const{InMemoryTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/inMemory.js')));
test('real MCP maintenance gateway preserves the complete service-owned projectAliases result',async()=>{
 const store=new CatalogStore(':memory:');const aliases=[{sourceId:'00000000-0000-4000-8000-000000000004',hostId:'local',chatgptProjectId:'g-p-00000000000000000000000000000006'}];
 const result={observations:[],projectAliases:aliases,coverage:{localProjectAliases:'explicit'},errors:[],counts:{localProjectAliases:1}};
 let collected;const server=createOrganizerServer(store,'stdio',{recentCollector:async args=>{collected=args;return result;}});
 const client=new Client({name:'project-alias-gateway-fixture',version:'1.0.0'});const[ct,st]=InMemoryTransport.createLinkedPair();
 try{await server.connect(st);await client.connect(ct);const projects=[{projectId:aliases[0].sourceId,projectKind:'local',hostId:'local'}];const response=await client.callTool({name:'maintain_catalog',arguments:{request:{op:'collect',args:{projects}}}});assert.ok(!response.isError);assert.deepEqual(response.structuredContent.value,result);assert.deepEqual(collected,{projects});assert.equal(store.snapshot().items.length,0);}finally{await client.close();await server.close();store.close();}
});
