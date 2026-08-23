(function(){
  'use strict';

  const WALLET_CLASSES=Object.freeze(['privy_embedded','connected_external','watch_only']);
  const SCENARIOS=Object.freeze([
    'normal','empty','loading','partial','provider_succeeded_demo','external_gap','watch_only'
  ]);
  const ASSETS=Object.freeze(['ETH','SOL','USDC','GLYPH']);
  const CHAINS=Object.freeze(['ethereum','base','arbitrum','solana']);
  // Private work limits bound all parsing and exact-arithmetic effort at the provider boundary.
  const MAX_NUMERIC_TEXT=100;
  const MAX_DECIMAL_VALUES=128;
  const MAX_BALANCES=128;
  const MAX_TRANSACTIONS=256;
  const MAX_PROVIDER_LABEL=128;
  const MAX_PROVIDER_OPAQUE=256;
  const MAX_PROVIDER_TIMESTAMP=8640000000000000;

  function deepFreeze(value){
    if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  function success(value,source,partial){
    return deepFreeze({ok:true,value,meta:{
      source,fetched_at_ms:0,stale:false,partial:partial===true
    }});
  }

  function staleSuccess(value,source,fetchedAtMs){
    return deepFreeze({ok:true,value,meta:{
      source,fetched_at_ms:fetchedAtMs,stale:true,partial:false
    }});
  }

  const SAFE_MESSAGES=Object.freeze({
    UNAUTHENTICATED:'Sign in to use this wallet.',
    UNSUPPORTED_WALLET:'Watch-only wallets cannot authorize signing requests.',
    PROVIDER_GAP:'This provider capability is not available for this wallet.',
    MALFORMED_PROVIDER_RESPONSE:'The wallet provider returned data LOOP could not safely use.',
    PROVIDER_UNAVAILABLE:'The wallet provider is temporarily unavailable.',
    USER_REJECTED:'The wallet request was rejected by the user.',
    POLICY_REJECTED:'The wallet request was blocked by provider policy.',
    ACTION_FAILED:'The wallet action did not complete.',
    PERP_EXECUTION_PENDING:'Privy + Hyperliquid execution requires the production capability spike.'
  });

  function failure(code,safeMessage){
    return deepFreeze({ok:false,error:{
      code,retryable:false,safe_message:safeMessage||SAFE_MESSAGES[code]
    }});
  }

  function isRecord(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
  }

  function hasAllowedRecordPrototype(value){
    if(!isRecord(value)) return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
  }

  function ownDataDescriptors(value){
    if(!hasAllowedRecordPrototype(value)) return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(value);
    if(keys.some(key=>typeof key!=='string')) return null;
    if(keys.some(key=>!descriptors[key]||
       !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
      return null;
    }
    return descriptors;
  }

  function snapshotLoopRecord(value,required,optional,label){
    const descriptors=ownDataDescriptors(value);
    if(!descriptors) throw new TypeError(label+' must be a plain data object');
    const allowed=required.concat(optional||[]);
    const keys=Reflect.ownKeys(descriptors);
    if(required.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key))||
       keys.some(key=>!allowed.includes(key))){
      throw new TypeError(label+' has invalid keys');
    }
    const snapshot=Object.create(null);
    keys.forEach(key=>{ snapshot[key]=descriptors[key].value; });
    return snapshot;
  }

  function providerArrayValues(value,maximum){
    if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
       value.length>maximum) return null;
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(value);
    const allowed=['length'];
    const values=[];
    for(let index=0;index<value.length;index+=1){
      const key=String(index);
      allowed.push(key);
      const descriptor=descriptors[key];
      if(!descriptor||!Object.prototype.hasOwnProperty.call(descriptor,'value')){
        return null;
      }
      values.push(descriptor.value);
    }
    if(keys.some(key=>typeof key!=='string'||!allowed.includes(key))) return null;
    return values;
  }

  function providerOwnValue(descriptors,key){
    return Object.prototype.hasOwnProperty.call(descriptors,key)?
      descriptors[key].value:undefined;
  }

  function isCanonicalInteger(value){
    return typeof value==='string'&&value.length<=MAX_NUMERIC_TEXT&&
      /^(?:0|[1-9][0-9]*)$/.test(value);
  }

  function isCanonicalDecimal(value){
    return typeof value==='string'&&value.length<=MAX_NUMERIC_TEXT&&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value);
  }

  function isDecimals(value){
    return typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=36;
  }

  function isSafeOpaque(value){
    return typeof value==='string'&&value.length>0&&value.length<=MAX_PROVIDER_OPAQUE&&
      value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
  }

  function isSafeProviderLabel(value){
    return typeof value==='string'&&value.length>0&&
      value.length<=MAX_PROVIDER_LABEL&&value.trim()===value&&
      !/[\u0000-\u001f\u007f]/.test(value);
  }

  function requireEnum(value,allowed,label){
    if(typeof value!=='string'||!allowed.includes(value)){
      throw new TypeError(label+' is invalid');
    }
  }

  function formatBaseUnits(raw,decimals,symbol){
    if(!isCanonicalInteger(raw)||!isDecimals(decimals)||!ASSETS.includes(symbol)){
      throw new TypeError('Invalid fixed-point amount');
    }
    let whole;
    let fraction='';
    if(decimals===0){
      whole=raw;
    }else{
      const padded=raw.padStart(decimals+1,'0');
      whole=padded.slice(0,-decimals);
      fraction=padded.slice(-decimals).replace(/0+$/,'');
    }
    return whole+(fraction?'.'+fraction:'')+' '+symbol;
  }

  function addDecimalStrings(values){
    const snapshot=providerArrayValues(values,MAX_DECIMAL_VALUES);
    if(!snapshot||snapshot.length===0){
      throw new TypeError('Invalid decimal values');
    }
    let scale=0;
    for(const value of snapshot){
      if(!isCanonicalDecimal(value)) throw new TypeError('Invalid decimal values');
      const point=value.indexOf('.');
      const width=point<0?0:value.length-point-1;
      if(width>scale) scale=width;
    }
    let exactTotal=0n;
    for(const value of snapshot){
      const parts=value.split('.');
      exactTotal+=BigInt(parts[0]+(parts[1]||'').padEnd(scale,'0'));
    }
    const total=exactTotal.toString().padStart(scale+1,'0');
    if(scale===0) return total;
    return total.slice(0,-scale)+'.'+total.slice(-scale);
  }

  function malformed(){
    return failure('MALFORMED_PROVIDER_RESPONSE');
  }

  function normalizedBalanceItem(entry){
    const descriptors=ownDataDescriptors(entry);
    if(!descriptors) return null;
    const chain=providerOwnValue(descriptors,'chain');
    const asset=providerOwnValue(descriptors,'asset');
    const rawValue=providerOwnValue(descriptors,'raw_value');
    const rawDecimals=providerOwnValue(descriptors,'raw_value_decimals');
    const rawDisplay=providerOwnValue(descriptors,'display_values');
    if(!isSafeProviderLabel(chain)||!CHAINS.includes(chain)||
       !isSafeProviderLabel(asset)||!ASSETS.includes(asset.toUpperCase())||
       !isCanonicalInteger(rawValue)||!isDecimals(rawDecimals)){
      return null;
    }
    let displayDescriptors=Object.create(null);
    if(rawDisplay!==undefined){
      displayDescriptors=ownDataDescriptors(rawDisplay);
      if(!displayDescriptors) return null;
    }
    const assetId=asset.toUpperCase();
    const quantity=providerOwnValue(displayDescriptors,asset);
    if(quantity!==undefined&&!isCanonicalDecimal(quantity)) return null;
    const usd=providerOwnValue(displayDescriptors,'usd');
    if(usd!==undefined&&!isCanonicalDecimal(usd)) return null;
    const fiatValue=assetId==='GLYPH'||usd===undefined?null:usd;
    return {
      asset_id:assetId,
      chain_id:chain,
      raw_value:rawValue,
      decimals:rawDecimals,
      amount_display:quantity===undefined?
        formatBaseUnits(rawValue,rawDecimals,assetId):quantity+' '+assetId,
      fiat_currency:'USD',
      fiat_value:fiatValue,
      value_provenance:fiatValue===null?'unavailable':'privy_balance'
    };
  }

  function balanceTotal(items){
    const included=items.filter(item=>item.fiat_value!==null).map(item=>item.fiat_value);
    return {
      value:included.length?addDecimalStrings(included):null,
      currency:'USD',
      label:'LOOP total derived from Privy balances',
      excluded_asset_count:items.length-included.length
    };
  }

  function normalizeBalanceResponse(raw){
    const descriptors=ownDataDescriptors(raw);
    if(!descriptors||!Object.prototype.hasOwnProperty.call(descriptors,'balances')){
      return malformed();
    }
    const balances=providerArrayValues(descriptors.balances.value,MAX_BALANCES);
    if(!balances) return malformed();
    const items=[];
    const chainErrors=[];
    balances.forEach(entry=>{
      const item=normalizedBalanceItem(entry);
      if(item){
        items.push(item);
      }else{
        const entryDescriptors=ownDataDescriptors(entry);
        const chain=entryDescriptors?providerOwnValue(entryDescriptors,'chain'):undefined;
        chainErrors.push({
          chain_id:isSafeProviderLabel(chain)&&CHAINS.includes(chain)?chain:'unknown',
          code:'MALFORMED_PROVIDER_RESPONSE'
        });
      }
    });
    if(chainErrors.length&&items.length===0) return malformed();
    let status='ready';
    if(chainErrors.length) status='partial';
    else if(items.length===0) status='empty';
    return success({status,items,loop_total:balanceTotal(items),chain_errors:chainErrors},
      'privy_balance',status==='partial');
  }

  function optionalProviderString(value){
    if(value===undefined||value===null||value==='') return null;
    return isSafeOpaque(value)?value:undefined;
  }

  function normalizeTransactionRecord(record){
    const descriptors=ownDataDescriptors(record);
    if(!descriptors) return {malformed:true};
    const status=providerOwnValue(descriptors,'status');
    const createdAt=providerOwnValue(descriptors,'created_at');
    if(!isSafeProviderLabel(status)||typeof createdAt!=='number'||
       !Number.isSafeInteger(createdAt)||createdAt<0||
       createdAt>MAX_PROVIDER_TIMESTAMP){
      return {malformed:true};
    }
    const providerId=optionalProviderString(
      providerOwnValue(descriptors,'privy_transaction_id'));
    const hash=optionalProviderString(providerOwnValue(descriptors,'transaction_hash'));
    if(providerId===undefined||hash===undefined) return {malformed:true};
    const id=providerId||hash;
    if(!id) return {missingId:true};
    let direction='other';
    let chainId=null;
    let assetId=null;
    let rawValue=null;
    let decimals=null;
    let amountDisplay=null;
    let counterparty=null;
    const rawDetails=providerOwnValue(descriptors,'details');
    const detailsPresent=rawDetails!==undefined&&rawDetails!==null;
    if(rawDetails!==undefined&&rawDetails!==null){
      const detailDescriptors=ownDataDescriptors(rawDetails);
      if(!detailDescriptors) return {malformed:true};
      const type=providerOwnValue(detailDescriptors,'type');
      if(type!==undefined&&!isSafeProviderLabel(type)) return {malformed:true};
      if(type==='transfer_sent') direction='outgoing';
      else if(type==='transfer_received') direction='incoming';
      const chain=providerOwnValue(detailDescriptors,'chain');
      if(chain!==undefined){
        if(!isSafeProviderLabel(chain)) return {malformed:true};
        chainId=chain;
      }
      const asset=providerOwnValue(detailDescriptors,'asset');
      if(asset!==undefined){
        if(!isSafeProviderLabel(asset)||!ASSETS.includes(asset.toUpperCase())){
          return {malformed:true};
        }
        assetId=asset.toUpperCase();
      }
      const detailRawValue=providerOwnValue(detailDescriptors,'raw_value');
      if(detailRawValue!==undefined&&detailRawValue!==null){
        if(!isCanonicalInteger(detailRawValue)) return {malformed:true};
        rawValue=detailRawValue;
      }
      const detailDecimals=providerOwnValue(detailDescriptors,'raw_value_decimals');
      if(detailDecimals!==undefined&&detailDecimals!==null){
        if(!isDecimals(detailDecimals)) return {malformed:true};
        decimals=detailDecimals;
      }
      const display=providerOwnValue(detailDescriptors,'display_values');
      let displayDescriptors=Object.create(null);
      if(display!==undefined){
        displayDescriptors=ownDataDescriptors(display);
        if(!displayDescriptors) return {malformed:true};
      }
      if(rawValue!==null&&decimals!==null&&assetId!==null){
        const shown=providerOwnValue(displayDescriptors,asset);
        if(shown!==undefined&&!isCanonicalDecimal(shown)) return {malformed:true};
        amountDisplay=shown===undefined?
          formatBaseUnits(rawValue,decimals,assetId):shown+' '+assetId;
      }
      const sender=optionalProviderString(providerOwnValue(detailDescriptors,'sender'));
      const recipient=optionalProviderString(providerOwnValue(detailDescriptors,'recipient'));
      if(sender===undefined||recipient===undefined) return {malformed:true};
      if(direction==='outgoing') counterparty=recipient;
      else if(direction==='incoming') counterparty=sender;
    }
    return {item:{
      id,direction,provider_status:status,details_present:detailsPresent,
      chain_id:chainId,asset_id:assetId,
      raw_value:rawValue,decimals,amount_display:amountDisplay,counterparty,
      transaction_hash:hash,created_at_ms:createdAt
    }};
  }

  function normalizeTransactionPage(raw){
    const descriptors=ownDataDescriptors(raw);
    if(!descriptors||
       !Object.prototype.hasOwnProperty.call(descriptors,'transactions')||
       !Object.prototype.hasOwnProperty.call(descriptors,'next_cursor')){
      return malformed();
    }
    const transactions=providerArrayValues(
      descriptors.transactions.value,MAX_TRANSACTIONS);
    const nextCursor=descriptors.next_cursor.value;
    if(!transactions||!(nextCursor===null||isSafeOpaque(nextCursor))) return malformed();
    const items=[];
    const recordErrors=[];
    const ids=new Set();
    for(let index=0;index<transactions.length;index+=1){
      const normalized=normalizeTransactionRecord(transactions[index]);
      if(normalized.malformed) return malformed();
      if(normalized.missingId){
        recordErrors.push({index,code:'MISSING_TRANSACTION_ID'});
      }else if(!ids.has(normalized.item.id)){
        ids.add(normalized.item.id);
        items.push(normalized.item);
      }
    }
    const status=recordErrors.length?'partial':items.length?'ready':'empty';
    return success({status,items,next_cursor:nextCursor,record_errors:recordErrors},
      'privy_transactions',status==='partial');
  }

  function validateBalanceArgs(value){
    const snapshot=snapshotLoopRecord(
      value,[],['asset_id','chain_id'],'balance filters');
    if(snapshot.asset_id!==undefined) requireEnum(snapshot.asset_id,ASSETS,'asset_id');
    if(snapshot.chain_id!==undefined) requireEnum(snapshot.chain_id,CHAINS,'chain_id');
    return snapshot;
  }

  function validateHistoryArgs(value){
    const snapshot=snapshotLoopRecord(
      value,['asset_id','chain_id'],['cursor'],'history request');
    requireEnum(snapshot.asset_id,ASSETS,'asset_id');
    requireEnum(snapshot.chain_id,CHAINS,'chain_id');
    if(snapshot.cursor!==undefined&&!isSafeOpaque(snapshot.cursor)){
      throw new TypeError('cursor is invalid');
    }
    return snapshot;
  }

  function validateIdArgs(value,label,key){
    const snapshot=snapshotLoopRecord(value,[key],[],label);
    if(!isSafeOpaque(snapshot[key])) throw new TypeError(key+' is invalid');
    return snapshot;
  }

  function validateReceiveArgs(value){
    const snapshot=snapshotLoopRecord(
      value,['asset_id','chain_id'],[],'receive request');
    requireEnum(snapshot.asset_id,ASSETS,'asset_id');
    requireEnum(snapshot.chain_id,CHAINS,'chain_id');
    const compatible=snapshot.asset_id==='SOL'?snapshot.chain_id==='solana':
      snapshot.asset_id==='GLYPH'?snapshot.chain_id==='base':snapshot.chain_id!=='solana';
    if(!compatible) throw new TypeError('asset and chain are incompatible');
    return snapshot;
  }

  function walletSnapshot(walletClass){
    if(walletClass==='privy_embedded'){
      return success({
        wallet_class:walletClass,wallet_ref:'fixture-wallet-1',
        addresses:[
          {chain_type:'ethereum',address:'0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821'},
          {chain_type:'solana',address:'9tXr2QmVX7gDhnJbYaL5N3F4Kp8WcE6sZ1uAqR7vM2Lo'}
        ],
        capabilities:{balances:'supported',history:'supported',receive:'supported',
          transfer:'supported',swap:'supported',approve:'spike_required'}
      },'privy_flutter');
    }
    if(walletClass==='connected_external'){
      return success({
        wallet_class:walletClass,wallet_ref:null,
        addresses:[{chain_type:'ethereum',
          address:'0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721'}],
        capabilities:{balances:'provider_gap',history:'provider_gap',receive:'supported',
          transfer:'external_provider',swap:'provider_gap',approve:'external_provider'}
      },'external_wallet');
    }
    return success({
      wallet_class:walletClass,wallet_ref:null,
      addresses:[{chain_type:'ethereum',
        address:'0xA11CE00000000000000000000000000000000F01'}],
      capabilities:{balances:'provider_gap',history:'provider_gap',receive:'supported',
        transfer:'unsupported',swap:'unsupported',approve:'unsupported'}
    },'prototype_fixture');
  }

  function normalBalances(includeGlyph){
    const balances=[
      {chain:'base',asset:'eth',raw_value:'1000000000000000000',raw_value_decimals:18,
        display_values:{eth:'1',usd:'2560.00'}},
      {chain:'base',asset:'usdc',raw_value:'10000000',raw_value_decimals:6,
        display_values:{usdc:'10',usd:'10.00'}},
      {chain:'solana',asset:'sol',raw_value:'2500000000',raw_value_decimals:9,
        display_values:{sol:'2.5',usd:'350.50'}}
    ];
    if(includeGlyph){
      balances.push({chain:'base',asset:'glyph',raw_value:'125000000',
        raw_value_decimals:6,display_values:{glyph:'125'}});
    }
    return balances;
  }

  const STALE_ARBITRUM_ETH=deepFreeze({balances:[{
    chain:'arbitrum',asset:'eth',raw_value:'500000000000000000',
    raw_value_decimals:18,display_values:{eth:'0.5',usd:'1280.00'}
  }]});

  function loadingBalanceSnapshot(){
    return success({
      status:'loading',items:[],
      loop_total:{value:null,currency:'USD',
        label:'LOOP total derived from Privy balances',excluded_asset_count:0},
      chain_errors:[]
    },'privy_balance');
  }

  function loadingHistorySnapshot(){
    return success({status:'loading',items:[],next_cursor:null,record_errors:[]},
      'privy_transactions');
  }

  function balanceFixture(scenario,filters){
    if(scenario==='empty') return {balances:[]};
    let balances=normalBalances(scenario==='provider_succeeded_demo');
    if(filters.asset_id!==undefined){
      balances=balances.filter(item=>item.asset.toUpperCase()===filters.asset_id);
    }
    if(filters.chain_id!==undefined){
      balances=balances.filter(item=>item.chain===filters.chain_id);
    }
    if(scenario==='partial'){
      balances=balances.concat([{chain:'arbitrum',asset:'eth',raw_value:'unavailable',
        raw_value_decimals:18,display_values:{eth:'0'}}]);
    }
    return {balances};
  }

  function historyFixture(assetId,chainId,scenario,cursor){
    if(scenario==='empty') return {transactions:[],next_cursor:null};
    const asset=assetId.toLowerCase();
    const decimals=assetId==='USDC'||assetId==='GLYPH'?6:assetId==='SOL'?9:18;
    const transactions=[{
      privy_transaction_id:'fixture-tx-1',
      transaction_hash:'0x71d96d51c7eD983A21B46af2C9b82363d1A0394f',
      status:'confirmed',created_at:1746920539240,
      details:{type:'transfer_received',chain:chainId,asset,
        sender:'0x11aA00000000000000000000000000000000011',
        recipient:'0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821',
        raw_value:'1',raw_value_decimals:decimals,
        display_values:{[asset]:formatBaseUnits('1',decimals,assetId).split(' ')[0]}}
    }];
    if(scenario==='partial'){
      transactions.push({privy_transaction_id:'',transaction_hash:'',
        status:'pending',created_at:1746920539241});
    }
    return {transactions,next_cursor:cursor===undefined?'opaque-fixture-cursor':null};
  }

  function receiveAddress(walletClass,chainId){
    if(chainId==='solana') return walletClass==='watch_only'?
      '7ZcYH8qVvK2npW4rN1MsB6aFd3xE9tGj5uLoPqR7iS4D':
      '9tXr2QmVX7gDhnJbYaL5N3F4Kp8WcE6sZ1uAqR7vM2Lo';
    if(walletClass==='connected_external'){
      return '0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721';
    }
    if(walletClass==='watch_only'){
      return '0xA11CE00000000000000000000000000000000F01';
    }
    return '0x7E57D0041C5B5e9B6F3A9E64A2C8D1F0B4C6A821';
  }

  const ACTION_FIXTURES=deepFreeze({
    'action-pending':{status:'pending'},
    'action-rejected':{status:'rejected'},
    'action-failed':{status:'failed'},
    'action-succeeded':{status:'succeeded'}
  });

  const REVIEW_USDC='0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const REVIEW_SPENDER='0x2222222222222222222222222222222222222222';
  const REVIEW_LIMITED_CALLDATA=
    '0x095ea7b3000000000000000000000000'+REVIEW_SPENDER.slice(2)+
    '000000000000000000000000000000000000000000000000000000003b9aca00';
  const REVIEW_UNLIMITED_CALLDATA=
    '0x095ea7b3000000000000000000000000'+REVIEW_SPENDER.slice(2)+
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

  function reviewApproval(allowanceKind){
    return {chain_id:'ethereum',token_address:REVIEW_USDC,
      spender_address:REVIEW_SPENDER,dapp_origin:'https://swap.zone',
      allowance_kind:allowanceKind,
      limit_base_units:allowanceKind==='limited'?'1000000000':null,
      calldata:allowanceKind==='limited'?REVIEW_LIMITED_CALLDATA:
        REVIEW_UNLIMITED_CALLDATA,value:'0'};
  }

  function reviewQuote(status='available',output='216450000000',
    quoteId='privy-quote-1',routeId='privy-route-1',input='500000000',
    receivedAt=100000,providerExpiry=140000){
    return {response:{status,quote_id:quoteId,route_id:routeId,chain_id:'ethereum',
      input_token_address:REVIEW_USDC,
      output_token_address:'0x0000000000000000000000000000000000000a11',
      input_amount_base_units:input,output_amount_base_units:output,
      minimum_output_amount_base_units:output==='216500000000'?
        '215417500000':'215367750000',fee_amount_base_units:'500000',
      fee_asset_id:'USDC',provider_expiry_ms:providerExpiry},
      received_at_ms:receivedAt,
      freshness_deadline_ms:Math.min(providerExpiry,receivedAt+30000)};
  }

  const REFRESH_WINDOWS=[130000,160000,190000,220000,250000,280000,310000,
    340000,370000,400000,430000,460000,490000];
  const refreshReviewId=receivedAt=>receivedAt===130000?
    'review-swap-refresh-late':'review-swap-refresh-'+String(receivedAt/1000);
  const refreshReviewFixture=receivedAt=>({kind:'swap',outcome:'pending',
    wallet_class:'privy_embedded',status:'available',preview:reviewQuote(
      'available','216500000000','privy-quote-r'+String(receivedAt/1000),
      'privy-route-r'+String(receivedAt/1000),'500000000',receivedAt,500000)});

  const REVIEW_FIXTURES=deepFreeze({
    'review-transfer':{kind:'transfer',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-transfer-late':{kind:'transfer',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-pending':{kind:'transfer',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-rejected':{kind:'transfer',outcome:'rejected',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-policy':{kind:'transfer',outcome:'policy',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-failed':{kind:'transfer',outcome:'failed',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-approve':{kind:'approve',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-approve-limited':{kind:'approve',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-approve-unlimited':{kind:'approve',outcome:'pending',wallet_class:'privy_embedded',status:'unavailable',preview:null},
    'review-approve-mismatch':{kind:'approve',outcome:'blocked',wallet_class:'privy_embedded',status:'blocked',preview:null},
    'review-swap':{kind:'swap',outcome:'pending',wallet_class:'privy_embedded',status:'available',preview:reviewQuote()},
    'review-swap-fresh':{kind:'swap',outcome:'pending',wallet_class:'privy_embedded',status:'available',preview:reviewQuote()},
    'review-swap-stale':{kind:'swap',outcome:'blocked',wallet_class:'privy_embedded',status:'stale',preview:reviewQuote('stale')},
    'review-swap-unavailable':{kind:'swap',outcome:'blocked',wallet_class:'privy_embedded',status:'unavailable',preview:reviewQuote('unavailable')},
    'review-swap-no-liquidity':{kind:'swap',outcome:'blocked',wallet_class:'privy_embedded',status:'no_liquidity',preview:reviewQuote('no_liquidity')},
    'review-swap-refresh':{kind:'swap',outcome:'pending',wallet_class:'privy_embedded',status:'available',preview:reviewQuote('available','216500000000','privy-quote-2','privy-route-2')},
    ...Object.fromEntries(REFRESH_WINDOWS.map(receivedAt=>
      [refreshReviewId(receivedAt),refreshReviewFixture(receivedAt)])),
    'review-swap-refresh-input-changed':{kind:'swap',outcome:'pending',wallet_class:'privy_embedded',status:'available',preview:reviewQuote('available','216500000000','privy-quote-2','privy-route-2','400000000')},
    'review-perp':{kind:'perp_order',outcome:'blocked',wallet_class:'privy_embedded',status:'blocked',preview:null},
    'review-transfer-external':{kind:'transfer',outcome:'pending',wallet_class:'connected_external',status:'unavailable',preview:null},
    'review-approve-external':{kind:'approve',outcome:'pending',wallet_class:'connected_external',status:'unavailable',preview:reviewApproval('limited')},
    'review-approve-unlimited-external':{kind:'approve',outcome:'pending',wallet_class:'connected_external',status:'unavailable',preview:reviewApproval('unlimited')},
    'review-swap-external':{kind:'swap',outcome:'blocked',wallet_class:'connected_external',status:'provider_gap',preview:null},
    'review-perp-external':{kind:'perp_order',outcome:'blocked',wallet_class:'connected_external',status:'blocked',preview:null}
  });

  function ownFixture(fixtures,id){
    return Object.prototype.hasOwnProperty.call(fixtures,id)?fixtures[id]:null;
  }

  function createSimulatedAdapter(options){
    const safeOptions=snapshotLoopRecord(
      options,['walletClass','scenario'],[],'adapter options');
    requireEnum(safeOptions.walletClass,WALLET_CLASSES,'walletClass');
    requireEnum(safeOptions.scenario,SCENARIOS,'scenario');
    const walletClass=safeOptions.walletClass;
    const scenario=safeOptions.scenario;
    const compatible=walletClass==='privy_embedded'?
      ['normal','empty','loading','partial','provider_succeeded_demo'].includes(scenario):
      walletClass==='connected_external'?scenario==='external_gap':scenario==='watch_only';
    if(!compatible) throw new TypeError('walletClass and scenario are incompatible');

    function getWalletSnapshot(){
      if(arguments.length!==0) throw new TypeError('wallet snapshot takes no arguments');
      return walletSnapshot(walletClass);
    }

    function getBalanceSnapshot(filters){
      const selected=validateBalanceArgs(filters);
      if(walletClass!=='privy_embedded') return failure('PROVIDER_GAP',
        'Balance provider not available for this wallet.');
      if(scenario==='loading') return loadingBalanceSnapshot();
      if(scenario==='normal'&&selected.asset_id==='ETH'&&
         selected.chain_id==='arbitrum'){
        const cached=normalizeBalanceResponse(STALE_ARBITRUM_ETH);
        return staleSuccess(cached.value,'privy_balance',1746920539240);
      }
      return normalizeBalanceResponse(balanceFixture(scenario,selected));
    }

    function getTransactionHistorySnapshot(request){
      const selected=validateHistoryArgs(request);
      if(walletClass!=='privy_embedded') return failure('PROVIDER_GAP',
        'Transaction history is not available for this wallet.');
      if(scenario==='loading') return loadingHistorySnapshot();
      return normalizeTransactionPage(historyFixture(
        selected.asset_id,selected.chain_id,scenario,selected.cursor));
    }

    function getWalletActionSnapshot(request){
      const selected=validateIdArgs(request,'wallet action request','action_id');
      if(walletClass!=='privy_embedded') return failure('PROVIDER_GAP',
        'Privy Wallet Actions are not available for this wallet.');
      const fixture=ownFixture(ACTION_FIXTURES,selected.action_id);
      if(!fixture) return failure('ACTION_FAILED','Unknown wallet action fixture.');
      if(fixture.status==='succeeded'&&scenario!=='provider_succeeded_demo'){
        return failure('ACTION_FAILED','Completed action fixture is not active.');
      }
      return success({action_id:selected.action_id,status:fixture.status},
        'privy_wallet_action');
    }

    function getReceiveTarget(request){
      const selected=validateReceiveArgs(request);
      if(selected.chain_id==='solana'&&walletClass!=='privy_embedded'){
        return failure('PROVIDER_GAP',
          'A Solana receive address is not available for this wallet.');
      }
      return success({asset_id:selected.asset_id,chain_id:selected.chain_id,
        address:receiveAddress(walletClass,selected.chain_id)},
      walletClass==='privy_embedded'?'privy_flutter':
        walletClass==='connected_external'?'external_wallet':'prototype_fixture');
    }

    function getReviewPreview(request){
      const selected=validateIdArgs(request,'review preview request','review_id');
      if(walletClass==='watch_only') return failure('UNSUPPORTED_WALLET');
      const fixture=ownFixture(REVIEW_FIXTURES,selected.review_id);
      if(!fixture) return failure('ACTION_FAILED','Unknown review fixture.');
      if(fixture.wallet_class!==walletClass) return failure('PROVIDER_GAP',
        'This review does not belong to the active wallet provider.');
      const preview=fixture.preview===null?null:fixture.kind==='swap'?
        {response:{...fixture.preview.response},
          received_at_ms:fixture.preview.received_at_ms,
          freshness_deadline_ms:fixture.preview.freshness_deadline_ms}:
        {...fixture.preview};
      return success({review_id:selected.review_id,wallet_class:walletClass,
        kind:fixture.kind,status:fixture.status,preview},
        walletClass==='connected_external'?'external_wallet':'prototype_fixture');
    }

    function handoffReview(request){
      const selected=validateIdArgs(request,'review handoff request','review_id');
      if(walletClass==='watch_only') return failure('UNSUPPORTED_WALLET');
      const fixture=ownFixture(REVIEW_FIXTURES,selected.review_id);
      if(!fixture) return failure('ACTION_FAILED','Unknown review fixture.');
      if(fixture.wallet_class!==walletClass) return failure('PROVIDER_GAP',
        'This review does not belong to the active wallet provider.');
      if(fixture.kind==='perp_order') return failure('PERP_EXECUTION_PENDING');
      if(walletClass==='connected_external'&&fixture.kind==='swap'){
        return failure('PROVIDER_GAP','Swap is not available for this external wallet.');
      }
      if(fixture.outcome==='blocked') return failure('PROVIDER_UNAVAILABLE',
        fixture.kind==='swap'?'A fresh Privy quote is required.':
          'The immutable approval semantics do not match the reviewed calldata.');
      if(walletClass==='privy_embedded'&&fixture.kind==='approve'){
        return failure('PROVIDER_GAP',
          'Approval handoff requires the production Privy method spike.');
      }
      if(fixture.outcome==='rejected') return failure('USER_REJECTED');
      if(fixture.outcome==='policy') return failure('POLICY_REJECTED');
      if(fixture.outcome==='failed') return failure('ACTION_FAILED');
      const isExternal=walletClass==='connected_external';
      return success({review_id:selected.review_id,
        action_id:isExternal?null:'action-pending',
        status:isExternal?'provider_confirmation_pending':'handoff_pending'},
      isExternal?'external_wallet':'privy_wallet_action');
    }

    return Object.freeze({getWalletSnapshot,getBalanceSnapshot,
      getTransactionHistorySnapshot,getWalletActionSnapshot,getReceiveTarget,
      getReviewPreview,handoffReview});
  }

  globalThis.LoopWalletProvider=Object.freeze({
    createSimulatedAdapter,normalizeBalanceResponse,normalizeTransactionPage,
    formatBaseUnits,addDecimalStrings
  });
})();
