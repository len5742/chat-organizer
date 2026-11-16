(async function archiveConfirmedTrash(tools, options = {}) {
  const started = Date.now();
  if (typeof options.batchId !== 'string' || !options.batchId) throw new Error('A confirmed Trash archive batch ID is required.');
  const service = tools.mcp__chat_organizer__manage_trash_archive;
  const archive = tools.mcp__codex_app__set_thread_archived;
  if (typeof service !== 'function') throw new Error('The organizer archive service is unavailable. Reload the installed plugin.');
  const body = response => {
    if (response?.isError) {
      const error = new Error((response.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0,500) || 'The tool reported an error.');
      error.explicitToolError = true; throw error;
    }
    if (response?.structuredContent) return response.structuredContent;
    for (const part of response?.content ?? []) if (part.type === 'text') {try {return JSON.parse(part.text);} catch {}}
    return null;
  };
  const call = async (op,args={}) => {
    const result = body(await service({request:{op,args}}));
    if (!result || !Object.hasOwn(result,'value')) throw new Error('The archive service returned an invalid response.');
    return result.value;
  };
  const report = (state,extra={}) => ({...state,...extra,elapsedSeconds:Math.round((Date.now()-started)/100)/10});
  let state = await call('state',{batchId:options.batchId});
  if (!state) throw new Error('The confirmed Trash archive batch could not be found.');
  if (!['pending','running'].includes(state.status)) return report(state,{complete:state.status === 'completed'});
  if (!state.items.some(item=>['pending','processing'].includes(item.outcome))) {
    // A confirmed empty project needs only organizer cleanup, no source tool.
    state=await call('finish',{batchId:options.batchId});
    return report(state,{complete:state.status==='completed'});
  }
  if (typeof archive !== 'function') {
    state = await call('finish',{batchId:options.batchId,reason:'The hosting assistant has no native archive tool. No source chats were changed.'});
    return report(state,{complete:false});
  }
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve,ms)));
  while (Date.now()-started < 10*60*1000) {
    const claim = await call('claim',{batchId:options.batchId});
    if (!claim.claimed) {
      if(claim.reason==='stopping') return report(claim.state,{complete:false,blocked:'Stop requested. Waiting for the current archive request to finish; no further chats will be started.'});
      if (claim.reason === 'in_flight') return report(claim.state,{complete:false,blocked:'An archive request is already in progress or its outcome is unknown. Check its result before retrying.'});
      state = await call('finish',{batchId:options.batchId});
      return report(state,{complete:state.status === 'completed'});
    }
    const item = claim.item;
    let outcome='unknown',detail='',stop=false;
    try {
      const args = {archived:true,source:item.source,threadId:item.sourceId};
      if (item.source === 'codex' && item.hostId) args.hostId=item.hostId;
      // Claim just rechecked this frozen target's current Trash assignment.
      // The only external mutation this workflow permits is archive:true.
      const response = body(await archive(args));
      const values = [response,response?.value,response?.thread,response?.conversation,response?.result].filter(value => value && typeof value === 'object');
      const ack = values.find(value => value.archived === true);
      const returnedIds = values.flatMap(value => ['id','threadId','conversationId'].filter(key => typeof value[key] === 'string').map(key => value[key]));
      if (ack && returnedIds.every(id => id === item.sourceId)) {
        outcome='archived';detail='The native archive tool explicitly confirmed archived:true for this request.';
      } else {
        detail='The archive tool did not return an unambiguous archived:true acknowledgment for this chat. Review its source archive status before retrying.';stop=true;
      }
    } catch (error) {
      detail=String(error?.message ?? error).slice(0,500);
      const uncertain=/timed?\s*out|timeout|network|fetch|ECONN|ENOTFOUND|connection|transport/i.test(detail);
      outcome=error?.explicitToolError && !uncertain ? 'failed' : 'unknown';
      stop=outcome === 'unknown' || /rate.?limit|too many requests|\b429\b|cooldown|permission|access denied|unauthori[sz]ed|forbidden|authentication|sign.?in|log.?in|service unavailable|\b50[0234]\b/i.test(detail);
    }
    // A failure to save this receipt deliberately leaves the claim processing.
    // A later invocation cannot repeat an action with an unknown result.
    state = await call('record',{batchId:options.batchId,id:item.id,claimToken:claim.claimToken,outcome,detail});
    if(state.stopRequestedAt) {
      state=await call('finish',{batchId:options.batchId});
      return report(state,{complete:false});
    }
    if (stop) {
      state = await call('finish',{batchId:options.batchId,reason:'Stopped after an archive request needed attention. Remaining chats were not attempted.'});
      return report(state,{complete:false});
    }
    await wait(250);
  }
  state = await call('finish',{batchId:options.batchId,reason:'The archive run reached its ten-minute limit. Remaining chats were not attempted.'});
  return report(state,{complete:false});
})
