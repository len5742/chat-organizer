(async function runMaintenance(tools, options = {}) {
  // Evaluated by functions.exec with its supported tools object. No account
  // credentials or private web endpoints are used. All chat reads use app tools.
  const started = Date.now();
  const mode = options.mode ?? 'recent';
  if (!['recent','daily'].includes(mode)) throw new Error('Unsupported maintenance mode.');
  if(options.adapter && options.adapter!=='service')throw new Error('The public workflow supports only the organizer service adapter.');
  if(typeof tools.mcp__chat_organizer__maintain_catalog!=='function') {
    throw new Error('The organizer service is unavailable. Fully quit and reopen Codex to load the installed Chat Organizer plugin, then press Update now again.');
  }
  const requiredTools=['mcp__codex_app__list_projects','mcp__codex_app__list_threads','mcp__codex_app__list_archived_threads'];
  const unavailable=requiredTools.filter(name=>typeof tools[name]!=='function');
  if(unavailable.length)throw new Error('This assistant host cannot update the organizer because these native app tools are unavailable: '+unavailable.join(', '));
  const dryRun = options.dryRun === true;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve,ms)));
  const probeDelayMs = 2000;
  let leaseToken;
  const stats = {mode,dryRun,added:0,renamed:0,moved:0,statusChanged:0,checked:0,probeCalls:0,errors:[],exceptions:[],batches:0};
  const namedException = (item,reason,detail) => ({id:item.id,title:typeof item.title==='string'&&item.title.trim()?item.title.trim().slice(0,1000):null,reason,detail:String(detail).slice(0,500)});
  const unpack = r => {
    if (r?.isError) {
      const error=new Error((r.content??[]).filter(x=>x.type==='text').map(x=>x.text).join(' ').slice(0,500));
      error.code=r._meta?.error?.code??r.structuredContent?.error?.code;throw error;
    }
    if (r?.structuredContent) return r.structuredContent;
    for (const c of r?.content??[]) if(c.type==='text') {try{return JSON.parse(c.text);}catch{}}
    throw new Error('Unexpected app response.');
  };
  const conclusiveMissing = (message,item) => {
    if (/could not determine|unavailable|failed hosts|timed? ?out|permission|access denied|do not have access|don.t have access|unauthori[sz]ed|forbidden|rate.?limit|too many requests|\b429\b/i.test(message)) return false;
    if (item.hostId && item.hostId!=='local' && /no rollout/i.test(message)) return false;
    return /(?:conversation|thread|chat|rollout) (?:was )?not found|no (?:conversation|thread|rollout) (?:found|exists)|conversation_not_found|thread_not_found|conversation_deleted|thread_deleted/i.test(message);
  };
  const unresolvedLookup = message =>
    !/rate.?limit|too many requests|\b429\b|permission|access denied|do not have access|don.t have access|unauthori[sz]ed|forbidden|authenticat|network|timed? ?out|ECONN|ENOTFOUND|fetch failed/i.test(message)
    && /could not determine|unavailable or failed hosts|no matching conversation|no rollout/i.test(message);
  const sourceTitle = thread => {
    const name = typeof thread.name === 'string' ? thread.name.trim() : '';
    if (name && name !== thread.id && name.length <= 1000) return name;
    const title = typeof thread.title === 'string' ? thread.title.trim() : '';
    if (!title || title === thread.id || title.length > 1000) return;
    if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(title)) return;
    // The host may use the first message when its display name is absent.
    // Such previews cannot establish a source title.
    if (title === thread.preview?.trim() || /(?:…|\.\.\.)$/.test(title)) return;
    if (/^(?:<|\{|#|\[@[^\]]+\]\(plugin:\/\/|An MCP app initiated)/i.test(title)) return;
    return title;
  };
  const activityDate = value => {
    if(!Number.isFinite(value))return;
    // Native app metadata can mix Unix seconds and milliseconds in one list.
    const date=new Date(Math.abs(value)<1e11?value*1000:value);
    // Optional unusable dates must not reject the whole batch or replace a
    // saved date. The MCP datetime schema accepts four-digit years only.
    if(!Number.isFinite(date.getTime())||date.getUTCFullYear()<0||date.getUTCFullYear()>9999)return;
    return date.toISOString();
  };
  if(options.recentOnly===true && typeof tools.mcp__chat_organizer__get_connection_status==='function') {
    const status=unpack(await tools.mcp__chat_organizer__get_connection_status({}));
    const version=String(status.serverVersion??'').split('.').map(Number);
    if(!(version[0]>0||version[0]===0&&(version[1]>2||version[1]===2&&version[2]>=5))) throw new Error('Fully quit and reopen Codex to load Chat Organizer 0.2.5 before updating.');
  }
  const local = async (op,args={}) => {
    const serviceArgs=op==='collect'?{projects:args.projects.map(project=>{
      const selected={projectId:project.projectId,projectKind:project.projectKind};
      for(const key of ['hostId','path','rootPaths'])if(Object.hasOwn(project,key))selected[key]=project[key];
      if(Object.hasOwn(project,'rootPathAliases'))selected.rootPathAliases=project.rootPathAliases?.map(entry=>({alias:entry.alias}))??null;
      return selected;
    })}:args;
    const response=unpack(await tools.mcp__chat_organizer__maintain_catalog({request:{op,args:serviceArgs,...(leaseToken?{leaseToken}:{})}}));
    if(!response || !Object.hasOwn(response,'value'))throw new Error('Invalid organizer service response.');
    return response.value;
  };
  const addStats = summary => { for(const key of ['added','renamed','moved','statusChanged','checked'])stats[key]+=summary[key]??0; stats.batches++; };
  const finish = async result => {
    let state;
    if(leaseToken){
      state=await local('state');
      if(Number.isSafeInteger(state.visibleItems))result.visibleItems=state.visibleItems;
      const reviews=state.deletionReviewItems??[];
      result.sources={...result.sources,potentiallyDeleted:reviews.length};
      result.exceptions=[...(result.exceptions??[]),...reviews.map(item=>namedException(item,'potentially_deleted',
        item.reason==='owner_request'?'Moved to Potentially deleted at your request. Review it there; checks are paused.':item.failureCount+' failed checks. Moved to Potentially deleted for your review; checks are paused.'))];
    }
    const priority={potentially_deleted:0,verification_failed:1,verification_pending:2,not_found:3};
    const exceptions=[...new Map((result.exceptions??[]).map(item=>[item.reason+':'+item.id,item])).values()]
      .sort((a,b)=>(priority[a.reason]??3)-(priority[b.reason]??3));
    result.exceptions=exceptions.slice(0,1000);result.exceptionsOmitted=Math.max(0,exceptions.length-1000);
    if(leaseToken){
      const saved=await local('recordRun',{report:result});
      if(Array.isArray(saved?.exceptions))result.exceptions=saved.exceptions;
    }
    return result;
  };
  const apply = async (observations,auditId) => {
    if(dryRun)return;
    // Bound encoded command size even when titles approach the input limit.
    if(JSON.stringify(observations).length>12000&&observations.length>1) {
      const half=Math.ceil(observations.length/2);
      await apply(observations.slice(0,half),auditId);return apply(observations.slice(half),auditId);
    }
    await local('renew',{token:leaseToken});
    for(let retry=0;retry<3;retry++) {
      const state=await local('state');
      try {
        const result=await local(auditId?'auditApply':'apply',{observations,expectedRevision:state.revision,...(auditId?{auditId}:{mode,coverage:'Current app listings and local metadata; absence from partial lists is retained.'})});
        addStats(result.sync??result);return result;
      }catch(error){if(error.code!=='STALE_REVISION'||retry===2)throw error;}
    }
  };
  const listArchives = async args => {
    const rows=[];let cursor;
    const seen=new Set();
    do {
      const page=unpack(await tools.mcp__codex_app__list_archived_threads({...args,limit:50,...(cursor?{cursor}:{})}));
      if(!Array.isArray(page.threads))throw new Error('Incomplete archive listing.');
      rows.push(...page.threads);cursor=page.nextCursor;
      if(cursor && seen.has(cursor))throw new Error('Archive pagination repeated a cursor.');
      seen.add(cursor);
    }while(cursor);
    return rows;
  };
  if(!dryRun) {
    const lease=await local('acquire');
    if(!lease.acquired)return {...stats,complete:true,skipped:'Another maintenance run is active.',elapsedSeconds:(Date.now()-started)/1000};
    leaseToken=lease.token;
  }
  try {
  const fetched=await Promise.allSettled([
    tools.mcp__codex_app__list_projects({}).then(unpack),
    tools.mcp__codex_app__list_threads({limit:50}).then(unpack),
    listArchives({source:'chatgpt'}),listArchives({source:'codex',hostId:'local'})
  ]);
  const labels=['projects','recent_sidebar','chatgpt_archives','local_archives'];
  fetched.forEach((r,i)=>{if(r.status==='rejected')stats.errors.push({source:labels[i],message:String(r.reason).slice(0,250)});});
  if(fetched[0].status!=='fulfilled'||fetched[1].status!=='fulfilled')return await finish({...stats,complete:false,elapsedSeconds:(Date.now()-started)/1000});
  const projects=fetched[0].value.projects,sidebar=fetched[1].value;
  if(!Array.isArray(projects)||!Array.isArray(sidebar.threads))throw new Error('Invalid current inventory.');
  const collected=await local('collect',{projects});
  stats.errors.push(...collected.errors);
  stats.exceptions.push(...(collected.exceptions??[]));
  const now=new Date().toISOString();
  const observations=[...collected.observations];
  // The sidebar can return null for a local chat which still has an explicit
  // project assignment. Only the local collector's explicit projectless state
  // establishes removal; a null sidebar field does not establish that fact.
  const explicitlyProjectless=new Set(collected.observations.filter(obs=>obs.source==='codex' && obs.evidence==='local_index' && Object.hasOwn(obs,'projectId') && obs.projectId===null).map(obs=>obs.id));
  // A blank sidebar field is also resolved when current local metadata already
  // established a project for this same local chat. This affects reporting only.
  const locallyAssigned=new Set(collected.observations.filter(obs=>obs.source==='codex' && obs.evidence==='local_index'
    && obs.hostId==='local' && ['found','archived'].includes(obs.outcome)
    && typeof obs.projectId==='string' && obs.projectId.trim()).map(obs=>obs.id));
  let unverifiedSidebarMemberships=0;
  let unnamedRemoteSkipped=0;
  for(const p of projects) {
    const source=p.projectKind==='chatgpt'?'chatgpt':'codex';
    const observation={id:source+':project:'+p.projectId,source,kind:'project',sourceId:p.projectId,title:p.label,hostId:p.hostId??null,observedAt:now,evidence:'project_list',outcome:'found'};
    if(p.projectKind==='local'&&(!p.hostId||p.hostId==='local')) {
      const aliases=(Array.isArray(collected.projectAliases)?collected.projectAliases:[]).filter(alias=>alias.sourceId===p.projectId&&alias.hostId==='local'
        &&typeof alias.chatgptProjectId==='string'&&/^g-p-[0-9a-f]{32}$/i.test(alias.chatgptProjectId)
        &&projects.filter(target=>target.projectKind==='chatgpt'&&target.projectId===alias.chatgptProjectId).length===1);
      if(aliases.length===1)observation.chatgptProjectId=aliases[0].chatgptProjectId;
    }
    observations.push(observation);
  }
  for(const t of [...(sidebar.pinnedThreads??[]),...sidebar.threads]) {
    if(!['chatgpt','codex'].includes(t.kind)||typeof t.title!=='string'||!t.title.trim())continue;
    const title = sourceTitle(t);
    if (!title && t.kind === 'codex' && t.hostId && t.hostId !== 'local') {
      unnamedRemoteSkipped++;
      continue;
    }
    const observation={id:t.kind+':chat:'+t.id,source:t.kind,sourceId:t.id,kind:'chat',...(title?{title}:{}),hostId:t.hostId??null,observedAt:now,evidence:'sidebar',outcome:'found',url:t.kind==='chatgpt'?'https://chatgpt.com/c/'+t.id:'codex://threads/'+t.id};
    if (!title && !collected.observations.some(row => row.id === observation.id)) continue;
    if(typeof t.projectId==='string' && t.projectId.trim()) {
      if(t.kind!=='codex' || !explicitlyProjectless.has(observation.id))observation.projectId=t.projectId;
    }else if(t.projectId===null) {
      if(t.kind==='chatgpt')observation.projectId=null;
      else if(!explicitlyProjectless.has(observation.id) && !(t.hostId==='local' && locallyAssigned.has(observation.id))){
        unverifiedSidebarMemberships++;
        stats.exceptions.push(namedException(observation,'project_membership_unverified','The sidebar did not establish current project membership; the saved assignment was retained.'));
      }
    }
    const updatedAt=activityDate(t.updatedAt);if(updatedAt!==undefined)observation.updatedAt=updatedAt;
    observations.push(observation);
  }
  const archiveIds=new Set();
  for(let i=2;i<4;i++)if(fetched[i].status==='fulfilled')for(const t of fetched[i].value) {
    const id=(i===2?'chatgpt':'codex')+':chat:'+t.id;archiveIds.add(id);
    observations.push({id,observedAt:now,evidence:'archive_list',outcome:'archived'});
  }
  // Source order is intentional: old cache observations, then fresh sidebar,
  // then explicit archive state. Field-level timestamps prevent regressions.
  for(let i=0;i<observations.length;i+=25)await apply(observations.slice(i,i+25));
  stats.sources={...collected.counts,sidebarMembershipUnverified:unverifiedSidebarMemberships,unnamedRemoteSkipped};stats.projectCount=projects.length;stats.observations=observations.length;
  if(options.recentOnly===true && mode==='recent' && (options.verifyRecent??true) && !dryRun) {
    const batch=await local('verificationBatch',{observedIds:observations.filter(x=>x.outcome==='found'||x.outcome==='archived').map(x=>x.id),limit:8});
    stats.sources.recentVerificationCandidates=batch.pending;
    let verified=0;
    const attempted=new Set();
    if(batch.retryAfter) stats.deferred='Recent verification cooldown until '+batch.retryAfter;
    else for(const item of batch.items) {
      if(stats.probeCalls>=Math.min(options.maxProbeCalls??80,8)) break;
      await local('renew',{token:leaseToken});
      const base={id:item.id,observedAt:new Date().toISOString(),evidence:'probe'};
      let observation;
      try {
        stats.probeCalls++;
        const result=unpack(await tools.mcp__codex_app__read_thread({threadId:item.sourceId,...(item.source==='codex'&&item.hostId?{hostId:item.hostId}:{}),turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:600}));
        if(result.thread?.id!==item.sourceId) throw new Error('Lookup returned no matching conversation');
        observation={...base,outcome:'found'};
        const title = sourceTitle(result.thread);
        if (title) observation.title = title;
        const updatedAt=activityDate(result.thread.updatedAt);if(updatedAt!==undefined)observation.updatedAt=updatedAt;
      } catch(error) {
        const message=String(error.message??error).slice(0,500);
        const missing=conclusiveMissing(message,item);
        observation={...base,outcome:missing?'not_found':'error',...(missing?{}:{error:message,...(unresolvedLookup(message)?{verificationFailure:'unresolved'}:{})})};
      } finally {await wait(probeDelayMs);}
      await apply([observation]);verified++;attempted.add(item.id);
      if(observation.outcome==='not_found')stats.exceptions.push(namedException(item,'not_found','The source explicitly reported this chat missing; its saved record is retained and hidden.'));
      if(observation.outcome==='error') {
        const detail=(item.availability==='not_found'?'Already marked Not found and hidden. ':'')+observation.error;
        stats.exceptions.push(namedException(item,'verification_failed',detail));
        stats.errors.push({source:'recent_verification',message:((item.title||item.id).slice(0,120)+': '+observation.error).slice(0,500)});
        if(/rate.?limit|too many requests|\b429\b/i.test(observation.error)) {
          const deferred=await local('deferVerification');stats.deferred='Recent verification cooldown until '+deferred.retryAfter;
        }
        break;
      }
    }
    stats.sources.recentVerificationChecked=verified;
    stats.sources.recentVerificationPending=Math.max(0,batch.pending-verified);
    for(const item of batch.pendingItems??batch.items)if(!attempted.has(item.id))stats.exceptions.push(namedException(item,'verification_pending',
      (item.availability==='not_found'?'Already marked Not found and hidden. ':'')+(batch.retryAfter?'Waiting for the source cooldown to end.':stats.errors.some(error=>error.source==='recent_verification')?'Not checked because an earlier lookup failed.':'Waiting for a later update within the limit of eight checks per run.')));
  }
  if(dryRun)return {...stats,complete:stats.errors.length===0,elapsedSeconds:(Date.now()-started)/1000};
  let state=await local('state');
  // Manual recent updates finish independently of the weekly saved-ID audit.
  if(options.recentOnly === true && mode === 'recent') {
    return await finish({...stats,complete:stats.errors.length===0,elapsedSeconds:(Date.now()-started)/1000});
  }
  if(mode==='daily'||state.audit&&!state.audit.completedAt) {
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const audit=await local('begin',{day});
    if(!audit.completedAt && Date.now()-Date.parse(audit.startedAt)>8*24*60*60*1000) {
      stats.errors.push({source:'audit',message:'The full audit has remained unfinished for over eight days; review source availability and the saved maintenance report.'});
    }
    if(audit.retryAfter && Date.parse(audit.retryAfter)>Date.now()) {
      stats.audit=audit;stats.deferred='Source cooldown until '+audit.retryAfter;
      return await finish({...stats,complete:stats.errors.length===0,elapsedSeconds:(Date.now()-started)/1000});
    }
    const confirmed=new Map(observations.filter(x=>x.outcome==='found'||x.outcome==='archived').map(x=>[x.id,x]));
    const projectIds=new Set(projects.map(p=>(p.projectKind==='chatgpt'?'chatgpt':'codex')+':project:'+p.projectId));
    const unavailableHosts=new Set((sidebar.unavailableHosts??[]).map(x=>typeof x==='string'?x:x.hostId??x.id)),unavailableSources=new Set((sidebar.unavailableSources??[]).map(x=>typeof x==='string'?x:x.source??x.kind));
    let consecutiveErrors=0;
    while(!audit.completedAt) {
      if(Date.now()-started>(options.maxRunMs??10*60*1000) || stats.probeCalls>=(options.maxProbeCalls??80)) {
        stats.paused=true;stats.deferred='Audit checkpoint saved for the next requested audit.';break;
      }
      const batch=await local('batch',{auditId:audit.id,limit:40});
      if(!batch.items.length)break;
      const outcomes=[];
      let rateLimited=false;
      for(let i=0;i<batch.items.length;i++) {
        if(stats.probeCalls>=(options.maxProbeCalls??80))break;
        const group=[await (async item=>{
          const base={id:item.id,observedAt:new Date().toISOString(),evidence:'probe'};
          if(archiveIds.has(item.id))return {...base,evidence:'archive_list',outcome:'archived'};
          if(item.kind==='project') {
            if(projectIds.has(item.id))return {...confirmed.get(item.id),observedAt:base.observedAt};
            if(unavailableSources.has(item.source)||unavailableHosts.has(item.hostId)||item.hostId&&item.hostId!=='local')return {...base,outcome:'error',error:'Project source unavailable or incomplete'};
            return {...base,evidence:'project_list_complete',outcome:'not_found'};
          }
          // Local index observations are direct current records. ChatGPT cached
          // records still get an individual read during the complete audit.
          const direct=confirmed.get(item.id);
          if(direct && item.source==='codex' && (!item.hostId||item.hostId==='local'))return {...direct,observedAt:base.observedAt};
          if(stats.probeCalls>=(options.maxProbeCalls??80))return null;
          // A paced batch may outlast the lease; renew before every source read.
          await local('renew',{token:leaseToken});
          try {
            stats.probeCalls++;
            const result=unpack(await tools.mcp__codex_app__read_thread({threadId:item.sourceId,...(item.source==='codex'&&item.hostId?{hostId:item.hostId}:{}),turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1}));
            if(result.thread?.id!==item.sourceId)throw new Error('Lookup returned no matching conversation');
            const found={...base,outcome:'found'};
            const title = sourceTitle(result.thread);
            if (title) found.title = title;
            const updatedAt=activityDate(result.thread.updatedAt);if(updatedAt!==undefined)found.updatedAt=updatedAt;
            return found;
          }catch(error){
            const message=String(error.message??error).slice(0,500);
            const missing=conclusiveMissing(message,item);
            return {...base,outcome:missing?'not_found':'error',...(missing?{}:{error:message,...(unresolvedLookup(message)?{verificationFailure:'unresolved'}:{})})};
          }finally{
            // Keep source requests serial and pause after each response,
            // including errors. Local records need no network pacing.
            await wait(probeDelayMs);
          }
        })(batch.items[i])].filter(Boolean);
        outcomes.push(...group);
        for(const outcome of group)consecutiveErrors=outcome.outcome==='error'?consecutiveErrors+1:0;
        rateLimited=group.some(outcome=>outcome.outcome==='error'&&/rate.?limit|too many requests|\b429\b/i.test(outcome.error));
        if(rateLimited||consecutiveErrors>=8)break;
      }
      // Keep individual requests comfortably below the Windows command limit.
      for(let i=0;i<outcomes.length;i+=20)await apply(outcomes.slice(i,i+20),audit.id);
      for(const outcome of outcomes)if(outcome.outcome==='error'||outcome.outcome==='not_found'){
        const item=batch.items.find(item=>item.id===outcome.id)??outcome;
        stats.exceptions.push(namedException(item,outcome.outcome==='error'?'verification_failed':'not_found',outcome.error??'The source explicitly reported this item missing.'));
      }
      if(typeof options.onProgress==='function')options.onProgress({processed:batch.audit.processed+outcomes.length,total:batch.audit.total,probeCalls:stats.probeCalls});
      if(rateLimited) {
        const retryAfter=new Date(Date.now()+60*60*1000).toISOString();
        await local('defer',{auditId:audit.id,retryAfter,reason:'ChatGPT rate limit',retryIds:outcomes.filter(x=>x.outcome==='error'&&/rate.?limit|too many requests|\b429\b/i.test(x.error)).map(x=>x.id)});
        stats.paused=true;stats.deferred='Source cooldown until '+retryAfter;break;
      }
      if(consecutiveErrors>=8){stats.paused=true;stats.errors.push({source:'audit',message:'Repeated lookup failures; audit checkpoint saved.'});break;}
    }
    stats.audit=(await local('state')).audit;
    if(stats.audit.errors)stats.errors.push({source:'audit',message:stats.audit.errors+' lookups could not be verified.'});
  }
  return await finish({...stats,complete:stats.errors.length===0&&(!stats.paused||Boolean(stats.deferred)),elapsedSeconds:(Date.now()-started)/1000});
  } catch(error) {
    try {await finish({...stats,complete:false,errors:[...stats.errors,{source:'workflow',message:String(error.message??error).slice(0,500)}],elapsedSeconds:(Date.now()-started)/1000});}catch{}
    throw error;
  } finally {
    if(leaseToken)await local('release',{token:leaseToken});
  }
})
