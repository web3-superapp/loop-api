(()=>{
  'use strict';

  const OFFLINE_LABEL='Simulated Hyperliquid testnet fixture — no network, signing, or submission';
  const CORE_COINS=Object.freeze(['BTC','ETH','SOL']);
  const ADAPTER_METHODS=Object.freeze([
    'getMarketsSnapshot','getMarketSnapshot','getPositionsSnapshot',
    'getOrdersSnapshot','getPositionSnapshot','prepareOrderIntent',
    'prepareMutationReview'
  ]);
  const adapters=new WeakSet();
  const freeze=Object.freeze;
  const monotonicNow=performance.now.bind(performance);
  const capturedAtMs=monotonicNow();

  function sourceFreshness(value){
    if(Array.isArray(value))return value.reduce((age,item)=>Math.max(age,sourceFreshness(item)),0);
    if(value&&typeof value==='object'&&Number.isInteger(value.freshness_ms))return value.freshness_ms;
    return 0;
  }

  function result(value){
    const elapsed=Math.max(0,Math.floor(monotonicNow()-capturedAtMs));
    const age=sourceFreshness(value)+elapsed;
    return freeze({ok:true,value,meta:freeze({source:'hyperliquid_offline_fixture',
      mode:'offline_readonly',network:'testnet',label:OFFLINE_LABEL,
      fetched_at_ms:capturedAtMs,age_ms:age,stale:age>2000,partial:false})});
  }
  function failure(code,message){
    return freeze({ok:false,error:freeze({code,retryable:false,safe_message:message})});
  }
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
  function decimal(value){
    return typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)?value:null;
  }
  function coreCoin(value){
    return typeof value==='string'&&CORE_COINS.includes(value)&&!value.includes(':')?value:null;
  }
  function immutableRows(rows,keys,validator){
    if(!Array.isArray(rows)||Object.getPrototypeOf(rows)!==Array.prototype||rows.length>20){
      throw new TypeError('rows');
    }
    return freeze(rows.map(row=>{
      const item=exactRecord(row,keys);
      if(!item||!validator(item))throw new TypeError('row');
      return freeze({...item});
    }));
  }
  function snapshot(value){
    const item=exactRecord(value,['mode','label','markets','positions','orders']);
    if(!item||item.mode!=='offline_readonly'||item.label!==OFFLINE_LABEL)throw new TypeError('mode');
    const markets=immutableRows(item.markets,
      ['coin','display_name','mark_px','change_24h','volume_24h','funding','open_interest','best_bid',
        'best_ask','freshness_ms','source_revision'],
      row=>Boolean(coreCoin(row.coin)&&text(row.display_name,32)&&decimal(row.mark_px)&&decimal(row.change_24h)&&
        decimal(row.volume_24h)&&decimal(row.funding)&&decimal(row.open_interest)&&
        decimal(row.best_bid)&&decimal(row.best_ask)&&Number.isInteger(row.freshness_ms)&&
        row.freshness_ms>=0&&row.freshness_ms<=2000&&text(row.source_revision)));
    if(markets.length!==3||markets.some((market,index)=>market.coin!==CORE_COINS[index])){
      throw new TypeError('Core market allowlist rejects HIP-3');
    }
    const positions=immutableRows(item.positions,
      ['id','coin','side','size','entry_px','mark_px','leverage','margin','unrealized_pnl',
        'liquidation_px','freshness_ms','source_revision'],
      row=>Boolean(text(row.id)&&coreCoin(row.coin)&&['long','short'].includes(row.side)&&
        decimal(row.size)&&decimal(row.entry_px)&&decimal(row.mark_px)&&decimal(row.leverage)&&
        decimal(row.margin)&&decimal(row.unrealized_pnl)&&decimal(row.liquidation_px)&&
        Number.isInteger(row.freshness_ms)&&row.freshness_ms>=0&&
        row.freshness_ms<=2000&&text(row.source_revision)));
    const orders=immutableRows(item.orders,
      ['id','coin','side','type','size','price','status','filled_size','created_label',
        'freshness_ms','source_revision'],
      row=>Boolean(text(row.id)&&coreCoin(row.coin)&&['buy','sell'].includes(row.side)&&
        ['Limit','Market · IOC'].includes(row.type)&&decimal(row.size)&&decimal(row.price)&&
        ['Open','Filled','Cancelled'].includes(row.status)&&decimal(row.filled_size)&&
        text(row.created_label)&&Number.isInteger(row.freshness_ms)&&
        row.freshness_ms>=0&&row.freshness_ms<=2000&&text(row.source_revision)));
    return freeze({markets,positions,orders});
  }
  function mutationDecision(action){
    const item=exactRecord(action,['kind','coin','intent_revision']);
    const knownKinds=['order','close_position'];
    if(!item||!knownKinds.includes(item.kind)||!coreCoin(item.coin)||
       !text(item.intent_revision)){
      return failure('INVALID_MUTATION_REVIEW','The Perp request could not be reviewed safely.');
    }
    return freeze({ok:false,binding:freeze({kind:item.kind,coin:item.coin,
      intent_revision:item.intent_revision}),error:freeze({
      code:'PENDING_default_deny',retryable:false,
      safe_message:'Trading is unavailable until Hyperliquid credentials, eligibility evidence, and the Privy signer handoff are approved.',
      rechecks:freeze(['region','eligibility','policy','nonce','unknown submission'])
    })});
  }
  function orderDraft(value){
    const item=exactRecord(value,
      ['coin','side','order_type','size','leverage','reduce_only']);
    if(!item||item.coin!=='ETH'||item.side!=='buy'||item.order_type!=='market'||
       item.reduce_only!==false||!decimal(item.size)||item.size.startsWith('-')||
       /^0(?:\.0+)?$/.test(item.size)||item.size.length>18||
       !Object.freeze(['1','2','3','4','5','6','7','8','9','10','11','12','13',
         '14','15','16','17','18','19','20']).includes(item.leverage)){
      return null;
    }
    return item;
  }
  function orderIntent(data,value){
    const draft=orderDraft(value);
    const market=draft?data.markets.find(item=>item.coin===draft.coin):null;
    if(!draft||!market){
      return failure('INVALID_ORDER_INTENT','The Perp order draft could not be bound safely.');
    }
    return result(freeze({
      market:draft.coin,side:draft.side,order_type:draft.order_type,
      size:draft.size,leverage:draft.leverage,reduce_only:draft.reduce_only,
      mark_px:market.mark_px,margin_estimate:'Unavailable in read-only fixture',
      trading_fee_estimate:'Unavailable in read-only fixture',builder_fee:'0.00',
      liquidation_estimate:'Unavailable in read-only fixture',
      freshness_ms:market.freshness_ms,source_revision:market.source_revision,
      intent_revision:'fixture-order:'+market.source_revision+':'+draft.size+':'+draft.leverage
    }));
  }
  function createOfflineReadOnlyAdapter(value){
    let data;
    try{data=snapshot(value)}catch(_error){
      return null;
    }
    const byCoin=coin=>data.markets.find(item=>item.coin===coin)||null;
    const byPosition=id=>data.positions.find(item=>item.id===id)||null;
    const adapter=freeze({
      getMarketsSnapshot:()=>result(data.markets),
      getMarketSnapshot:request=>{
        const item=exactRecord(request,['coin']);
        const market=item?byCoin(item.coin):null;
        return market?result(market):failure('CORE_MARKET_UNAVAILABLE','Core market unavailable.');
      },
      getPositionsSnapshot:()=>result(data.positions),
      getOrdersSnapshot:()=>result(data.orders),
      getPositionSnapshot:request=>{
        const item=exactRecord(request,['position_id']);
        const position=item?byPosition(item.position_id):null;
        return position?result(position):failure('POSITION_UNAVAILABLE','Position unavailable.');
      },
      prepareOrderIntent:request=>orderIntent(data,request),
      prepareMutationReview:mutationDecision
    });
    adapters.add(adapter);
    return adapter;
  }
  function createPendingProductionAdapter(){
    const unavailable=()=>failure('PRODUCTION_ADAPTER_PENDING',
      'Hyperliquid production reads are unavailable until the pinned SDK and credentials are approved.');
    const adapter=freeze({
      getMarketsSnapshot:unavailable,getMarketSnapshot:unavailable,
      getPositionsSnapshot:unavailable,getOrdersSnapshot:unavailable,
      getPositionSnapshot:unavailable,prepareOrderIntent:unavailable,
      prepareMutationReview:mutationDecision
    });
    adapters.add(adapter);
    return adapter;
  }
  function captureAdapter(value){
    if(!adapters.has(value)||!Object.isFrozen(value))return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(descriptors);
    if(keys.length!==ADAPTER_METHODS.length||keys.some(key=>typeof key!=='string'||
       !ADAPTER_METHODS.includes(key)||typeof descriptors[key].value!=='function')){
      return null;
    }
    const captured={};
    for(const key of ADAPTER_METHODS)captured[key]=descriptors[key].value;
    return freeze(captured);
  }

  globalThis.LoopHyperliquidPerp=freeze({
    createOfflineReadOnlyAdapter,createPendingProductionAdapter,captureAdapter
  });
})();
