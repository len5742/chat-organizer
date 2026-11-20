import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const run=(0,eval)(await readFile(new URL('../maintenance-workflow.js',import.meta.url),'utf8'));
const localId='00000000-0000-4000-8000-000000000004',webId='g-p-00000000000000000000000000000006';
const projects=[{projectId:localId,projectKind:'local',hostId:'local',label:'Local backing',path:'D:\\fixture',unrelated:'not forwarded'}, {projectId:webId,projectKind:'chatgpt',label:'Canonical web'}];
const alias={sourceId:localId,hostId:'local',chatgptProjectId:webId};
const response=value=>({content:[],structuredContent:value});
async function execute({projectAliases=[alias],currentProjects=projects,omitAliases=false}={}){
 const operations=[],observations=[];let revision=4;
 const tools={
  exec_command:async()=>{throw Error('Caller shell not allowed');},
  mcp__chat_organizer__get_connection_status:async()=>response({serverVersion:'0.2.5'}),
  mcp__chat_organizer__maintain_catalog:async({request})=>{const{op,args}=request;operations.push(request);let value;
   if(op==='acquire')value={acquired:true,token:'fixture-lease'};
   else if(op==='renew')value={renewed:true};
   else if(op==='release')value={released:true};
   else if(op==='state')value={revision,audit:null,counts:{}};
   else if(op==='recordRun')value={recorded:true};
   else if(op==='collect'){assert.ok(args.projects.every(p=>p.label===undefined&&p.unrelated===undefined));value={observations:[{id:'codex:chat:native',source:'codex',sourceId:'native',kind:'chat',title:'Native assignment',hostId:'local',projectId:localId,observedAt:new Date().toISOString(),evidence:'local_index',outcome:'found'}],errors:[],coverage:{scope:'fixture'},counts:{localProjectAliases:projectAliases.length},...(omitAliases?{}:{projectAliases})};}
   else if(op==='apply'){assert.equal(request.leaseToken,'fixture-lease');assert.equal(args.expectedRevision,revision);observations.push(...args.observations);value={revision:++revision,added:0,renamed:0,moved:0,statusChanged:0,checked:args.observations.length};}
   else throw Error('Unexpected operation '+op);
   return response({value});
  },
  mcp__codex_app__list_projects:async()=>response({projects:currentProjects}),
  mcp__codex_app__list_threads:async()=>response({threads:[],pinnedThreads:[]}),
  mcp__codex_app__list_archived_threads:async()=>response({threads:[],nextCursor:null}),
  mcp__codex_app__read_thread:async()=>{throw Error('No source chat reads authorized by fixture');}
 };
 const report=await run(tools,{mode:'recent',recentOnly:true,verifyRecent:false});
 assert.equal(report.complete,true);assert.equal(operations[0].op,'acquire');assert.equal(operations.at(-1).op,'release');
 assert.ok(!operations.some(o=>['begin','batch','auditApply'].includes(o.op)));
 return {operations,observations};
}
test('service gateway collector metadata attaches only to the native backing project observation',async()=>{const{observations}=await execute();const local=observations.find(o=>o.id==='codex:project:'+localId),canonical=observations.find(o=>o.id==='chatgpt:project:'+webId),chat=observations.find(o=>o.kind==='chat');assert.equal(local.chatgptProjectId,webId);assert.equal(local.evidence,'project_list');assert.equal(local.title,'Local backing');assert.equal(Object.hasOwn(canonical,'chatgptProjectId'),false);assert.equal(Object.hasOwn(chat,'chatgptProjectId'),false);assert.equal(chat.projectId,localId);});
test('older collector shape and absent aliases never emit an unlink or inferred mapping',async()=>{for(const config of [{omitAliases:true},{projectAliases:[]}]){const{observations}=await execute(config);assert.ok(observations.every(o=>!Object.hasOwn(o,'chatgptProjectId')));}});
test('workflow rejects ambiguous, wrong-host, wrong-source and inaccessible target alias payloads',async()=>{for(const config of [{projectAliases:[alias,alias]}, {projectAliases:[{...alias,hostId:'durable'}]}, {projectAliases:[{...alias,sourceId:'unrelated'}]}, {projectAliases:[{...alias,chatgptProjectId:'not-a-project'}]}, {currentProjects:projects.slice(0,1)}, {currentProjects:projects.map(p=>p.projectKind==='local'?{...p,hostId:'durable'}:p)}, {currentProjects:projects.map(p=>p.projectKind==='local'?{...p,projectKind:'remote'}:p)}]){const{observations}=await execute(config);assert.ok(observations.every(o=>!Object.hasOwn(o,'chatgptProjectId')));}});

test('project alias workflow requires service 0.2.5 before lease or source collection',async()=>{
  let calls=0;
  const unavailable=async()=>{calls++;throw Error('Must not read source metadata');};
  const tools={
    mcp__chat_organizer__maintain_catalog:async()=>{calls++;throw Error('Must not acquire a lease');},
    mcp__chat_organizer__get_connection_status:async()=>response({serverVersion:'0.1.22'}),
    mcp__codex_app__list_projects:unavailable,
    mcp__codex_app__list_threads:unavailable,
    mcp__codex_app__list_archived_threads:unavailable,
  };
  await assert.rejects(run(tools,{mode:'recent',recentOnly:true}),/Fully quit and reopen Codex.*0\.2\.5/);
  assert.equal(calls,0);
});
