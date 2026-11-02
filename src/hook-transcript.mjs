// Claude-compatible view of the FULL native journal. It never rewrites Session history.
const input=value=>{if(typeof value!=='string')return value??{};try{return JSON.parse(value);}catch{return{raw:value};}};
const xml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export async function transcript(ctx,agent,signal,{toolName=name=>name}={}) {
  signal?.throwIfAborted();
  const events=agent.session.snapshotEvents(),rows=[],calls=new Map(),effective=new Map(),successful=new Set(),emitted=new Set();
  let parentUuid=null,lastAssistant='',turn=0;
  const markers=new Set(),commands=new Map();
  for(const event of events) {
    if(event.type==='tool/input-updated')effective.set(event.data.callId,event.data.arguments);
    if(event.type==='tool/call')calls.set(event.data.callId,{name:event.data.name,args:input(event.data.arguments)});
    if(event.type==='tool/ptc-dispatch-start'||event.type==='tool/ptc-dispatch')calls.set(event.data.subCallId,{name:event.data.name,args:input(event.data.arguments)});
    if(event.type==='tool/result'&&!event.data.message.isError)successful.add(event.data.message.toolCallId);
    if(event.type==='tool/ptc-dispatch'&&!event.data.isError)successful.add(event.data.subCallId);
  }
  const append=(event,suffix,type,message,extra={})=>{
    const uuid=`native-${event.seq}-${suffix}`;
    rows.push({type,uuid,parentUuid,sessionId:agent.session.id,timestamp:new Date(event.time).toISOString(),...(message?{message}:{}),...extra});parentUuid=uuid;
  };
  const marker=(event,name,args='')=>{
    if(!name)return;
    const id=JSON.stringify([turn,name,args]);if(markers.has(id))return;markers.add(id);
    append(event,'command-'+rows.length,'user',{role:'user',content:[{type:'text',text:`<command-message>${xml(name)}</command-message>\n<command-name>/${xml(name)}</command-name>\n<command-args>${xml(args)}</command-args>`}]},{native_command_marker:true});
  };
  const use=(name,id,args)=>{
    if(emitted.has(id))return[];emitted.add(id);
    let value=effective.has(id)?effective.get(id):input(args);
    const canonical=toolName(name);
    if((name==='skill'||canonical==='Skill')&&value&&typeof value==='object')value={...value,skill:value.skill??value.name,...(value.arguments!==undefined?{args:value.args??value.arguments}:{})};
    return[{type:'tool_use',id,name:canonical,input:value}];
  };
  const blocks=content=>(content??[]).flatMap(block=>{
    if(block.type==='tool-call')return use(block.name,block.id,block.arguments);
    if(block.type==='reasoning')return[{type:'thinking',thinking:block.text??''}];
    if(block.type==='text'||block.type==='image')return[block];
    return[{type:'text',text:`[native ${block.type}] ${JSON.stringify(block)}`}];
  });
  for(const event of events) {
    signal?.throwIfAborted();
    if(event.type==='turn/start')turn=event.data.turn;
    // Keep attempts, removed/replaced messages, boundaries, jobs, workflow and
    // tool audit events, even when native deriveMessages intentionally omits them.
    append(event,'event','system',undefined,{subtype:'dsh_event',native_event:event});
    const data=event.data;
    if(event.type==='user/message') {
      const text=(data.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
      const command=data.source?.kind==='user'?/^\s*\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text):undefined;
      if(command){commands.set(`${turn}:${command[1]}`,command[2]??'');marker(event,command[1],command[2]??'');}
      if(data.source?.kind==='skill-invocation')marker(event,data.source.name,commands.get(`${turn}:${data.source.name}`)??'');
      append(event,'message','user',{role:'user',content:blocks(data.content)},{native_source:data.source});
    } else if(event.type==='assistant/message') {
      const message=data.message,text=(message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
      if(text)lastAssistant=text;
      append(event,'message','assistant',{role:'assistant',content:blocks(message.content)});
    } else if(event.type==='tool/call'||event.type==='tool/ptc-dispatch-start') {
      const id=event.type==='tool/call'?data.callId:data.subCallId,content=use(data.name,id,data.arguments);
      if(content.length)append(event,'tool-use','assistant',{role:'assistant',content});
    } else if(event.type==='tool/result'||event.type==='tool/ptc-dispatch') {
      const message=event.type==='tool/result'?data.message:{toolCallId:data.subCallId,isError:data.isError,content:data.content};
      const call=calls.get(message.toolCallId);
      if(call&&!emitted.has(message.toolCallId))append(event,'tool-use','assistant',{role:'assistant',content:use(call.name,message.toolCallId,call.args)});
      append(event,'tool-result','user',{role:'user',content:[{type:'tool_result',tool_use_id:message.toolCallId,is_error:message.isError===true,content:blocks(message.content)}]});
      if(call&&successful.has(message.toolCallId)&&(call.name==='skill'||toolName(call.name)==='Skill')) {
        const name=call.args.skill??call.args.name;
        marker(event,name,call.args.args??call.args.arguments??commands.get(`${turn}:${name}`)??'');
      }
    } else if(event.type==='command/run'&&data.name==='review')marker(event,data.name,data.args??'');
  }
  const activity=await ctx.waterfall('workspace/session-activity',{sessionId:agent.session.id},()=>Promise.resolve([]));
  const background_tasks=activity.filter(item=>['job','workflow','subagent'].includes(item.kind)).map(item=>({
    type:item.kind==='subagent'?'subagent':'workflow',native_kind:item.kind,
    ...(typeof(item.id??item.jobId??item.agentId??item.runId)==='string'?{id:item.id??item.jobId??item.agentId??item.runId}:{}),
    ...(typeof(item.description??item.label??item.title)==='string'?{description:item.description??item.label??item.title}:{}),
  }));
  const path=await ctx.platformProjectConfig.writeState(agent,'transcript.jsonl',rows.map(row=>JSON.stringify(row)).join('\n')+'\n',signal);
  return{transcript_path:path,last_assistant_message:lastAssistant,background_tasks};
}
