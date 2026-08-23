(function(root){
  'use strict';
  const bootstrap=root.LoopPlatformProviderBootstrap;
  if(!bootstrap||!Object.isFrozen(bootstrap)||typeof bootstrap.claimOfflineHandle!=='function'){
    throw new TypeError('provider bootstrap unavailable');
  }
  const offlineHandle=bootstrap.claimOfflineHandle();
  delete root.LoopPlatformProviderBootstrap;
  function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Reflect.ownKeys(value).forEach(key=>freeze(value[key]));Object.freeze(value)}return value}
  const EVENTS=freeze({
    firebase:[{id:'sys-1',category:'system',title:'Price alert delivery paused',detail:'Device notification permission is off. Open system settings to change it.',occurred_at:'2026-08-23T09:39:00Z',read:false}],
    stream:[{id:'chat-1',category:'community',title:'Glyph Hunters mentioned you',detail:'A Stream event projection from a fixture channel; no message was sent.',occurred_at:'2026-08-23T09:37:00Z',read:false}],
    hyperliquid:[{id:'perp-1',category:'transaction',title:'Perp market data delayed',detail:'Read-only Hyperliquid feed is reconnecting. Trading remains unavailable.',occurred_at:'2026-08-23T09:34:00Z',read:true}],
    privy:[{id:'wallet-1',category:'security',title:'New wallet session observed',detail:'Privy fixture session fact. Review devices when production access is configured.',occurred_at:'2026-08-23T09:31:00Z',read:true}]
  });
  const SEARCH=freeze({
    market_data:[{id:'eth-token',kind:'token',title:'Ethereum',subtitle:'Market-data fixture · ETH'}],
    stream:[{id:'eth-group',kind:'group',title:'ETH Holders Lounge',subtitle:'Stream fixture channel'}],
    hyperliquid:[{id:'eth-perp',kind:'perp',title:'ETH-PERP',subtitle:'Hyperliquid read-only fixture market'}],
    privy:[{id:'eth-wallet',kind:'user',title:'Your embedded wallet',subtitle:'Privy fixture identity'}]
  });
  const FACTS=freeze({
    goplus:[{id:'gp-1',label:'Token permission fact',value:'No mint function reported in fixture',severity:'info',observed_at:'2026-08-23T09:20:00Z'}],
    chainalysis:[{id:'ch-1',label:'Address screening',value:'Production screening not configured',severity:'warning',observed_at:'2026-08-23T09:20:00Z'}]
  });
  const PRIVY_SECURITY=freeze([
    {id:'mfa',label:'MFA',state:'PENDING',detail:'Privy production configuration required.'},
    {id:'app-lock',label:'App lock',state:'PENDING',detail:'Device capability audit required.'},
    {id:'devices',label:'Devices & sessions',state:'PENDING',detail:'Privy/server session management is not configured.'},
    {id:'recovery',label:'Recovery',state:'attention',detail:'Privy fixture recovery requires production verification.'},
    {id:'login-history',label:'Login history',state:'PENDING',detail:'Privy/server history authority is not configured.'}
  ]);
  const source=(authority,items)=>freeze({authority,read:async()=>items});
  const configuration=()=>freeze({
    eventSources:['firebase','stream','hyperliquid','privy'].map(name=>source(name,EVENTS[name])),
    searchSources:['market_data','stream','hyperliquid','privy'].map(name=>source(name,SEARCH[name])),
    securitySources:['goplus','chainalysis'].map(name=>source(name,FACTS[name])),
    privySecuritySource:source('privy',PRIVY_SECURITY),privacyClient:null
  });
  function createAdapter(){
    if(arguments.length!==0)throw new TypeError('offline adapter accepts no configuration');
    return root.LoopPlatformProvider.createOfflineAdapter(offlineHandle,configuration());
  }
  function regionalPolicy(){
    if(arguments.length!==0)throw new TypeError('regional policy accepts no configuration');
    let snapshot=freeze({state:'unknown',revision:0,policy_id:'offline-fixture-policy',
      verified:false,source:'trusted_offline_policy_fixture'});
    const capabilities=freeze(['wallet_mutation','privacy_mutation']);
    const operations=freeze(['transfer','swap','approval','perp_order','privacy_export',
      'privacy_delete','control_home-pay','control_token-buy','control_group-token-buy',
      'control_group-copy-trade','control_wallet-send','control_wallet-swap',
      'control_wallet-bridge','control_wallet-dapps','control_swap-submit',
      'control_dapp-approve','control_approval-limit','control_approval-unlimited']);
    const stages=freeze(['entry_gate','review_open','begin_handoff','provider_handoff',
      'provider_mutation']);
    function inspect(request,rechecking=false){
      let values=null;
      try{
        const descriptors=request&&Object.getPrototypeOf(request)===Object.prototype?
          Object.getOwnPropertyDescriptors(request):null;
        if(!descriptors||Reflect.ownKeys(descriptors).some(key=>
          !Object.prototype.hasOwnProperty.call(descriptors[key],'value')))return null;
        values={};Reflect.ownKeys(descriptors).forEach(key=>{values[key]=descriptors[key].value});
      }catch(_error){return null}
      const keys=Object.keys(values||{}),expected=rechecking?
        ['capability','operation','stage']:['capability'];
      if(keys.length!==expected.length||expected.some(key=>!keys.includes(key))||
         !capabilities.includes(values.capability))return null;
      if(rechecking&&(!operations.includes(values.operation)||!stages.includes(values.stage)))
        return null;
      return values;
    }
    function projection(request,rechecking=false){
      const input=inspect(request,rechecking),known=Boolean(input);
      const allowed=false;
      return freeze({allowed,state:known?snapshot.state:'unknown',revision:snapshot.revision,
        policy_id:snapshot.policy_id,verified:snapshot.verified,source:snapshot.source,
        reason:known&&snapshot.state==='eligible_readonly'?
          'Offline eligibility preview is read-only; provider mutations remain unavailable.':
          known?'This action is unavailable under the current regional policy.':
          'Regional eligibility is unknown for this action.'});
    }
    return freeze({
      decision(request){return projection(request)},
      recheck(request){
        const input=inspect(request,true);
        if(!input){
          return projection({capability:'unknown'});
        }
        return projection(input,true);
      },
      activateReadOnlyPreview(){
        if(snapshot.revision!==0)return snapshot;
        snapshot=freeze({state:'eligible_readonly',revision:1,
          policy_id:'offline-readonly-preview',verified:true,
          source:'explicit_offline_readonly_preview'});
        return snapshot;
      },
      applyTrustedFixtureTransition(state){
        if(!['blocked','unknown','stale','malformed'].includes(state))state='unknown';
        snapshot=freeze({state,revision:snapshot.revision+1,policy_id:'offline-fixture-policy',
          verified:state==='blocked',source:'trusted_offline_policy_fixture'});
        return snapshot;
      },
      snapshot(){return snapshot}
    });
  }
  const facade=freeze({createAdapter,regionalPolicy});
  Object.defineProperty(root,'LoopPlatformOfflineFixture',{value:facade,writable:false,
    configurable:false,enumerable:true});
})(globalThis);
