(function(root){
  'use strict';
  const MAX_QUERY_LENGTH=64,MAX_SOURCES=4,MAX_RESULTS_PER_SOURCE=5,MAX_NOTIFICATIONS=24;
  const EVENT_AUTHORITIES=Object.freeze(['firebase','stream','hyperliquid','privy']);
  const SECURITY_AUTHORITIES=Object.freeze(['goplus','chainalysis']);
  const SEARCH_DESTINATIONS=Object.freeze(Object.fromEntries([
    ['token','#token'],['contract','#token'],['group','#chat'],
    ['user','#profile'],['perp','#market']
  ]));
  const SELECTION_GATES=Object.freeze({notification_inbox:'whole_app_core_selection_pending',
    federated_search_indexing:'whole_app_core_selection_pending',
    provider_event_ingestion:'whole_app_core_selection_pending'});
  const offlineHandles=new WeakSet(),productionHandles=new WeakSet(),productionPolicies=new WeakSet();
  let offlineClaimed=false,productionClaimed=false,pendingProductionPolicy=null;
  function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Reflect.ownKeys(value).forEach(key=>freeze(value[key]));Object.freeze(value)}return value}
  function cleanText(value,max,label){if(typeof value!=='string'||value.length<1||
    value.length>max||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError(label);return value}
  function ownRecord(value,label){if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.getPrototypeOf(value)!==Object.prototype)throw new TypeError(label);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||
      !Object.prototype.hasOwnProperty.call(descriptors[key],'value')))throw new TypeError(label);
    const copy={};Reflect.ownKeys(descriptors).forEach(key=>{copy[key]=descriptors[key].value});return copy}
  function exactKeys(value,required,label){const item=ownRecord(value,label),keys=Object.keys(item);
    if(keys.length!==required.length||required.some(key=>!keys.includes(key)))throw new TypeError(label);return item}
  function sourceArray(value,allowed,label){if(!Array.isArray(value)||value.length<1||
    value.length>MAX_SOURCES)throw new TypeError(label);const seen=new Set();return value.map(raw=>{
      const item=exactKeys(raw,['authority','read'],label+' source');cleanText(item.authority,24,label+' authority');
      if(!allowed.includes(item.authority)||seen.has(item.authority)||typeof item.read!=='function')throw new TypeError(label+' authority');
      seen.add(item.authority);return freeze({authority:item.authority,read:item.read})})}
  function notification(raw,authority){const item=exactKeys(raw,
    ['id','category','title','detail','occurred_at','read'],'notification');
    ['id','category','title','detail','occurred_at'].forEach(key=>cleanText(item[key],key==='detail'?180:80,'notification '+key));
    if(!['transaction','community','security','system'].includes(item.category)||typeof item.read!=='boolean')throw new TypeError('notification value');
    return {id:item.id,authority,category:item.category,title:item.title,detail:item.detail,occurred_at:item.occurred_at,read:item.read}}
  function result(raw,authority){const item=exactKeys(raw,['id','kind','title','subtitle'],'search result');
    ['id','title','subtitle'].forEach(key=>cleanText(item[key],key==='subtitle'?160:80,'search '+key));
    if(!Object.prototype.hasOwnProperty.call(SEARCH_DESTINATIONS,item.kind))throw new TypeError('search value');
    return {id:item.id,authority,kind:item.kind,title:item.title,subtitle:item.subtitle,
      route:SEARCH_DESTINATIONS[item.kind]}}
  function fact(raw,authority){const item=exactKeys(raw,['id','label','value','severity','observed_at'],'security fact');
    ['id','label','value','observed_at'].forEach(key=>cleanText(item[key],120,'security '+key));
    if(!['info','warning','critical'].includes(item.severity))throw new TypeError('security severity');
    return {id:item.id,authority,label:item.label,value:item.value,severity:item.severity,observed_at:item.observed_at}}
  function privyCapability(raw){const item=exactKeys(raw,['id','label','state','detail'],'Privy security capability');
    ['id','label','state','detail'].forEach(key=>cleanText(item[key],160,'Privy security '+key));
    if(!['PENDING','available','attention'].includes(item.state))throw new TypeError('Privy security state');
    return {id:item.id,label:item.label,state:item.state,detail:item.detail}}
  function readList(raw,max,label){if(!Array.isArray(raw)||raw.length>max)throw new TypeError(label);return raw}
  function validHandle(handles,handle){return Boolean(handle&&typeof handle==='object'&&
    Object.getPrototypeOf(handle)===null&&Object.isFrozen(handle)&&Reflect.ownKeys(handle).length===0&&handles.has(handle))}
  function createAdapter(handle,configuration,status){
    const handles=status==='offline_fixture'?offlineHandles:productionHandles;
    if(!validHandle(handles,handle))throw new TypeError('untrusted adapter channel');
    const config=exactKeys(configuration,
      ['eventSources','searchSources','securitySources','privySecuritySource','privacyClient'],'platform configuration');
    const eventSources=sourceArray(config.eventSources,EVENT_AUTHORITIES,'event');
    const searchSources=sourceArray(config.searchSources,['privy','stream','hyperliquid','market_data'],'search');
    const securitySources=sourceArray(config.securitySources,SECURITY_AUTHORITIES,'security');
    const privySource=exactKeys(config.privySecuritySource,['authority','read'],'Privy security source');
    if(privySource.authority!=='privy'||typeof privySource.read!=='function')throw new TypeError('Privy security authority');
    if(config.privacyClient!==null&&(!config.privacyClient||typeof config.privacyClient.requestOperation!=='function'))throw new TypeError('privacy client');
    const privacyRequest=config.privacyClient===null?null:config.privacyClient.requestOperation;
    return freeze({
      async notifications(request){const input=exactKeys(request,['limit'],'notification request');
        if(!Number.isInteger(input.limit)||input.limit<1||input.limit>MAX_NOTIFICATIONS)throw new TypeError('notification limit');
        const batches=await Promise.all(eventSources.map(async source=>({source,
          items:readList(await source.read({limit:Math.min(input.limit,6)}),6,'event batch')})));
        const items=batches.flatMap(batch=>batch.items.map(item=>notification(item,batch.source.authority)))
          .sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)).slice(0,input.limit);
        return freeze({status,selection_gate:SELECTION_GATES.notification_inbox,durable_read_state:false,items})},
      async search(request){const input=exactKeys(request,['query'],'search request');
        const query=cleanText(input.query,MAX_QUERY_LENGTH,'query');
        const batches=await Promise.all(searchSources.map(async source=>({source,
          items:readList(await source.read({query,limit:MAX_RESULTS_PER_SOURCE}),MAX_RESULTS_PER_SOURCE,'search batch')})));
        const results=batches.flatMap(batch=>batch.items.map(item=>result(item,batch.source.authority))).slice(0,MAX_SOURCES*MAX_RESULTS_PER_SOURCE);
        return freeze({status,selection_gate:SELECTION_GATES.federated_search_indexing,query,results})},
      async privySecurity(){const capabilities=readList(await privySource.read({limit:5}),5,'Privy security batch').map(privyCapability);
        return freeze({status,profile:'privy_wallet',authority:'privy',capabilities})},
      async securityFacts(){const batches=await Promise.all(securitySources.map(async source=>({source,
          items:readList(await source.read({limit:4}),4,'security batch')})));
        return freeze({status,profile:'security_facts',facts:batches.flatMap(batch=>batch.items.map(item=>fact(item,batch.source.authority)))})},
      async requestPrivacyOperation(request){const input=exactKeys(request,['kind'],'privacy request');
        if(!['export','delete'].includes(input.kind))throw new TypeError('privacy kind');
        if(status==='offline_fixture'||privacyRequest===null)return freeze({status:'PENDING',kind:input.kind,request_id:null,
          mutation_performed:false,reason:'provider_selection_or_server_configuration_pending'});
        const response=exactKeys(await privacyRequest({kind:input.kind}),['request_id','status'],'privacy response');
        cleanText(response.request_id,96,'privacy request id');if(response.status!=='PENDING')throw new TypeError('privacy status');
        return freeze({status:'PENDING',kind:input.kind,request_id:response.request_id,
          mutation_performed:false,reason:'provider_async_request_accepted'})}
    })
  }
  function createOfflineAdapter(handle,configuration){return createAdapter(handle,configuration,'offline_fixture')}
  function createProductionAdapter(handle,configuration){return createAdapter(handle,configuration,'production_injected')}
  function buildProductionRegionalPolicy(configuration){
    const config=exactKeys(configuration,['authoritativeRecheck'],'regional policy configuration');
    if(typeof config.authoritativeRecheck!=='function')throw new TypeError('regional policy recheck');
    const authoritativeRecheck=config.authoritativeRecheck;
    const capabilities=freeze(['wallet_mutation','privacy_mutation']);
    const operations=freeze(['transfer','swap','approval','perp_order','privacy_export',
      'privacy_delete','control_home-pay','control_token-buy','control_group-token-buy',
      'control_group-copy-trade','control_wallet-send','control_wallet-swap',
      'control_wallet-bridge','control_wallet-dapps','control_swap-submit',
      'control_dapp-approve','control_approval-limit','control_approval-unlimited']);
    const stages=freeze(['entry_gate','review_open','begin_handoff','provider_handoff',
      'provider_mutation']);
    let snapshot=freeze({state:'unknown',revision:0,policy_id:'',verified:false,
      source:'production_policy_provider'}),blocked=false;
    const deny=(state,reason)=>freeze({allowed:false,state,revision:snapshot.revision,
      policy_id:snapshot.policy_id,verified:false,source:snapshot.source,reason});
    const inspect=(request,rechecking)=>{
      const input=exactKeys(request,rechecking?['capability','operation','stage']:
        ['capability'],'regional policy request');
      cleanText(input.capability,32,'regional capability');
      if(!capabilities.includes(input.capability))throw new TypeError('regional capability');
      if(rechecking){
        cleanText(input.operation,64,'regional operation');
        cleanText(input.stage,32,'regional stage');
        if(!operations.includes(input.operation)||!stages.includes(input.stage))
          throw new TypeError('regional operation');
      }
      return input;
    };
    const projection=()=>{
      const allowed=!blocked&&snapshot.verified&&snapshot.state==='eligible';
      return freeze({allowed,state:blocked?'blocked':snapshot.state,revision:snapshot.revision,
        policy_id:snapshot.policy_id,verified:snapshot.verified,source:snapshot.source,
        reason:allowed?'':'Regional eligibility is unavailable for this operation.'});
    };
    const policy=freeze({
      decision(request){try{inspect(request,false);return projection()}catch(_error){
        return deny('unknown','Regional eligibility is unknown for this action.')}},
      recheck(request){
        let input;
        try{input=inspect(request,true)}catch(_error){return deny('unknown','Regional eligibility is unknown for this action.')}
        let response;
        try{response=exactKeys(authoritativeRecheck(freeze({...input})),
          ['state','revision','policy_id','verified'],'regional policy response')}
        catch(_error){return blocked?projection():
          deny('unknown','Regional policy provider recheck failed.')}
        if(blocked)return projection();
        if(!['eligible','blocked'].includes(response.state)||
           !Number.isInteger(response.revision)||response.revision<1||
           response.revision<snapshot.revision||response.verified!==true){
          return deny('stale','Regional policy provider response was not current and verified.');
        }
        cleanText(response.policy_id,96,'regional policy id');
        snapshot=freeze({state:response.state,revision:response.revision,
          policy_id:response.policy_id,verified:true,source:'production_policy_provider'});
        if(response.state==='blocked')blocked=true;
        return projection();
      },
      snapshot(){return snapshot}
    });
    productionPolicies.add(policy);return policy;
  }
  function burnProductionPolicyHandle(handle){
    if(!validHandle(productionHandles,handle))throw new TypeError('untrusted production policy channel');
    productionHandles.delete(handle);
  }
  function createProductionRegionalPolicy(handle,configuration){
    burnProductionPolicyHandle(handle);
    return buildProductionRegionalPolicy(configuration);
  }
  function installProductionRegionalPolicy(handle,configuration){
    burnProductionPolicyHandle(handle);
    if(pendingProductionPolicy!==null)throw new TypeError('production policy already installed');
    const policy=buildProductionRegionalPolicy(configuration);
    if(!productionPolicies.has(policy))throw new TypeError('untrusted production policy');
    pendingProductionPolicy=policy;return policy;
  }
  function consumeProductionRegionalPolicy(){
    if(arguments.length!==0)throw new TypeError('production policy consume arguments');
    const policy=pendingProductionPolicy;pendingProductionPolicy=null;
    return policy&&productionPolicies.has(policy)?policy:null;
  }
  const bootstrap=freeze({
    claimOfflineHandle(){if(offlineClaimed)throw new TypeError('offline channel already claimed');offlineClaimed=true;
      const handle=Object.freeze(Object.create(null));offlineHandles.add(handle);return handle},
    claimProductionHandle(){if(productionClaimed)throw new TypeError('production channel already claimed');productionClaimed=true;
      const handle=Object.freeze(Object.create(null));productionHandles.add(handle);return handle}
  });
  const facade=freeze({createOfflineAdapter,createProductionAdapter,
    createProductionRegionalPolicy,installProductionRegionalPolicy,
    consumeProductionRegionalPolicy,MAX_QUERY_LENGTH,MAX_SOURCES,
    MAX_RESULTS_PER_SOURCE,SEARCH_DESTINATIONS,SELECTION_GATES});
  Object.defineProperty(root,'LoopPlatformProvider',{value:facade,writable:false,configurable:false,enumerable:true});
  Object.defineProperty(root,'LoopPlatformProviderBootstrap',{value:bootstrap,writable:false,configurable:true,enumerable:false});
})(globalThis);
