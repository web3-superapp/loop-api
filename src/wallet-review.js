(function(){
  'use strict';

  const MAX_TEXT=256,MAX_AMOUNT=100,MAX_SESSIONS=5,TTL=300000,MAX_TIME=8640000000000000;
  const ENDPOINT='/v1/wallets/fixture-wallet-1/actions',WALLET='fixture-wallet-1';
  const USER='fixture-user-1',DEST='0x71C700000000000000000000000000000000F0A2';
  const EXTERNAL_ADDRESS='0xE87A4C2D1F9B6A3058C7E4D2B1A093F6C5E8D721';
  const SPENDER='0x2222222222222222222222222222222222222222';
  const USDC='0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const GLYPH='0x0000000000000000000000000000000000000a11';
  const LIMITED='0x095ea7b3'+'0000000000000000000000002222222222222222222222222222222222222222'+
    '000000000000000000000000000000000000000000000000000000003b9aca00';
  const UNLIMITED='0x095ea7b3'+'0000000000000000000000002222222222222222222222222222222222222222'+
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const PERP_REASON='Privy + Hyperliquid execution requires the production capability spike.';
  const CLASSES=['privy_embedded','connected_external'];

  function freeze(value){
    if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
      Reflect.ownKeys(value).forEach(key=>freeze(value[key]));Object.freeze(value);
    }
    return value;
  }
  function frozenData(value){
    if(value===null||typeof value!=='object')return true;
    if(!Object.isFrozen(value))return false;
    const proto=Object.getPrototypeOf(value);
    if(Array.isArray(value)){if(proto!==Array.prototype)return false;}
    else if(proto!==Object.prototype&&proto!==null)return false;
    const found=Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(found).every(key=>typeof key==='string'&&
      Object.prototype.hasOwnProperty.call(found[key],'value')&&
      frozenData(found[key].value));
  }
  function descriptors(value,label){
    if(value===null||typeof value!=='object'||Array.isArray(value)) throw new TypeError(label);
    const proto=Object.getPrototypeOf(value);
    if(proto!==Object.prototype&&proto!==null) throw new TypeError(label);
    const result=Object.getOwnPropertyDescriptors(value);
    if(Reflect.ownKeys(result).some(key=>typeof key!=='string'||
       !Object.prototype.hasOwnProperty.call(result[key],'value'))) throw new TypeError(label);
    return result;
  }
  function record(value,required,optional,label){
    const found=descriptors(value,label),allowed=required.concat(optional||[]);
    const keys=Reflect.ownKeys(found);
    if(required.some(key=>!Object.prototype.hasOwnProperty.call(found,key))||
       keys.some(key=>!allowed.includes(key))) throw new TypeError(label+' keys');
    const result=Object.create(null);keys.forEach(key=>{result[key]=found[key].value;});
    return result;
  }
  function array(value,max,label){
    if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max){
      throw new TypeError(label);
    }
    const found=Object.getOwnPropertyDescriptors(value),allowed=['length'],result=[];
    for(let index=0;index<value.length;index+=1){
      const key=String(index),item=found[key];allowed.push(key);
      if(!item||!Object.prototype.hasOwnProperty.call(item,'value')) throw new TypeError(label);
      result.push(item.value);
    }
    if(Reflect.ownKeys(found).some(key=>typeof key!=='string'||!allowed.includes(key))){
      throw new TypeError(label);
    }
    return result;
  }
  function text(value,label,max=MAX_TEXT){
    if(typeof value!=='string'||!value||value.length>max||value.trim()!==value||
       /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(label);
    return value;
  }
  function adapterErrorMessage(code){
    switch(code){
      case 'UNAUTHENTICATED':return 'Sign in to use this wallet.';
      case 'UNSUPPORTED_WALLET':
        return 'Watch-only wallets cannot authorize signing requests.';
      case 'PROVIDER_GAP':
        return 'This provider capability is not available for this wallet.';
      case 'MALFORMED_PROVIDER_RESPONSE':
        return 'The wallet provider returned data LOOP could not safely use.';
      case 'PROVIDER_UNAVAILABLE':
        return 'The wallet provider is temporarily unavailable.';
      case 'USER_REJECTED':return 'The wallet request was rejected by the user.';
      case 'POLICY_REJECTED':
        return 'The wallet request was blocked by provider policy.';
      case 'ACTION_FAILED':return 'The wallet action did not complete.';
      case 'PERP_EXECUTION_PENDING':return PERP_REASON;
      default:return null;
    }
  }
  function exact(value,expected,label){text(value,label);if(value!==expected)throw new TypeError(label);return value;}
  function time(value,label){
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>MAX_TIME){
      throw new TypeError(label);
    }
    return value;
  }
  function integer(value,label,positive=false){
    if(typeof value!=='string'||value.length>MAX_AMOUNT||!/^(?:0|[1-9][0-9]*)$/.test(value)||
       (positive&&!/[1-9]/.test(value))) throw new TypeError(label);
    return value;
  }
  function decimal(value,places,label){
    if(typeof value!=='string'||value.length>MAX_AMOUNT||
       !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)||
       (value.split('.')[1]||'').length>places||!/[1-9]/.test(value.replace('.',''))){
      throw new TypeError(label);
    }
    return value;
  }
  function toBase(value,places,label){
    decimal(value,places,label);const parts=value.split('.'),fraction=parts[1]||'';
    const result=(parts[0]+fraction.padEnd(places,'0')).replace(/^0+(?=\d)/,'')||'0';
    const padded=result.padStart(places+1,'0'),whole=places?padded.slice(0,-places):padded;
    const round=whole+(fraction?'.'+padded.slice(-places).slice(0,fraction.length):'');
    if(round!==value) throw new TypeError(label+' round trip');return result;
  }
  function fromBase(value,places){
    integer(value,'base units');const padded=value.padStart(places+1,'0');
    const whole=places?padded.slice(0,-places):padded;
    const fraction=places?padded.slice(-places).replace(/0+$/,''):'';
    return whole+(fraction?'.'+fraction:'');
  }
  function commas(value){const parts=value.split('.');return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',')+(parts[1]?'.'+parts[1]:'');}
  function canonical(value){
    if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
    if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new TypeError('number');return String(value);}
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>
      JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
    throw new TypeError('canonical value');
  }

  // Small synchronous SHA-256 for deterministic prototype-fixture equality only. It does not
  // sign, authorize, encode ABI data, or replace the production Privy/BFF trust boundary.
  function sha256(message){
    const bytes=new TextEncoder().encode(message),bits=bytes.length*8;
    const length=((bytes.length+72)>>6)<<6,data=new Uint8Array(length);data.set(bytes);data[bytes.length]=128;
    const view=new DataView(data.buffer);view.setUint32(length-8,Math.floor(bits/4294967296));
    view.setUint32(length-4,bits>>>0);
    const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64);
    const ro=(x,n)=>(x>>>n)|(x<<(32-n));
    for(let offset=0;offset<length;offset+=64){
      for(let i=0;i<16;i+=1)w[i]=view.getUint32(offset+i*4);
      for(let i=16;i<64;i+=1){const a=ro(w[i-15],7)^ro(w[i-15],18)^(w[i-15]>>>3),b=ro(w[i-2],17)^ro(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+a+w[i-7]+b)>>>0;}
      let [a,b,c,d,e,f,g,z]=h;
      for(let i=0;i<64;i+=1){const s1=ro(e,6)^ro(e,11)^ro(e,25),ch=(e&f)^((~e)&g),t1=(z+s1+ch+k[i]+w[i])>>>0,s0=ro(a,2)^ro(a,13)^ro(a,22),maj=(a&b)^(a&c)^(b&c),t2=(s0+maj)>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+z)>>>0;
    }
    return h.map(value=>value.toString(16).padStart(8,'0')).join('');
  }
  const digest=value=>'sha256:'+sha256(canonical(value));
  function checkedDigest(value,label){if(typeof value!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value))throw new TypeError(label);return value;}

  const TOKENS=freeze({ETH:{asset_id:'ETH',address:'native:ethereum',decimals:18,symbol:'ETH'},USDC:{asset_id:'USDC',address:USDC,decimals:6,symbol:'USDC'},GLYPH:{asset_id:'GLYPH',address:GLYPH,decimals:6,symbol:'GLYPH'}});
  function metadata(value){
    const seen=new Set();return array(value,4,'metadata').map(raw=>{
      const item=record(raw,['asset_id','address','decimals','symbol'],[],'metadata item'),trusted=TOKENS[item.asset_id];
      if(!trusted||seen.has(item.asset_id)||item.address!==trusted.address||item.decimals!==trusted.decimals||item.symbol!==trusted.symbol)throw new TypeError('metadata mismatch');
      seen.add(item.asset_id);return {...trusted};
    });
  }
  function labels(value){const item=record(value,['spender','provider','environment'],[],'labels');['spender','provider','environment'].forEach(key=>{if(item[key]!==null)text(item[key],key,128);});return {...item};}
  function dapp(value){if(value===null)return null;const item=record(value,['origin','allowlisted_label'],[],'dapp');exact(item.origin,'https://swap.zone','origin');exact(item.allowlisted_label,'Swap.zone','label');return {...item};}
  function response(value){
    const common=['status','chain_id','input_token_address','output_token_address','input_amount_base_units','provider_expiry_ms'];
    const found=descriptors(value,'quote'),keys=Reflect.ownKeys(found);
    const full=keys.includes('quote_id');
    const expected=full?common.concat(['quote_id','route_id','output_amount_base_units','minimum_output_amount_base_units','fee_amount_base_units','fee_asset_id']):common;
    const item=record(value,expected,[],'quote');
    if(full){
      if(!['available','unavailable','no_liquidity','stale'].includes(item.status))throw new TypeError('quote status');
      text(item.quote_id,'quote id');text(item.route_id,'route id');
      ['output_amount_base_units','minimum_output_amount_base_units'].forEach(key=>integer(item[key],key,true));
      integer(item.fee_amount_base_units,'fee');exact(item.fee_asset_id,'USDC','fee asset');
    }else if(!['unavailable','no_liquidity'].includes(item.status))throw new TypeError('quote status');
    if(!['ethereum','base'].includes(item.chain_id))throw new TypeError('quote chain');if(![USDC,GLYPH].includes(item.input_token_address))throw new TypeError('input token');if(![USDC,GLYPH].includes(item.output_token_address))throw new TypeError('output token');integer(item.input_amount_base_units,'input_amount_base_units',true);
    if(item.provider_expiry_ms!==null)time(item.provider_expiry_ms,'provider expiry');return {...item};
  }
  function quote(value){
    if(value===null)return null;const item=record(value,['response','received_at_ms','freshness_deadline_ms'],[],'quote context'),preview=response(item.response),received=time(item.received_at_ms,'received'),deadline=time(item.freshness_deadline_ms,'deadline');
    const expected=preview.provider_expiry_ms===null?received+30000:Math.min(preview.provider_expiry_ms,received+30000);if(deadline!==expected)throw new TypeError('deadline mismatch');return {response:preview,received_at_ms:received,freshness_deadline_ms:deadline};
  }
  function walletIdentity(value,walletClass){
    if(walletClass==='privy_embedded'){
      const item=record(value,['kind','wallet_id'],[],'wallet identity');
      exact(item.kind,'privy_wallet','wallet identity kind');
      exact(item.wallet_id,WALLET,'wallet identity wallet');
      return {kind:item.kind,wallet_id:item.wallet_id};
    }
    const item=record(value,['kind','chain_type','address'],[],'wallet identity');
    exact(item.kind,'external_connector','wallet identity kind');
    exact(item.chain_type,'ethereum','wallet identity chain');
    exact(item.address,EXTERNAL_ADDRESS,'wallet identity address');
    return {kind:item.kind,chain_type:item.chain_type,address:item.address};
  }
  function context(value){
    const item=record(value,['wallet_class','wallet_identity','provenance','token_metadata','dapp','quote','labels'],[],'context');if(!CLASSES.includes(item.wallet_class))throw new TypeError('wallet class');text(item.provenance,'provenance',128);return {wallet_class:item.wallet_class,wallet_identity:walletIdentity(item.wallet_identity,item.wallet_class),provenance:item.provenance,token_metadata:metadata(item.token_metadata),dapp:dapp(item.dapp),quote:quote(item.quote),labels:labels(item.labels)};
  }
  function transfer(value,walletClass){
    const item=record(value,['request_id','endpoint','method','chain_id','token_address','destination','source','amount_type','fee_display'],['amount'],'transfer'),source=record(item.source,['amount'],[],'source amount');
    text(item.request_id,'request id');exact(item.endpoint,walletClass==='privy_embedded'?ENDPOINT:'external_wallet:request','endpoint');exact(item.method,'transfer','method');exact(item.chain_id,'ethereum','chain');exact(item.token_address,'native:ethereum','token');exact(item.destination,DEST,'destination');decimal(source.amount,18,'source amount');if(!['exact_input','exact_output'].includes(item.amount_type))throw new TypeError('amount type');if(item.fee_display!==null)text(item.fee_display,'fee');
    const result={request_id:item.request_id,endpoint:item.endpoint,method:item.method,chain_id:item.chain_id,token_address:item.token_address,destination:item.destination};if(Object.prototype.hasOwnProperty.call(item,'amount')){decimal(item.amount,18,'amount');result.amount=item.amount;}result.source={amount:source.amount};result.amount_type=item.amount_type;result.fee_display=item.fee_display;return result;
  }
  function approval(value,walletClass){
    const item=record(value,['request_id','endpoint','method','chain_id','token_address','spender','calldata','value','approval'],[],'approval');text(item.request_id,'request id');exact(item.endpoint,walletClass==='privy_embedded'?'eth_sendTransaction':'external_wallet:request','endpoint');exact(item.method,'approve','method');exact(item.chain_id,'ethereum','chain');exact(item.token_address,USDC,'token');exact(item.spender,SPENDER,'spender');text(item.calldata,'calldata',300);exact(item.value,'0','value');
    const base=record(item.approval,['type'],['limit_base_units'],'semantics');let semantics;if(base.type==='limited'){const limit=record(item.approval,['type','limit_base_units'],[],'limited');exact(limit.limit_base_units,'1000000000','limit');if(item.calldata!==LIMITED)throw new TypeError('limited calldata mismatch');semantics={type:'limited',limit_base_units:limit.limit_base_units};}else if(base.type==='unlimited'){record(item.approval,['type'],[],'unlimited');if(item.calldata!==UNLIMITED)throw new TypeError('unlimited calldata mismatch');semantics={type:'unlimited'};}else throw new TypeError('semantics');
    return {request_id:item.request_id,endpoint:item.endpoint,method:item.method,chain_id:item.chain_id,token_address:item.token_address,spender:item.spender,calldata:item.calldata,value:item.value,approval:semantics};
  }
  function swap(value,walletClass){
    const keys=['request_id','endpoint','method','chain_id','input_token_address','output_token_address','input_amount_base_units','quote_id','route_id'],item=record(value,keys,[],'swap');text(item.request_id,'request id');exact(item.endpoint,walletClass==='privy_embedded'?ENDPOINT:'external_wallet:swap','endpoint');exact(item.method,'swap','method');exact(item.chain_id,'ethereum','chain');exact(item.input_token_address,USDC,'input');exact(item.output_token_address,GLYPH,'output');integer(item.input_amount_base_units,'input amount',true);text(item.quote_id,'quote id');text(item.route_id,'route id');return {...item};
  }
  function perp(value){
    const keys=['request_id','endpoint','method','chain_id','market','side','order_type','size','leverage','reduce_only','environment'],item=record(value,keys,[],'perp');text(item.request_id,'request id');exact(item.endpoint,'hyperliquid:testnet','endpoint');exact(item.method,'order','method');exact(item.chain_id,'hyperliquid-testnet','chain');exact(item.market,'ETH','market');exact(item.side,'buy','side');exact(item.order_type,'market','order');decimal(item.size,18,'size');decimal(item.leverage,2,'leverage');if(typeof item.reduce_only!=='boolean')throw new TypeError('reduce');exact(item.environment,'testnet','environment');return {...item};
  }
  function execution(value,kind,walletClass){
    const item=record(value,['provider_path','wallet_id','payload','execution_digest'],[],'execution');
    const paths=walletClass==='privy_embedded'?{transfer:'privy_wallet_action',approve:'privy_flutter_rpc',swap:'privy_wallet_action',perp_order:'hyperliquid'}:{transfer:'external_wallet',approve:'external_wallet',swap:'provider_gap',perp_order:'hyperliquid'};
    exact(item.provider_path,paths[kind],'path');
    if(walletClass==='privy_embedded')exact(item.wallet_id,WALLET,'wallet');else if(item.wallet_id!==null)throw new TypeError('wallet');
    const payload=kind==='transfer'?transfer(item.payload,walletClass):kind==='approve'?approval(item.payload,walletClass):kind==='swap'?swap(item.payload,walletClass):perp(item.payload);const proof=checkedDigest(item.execution_digest,'execution digest');if(proof!==digest(payload))throw new TypeError('execution digest mismatch');return {provider_path:item.provider_path,wallet_id:item.wallet_id,payload,execution_digest:proof};
  }
  function source(value){
    const item=record(value,['kind','execution','context','source_digest','expires_at_ms'],[],'source');if(!['transfer','approve','swap','perp_order'].includes(item.kind))throw new TypeError('kind');const boundContext=context(item.context),result={kind:item.kind,execution:execution(item.execution,item.kind,boundContext.wallet_class),context:boundContext,source_digest:checkedDigest(item.source_digest,'source digest'),expires_at_ms:time(item.expires_at_ms,'expiry')};if(result.source_digest!==digest({kind:result.kind,execution:result.execution,context:result.context,expires_at_ms:result.expires_at_ms}))throw new TypeError('source digest mismatch');return freeze(result);
  }
  function token(bound,address){const found=bound.context.token_metadata.find(item=>item.address===address);if(!found)throw new TypeError('token metadata missing');return found;}
  const prov=value=>freeze(value);
  function transferModel(bound){
    const embedded=bound.context.wallet_class==='privy_embedded',expectedProvenance=embedded?'privy_transfer_request':'prototype_fixture',expectedProvider=embedded?'Privy':'External wallet';
    if(bound.context.provenance!==expectedProvenance||bound.context.quote!==null||bound.context.dapp!==null||bound.context.labels.provider!==expectedProvider)throw new TypeError('transfer context');const payload=bound.execution.payload,asset=token(bound,payload.token_address),amount=Object.prototype.hasOwnProperty.call(payload,'amount')?payload.amount:payload.source.amount,base=toBase(amount,asset.decimals,'effective amount'),provider=embedded?'Privy':'the external wallet';return freeze({version:1,id:payload.request_id,kind:'transfer',wallet_class:bound.context.wallet_class,wallet_ref:bound.execution.wallet_id,chain_id:payload.chain_id,provenance:bound.context.provenance,provider_preview:'available',expires_at_ms:bound.expires_at_ms,summary:'You are preparing to ask '+provider+' to send '+amount+' '+asset.symbol+' on Ethereum to '+payload.destination.slice(0,6)+'…'+payload.destination.slice(-4)+'.',fields:{wallet_address:embedded?null:bound.context.wallet_identity.address,amount_decimal:amount,amount_base_units:base,source_amount:payload.source.amount,amount_type:payload.amount_type,amount_semantics:payload.amount_type==='exact_input'?'sent':'received',asset_id:asset.asset_id,chain_id:payload.chain_id,destination:payload.destination,fee_display:payload.fee_display,field_provenance:prov({wallet:'digest_bound_provider',amount:'digest_bound_provider',asset:'digest_bound_provider',chain:'digest_bound_provider',destination:'digest_bound_provider',amount_type:'digest_bound_provider',fee:payload.fee_display===null?'unavailable':'digest_bound_provider'})},handoff_eligible:true,refreshable:false,primary_action:embedded?'Continue with Privy':'Continue to external wallet',blocking_error:null});
  }
  function approvalModel(bound){
    const embedded=bound.context.wallet_class==='privy_embedded',expectedProvider=embedded?'Privy Flutter':'External wallet';if(bound.context.provenance!=='dapp_request'||!bound.context.dapp||bound.context.quote!==null||bound.context.labels.spender!=='Swap.zone'||bound.context.labels.provider!==expectedProvider)throw new TypeError('approval context');const payload=bound.execution.payload,asset=token(bound,payload.token_address),limited=payload.approval.type==='limited',display=limited?commas(fromBase(payload.approval.limit_base_units,asset.decimals)):null;return freeze({version:1,id:payload.request_id,kind:'approve',wallet_class:bound.context.wallet_class,wallet_ref:bound.execution.wallet_id,chain_id:payload.chain_id,provenance:bound.context.provenance,provider_preview:embedded?'unavailable':'available',expires_at_ms:bound.expires_at_ms,summary:limited?'You are reviewing a request for Swap.zone to spend up to '+display+' USDC on Ethereum.':'You are reviewing a request for Swap.zone to spend unlimited USDC on Ethereum.',fields:{wallet_address:embedded?null:bound.context.wallet_identity.address,asset_id:asset.asset_id,chain_id:payload.chain_id,spender_label:bound.context.labels.spender,spender_address:payload.spender,dapp_origin:bound.context.dapp.origin,allowance_kind:payload.approval.type,limit_base_units:limited?payload.approval.limit_base_units:null,calldata:payload.calldata,value:payload.value,field_provenance:prov({wallet:'digest_bound_provider',asset:'digest_bound_provider',chain:'digest_bound_provider',spender:'digest_bound_provider',origin:'digest_bound_provider',allowance:'digest_bound_provider',calldata:'digest_bound_provider',value:'digest_bound_provider'})},handoff_eligible:!embedded,refreshable:false,primary_action:embedded?null:'Continue to external wallet',blocking_error:embedded?{code:'PROVIDER_GAP',retryable:false,safe_message:'Approval handoff requires the production Privy method spike.'}:null});
  }
  function swapModel(bound){
    const embedded=bound.context.wallet_class==='privy_embedded',expectedProvenance=embedded?'privy_swap_quote':'prototype_fixture',expectedProvider=embedded?'Privy':'External wallet';
    if(bound.context.provenance!==expectedProvenance||!bound.context.quote||
       bound.context.dapp!==null||bound.context.labels.provider!==expectedProvider){
      throw new TypeError('swap context');
    }
    const payload=bound.execution.payload,q=bound.context.quote,r=q.response;
    const input=token(bound,payload.input_token_address);
    const output=token(bound,payload.output_token_address);
    const full=Object.prototype.hasOwnProperty.call(r,'quote_id');
    const matches=(!full||(r.quote_id===payload.quote_id&&r.route_id===payload.route_id))&&r.chain_id===payload.chain_id&&
      r.input_token_address===payload.input_token_address&&
      r.output_token_address===payload.output_token_address&&
      r.input_amount_base_units===payload.input_amount_base_units;
    const preview=embedded?(matches?r.status:'mismatch'):'unavailable';
    const inputDisplay=fromBase(payload.input_amount_base_units,input.decimals);
    const terms=full&&matches&&embedded&&(r.status==='available'||r.status==='stale');
    const outputDisplay=terms?fromBase(r.output_amount_base_units,output.decimals):null;
    const minimum=terms?fromBase(r.minimum_output_amount_base_units,output.decimals):null;
    const fee=terms?fromBase(r.fee_amount_base_units,input.decimals):null;
    const eligible=embedded&&preview==='available';
    const materialProvenance=terms?'digest_bound_provider':'unavailable';
    return freeze({version:1,id:payload.request_id,kind:'swap',
      wallet_class:bound.context.wallet_class,wallet_ref:bound.execution.wallet_id,
      chain_id:payload.chain_id,provenance:bound.context.provenance,
      provider_preview:preview,expires_at_ms:bound.expires_at_ms,
      summary:eligible?'You are preparing to ask Privy to swap '+commas(inputDisplay)+' '+
        input.symbol+' for approximately '+commas(outputDisplay)+' '+output.symbol+
        ' on Ethereum (minimum '+commas(minimum)+' '+output.symbol+').':embedded?
        'A fresh Privy swap quote is required before this request can continue.':
        'Swap is not available for this external wallet.',
      fields:{wallet_address:embedded?null:bound.context.wallet_identity.address,
        input_asset_id:input.asset_id,output_asset_id:output.asset_id,
        input_token_address:payload.input_token_address,
        output_token_address:payload.output_token_address,
        input_amount_base_units:payload.input_amount_base_units,
        input_amount_display:inputDisplay+' '+input.symbol,
        output_amount_base_units:terms?r.output_amount_base_units:null,
        output_amount_display:terms?outputDisplay+' '+output.symbol:null,
        minimum_output_amount_base_units:terms?r.minimum_output_amount_base_units:null,
        minimum_output_display:terms?minimum+' '+output.symbol:null,
        fee_amount_base_units:terms?r.fee_amount_base_units:null,
        fee_display:terms?fee+' '+r.fee_asset_id:null,
        quote_id:full&&matches&&embedded?r.quote_id:null,route_id:full&&matches&&embedded?r.route_id:null,route_available:embedded&&matches&&r.status==='available',
        received_at_ms:q.received_at_ms,freshness_deadline_ms:q.freshness_deadline_ms,
        chain_id:payload.chain_id,field_provenance:prov({
          wallet:'digest_bound_provider',input:'digest_bound_provider',estimated_output:materialProvenance,
          minimum_output:materialProvenance,fees:materialProvenance,
          received_at:'digest_bound_provider',deadline:'digest_bound_provider',
          chain:'digest_bound_provider',tokens:'digest_bound_provider',
          route:full&&matches&&embedded?'digest_bound_provider':'unavailable',identity:'digest_bound_provider'})},
      handoff_eligible:eligible,refreshable:embedded,
      primary_action:eligible?(bound.context.wallet_class==='privy_embedded'?
        'Continue with Privy':'Continue to external wallet'):null,
      blocking_error:eligible?null:embedded?{code:'QUOTE_REFRESH_REQUIRED',retryable:true,
        safe_message:'The reviewed quote is not available. Refresh quote to continue.'}:{code:'PROVIDER_GAP',retryable:false,safe_message:'Swap is not available for this external wallet.'}});
  }
  function perpModel(bound){
    if(bound.context.provenance!=='hyperliquid_order_fixture'||bound.context.quote!==null||bound.context.labels.provider!=='Hyperliquid'||bound.context.labels.environment!=='testnet')throw new TypeError('perp context');const payload=bound.execution.payload,embedded=bound.context.wallet_class==='privy_embedded';return freeze({version:1,id:payload.request_id,kind:'perp_order',wallet_class:bound.context.wallet_class,wallet_ref:bound.execution.wallet_id,chain_id:payload.chain_id,provenance:bound.context.provenance,provider_preview:'available',expires_at_ms:bound.expires_at_ms,summary:'You are reviewing a Hyperliquid testnet market order to buy '+payload.size+' ETH with '+payload.leverage+'× leverage.',fields:{wallet_address:embedded?null:bound.context.wallet_identity.address,provider:'hyperliquid',environment:payload.environment,market:payload.market,side:payload.side,order_type:payload.order_type,size:payload.size,leverage:payload.leverage,reduce_only:payload.reduce_only,field_provenance:prov({wallet:'digest_bound_provider',provider:'digest_bound_provider',environment:'digest_bound_provider',market:'digest_bound_provider',side:'digest_bound_provider',order_type:'digest_bound_provider',size:'digest_bound_provider',leverage:'digest_bound_provider',reduce_only:'digest_bound_provider'})},provider_capability:'pending_spike',handoff_eligible:false,refreshable:false,primary_action:null,blocking_error:{code:'PERP_EXECUTION_PENDING',retryable:false,safe_message:PERP_REASON}});
  }
  function decodeInternal(value){const bound=source(value),model=bound.kind==='transfer'?transferModel(bound):bound.kind==='approve'?approvalModel(bound):bound.kind==='swap'?swapModel(bound):perpModel(bound),payload=bound.execution.payload,binding=freeze({provider_path:bound.execution.provider_path,wallet_id:bound.execution.wallet_id,endpoint:payload.endpoint,method:payload.method,chain_id:payload.chain_id,payload,execution_digest:bound.execution.execution_digest});return freeze({source:bound,model,execution_binding:binding});}
  const decodeReviewSource=value=>decodeInternal(value).model;

  function seal(body){body.execution.execution_digest=digest(body.execution.payload);body.source_digest=digest({kind:body.kind,execution:body.execution,context:body.context,expires_at_ms:body.expires_at_ms});return freeze(body);}
  function common(provenance,tokens,dappValue=null,quoteValue=null,labelsValue={spender:null,provider:'Privy',environment:'prototype'}){return {wallet_class:'privy_embedded',wallet_identity:{kind:'privy_wallet',wallet_id:WALLET},provenance,token_metadata:tokens,dapp:dappValue,quote:quoteValue,labels:labelsValue};}
  function transferFixture(){return seal({kind:'transfer',execution:{provider_path:'privy_wallet_action',wallet_id:WALLET,payload:{request_id:'review-transfer',endpoint:ENDPOINT,method:'transfer',chain_id:'ethereum',token_address:'native:ethereum',destination:DEST,amount:'0.01',source:{amount:'999.123400'},amount_type:'exact_input',fee_display:null},execution_digest:''},context:common('privy_transfer_request',[TOKENS.ETH]),source_digest:'',expires_at_ms:500000});}
  function approvalFixture(id,type,calldata){return seal({kind:'approve',execution:{provider_path:'privy_flutter_rpc',wallet_id:WALLET,payload:{request_id:id,endpoint:'eth_sendTransaction',method:'approve',chain_id:'ethereum',token_address:USDC,spender:SPENDER,calldata,value:'0',approval:type==='limited'?{type,limit_base_units:'1000000000'}:{type}},execution_digest:''},context:common('dapp_request',[TOKENS.USDC],{origin:'https://swap.zone',allowlisted_label:'Swap.zone'},null,{spender:'Swap.zone',provider:'Privy Flutter',environment:'prototype'}),source_digest:'',expires_at_ms:500000});}
  function quoteFixture(status='available',providerExpiry=140000,output='216450000000',quoteId='privy-quote-1',routeId='privy-route-1'){return {status,quote_id:quoteId,route_id:routeId,chain_id:'ethereum',input_token_address:USDC,output_token_address:GLYPH,input_amount_base_units:'500000000',output_amount_base_units:output,minimum_output_amount_base_units:output==='216500000000'?'215417500000':'215367750000',fee_amount_base_units:'500000',fee_asset_id:'USDC',provider_expiry_ms:providerExpiry};}
  function swapFixture(id,r,received=100000){const deadline=r.provider_expiry_ms===null?received+30000:Math.min(r.provider_expiry_ms,received+30000);return seal({kind:'swap',execution:{provider_path:'privy_wallet_action',wallet_id:WALLET,payload:{request_id:id,endpoint:ENDPOINT,method:'swap',chain_id:'ethereum',input_token_address:USDC,output_token_address:GLYPH,input_amount_base_units:'500000000',quote_id:r.quote_id,route_id:r.route_id},execution_digest:''},context:common('privy_swap_quote',[TOKENS.USDC,TOKENS.GLYPH],null,{response:r,received_at_ms:received,freshness_deadline_ms:deadline}),source_digest:'',expires_at_ms:500000});}
  function boundPerpIntent(value){const item=record(value,['market','side','order_type','size','leverage','reduce_only','intent_revision'],[],'perp intent');exact(item.market,'ETH','market');exact(item.side,'buy','side');exact(item.order_type,'market','order');decimal(item.size,18,'size');if(item.size.startsWith('-')||/^0(?:\.0+)?$/.test(item.size))throw new TypeError('size');decimal(item.leverage,2,'leverage');if(!['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20'].includes(item.leverage))throw new TypeError('leverage');if(item.reduce_only!==false)throw new TypeError('reduce');text(item.intent_revision,'intent revision',128);return {...item};}
  function perpFixture(intent){const bound=boundPerpIntent(intent);return seal({kind:'perp_order',execution:{provider_path:'hyperliquid',wallet_id:WALLET,payload:{request_id:'review-perp',endpoint:'hyperliquid:testnet',method:'order',chain_id:'hyperliquid-testnet',market:bound.market,side:bound.side,order_type:bound.order_type,size:bound.size,leverage:bound.leverage,reduce_only:bound.reduce_only,environment:'testnet'},execution_digest:''},context:common('hyperliquid_order_fixture',[TOKENS.ETH],null,null,{spender:null,provider:'Hyperliquid',environment:'testnet'}),source_digest:'',expires_at_ms:500000});}
  const DEFAULT_PERP_INTENT=freeze({market:'ETH',side:'buy',order_type:'market',size:'0.01',leverage:'3',reduce_only:false,intent_revision:'fixture-intent-eth-1'});
  function externalFixture(sourceValue,id){
    const body=JSON.parse(JSON.stringify(sourceValue)),payload=body.execution.payload;
    body.context.wallet_class='connected_external';body.context.wallet_identity={kind:'external_connector',chain_type:'ethereum',address:EXTERNAL_ADDRESS};body.execution.wallet_id=null;payload.request_id=id;
    if(body.kind==='transfer'){body.execution.provider_path='external_wallet';payload.endpoint='external_wallet:request';body.context.provenance='prototype_fixture';body.context.labels.provider='External wallet';}
    else if(body.kind==='approve'){body.execution.provider_path='external_wallet';payload.endpoint='external_wallet:request';body.context.labels.provider='External wallet';}
    else if(body.kind==='swap'){body.execution.provider_path='provider_gap';payload.endpoint='external_wallet:swap';body.context.provenance='prototype_fixture';body.context.labels.provider='External wallet';}
    return seal(body);
  }
  function changedInputFixture(){const body=JSON.parse(JSON.stringify(swapFixture('review-swap-refresh',quoteFixture('available',140000,'216500000000','privy-quote-2','privy-route-2'))));body.execution.payload.request_id='review-swap-refresh-input-changed';body.execution.payload.input_amount_base_units='400000000';body.context.quote.response.input_amount_base_units='400000000';return seal(body);}
  const REFRESH_WINDOWS=freeze([130000,160000,190000,220000,250000,280000,310000,
    340000,370000,400000,430000,460000,490000]);
  const refreshReviewId=received=>received===130000?'review-swap-refresh-late':
    'review-swap-refresh-'+String(received/1000);
  function refreshWindowFixture(received){const suffix=String(received/1000);return swapFixture(
    refreshReviewId(received),quoteFixture('available',500000,'216500000000',
      'privy-quote-r'+suffix,'privy-route-r'+suffix),received);}
  // Production calldata decoding and construction are pinned to viem on the BFF. The HTML has
  // only these immutable limited/unlimited semantic fixtures and a deliberate mismatch fixture.
  function lateTransferFixture(){const body=JSON.parse(JSON.stringify(transferFixture()));body.execution.payload.request_id='review-transfer-late';body.expires_at_ms=800000;return seal(body);}
  const SOURCES=freeze({'review-transfer':transferFixture(),'review-transfer-late':lateTransferFixture(),'review-approve-limited':approvalFixture('review-approve-limited','limited',LIMITED),'review-approve-unlimited':approvalFixture('review-approve-unlimited','unlimited',UNLIMITED),'review-approve-mismatch':approvalFixture('review-approve-mismatch','limited',UNLIMITED),'review-swap-fresh':swapFixture('review-swap-fresh',quoteFixture()),'review-swap-stale':swapFixture('review-swap-stale',quoteFixture('stale')),'review-swap-unavailable':swapFixture('review-swap-unavailable',quoteFixture('unavailable')),'review-swap-no-liquidity':swapFixture('review-swap-no-liquidity',quoteFixture('no_liquidity')),'review-swap-refresh':swapFixture('review-swap-refresh',quoteFixture('available',140000,'216500000000','privy-quote-2','privy-route-2')),...Object.fromEntries(REFRESH_WINDOWS.map(received=>[refreshReviewId(received),refreshWindowFixture(received)])),'review-swap-refresh-input-changed':changedInputFixture(),'review-perp':perpFixture(DEFAULT_PERP_INTENT),'review-transfer-external':externalFixture(transferFixture(),'review-transfer-external'),'review-approve-external':externalFixture(approvalFixture('review-approve-external','limited',LIMITED),'review-approve-external'),'review-approve-unlimited-external':externalFixture(approvalFixture('review-approve-unlimited-external','unlimited',UNLIMITED),'review-approve-unlimited-external'),'review-swap-external':externalFixture(swapFixture('review-swap-external',quoteFixture()),'review-swap-external'),'review-perp-external':externalFixture(perpFixture(DEFAULT_PERP_INTENT),'review-perp-external')});
  const FIXTURES=freeze(Object.fromEntries(Object.entries(SOURCES).map(([id,fixture])=>
    [id,freeze({owner_user_id:USER,source:fixture})])));

  const failure=(code,message,refreshable=false)=>freeze({ok:false,error:{code,retryable:false,safe_message:message,refreshable}}),success=value=>freeze({ok:true,value});
  function live(value){const item=record(value,['user_id','wallet_id','wallet_class','endpoint'],[],'live');text(item.user_id,'user');if(!CLASSES.includes(item.wallet_class))throw new TypeError('wallet class');if(item.wallet_class==='privy_embedded')text(item.wallet_id,'wallet');else if(item.wallet_id!==null)throw new TypeError('wallet');text(item.endpoint,'endpoint');return freeze({...item});}
  function origin(value){const item=record(value,['stack'],[],'origin'),stack=array(item.stack,26,'stack'),excluded=['scr-notifications','scr-search','scr-privacy','scr-security'];if(!stack.length||stack.some(entry=>typeof entry!=='string'||!/^scr-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry)||excluded.includes(entry)))throw new TypeError('origin');return freeze({stack:[...stack]});}
  const same=(left,right)=>canonical(left)===canonical(right);
  const ADAPTER_METHODS=['getWalletSnapshot','getBalanceSnapshot',
    'getTransactionHistorySnapshot','getWalletActionSnapshot','getReceiveTarget',
    'getReviewPreview','handoffReview'];
  function captureAdapter(value){
    if(!Object.isFrozen(value))throw new TypeError('adapter');
    const found=descriptors(value,'adapter'),keys=Reflect.ownKeys(found);
    if(keys.length!==ADAPTER_METHODS.length||
       ADAPTER_METHODS.some(key=>!Object.prototype.hasOwnProperty.call(found,key)||
         typeof found[key].value!=='function')||
       keys.some(key=>!ADAPTER_METHODS.includes(key)))throw new TypeError('adapter');
    const result={};ADAPTER_METHODS.forEach(key=>{result[key]=found[key].value;});
    return freeze(result);
  }
  function createController(options){
    const selected=record(options,['adapter'],['perpIntentProvider'],'options'),adapter=captureAdapter(selected.adapter),perpIntentProvider=Object.prototype.hasOwnProperty.call(selected,'perpIntentProvider')&&typeof selected.perpIntentProvider==='function'?selected.perpIntentProvider:null,sessions=new Map(),consumed=new Set(),forwardBlocked=new Set(),acknowledged=new Set(),returning=new Set(),handoffOutcomes=new Map();
    const take=id=>{const found=sessions.get(id)||null;sessions.delete(id);forwardBlocked.delete(id);acknowledged.delete(id);returning.delete(id);consumed.add(id);return found;};
    const expired=(session,now)=>now>=session.ttl||now>=session.sourceExpiry;
    const prune=now=>{for(const [id,session] of sessions){if(expired(session,now))take(id);}};
    const quoteExpired=(session,now)=>session.model.kind==='swap'&&now>=session.model.fields.freshness_deadline_ms;
    const state=(session,now)=>!session.model.handoff_eligible||(session.model.kind==='swap'&&(session.model.provider_preview!=='available'||quoteExpired(session,now)))?'blocked':session.previewStatus==='unavailable'&&(session.model.kind==='transfer'||session.model.kind==='approve')?'preview_unavailable':'ready';
    const present=(session,now)=>{const current=state(session,now),refreshable=session.model.refreshable&&current==='blocked',acknowledgementRequired=current==='preview_unavailable';return {review_id:session.id,state:current,model:session.model,expires_at_ms:Math.min(session.ttl,session.sourceExpiry),refreshable,acknowledgement_required:acknowledgementRequired,acknowledged:acknowledgementRequired&&acknowledged.has(session.id),handoff_eligible:session.model.handoff_eligible&&(current==='ready'||(acknowledgementRequired&&acknowledged.has(session.id)))};};
    const endpointMatches=(_model,execution,current)=>current.endpoint===execution.endpoint;
    const matches=(session,current)=>current.user_id===session.ownerUserId&&same(session.live,current)&&current.wallet_id===session.execution.wallet_id&&current.wallet_class===session.model.wallet_class&&endpointMatches(session.model,session.execution,current);
    const livePerpSource=()=>{if(!perpIntentProvider)return null;try{return perpFixture(perpIntentProvider());}catch(_error){return null;}};
    const unchanged=session=>{const repeated=decodeInternal(session.source);if(!same(repeated.model,session.model)||!same(repeated.execution_binding,session.execution))return false;if(session.model.kind!=='perp_order'||!perpIntentProvider)return true;const current=livePerpSource();if(!current)return false;const decoded=decodeInternal(current);return same(decoded.model,session.model)&&same(decoded.execution_binding,session.execution);};
    function approvalPreview(value){
      const item=record(value,['chain_id','token_address','spender_address',
        'dapp_origin','allowance_kind','limit_base_units','calldata','value'],[],
      'approval preview');
      exact(item.chain_id,'ethereum','preview chain');exact(item.token_address,USDC,
        'preview token');exact(item.spender_address,SPENDER,'preview spender');
      exact(item.dapp_origin,'https://swap.zone','preview origin');
      if(!['limited','unlimited'].includes(item.allowance_kind))throw new TypeError(
        'preview allowance');
      if(item.allowance_kind==='limited')exact(item.limit_base_units,'1000000000',
        'preview limit');
      else if(item.limit_base_units!==null)throw new TypeError('preview limit');
      exact(item.calldata,item.allowance_kind==='limited'?LIMITED:UNLIMITED,
        'preview calldata');exact(item.value,'0','preview value');
      return {...item};
    }
    function authoritativePreview(boundSource,model){
      let raw;
      try{raw=adapter.getReviewPreview({review_id:model.id});}
      catch(_error){return freeze({ok:false,type:'provider',error:{code:'PROVIDER_UNAVAILABLE',safe_message:'The wallet provider is temporarily unavailable.'}});}
      try{
        if(!frozenData(raw))throw new TypeError('preview freeze');
        const shape=record(raw,['ok'],['value','meta','error'],'preview result');
        if(shape.ok===false){
          const outer=record(raw,['ok','error'],[],'preview failure'),error=record(outer.error,['code','retryable','safe_message'],[],'preview error');
          const safeMessage=adapterErrorMessage(error.code);
          if(!safeMessage||error.retryable!==false||typeof error.safe_message!=='string'){
            throw new TypeError('preview error');
          }
          return freeze({ok:false,type:'provider',error:{code:error.code,
            safe_message:safeMessage}});
        }
        if(shape.ok!==true)throw new TypeError('preview status');
        const outer=record(raw,['ok','value','meta'],[],'preview success'),meta=record(outer.meta,['source','fetched_at_ms','stale','partial'],[],'preview meta');
        const expectedSource=model.wallet_class==='connected_external'?'external_wallet':'prototype_fixture';
        exact(meta.source,expectedSource,'preview source');
        if(meta.fetched_at_ms!==0||meta.stale!==false||meta.partial!==false)throw new TypeError('preview meta');
        const value=record(outer.value,['review_id','wallet_class','kind','status','preview'],[],'preview value');
        exact(value.review_id,model.id,'preview id');exact(value.wallet_class,model.wallet_class,'preview class');exact(value.kind,model.kind,'preview kind');
        if(!['available','stale','unavailable','no_liquidity','blocked','provider_gap'].includes(value.status))throw new TypeError('preview status');
        if(model.kind==='swap'&&model.wallet_class==='privy_embedded'){
          if(!['available','stale','unavailable','no_liquidity'].includes(value.status))throw new TypeError('preview status');
          const current=quote(value.preview);if(current.response.status!==value.status)throw new TypeError('preview status');
          const changed=!same(current,boundSource.context.quote);
          return freeze({ok:true,changed,status:value.status});
        }
        if(model.kind==='approve'&&model.wallet_class==='connected_external'){
          exact(value.status,'unavailable','preview status');
          const current=approvalPreview(value.preview),payload=boundSource.execution.payload;
          const expected={chain_id:payload.chain_id,token_address:payload.token_address,
            spender_address:payload.spender,dapp_origin:boundSource.context.dapp.origin,
            allowance_kind:payload.approval.type,
            limit_base_units:payload.approval.type==='limited'?
              payload.approval.limit_base_units:null,calldata:payload.calldata,
            value:payload.value};
          return freeze({ok:true,changed:!same(current,expected),status:value.status});
        }
        if(value.preview!==null)throw new TypeError('preview material');
        const expectedStatus=model.kind==='perp_order'?'blocked':
          model.kind==='swap'?'provider_gap':'unavailable';
        exact(value.status,expectedStatus,'preview status');
        return freeze({ok:true,changed:false,status:value.status});
      }catch(_error){return freeze({ok:false,type:'malformed',error:{code:'MALFORMED_PROVIDER_RESPONSE',safe_message:'The wallet provider returned data LOOP could not safely use.'}});}
    }
    const previewFailure=(id,result,refreshable)=>{take(id);return failure(result.error.code,result.error.safe_message,refreshable);};
    function authority(){
      const raw=adapter.getWalletSnapshot();if(!frozenData(raw))throw new TypeError('authority freeze');
      const outer=record(raw,['ok','value','meta'],[],'authority');if(outer.ok!==true)throw new TypeError('authority status');
      const meta=record(outer.meta,['source','fetched_at_ms','stale','partial'],[],'authority meta');
      if(meta.fetched_at_ms!==0||meta.stale!==false||meta.partial!==false)throw new TypeError('authority meta');
      const value=record(outer.value,['wallet_class','wallet_ref','addresses','capabilities'],[],'authority value');
      if(!['privy_embedded','connected_external','watch_only'].includes(value.wallet_class))throw new TypeError('authority class');
      const expectedSource={privy_embedded:'privy_flutter',connected_external:'external_wallet',watch_only:'prototype_fixture'}[value.wallet_class];exact(meta.source,expectedSource,'authority source');
      if(value.wallet_class==='privy_embedded')exact(value.wallet_ref,WALLET,'authority wallet');else if(value.wallet_ref!==null)throw new TypeError('authority wallet');
      const addresses=array(value.addresses,4,'authority addresses');if(!addresses.length)throw new TypeError('authority addresses');const seen=new Set(),boundAddresses=addresses.map(rawAddress=>{const address=record(rawAddress,['chain_type','address'],[],'authority address');if(!['ethereum','solana'].includes(address.chain_type)||seen.has(address.chain_type))throw new TypeError('authority address');seen.add(address.chain_type);text(address.address,'authority address',128);return {chain_type:address.chain_type,address:address.address};});
      const capabilities=record(value.capabilities,['balances','history','receive','transfer','swap','approve'],[],'authority capabilities');
      const matrix={privy_embedded:{balances:'supported',history:'supported',receive:'supported',transfer:'supported',swap:'supported',approve:'spike_required'},connected_external:{balances:'provider_gap',history:'provider_gap',receive:'supported',transfer:'external_provider',swap:'provider_gap',approve:'external_provider'},watch_only:{balances:'provider_gap',history:'provider_gap',receive:'supported',transfer:'unsupported',swap:'unsupported',approve:'unsupported'}}[value.wallet_class];if(!same(capabilities,matrix))throw new TypeError('authority capabilities');
      return freeze({wallet_class:value.wallet_class,wallet_ref:value.wallet_ref,addresses:boundAddresses,capabilities:{...capabilities}});
    }
    function authorized(identity,model,execution,current){const trusted=authority();if(trusted.wallet_class==='watch_only'||trusted.wallet_class!==model.wallet_class||trusted.wallet_class!==current.wallet_class||trusted.wallet_ref!==execution.wallet_id||trusted.wallet_ref!==current.wallet_id)return false;if(trusted.wallet_class==='privy_embedded'){if(identity.kind!=='privy_wallet'||identity.wallet_id!==trusted.wallet_ref)return false;}else if(identity.kind!=='external_connector'||!trusted.addresses.some(address=>same(address,{chain_type:identity.chain_type,address:identity.address})))return false;if(model.kind==='perp_order')return true;return trusted.capabilities[model.kind]===(trusted.wallet_class==='privy_embedded'?(model.kind==='approve'?'spike_required':'supported'):(model.kind==='swap'?'provider_gap':'external_provider'));}
    function open(request){let item,current,start;try{item=record(request,['review_id','origin','live_context','trigger_ref','now_ms'],[],'open');text(item.review_id,'id');text(item.trigger_ref,'trigger');time(item.now_ms,'now');current=live(item.live_context);start=origin(item.origin);}catch(_error){return failure('INVALID_REQUEST','The review request is invalid.');}prune(item.now_ms);if(consumed.has(item.review_id)||sessions.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');let fixture=Object.prototype.hasOwnProperty.call(FIXTURES,item.review_id)?FIXTURES[item.review_id]:null;if(item.review_id==='review-perp'&&perpIntentProvider){const dynamic=livePerpSource();fixture=dynamic?freeze({owner_user_id:USER,source:dynamic}):null;}if(!fixture)return failure('SESSION_INVALID','This review is not available.');if(current.user_id!==fixture.owner_user_id){consumed.add(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(sessions.size>=MAX_SESSIONS)return failure('SESSION_CAPACITY','Too many review sessions are open.');let decoded;try{decoded=decodeInternal(fixture.source);}catch(_error){consumed.add(item.review_id);return failure('DECODE_FAILED','The wallet request could not be reviewed safely.');}let trusted=false;try{trusted=authorized(decoded.source.context.wallet_identity,decoded.model,decoded.execution_binding,current);}catch(_error){trusted=false;}if(decoded.model.id!==item.review_id||!trusted||current.wallet_id!==decoded.execution_binding.wallet_id||current.wallet_class!==decoded.model.wallet_class||!endpointMatches(decoded.model,decoded.execution_binding,current)){consumed.add(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(item.now_ms>=decoded.source.expires_at_ms){consumed.add(item.review_id);return failure('SESSION_EXPIRED','This review has expired.');}const preview=authoritativePreview(decoded.source,decoded.model);if(!preview.ok)return previewFailure(item.review_id,preview,decoded.model.refreshable);if(preview.changed){consumed.add(item.review_id);return failure('REVIEW_CHANGED','The reviewed provider preview changed.',decoded.model.refreshable);}sessions.set(item.review_id,freeze({id:item.review_id,ownerUserId:fixture.owner_user_id,walletIdentity:decoded.source.context.wallet_identity,source:decoded.source,model:decoded.model,execution:decoded.execution_binding,origin:start,live:current,previewStatus:preview.status,created:item.now_ms,ttl:item.now_ms+TTL,sourceExpiry:decoded.source.expires_at_ms,oneTime:'unconsumed',trigger:item.trigger_ref}));return success(present(sessions.get(item.review_id),item.now_ms));}
    function validationRequest(request,label){const item=record(request,['review_id','live_context','now_ms'],[],label);text(item.review_id,'id');time(item.now_ms,'now');return {review_id:item.review_id,live_context:item.live_context,now_ms:item.now_ms};}
    function validate(request){let item;try{item=validationRequest(request,'validate');}catch(_error){return failure('INVALID_REQUEST','The validation request is invalid.');}const session=sessions.get(item.review_id);if(!session||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');let current;try{current=live(item.live_context);if(!authorized(session.walletIdentity,session.model,session.execution,current))throw new TypeError('authority');}catch(_error){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(!matches(session,current)){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(expired(session,item.now_ms)||quoteExpired(session,item.now_ms)){take(item.review_id);return failure('SESSION_EXPIRED','This review has expired.',session.model.kind==='swap');}try{if(!unchanged(session))throw new TypeError('changed');}catch(_error){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed request changed.');}const preview=authoritativePreview(session.source,session.model);if(!preview.ok)return previewFailure(item.review_id,preview,session.model.refreshable);if(preview.changed){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed provider preview changed.',session.model.refreshable);}if(!session.model.handoff_eligible){const error=session.model.blocking_error;return failure(error.code,error.safe_message,session.model.refreshable);}return success(present(session,item.now_ms));}
    function forward(request){let item;try{item=validationRequest(request,'forward');}catch(_error){return failure('INVALID_REQUEST','The Forward request is invalid.');}const session=sessions.get(item.review_id);if(!session||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');let current;try{current=live(item.live_context);if(!authorized(session.walletIdentity,session.model,session.execution,current))throw new TypeError('authority');}catch(_error){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(!matches(session,current)){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}try{if(!unchanged(session))throw new TypeError('changed');}catch(_error){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed request changed.');}const preview=authoritativePreview(session.source,session.model);if(!preview.ok)return previewFailure(item.review_id,preview,session.model.refreshable);if(preview.changed){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed provider preview changed.',session.model.refreshable);}if(item.now_ms>=session.ttl){take(item.review_id);return failure('SESSION_EXPIRED','This review has expired.');}if(session.model.kind==='swap'&&(item.now_ms>=session.sourceExpiry||quoteExpired(session,item.now_ms))){forwardBlocked.add(item.review_id);return success(present(session,item.now_ms));}if(item.now_ms>=session.sourceExpiry){take(item.review_id);return failure('SESSION_EXPIRED','This review has expired.');}return success(present(session,item.now_ms));}
    function restore(request){let item;try{item=record(request,['review_id','live_context','now_ms'],[],'restore');text(item.review_id,'id');time(item.now_ms,'now');}catch(_error){return failure('INVALID_REQUEST','The restore request is invalid.');}const session=sessions.get(item.review_id);if(!session||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');let current;try{current=live(item.live_context);if(!authorized(session.walletIdentity,session.model,session.execution,current))throw new TypeError('authority');}catch(_error){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(!matches(session,current)){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}try{if(!unchanged(session))throw new TypeError('changed');}catch(_error){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed request changed.');}const preview=authoritativePreview(session.source,session.model);if(!preview.ok)return previewFailure(item.review_id,preview,session.model.refreshable);if(preview.changed){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed provider preview changed.',session.model.refreshable);}if(item.now_ms>=session.ttl){take(item.review_id);return failure('SESSION_EXPIRED','This review has expired.');}if((item.now_ms>=session.sourceExpiry||quoteExpired(session,item.now_ms))&&!(session.model.kind==='swap'&&forwardBlocked.has(item.review_id))){take(item.review_id);return failure('SESSION_EXPIRED','This review has expired.');}return success(present(session,item.now_ms));}
    function refresh(request){let item,current;try{item=record(request,['review_id','replacement_review_id','live_context','trigger_ref','now_ms'],[],'refresh');text(item.review_id,'id');text(item.replacement_review_id,'replacement');text(item.trigger_ref,'trigger');time(item.now_ms,'now');current=live(item.live_context);}catch(_error){return failure('INVALID_REQUEST','The refresh request is invalid.');}const session=sessions.get(item.review_id);if(!session||session.model.kind!=='swap'||consumed.has(item.review_id))return failure('SESSION_INVALID','This quote cannot be refreshed.');if(expired(session,item.now_ms)){take(item.review_id);return failure('SESSION_EXPIRED','This review session has expired.');}try{if(!authorized(session.walletIdentity,session.model,session.execution,current))throw new TypeError('authority');}catch(_error){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}if(!matches(session,current)){take(item.review_id);return failure('CONTEXT_MISMATCH','The live wallet context changed.');}try{if(!unchanged(session))throw new TypeError('changed');}catch(_error){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed request changed.');}const preview=authoritativePreview(session.source,session.model);if(!preview.ok)return previewFailure(item.review_id,preview,session.model.refreshable);if(preview.changed){take(item.review_id);return failure('REVIEW_CHANGED','The reviewed provider preview changed.',session.model.refreshable);}if(!session.model.refreshable){take(item.review_id);return failure('REFRESH_FAILED','This review cannot be refreshed.');}const replacement=Object.prototype.hasOwnProperty.call(FIXTURES,item.replacement_review_id)?FIXTURES[item.replacement_review_id]:null;take(item.review_id);if(!replacement||item.replacement_review_id===item.review_id)return failure('REFRESH_FAILED','A wholly new quote review is required.');if(replacement.owner_user_id!==session.ownerUserId)return failure('REFRESH_IDENTITY_MISMATCH','The replacement quote changed the swap input.');let decoded;try{decoded=decodeInternal(replacement.source);}catch(_error){return failure('REFRESH_FAILED','A wholly new quote review is required.');}if(decoded.source.kind!=='swap')return failure('REFRESH_KIND_MISMATCH','The replacement review must be a swap.');const identity=decodedValue=>({wallet_class:decodedValue.model.wallet_class,wallet_id:decodedValue.execution_binding.wallet_id,wallet_identity:decodedValue.source.context.wallet_identity,provider_path:decodedValue.execution_binding.provider_path,endpoint:decodedValue.execution_binding.endpoint,method:decodedValue.execution_binding.method,chain_id:decodedValue.execution_binding.chain_id,input_token_address:decodedValue.execution_binding.payload.input_token_address,output_token_address:decodedValue.execution_binding.payload.output_token_address,input_amount_base_units:decodedValue.execution_binding.payload.input_amount_base_units});if(!same(identity({source:session.source,model:session.model,execution_binding:session.execution}),identity(decoded)))return failure('REFRESH_IDENTITY_MISMATCH','The replacement quote changed the swap input.');if(decoded.source.source_digest===session.source.source_digest||decoded.execution_binding.execution_digest===session.execution.execution_digest)return failure('REFRESH_FAILED','A wholly new quote review is required.');if(item.now_ms>=decoded.source.expires_at_ms||item.now_ms>=decoded.model.fields.freshness_deadline_ms||decoded.model.provider_preview!=='available'||!decoded.model.handoff_eligible)return failure('REFRESH_EXPIRED','The replacement quote is not fresh.');return open({review_id:item.replacement_review_id,origin:session.origin,live_context:item.live_context,trigger_ref:item.trigger_ref,now_ms:item.now_ms});}
    function acknowledge(request){let item;try{item=record(request,['review_id','acknowledged'],[],'acknowledgement');text(item.review_id,'id');if(typeof item.acknowledged!=='boolean')throw new TypeError('acknowledgement');}catch(_error){return failure('INVALID_REQUEST','The acknowledgement request is invalid.');}const session=sessions.get(item.review_id);if(!session||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');if(returning.has(item.review_id))return failure('HANDOFF_PENDING','This review is already returning to its origin.');if(state(session,session.created)!=='preview_unavailable')return failure('ACKNOWLEDGEMENT_NOT_AVAILABLE','This review does not use the unavailable-preview fallback.');if(item.acknowledged)acknowledged.add(item.review_id);else acknowledged.delete(item.review_id);return success(present(session,session.created));}
    function beginHandoff(request){let item;try{item=validationRequest(request,'begin handoff');}catch(_error){return failure('INVALID_REQUEST','The handoff request is invalid.');}if(returning.has(item.review_id))return failure('HANDOFF_PENDING','This review is already returning to its origin.');const checked=validate(item);if(!checked.ok)return checked;if(checked.value.acknowledgement_required&&!checked.value.acknowledged)return failure('ACKNOWLEDGEMENT_REQUIRED','Acknowledge that the action preview is unavailable before continuing.');if(!checked.value.handoff_eligible)return failure('HANDOFF_BLOCKED','This review cannot be handed off.');returning.add(item.review_id);return success({review_id:item.review_id,state:'returning_to_origin'});}
    function providerState(reviewId,walletClass,result,providerId=reviewId){
      try{
        if(!frozenData(result))throw new TypeError('handoff freeze');
        const shape=record(result,['ok'],['value','meta','error'],'handoff result');
        if(shape.ok===false){
          const outer=record(result,['ok','error'],[],'handoff failure');
          const error=record(outer.error,['code','retryable','safe_message'],[],'handoff error');
          const safeMessage=adapterErrorMessage(error.code);
          if(!safeMessage||error.retryable!==false||typeof error.safe_message!=='string'){
            throw new TypeError('handoff error');
          }
          return success({review_id:reviewId,
            state:error.code==='USER_REJECTED'?'provider_rejected':'provider_failed',
            safe_message:safeMessage});
        }
        if(shape.ok!==true)throw new TypeError('handoff status');
        const outer=record(result,['ok','value','meta'],[],'handoff success');
        const value=record(outer.value,['review_id','action_id','status'],[],'handoff value');
        const meta=record(outer.meta,['source','fetched_at_ms','stale','partial'],[],'handoff meta');
        exact(value.review_id,providerId,'handoff id');
        const embedded=walletClass==='privy_embedded';
        if((embedded&&(value.action_id!=='action-pending'||
             value.status!=='handoff_pending'||meta.source!=='privy_wallet_action'))||
           (!embedded&&(value.action_id!==null||
             value.status!=='provider_confirmation_pending'||meta.source!=='external_wallet'))||
           meta.fetched_at_ms!==0||meta.stale!==false||meta.partial!==false){
          throw new TypeError('handoff result');
        }
        return success({review_id:reviewId,state:'provider_pending',safe_message:meta.source==='privy_wallet_action'?'Simulated Privy handoff pending':'External wallet confirmation pending'});
      }catch(_error){return success({review_id:reviewId,state:'provider_failed',safe_message:'The wallet provider returned data LOOP could not safely use.'});}
    }
    function handoff(request){let item,current,start;try{item=record(request,['review_id','live_context','origin','now_ms'],[],'handoff');text(item.review_id,'id');time(item.now_ms,'now');current=live(item.live_context);start=origin(item.origin);}catch(_error){return failure('INVALID_REQUEST','The handoff request is invalid.');}const queued=handoffOutcomes.get(item.review_id);if(queued){handoffOutcomes.delete(item.review_id);if(!same(start,queued.origin)||!same(current,queued.live))return failure('ORIGIN_MISMATCH','The review origin could not be restored safely.');return queued.result;}const session=sessions.get(item.review_id);if(!session||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');if(!returning.has(item.review_id))return failure('HANDOFF_NOT_READY','This review has not returned to its origin.');if(!same(start,session.origin)){take(item.review_id);return failure('ORIGIN_MISMATCH','The review origin could not be restored safely.');}const checked=validate({review_id:item.review_id,live_context:item.live_context,now_ms:item.now_ms});if(!checked.ok){take(item.review_id);return checked;}if(checked.value.acknowledgement_required&&!checked.value.acknowledged){take(item.review_id);return failure('ACKNOWLEDGEMENT_REQUIRED','Acknowledge that the action preview is unavailable before continuing.');}const walletClass=session.model.wallet_class;take(item.review_id);let outcome;try{outcome=providerState(item.review_id,walletClass,adapter.handoffReview({review_id:item.review_id}),item.review_id);}catch(_error){outcome=success({review_id:item.review_id,state:'provider_failed',safe_message:'The wallet provider is temporarily unavailable.'});}handoffOutcomes.set(item.review_id,freeze({origin:start,live:current,result:outcome}));while(handoffOutcomes.size>MAX_SESSIONS)handoffOutcomes.delete(handoffOutcomes.keys().next().value);return success({review_id:item.review_id,state:'handoff_pending',safe_message:'Wallet handoff pending'});}
    function consume(request){let item;try{item=record(request,['review_id'],[],'consume');text(item.review_id,'id');}catch(_error){return failure('INVALID_REQUEST','The consume request is invalid.');}if(!sessions.has(item.review_id)||consumed.has(item.review_id))return failure('SESSION_INVALID','This review is no longer available.');take(item.review_id);return success({review_id:item.review_id,state:'consumed'});}
    return Object.freeze({open,validate,forward,refresh,restore,acknowledge,beginHandoff,handoff,consume});
  }
  globalThis.LoopWalletReview=Object.freeze({decodeReviewSource,createController});
})();
