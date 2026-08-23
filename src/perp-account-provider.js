(()=>{
  'use strict';

  const LABEL='Simulated Hyperliquid account fixture — read-only, no network, signing, or submission';
  const CORE_COINS=Object.freeze(['BTC','ETH','SOL']);
  const ADAPTER_METHODS=Object.freeze([
    'getMarginAccountSnapshot','getTransferContext','getBridgeContext',
    'getFundingSnapshot','getRiskNotice','prepareAccountIntent',
    'prepareMutationReview'
  ]);
  const RECHECKS=Object.freeze([
    'region','eligibility','policy','nonce','unknown submission'
  ]);
  const PENDING_MESSAGE=
    'Account action unavailable until Hyperliquid credentials, eligibility evidence, and the Privy signer handoff are approved.';
  const adapters=new WeakSet();
  const freeze=Object.freeze;
  const monotonicNow=performance.now.bind(performance);
  const capturedAtMs=monotonicNow();

  function plainRecord(value){
    return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&
      Object.getPrototypeOf(value)===Object.prototype);
  }
  function exactRecord(value,keys){
    if(!plainRecord(value))return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const found=Reflect.ownKeys(descriptors);
    if(found.length!==keys.length||found.some(key=>typeof key!=='string'||
       !keys.includes(key)||!Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
      return null;
    }
    const copy={};
    for(const key of keys)copy[key]=descriptors[key].value;
    return copy;
  }
  function text(value,max=128){
    return typeof value==='string'&&value.length>0&&value.length<=max?value:null;
  }
  function token(value,max=128){
    return typeof value==='string'&&value.length>0&&value.length<=max&&
      /^[a-zA-Z0-9._:-]+$/.test(value)?value:null;
  }
  function decimal(value,{positive=false}={}){
    if(typeof value!=='string'||value.length>32||
       !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))return null;
    if(positive&&(value.startsWith('-')||/^0(?:\.0+)?$/.test(value)))return null;
    return value;
  }
  function boundedDecimal(value,min,max,{positive=false}={}){
    if(!decimal(value,{positive}))return null;
    const parsed=Number(value);
    return Number.isFinite(parsed)&&!Object.is(parsed,-0)&&parsed>=min&&parsed<=max?value:null;
  }
  function usdcUnits(value,{positive=false}={}){
    if(typeof value!=='string'||
       !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?$/.test(value))return null;
    const [whole,fraction='']=value.split('.');
    const units=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6));
    if(units>1000000000000000000000n||(positive&&units===0n))return null;
    return units;
  }
  function coreCoin(value){
    return typeof value==='string'&&CORE_COINS.includes(value)&&!value.includes(':')?value:null;
  }
  function frozenRows(rows,keys,validator,max=24){
    if(!Array.isArray(rows)||Object.getPrototypeOf(rows)!==Array.prototype||rows.length>max)
      throw new TypeError('rows');
    return freeze(rows.map((row,index)=>{
      const item=exactRecord(row,keys);
      if(!item||!validator(item,index))throw new TypeError('row');
      return freeze({...item});
    }));
  }
  function sourceFreshness(value){
    if(Array.isArray(value))return value.reduce((age,item)=>Math.max(age,sourceFreshness(item)),0);
    if(value&&typeof value==='object'&&Number.isInteger(value.freshness_ms))return value.freshness_ms;
    return 0;
  }
  function result(value){
    const elapsed=Math.max(0,Math.floor(monotonicNow()-capturedAtMs));
    const age=sourceFreshness(value)+elapsed;
    return freeze({ok:true,value,meta:freeze({source:'hyperliquid_account_offline_fixture',
      mode:'offline_readonly',network:'testnet',label:LABEL,fetched_at_ms:capturedAtMs,
      age_ms:age,stale:age>2000,partial:false})});
  }
  function failure(code,message){
    return freeze({ok:false,error:freeze({code,retryable:false,safe_message:message})});
  }

  const ACCOUNT_KEYS=Object.freeze(['account_ref','equity','available_margin','used_margin',
    'maintenance_margin','maintenance_margin_ratio','risk_level','freshness_ms','source_revision']);
  function marginAccount(value){
    const item=exactRecord(value,ACCOUNT_KEYS);
    if(!item||!token(item.account_ref)||!boundedDecimal(item.equity,0,1e15)||
       !boundedDecimal(item.available_margin,0,1e15)||!boundedDecimal(item.used_margin,0,1e15)||
       !boundedDecimal(item.maintenance_margin,0,1e15)||
       !boundedDecimal(item.maintenance_margin_ratio,0,100)||
       !['healthy','elevated','near_liquidation'].includes(item.risk_level)||
       !Number.isInteger(item.freshness_ms)||item.freshness_ms<0||item.freshness_ms>2000||
       !token(item.source_revision))throw new TypeError('account');
    return freeze({...item});
  }
  const TRANSFER_KEYS=Object.freeze(['account_ref','asset','spot_available','perp_available',
    'minimum_amount','arrival_label','failure_policy','freshness_ms','source_revision']);
  function transferContext(value){
    const item=exactRecord(value,TRANSFER_KEYS);
    if(!item||!token(item.account_ref)||item.asset!=='USDC'||
       usdcUnits(item.spot_available)===null||usdcUnits(item.perp_available)===null||
       usdcUnits(item.minimum_amount,{positive:true})===null||
       item.arrival_label!=='Provider-confirmed after official account transfer'||
       item.failure_policy!=='No local balance mutation; reconcile official account state'||
       !Number.isInteger(item.freshness_ms)||item.freshness_ms<0||item.freshness_ms>2000||
       !token(item.source_revision))throw new TypeError('transfer');
    return freeze({...item});
  }
  const BRIDGE_KEYS=Object.freeze(['account_ref','asset','network','deposit_minimum',
    'withdraw_minimum','arrival_label','bridge_authority','freshness_ms','source_revision']);
  function bridgeContext(value){
    const item=exactRecord(value,BRIDGE_KEYS);
    if(!item||!token(item.account_ref)||item.asset!=='USDC'||item.network!=='arbitrum'||
       usdcUnits(item.deposit_minimum,{positive:true})===null||
       usdcUnits(item.withdraw_minimum,{positive:true})===null||
       item.arrival_label!=='Provider-confirmed after official bridge finality'||
       item.bridge_authority!=='hyperliquid_official_bridge'||
       !Number.isInteger(item.freshness_ms)||item.freshness_ms<0||item.freshness_ms>2000||
       !token(item.source_revision))throw new TypeError('bridge');
    return freeze({...item});
  }
  const FUNDING_ROW_KEYS=Object.freeze(['id','coin','settled_at_ms','rate','payment',
    'plot_y','source_revision']);
  function fundingSnapshot(value){
    const item=exactRecord(value,['coin','current_rate','next_settlement_in_ms','history',
      'freshness_ms','source_revision']);
    if(!item||!coreCoin(item.coin)||!boundedDecimal(item.current_rate,-1,1)||
       !Number.isInteger(item.next_settlement_in_ms)||item.next_settlement_in_ms<0||
       item.next_settlement_in_ms>28800000||!Number.isInteger(item.freshness_ms)||
       item.freshness_ms<0||item.freshness_ms>2000||!token(item.source_revision))
      throw new TypeError('funding');
    const history=frozenRows(item.history,FUNDING_ROW_KEYS,row=>Boolean(token(row.id)&&
      coreCoin(row.coin)&&row.coin===item.coin&&Number.isInteger(row.settled_at_ms)&&
      row.settled_at_ms>=0&&boundedDecimal(row.rate,-1,1)&&
      boundedDecimal(row.payment,-1e15,1e15)&&
      Number.isInteger(row.plot_y)&&row.plot_y>=0&&row.plot_y<=100&&
      token(row.source_revision)),16);
    if(new Set(history.map(row=>row.id)).size!==history.length)throw new TypeError('funding ids');
    return freeze({...item,history});
  }
  const NOTICE_SECTION_KEYS=Object.freeze(['id','heading','body']);
  function riskNotice(value){
    const item=exactRecord(value,['account_ref','notice_id','revision','title','sections',
      'acknowledgement_required','freshness_ms','source_revision']);
    if(!item||!token(item.account_ref)||item.notice_id!=='core-perp-risk'||
       item.revision!=='risk-notice-2026-08'||
       item.title!=='Core perpetual leverage and liquidation risk'||
       typeof item.acknowledgement_required!=='boolean'||
       !Number.isInteger(item.freshness_ms)||item.freshness_ms<0||item.freshness_ms>2000||
       !token(item.source_revision))throw new TypeError('notice');
    const expected=Object.freeze([
      Object.freeze({id:'leverage',heading:'Leverage amplifies loss',
        body:'Losses can accelerate as leverage increases. A small market move can consume posted margin.'}),
      Object.freeze({id:'liquidation',heading:'Liquidation is provider controlled',
        body:'Hyperliquid may liquidate a position when maintenance requirements are not met.'}),
      Object.freeze({id:'funding',heading:'Funding changes over time',
        body:'Funding payments can increase the cost of holding a position and are not fixed.'})
    ]);
    const sections=frozenRows(item.sections,NOTICE_SECTION_KEYS,(row,index)=>Boolean(
      row.id===expected[index]?.id&&row.heading===expected[index]?.heading&&
      row.body===expected[index]?.body),8);
    if(sections.length!==expected.length)
      throw new TypeError('notice sections');
    return freeze({...item,sections});
  }
  function snapshot(value){
    const item=exactRecord(value,['mode','label','account','transfer','bridge','funding','risk_notice']);
    if(!item||item.mode!=='offline_readonly'||item.label!==LABEL)throw new TypeError('mode');
    const projected=freeze({account:marginAccount(item.account),
      transfer:transferContext(item.transfer),bridge:bridgeContext(item.bridge),
      funding:fundingSnapshot(item.funding),risk_notice:riskNotice(item.risk_notice)});
    const accountRef=projected.account.account_ref;
    if(projected.transfer.account_ref!==accountRef||projected.bridge.account_ref!==accountRef||
       projected.risk_notice.account_ref!==accountRef)throw new TypeError('account binding');
    return projected;
  }

  const INTENT_KEYS=Object.freeze(['kind','account_ref','asset','coin','network','direction',
    'amount','notice_id','notice_revision','accepted','context_revision','intent_revision']);
  function accountIntent(value){
    const item=exactRecord(value,INTENT_KEYS);
    if(!item||!['usd_class_transfer','bridge_deposit','bridge_withdraw',
       'risk_acknowledgement'].includes(item.kind)||!token(item.account_ref)||
       !token(item.context_revision)||!token(item.intent_revision))return null;
    if(item.kind==='usd_class_transfer'){
      if(item.asset!=='USDC'||item.coin!==null||item.network!=='hyperliquid'||
         !['spot_to_perp','perp_to_spot'].includes(item.direction)||
         usdcUnits(item.amount,{positive:true})===null||item.notice_id!==null||
         item.notice_revision!==null||item.accepted!==null)return null;
    }else if(item.kind==='bridge_deposit'||item.kind==='bridge_withdraw'){
      if(item.asset!=='USDC'||item.coin!==null||item.network!=='arbitrum'||
         item.direction!==null||usdcUnits(item.amount,{positive:true})===null||
         item.notice_id!==null||item.notice_revision!==null||item.accepted!==null)return null;
    }else if(item.asset!==null||item.coin!==null||item.network!==null||
             item.direction!==null||item.amount!==null||item.notice_id!=='core-perp-risk'||
             !token(item.notice_revision)||item.accepted!==true)return null;
    return freeze({...item});
  }
  function draft(value){
    const item=exactRecord(value,['kind','account_ref','asset','coin','network','direction',
      'amount','notice_id','notice_revision','accepted','context_revision']);
    if(!item)return null;
    return accountIntent({...item,intent_revision:'draft-validation-placeholder'});
  }
  function prepareIntent(data,value){
    const item=draft(value);
    if(!item||item.account_ref!==data.account.account_ref)return failure(
      'INVALID_ACCOUNT_INTENT','The Hyperliquid account request could not be bound safely.');
    let expectedRevision='';
    if(item.kind==='usd_class_transfer')expectedRevision=data.transfer.source_revision;
    else if(item.kind==='bridge_deposit'||item.kind==='bridge_withdraw')
      expectedRevision=data.bridge.source_revision;
    else expectedRevision=data.risk_notice.source_revision;
    if(item.context_revision!==expectedRevision||
       (item.kind==='risk_acknowledgement'&&
        item.notice_revision!==data.risk_notice.revision))return failure(
      'INVALID_ACCOUNT_INTENT','The Hyperliquid account request could not be bound safely.');
    if(item.kind==='usd_class_transfer'){
      const amount=usdcUnits(item.amount,{positive:true});
      const minimum=usdcUnits(data.transfer.minimum_amount,{positive:true});
      const available=usdcUnits(item.direction==='spot_to_perp'?
        data.transfer.spot_available:data.transfer.perp_available);
      if(amount===null||minimum===null||available===null||
         amount<minimum||amount>available)return failure(
        'INVALID_ACCOUNT_INTENT','The Hyperliquid account request could not be bound safely.');
    }else if(item.kind==='bridge_deposit'||item.kind==='bridge_withdraw'){
      const amount=usdcUnits(item.amount,{positive:true});
      const minimum=usdcUnits(item.kind==='bridge_deposit'?
        data.bridge.deposit_minimum:data.bridge.withdraw_minimum,{positive:true});
      if(amount===null||minimum===null||amount<minimum)return failure(
        'INVALID_ACCOUNT_INTENT','The Hyperliquid account request could not be bound safely.');
    }else if(data.risk_notice.acknowledgement_required!==true)return failure(
      'INVALID_ACCOUNT_INTENT','The Hyperliquid account request could not be bound safely.');
    const identity=[item.kind,item.direction||'-',item.amount||'-',item.context_revision].join(':');
    return result(accountIntent({...item,intent_revision:'fixture-intent:'+identity}));
  }
  function mutationDecision(value){
    const intent=accountIntent(value);
    if(!intent)return failure('INVALID_MUTATION_REVIEW',
      'The Hyperliquid account request could not be reviewed safely.');
    return freeze({ok:false,binding:intent,error:freeze({code:'PENDING_default_deny',
      retryable:false,safe_message:PENDING_MESSAGE,rechecks:RECHECKS})});
  }

  function request(value,keys,validator){
    const item=exactRecord(value,keys);
    return item&&validator(item)?freeze({...item}):null;
  }
  function createOfflineReadOnlyAdapter(value){
    let data;
    try{data=snapshot(value)}catch(_error){return null}
    const adapter=freeze({
      getMarginAccountSnapshot:value=>{
        const item=request(value,['account_ref'],row=>row.account_ref===data.account.account_ref);
        return item?result(data.account):failure('ACCOUNT_UNAVAILABLE','Margin account unavailable.');
      },
      getTransferContext:value=>{
        const item=request(value,['account_ref','asset'],row=>
          row.account_ref===data.transfer.account_ref&&row.asset===data.transfer.asset);
        return item?result(data.transfer):failure('TRANSFER_CONTEXT_UNAVAILABLE','Transfer context unavailable.');
      },
      getBridgeContext:value=>{
        const item=request(value,['account_ref','asset','network'],row=>
          row.account_ref===data.bridge.account_ref&&row.asset===data.bridge.asset&&
          row.network===data.bridge.network);
        return item?result(data.bridge):failure('BRIDGE_CONTEXT_UNAVAILABLE','Bridge context unavailable.');
      },
      getFundingSnapshot:value=>{
        const item=request(value,['coin'],row=>row.coin===data.funding.coin&&coreCoin(row.coin));
        return item?result(data.funding):failure('FUNDING_UNAVAILABLE','Funding history unavailable.');
      },
      getRiskNotice:value=>{
        const item=request(value,['account_ref','notice_id'],row=>
          row.account_ref===data.risk_notice.account_ref&&
          row.notice_id===data.risk_notice.notice_id);
        return item?result(data.risk_notice):failure('RISK_NOTICE_UNAVAILABLE','Risk notice unavailable.');
      },
      prepareAccountIntent:value=>prepareIntent(data,value),
      prepareMutationReview:mutationDecision
    });
    adapters.add(adapter);return adapter;
  }
  function createPendingProductionAdapter(){
    const unavailable=()=>failure('PRODUCTION_ADAPTER_PENDING',
      'Hyperliquid production account reads and mutations are unavailable until official credentials and policy evidence are approved.');
    const adapter=freeze(Object.fromEntries(ADAPTER_METHODS.map(method=>[method,unavailable])));
    adapters.add(adapter);return adapter;
  }
  function captureAdapter(value){
    if(!adapters.has(value)||!Object.isFrozen(value))return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if(keys.length!==ADAPTER_METHODS.length||keys.some(key=>typeof key!=='string'||
       !ADAPTER_METHODS.includes(key)||typeof descriptors[key].value!=='function'))return null;
    const captured={};
    for(const key of ADAPTER_METHODS)captured[key]=descriptors[key].value;
    return freeze(captured);
  }
  globalThis.LoopHyperliquidAccount=freeze({
    createOfflineReadOnlyAdapter,createPendingProductionAdapter,captureAdapter
  });
})();
