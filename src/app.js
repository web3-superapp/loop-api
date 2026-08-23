/* ---------- data ----------
   No 0–100 risk score anywhere: a single number invites users to treat a heuristic as a verdict,
   and it is the part of a "risk API" that is least defensible. We surface the underlying facts
   (which functions exist, how concentrated supply is, when LP unlocks) and let the worst one
   drive the badge. Capability is unchanged — only the framing is. See 文档/页面清单.md §5. */
const TOKENS = {
  GLYPH:{name:'Glyph',sym:'$GLYPH',logo:'G',grad:'linear-gradient(135deg,var(--cyan),var(--mint))',chain:'Ethereum',
    price:'$0.00231',chg:'▲ +36.2% · 24h',up:true,liq:'$4.2M',hold:'28,421',vol:'$18.7M',
    pill:['risk-med','LP unlock 3d'],
    sec:[['🟢','Ownership renounced'],['🟢','No mint function'],['🟢','Sells not blocked'],['🟡','Top 3 wallets hold 41%'],['🔴','LP unlocks in 3 days']],
    comm:['12,421 people','34','128','23'],seed:7,drift:.55},
  ETH:{name:'Ethereum',sym:'$ETH',logo:'Ξ',grad:'linear-gradient(135deg,#7fd0ff,#4f7cff)',chain:'Ethereum',
    price:'$3,842.16',chg:'▲ +2.4% · 24h',up:true,liq:'$1.2B',hold:'—',vol:'$14.2B',
    pill:['risk-low','native asset'],
    sec:[['🟢','Native asset — no contract'],['🟢','Deepest liquidity on LOOP'],['🟢','Staking position insured']],
    comm:['214k people','512','2.1k','480'],seed:3,drift:.52},
  SOL:{name:'Solana',sym:'$SOL',logo:'S',grad:'linear-gradient(135deg,#c78bff,#3de8c9)',chain:'Solana',
    price:'$41.52',chg:'▼ −1.1% · 24h',up:false,liq:'$640M',hold:'—',vol:'$3.8B',
    pill:['risk-low','native asset'],
    sec:[['🟢','Native asset — no contract'],['🟢','Validator set healthy']],
    comm:['96k people','301','1.4k','210'],seed:11,drift:.47},
  PXL:{name:'Pixelmind',sym:'$PXL',logo:'P',grad:'linear-gradient(135deg,#ff9a5c,#ffd66e)',chain:'Base',
    price:'$0.0184',chg:'▲ +12.8% · 24h',up:true,liq:'$9.1M',hold:'41,082',vol:'$6.2M',
    pill:['risk-low','LP locked 12mo'],
    sec:[['🟢','Ownership renounced'],['🟢','LP locked 12 months'],['🟡','Team tokens vest monthly']],
    comm:['8,904 people','21','96','14'],seed:5,drift:.56}
};
const MKT = ['ETH','SOL','GLYPH','PXL'];
const perpReadAdapter=(()=>{
  try{
    const provider=globalThis.LoopHyperliquidPerp;
    const fixture=globalThis.LoopHyperliquidPerpOfflineFixture;
    if(!provider||!fixture||!Object.isFrozen(provider)||!Object.isFrozen(fixture)||
       typeof provider.captureAdapter!=='function'||
       typeof provider.createPendingProductionAdapter!=='function'||
       typeof fixture.create!=='function'||fixture.mode!=='offline_readonly'||
       fixture.label!=='Simulated Hyperliquid testnet fixture — no network, signing, or submission'){
      return null;
    }
    return provider.captureAdapter(fixture.create())||
      provider.captureAdapter(provider.createPendingProductionAdapter());
  }catch(_error){return null}
})();
const perpViewState={coin:'ETH',positionId:'',intent:null,intentDeadlineMs:0};
let perpFreshnessTimer=null;
const perpAccountAdapter=(()=>{
  try{
    const provider=globalThis.LoopHyperliquidAccount;
    const fixture=globalThis.LoopHyperliquidAccountOfflineFixture;
    if(!provider||!fixture||!Object.isFrozen(provider)||!Object.isFrozen(fixture)||
       typeof provider.captureAdapter!=='function'||
       typeof provider.createPendingProductionAdapter!=='function'||
       typeof fixture.create!=='function'||fixture.mode!=='offline_readonly'||
       fixture.label!==
        'Simulated Hyperliquid account fixture — read-only, no network, signing, or submission')return null;
    return provider.captureAdapter(fixture.create())||
      provider.captureAdapter(provider.createPendingProductionAdapter());
  }catch(_error){return null}
})();
const PERP_ACCOUNT_REQUEST=Object.freeze({account_ref:'fixture-account-1',asset:'USDC',
  network:'arbitrum',coin:'ETH',notice_id:'core-perp-risk'});
const perpAccountViewState={intent:null,intentDeadlineMs:0,contexts:Object.create(null)};
let perpAccountFreshnessTimer=null;

/* ---------- app state (single source of truth) ---------- */
const REGIONAL_BLOCKED_SESSION_KEY='loop.prototype.regional-blocked.v1';
const REGIONAL_PROBE_SESSION_KEY='loop.prototype.regional-probe.v1';
const regionalSessionAuthority=(()=>{
  let storageReadable=false,storageWritable=false,roundtripConfirmed=false;
  let trusted=true,storageRef=null,blockedObserved=false,probeOrdinal=0;
  const snapshot=()=>Object.freeze({storageReadable,storageWritable,
    roundtripConfirmed,trusted:trusted&&storageReadable&&storageWritable&&
      roundtripConfirmed,blockedObserved});
  const distrust=({readable=storageReadable}={})=>{
    storageReadable=readable;storageWritable=false;roundtripConfirmed=false;
    trusted=false;return snapshot();
  };
  const probeValue=()=>`regional-roundtrip:${String(performance.timeOrigin)}:`+
    `${String(performance.now())}:${String(probeOrdinal+=1)}`;
  function recheck(){
    if(!trusted)return snapshot();
    let store;
    try{store=globalThis.sessionStorage}catch(_error){return distrust({readable:false})}
    if(!store||typeof store!=='object'||(storageRef&&store!==storageRef))
      return distrust({readable:false});
    storageRef=store;
    let previous;
    try{previous=store.getItem(REGIONAL_PROBE_SESSION_KEY);storageReadable=true}
    catch(_error){return distrust({readable:false})}
    const value=probeValue();
    try{
      store.setItem(REGIONAL_PROBE_SESSION_KEY,value);
      if(store.getItem(REGIONAL_PROBE_SESSION_KEY)!==value)return distrust();
      if(previous===null){
        store.removeItem(REGIONAL_PROBE_SESSION_KEY);
        if(store.getItem(REGIONAL_PROBE_SESSION_KEY)!==null)return distrust();
      }else{
        store.setItem(REGIONAL_PROBE_SESSION_KEY,previous);
        if(store.getItem(REGIONAL_PROBE_SESSION_KEY)!==previous)return distrust();
      }
      storageWritable=true;roundtripConfirmed=true;
      blockedObserved=blockedObserved||
        store.getItem(REGIONAL_BLOCKED_SESSION_KEY)==='1';
      return snapshot();
    }catch(_error){return distrust()}
  }
  function persistBlocked(){
    const current=recheck();
    if(!current.trusted)return current;
    try{
      storageRef.setItem(REGIONAL_BLOCKED_SESSION_KEY,'1');
      if(storageRef.getItem(REGIONAL_BLOCKED_SESSION_KEY)!=='1')return distrust();
      blockedObserved=true;return snapshot();
    }catch(_error){return distrust()}
  }
  recheck();
  return Object.freeze({snapshot,recheck,persistBlocked});
})();
let regionalBlockedLatch=regionalSessionAuthority.snapshot().blockedObserved;
const ROUTES = {
  splash:{screen:'scr-splash',stack:['scr-splash'],parent:null,account:true},
  auth:{screen:'scr-auth',stack:['scr-auth'],parent:'splash',account:true},
  'auth-otp':{screen:'scr-auth-otp',stack:['scr-auth','scr-auth-otp'],defaultParent:'auth',account:true,sensitive:true},
  'auth-wallet':{screen:'scr-auth-wallet',stack:['scr-auth','scr-auth-wallet'],parent:'auth',account:true},
  'wallet-create':{screen:'scr-wallet-create',stack:['scr-auth','scr-wallet-create'],account:true,defaultParent:'auth'},
  'wallet-backup':{screen:'scr-wallet-backup',stack:['scr-auth','scr-wallet-create','scr-wallet-backup'],parent:'wallet-create',account:true},
  'seed-show':{screen:'scr-seed-show',stack:['scr-auth','scr-wallet-create','scr-wallet-backup','scr-seed-show'],parent:'wallet-backup',account:true,sensitive:true},
  'seed-verify':{screen:'scr-seed-verify',stack:['scr-auth','scr-wallet-create','scr-wallet-backup','scr-seed-show','scr-seed-verify'],parent:'seed-show',account:true,sensitive:true},
  'wallet-import':{screen:'scr-wallet-import',stack:['scr-auth','scr-wallet-import'],parent:'auth',account:true,sensitive:true},
  home:{screen:'scr-home',stack:['scr-home'],root:true},
  market:{screen:'scr-market',stack:['scr-market'],root:true},
  'perp-markets':{screen:'scr-perp-markets',stack:['scr-market','scr-perp-markets']},
  'perp-market':{screen:'scr-perp-market',stack:['scr-market','scr-perp-markets','scr-perp-market']},
  'perp-order':{screen:'scr-perp-order',stack:['scr-market','scr-perp-markets','scr-perp-market','scr-perp-order']},
  'perp-confirm':{screen:'scr-perp-confirm',stack:['scr-market','scr-perp-markets','scr-perp-market','scr-perp-order','scr-perp-confirm']},
  'perp-positions':{screen:'scr-perp-positions',stack:['scr-market','scr-perp-markets','scr-perp-positions']},
  'perp-orders':{screen:'scr-perp-orders',stack:['scr-market','scr-perp-markets','scr-perp-orders']},
  'perp-position':{screen:'scr-perp-position',stack:['scr-market','scr-perp-markets','scr-perp-positions','scr-perp-position']},
  'perp-account':{screen:'scr-perp-account',stack:['scr-market','scr-perp-markets','scr-perp-account']},
  'perp-transfer':{screen:'scr-perp-transfer',stack:['scr-market','scr-perp-markets','scr-perp-account','scr-perp-transfer']},
  'perp-deposit':{screen:'scr-perp-deposit',stack:['scr-market','scr-perp-markets','scr-perp-account','scr-perp-deposit']},
  'perp-funding':{screen:'scr-perp-funding',stack:['scr-market','scr-perp-markets','scr-perp-funding']},
  'perp-risk-notice':{screen:'scr-perp-risk-notice',stack:['scr-market','scr-perp-markets','scr-perp-account','scr-perp-risk-notice']},
  launchpad:{screen:'scr-launchpad',stack:['scr-launchpad'],root:true},
  chat:{screen:'scr-chat',stack:['scr-chat'],root:true},
  wallet:{screen:'scr-wallet',stack:['scr-wallet'],root:true},
  profile:{screen:'scr-profile',stack:['scr-profile'],root:true},
  pay:{screen:'scr-pay',stack:['scr-home','scr-pay']},
  notifications:{screen:'scr-notifications',stack:['scr-home','scr-notifications']},
  search:{screen:'scr-search',stack:['scr-home','scr-search']},
  token:{screen:'scr-token',stack:['scr-market','scr-token']},
  group:{screen:'scr-group',stack:['scr-chat','scr-group']},
  voiceroom:{screen:'scr-group',stack:['scr-chat','scr-group']},
  dm:{screen:'scr-group',stack:['scr-chat','scr-group']},
  asset:{screen:'scr-asset',stack:['scr-wallet','scr-asset']},
  send:{screen:'scr-send',stack:['scr-wallet','scr-send']},
  'send-to':{screen:'scr-send-to',stack:['scr-wallet','scr-send','scr-send-to']},
  'send-confirm':{screen:'scr-send-confirm',stack:['scr-wallet','scr-send','scr-send-to','scr-send-confirm']},
  receive:{screen:'scr-receive',stack:['scr-wallet','scr-receive']},
  'tx-result':{screen:'scr-tx-result',stack:['scr-wallet','scr-tx-result']},
  swap:{screen:'scr-swap',stack:['scr-wallet','scr-swap']},
  dapp:{screen:'scr-dapp',stack:['scr-wallet','scr-dapp']},
  privacy:{screen:'scr-privacy',stack:['scr-profile','scr-privacy']},
  security:{screen:'scr-security',stack:['scr-profile','scr-security']}
};
const PLATFORM_ADAPTER=globalThis.LoopPlatformOfflineFixture.createAdapter();
const PRODUCTION_REGIONAL_POLICY=
  globalThis.LoopPlatformProvider.consumeProductionRegionalPolicy();
const PLATFORM_RUNTIME=PRODUCTION_REGIONAL_POLICY?'production_injected':'offline_fixture';
const REGIONAL_POLICY=PRODUCTION_REGIONAL_POLICY||
  globalThis.LoopPlatformOfflineFixture.regionalPolicy();
const WALLET_ROUTE_DEFAULT=Object.freeze({asset:'ETH',chain:'ethereum'});
const WALLET_ASSET_IDS=Object.freeze(['ETH','SOL','USDC','GLYPH']);
const WALLET_CHAIN_IDS=Object.freeze(['ethereum','base','arbitrum','solana']);
const WALLET_CHAINS=Object.freeze({
  ethereum:Object.freeze({label:'Ethereum'}),
  base:Object.freeze({label:'Base'}),
  arbitrum:Object.freeze({label:'Arbitrum'}),
  solana:Object.freeze({label:'Solana'})
});
const WALLET_ASSETS=Object.freeze({
  ETH:Object.freeze({name:'Ethereum',symbol:'ETH',chains:Object.freeze(['ethereum','base','arbitrum'])}),
  SOL:Object.freeze({name:'Solana',symbol:'SOL',chains:Object.freeze(['solana'])}),
  USDC:Object.freeze({name:'USD Coin',symbol:'USDC',chains:Object.freeze(['ethereum','base','arbitrum'])}),
  GLYPH:Object.freeze({name:'Glyph',symbol:'GLYPH',chains:Object.freeze(['base'])})
});
function capturePinnedQrFactory(factory){
  try{
    if(typeof factory!=='function') return null;
    const probe=factory(1,'L');
    if(!probe||typeof probe.addData!=='function'||typeof probe.make!=='function'||
       typeof probe.createSvgTag!=='function') return null;
    return factory;
  }catch(_error){return null}
}
const PINNED_QR_FACTORY=capturePinnedQrFactory(globalThis.qrcode);
let walletRouteParams={...WALLET_ROUTE_DEFAULT};
const ROOTS = Object.fromEntries(Object.entries(ROUTES)
  .filter(([,route])=>route.root)
  .map(([hash,route])=>[hash,route.screen]));
const ROOT_SCREENS = new Set(Object.values(ROOTS));
const ACCOUNT_SCREENS = new Set(Object.values(ROUTES)
  .filter(route=>route.account)
  .map(route=>route.screen));
const SCREEN_HASH = Object.entries(ROUTES).reduce((hashes,[hash,route])=>{
  if(!hashes[route.screen]) hashes[route.screen]=hash;
  return hashes;
},{});
const KNOWN_SCREENS = new Set(Object.values(ROUTES).flatMap(route=>route.stack));
const REVIEW_ORIGIN_EXCLUDED = new Set([
  'scr-notifications','scr-search','scr-privacy','scr-security'
]);
const SS_KEY = 'loop.proto.state';
const ONBOARDING_KEYS={complete:'loop.proto.onboarding.complete',backupIncomplete:'loop.proto.onboarding.backupIncomplete',watchOnly:'loop.proto.onboarding.watchOnly',recoveryMethod:'loop.proto.onboarding.recoveryMethod'};
const ONBOARDING_PREFIX = 'loop.proto.onboarding.';
const onboardingMemory=Object.create(null);
const RECOVERY_METHODS = new Set(['phrase','cloud-simulated','social-simulated','skipped']);
const BACKUP_PANELS = new Set(['cloud-simulated','social-simulated','skipped']);
const DEMO_PHRASE = Object.freeze(['orbit','velvet','cactus','harbor','lunar','maple','echo','raven','silver','tunnel','pixel','anchor']);
const PROTOTYPE_SEED_WORDS = DEMO_PHRASE;
const DEMO_BAD_CHECKSUM = 'orbit velvet cactus harbor lunar maple echo raven silver tunnel pixel pixel';
const DEMO_PRIVATE_KEY = '0x'+'1'.repeat(64);
const DEMO_EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const DEMO_SOLANA_ADDRESS = '11111111111111111111111111111111';
const DEMO_IMPORT_WORDS = new Set([...DEMO_PHRASE,'pixel']);
const ACCOUNT_TIMING = Object.freeze({
  splash:800,
  socialAuth:450,
  otpResend:60000,
  otpLock:30000,
  walletSignature:500,
  walletTimeout:10000,
  walletCreate:700,
  seedVerifyLock:30000,
  walletImport:500
});
const ACCOUNT_DEFAULTS = Object.freeze({
  otp:'',
  otpFailures:0,
  otpLockedUntil:0,
  otpExpiresAt:0,
  selectedWallet:'',
  walletState:'idle',
  createState:'idle',
  seedRevealed:false,
  verifyFailures:0,
  verifyLockedUntil:0,
  importMode:'phrase',
  importValue:'',
  authMethod:'',
  timers:Object.freeze([])
});
const account = {...ACCOUNT_DEFAULTS,timers:[]};
let pendingAuthMethod='';

function onboardingFlag(name){
  const key=ONBOARDING_KEYS[name];
  if(!key) return '';
  if(Object.prototype.hasOwnProperty.call(onboardingMemory,name)){
    const value=onboardingMemory[name];
    return name==='recoveryMethod' ? value : value==='true';
  }
  let value='';
  try{
    value=sessionStorage.getItem(key)||'';
    onboardingMemory[name]=value;
  }catch(e){return ''}
  return name==='recoveryMethod' ? (value||'') : value==='true';
}
function setOnboardingFlag(name,value){
  const key=ONBOARDING_KEYS[name];
  if(!key) return;
  const stored=value===null||value===undefined||value==='' ? '' : String(value);
  onboardingMemory[name]=stored;
  try{
    if(stored==='') sessionStorage.removeItem(key);
    else sessionStorage.setItem(key,stored);
  }catch(e){}
}
function clearAccountTimers(){
  account.timers.forEach(timer=>{clearTimeout(timer);clearInterval(timer)});
  account.timers=[];
  resetAuthProgress();
}
function accountTimeout(callback,delay){
  const timer=setTimeout(()=>{
    account.timers=account.timers.filter(candidate=>candidate!==timer);
    callback();
  },delay);
  account.timers.push(timer);
  return timer;
}
function accountInterval(callback,delay){
  const timer=setInterval(callback,delay);
  account.timers.push(timer);
  return timer;
}
function clearAccountTimer(timer){
  clearTimeout(timer);
  clearInterval(timer);
  account.timers=account.timers.filter(candidate=>candidate!==timer);
}
function clearSensitiveDom(){
  document.querySelectorAll('[data-sensitive]').forEach(el=>{
    if('value' in el){el.value='';el.removeAttribute('value')}
    else el.textContent='';
  });
}
function clearSensitiveAccountState(){
  clearAccountTimers();
  account.otp=ACCOUNT_DEFAULTS.otp;
  account.otpFailures=ACCOUNT_DEFAULTS.otpFailures;
  account.otpLockedUntil=ACCOUNT_DEFAULTS.otpLockedUntil;
  account.otpExpiresAt=ACCOUNT_DEFAULTS.otpExpiresAt;
  account.seedRevealed=ACCOUNT_DEFAULTS.seedRevealed;
  account.verifyFailures=ACCOUNT_DEFAULTS.verifyFailures;
  account.verifyLockedUntil=ACCOUNT_DEFAULTS.verifyLockedUntil;
  account.importMode=ACCOUNT_DEFAULTS.importMode;
  account.importValue=ACCOUNT_DEFAULTS.importValue;
  clearSensitiveDom();
  resetSeedShow();
  resetSeedVerifyView();
  resetWalletImportView();
  const toastEl=document.getElementById('toast');
  if(toastEl){toastEl.textContent='';toastEl.classList.remove('show')}
}
function resetAccountState(){
  clearSensitiveAccountState();
  Object.keys(account).forEach(key=>delete account[key]);
  Object.assign(account,ACCOUNT_DEFAULTS,{timers:[]});
  clearSensitiveDom();
}

function setSplashView(view){
  document.querySelectorAll('[data-splash-view]').forEach(panel=>{panel.hidden=panel.dataset.splashView!==view});
}
function blockingSplashDemo(){
  const demo=new URLSearchParams(location.search).get('demo');
  return demo==='splash-force-update'||demo==='splash-maintenance';
}
function finishSplash(){
  if(activeScr()!=='scr-splash'||blockingSplashDemo()) return;
  clearAccountTimers();
  navigate(ROUTES.auth.stack.slice(),{replace:true});
}
function startNormalSplash(){
  setSplashView('normal');
  const status=document.getElementById('splash-progress-copy');
  if(status) status.textContent='Checking account status…';
  accountTimeout(()=>{
    if(activeScr()==='scr-splash'&&!blockingSplashDemo()) finishSplash();
  },ACCOUNT_TIMING.splash);
}
function setupSplash(){
  const demo=new URLSearchParams(location.search).get('demo');
  if(demo==='splash-force-update'){
    setSplashView('force-update');
    return;
  }
  if(demo==='splash-maintenance'){
    setSplashView('maintenance');
    const copy=document.getElementById('splash-maintenance-copy');
    const retry=document.getElementById('splash-retry');
    if(copy) copy.textContent='The service is in maintenance. Your local prototype data is unchanged.';
    if(retry) retry.disabled=false;
    return;
  }
  startNormalSplash();
}
function retrySplashMaintenance(){
  if(activeScr()!=='scr-splash' || new URLSearchParams(location.search).get('demo')!=='splash-maintenance') return;
  clearAccountTimers();
  const copy=document.getElementById('splash-maintenance-copy');
  const retry=document.getElementById('splash-retry');
  if(copy) copy.textContent='Checking service status…';
  if(retry) retry.disabled=true;
  accountTimeout(()=>{
    if(activeScr()!=='scr-splash') return;
    if(copy) copy.textContent='Maintenance is still in progress. Your local prototype data is unchanged.';
    if(retry) retry.disabled=false;
  },ACCOUNT_TIMING.splash);
}
function resetSplashDemo(){
  if(activeScr()!=='scr-splash') return;
  const url=new URL(location.href);
  url.searchParams.delete('demo');
  history.replaceState(history.state,'',url.href);
  resetAccountState();
  startNormalSplash();
}

function passkeyAvailable(){return typeof window.PublicKeyCredential!=='undefined'}
function resetAuthProgress(){
  pendingAuthMethod='';
  document.querySelectorAll('[data-auth-method]').forEach(button=>{
    button.disabled=button.dataset.authMethod==='passkey'&&!passkeyAvailable();
    button.removeAttribute('aria-busy');
    if(button.disabled){
      button.setAttribute('aria-disabled','true');
      if(button.dataset.authMethod==='passkey') button.setAttribute('aria-describedby','auth-passkey-note');
    }else{
      button.removeAttribute('aria-disabled');
      if(button.dataset.authMethod==='passkey') button.removeAttribute('aria-describedby');
    }
    const status=button.querySelector('[data-method-status]');
    if(status) status.textContent='';
  });
}
function setupAuth(){
  resetAuthProgress();
  const note=document.getElementById('auth-passkey-note');
  if(note) note.hidden=passkeyAvailable();
}
function beginSimulatedAuth(button,method){
  if(pendingAuthMethod) return;
  pendingAuthMethod=method;
  account.authMethod=method;
  document.querySelectorAll('[data-auth-method]').forEach(candidate=>candidate.disabled=true);
  button.setAttribute('aria-busy','true');
  const status=button.querySelector('[data-method-status]');
  if(status) status.textContent='Signing in…';
  accountTimeout(()=>{
    if(activeScr()==='scr-auth'&&pendingAuthMethod===method) push('scr-wallet-create');
  },ACCOUNT_TIMING.socialAuth);
}
function chooseAuthMethod(event){
  const button=event.currentTarget;
  const method=button.dataset.authMethod;
  if(activeScr()!=='scr-auth'||button.disabled||pendingAuthMethod) return;
  if(method==='google'||method==='apple'||method==='passkey'){
    beginSimulatedAuth(button,method);
    return;
  }
  account.authMethod=method;
  if(method==='email'||method==='phone') push('scr-auth-otp');
  else if(method==='wallet') push('scr-auth-wallet');
  else if(method==='import') push('scr-wallet-import');
}
function otpInputs(){
  return [...document.querySelectorAll('#scr-auth-otp .otp-inputs input')];
}
function setOtpStatus(message,{error=false}={}){
  const status=document.getElementById('otp-status');
  if(!status) return;
  status.textContent=message;
  status.classList.toggle('is-error',error);
  otpInputs().forEach(input=>{
    if(error){
      input.setAttribute('aria-invalid','true');
      input.setAttribute('aria-describedby','otp-help otp-status');
    }else{
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby','otp-help');
    }
  });
}
function clearOtpInputs(){
  otpInputs().forEach(input=>{input.value='';input.removeAttribute('value')});
  account.otp='';
}
function otpIsLocked(){return account.otpLockedUntil>Date.now()}
function updateOtpControls(){
  const locked=otpIsLocked();
  otpInputs().forEach(input=>{input.disabled=locked});
  const verify=document.getElementById('otp-verify');
  if(verify) verify.disabled=locked||account.otp.length!==6;
  const resend=document.getElementById('otp-resend');
  if(resend) resend.disabled=locked||Date.now()<account.otpExpiresAt;
}
function syncOtpFromInputs(){
  account.otp=otpInputs().map(input=>input.value).join('').replace(/\D/g,'').slice(0,6);
  updateOtpControls();
}
function renderOtpResend(deadline){
  const resend=document.getElementById('otp-resend');
  const countdown=document.getElementById('otp-resend-countdown');
  if(!resend||!countdown) return;
  const remaining=Math.max(0,deadline-Date.now());
  resend.disabled=otpIsLocked()||remaining>0;
  countdown.textContent=remaining>0
    ? `Available in ${Math.ceil(remaining/1000)} seconds`
    : 'You can resend now';
}
function startOtpResendCountdown(){
  const deadline=Date.now()+ACCOUNT_TIMING.otpResend;
  account.otpExpiresAt=deadline;
  renderOtpResend(deadline);
  const ticker=accountInterval(()=>{
    if(activeScr()!=='scr-auth-otp'||account.otpExpiresAt!==deadline) return;
    renderOtpResend(deadline);
  },1000);
  accountTimeout(()=>{
    clearAccountTimer(ticker);
    if(activeScr()!=='scr-auth-otp'||account.otpExpiresAt!==deadline) return;
    renderOtpResend(deadline);
  },ACCOUNT_TIMING.otpResend);
}
function setupOtp(){
  account.otpFailures=0;
  account.otpLockedUntil=0;
  clearOtpInputs();
  setOtpStatus('');
  renderOtpLockCountdown(Date.now());
  const context=document.getElementById('otp-auth-context');
  if(context){
    context.textContent=account.authMethod==='email'
      ? 'Enter the code sent to your email.'
      : account.authMethod==='phone'
        ? 'Enter the code sent to your phone.'
        : 'Enter the code sent using your selected sign-in method.';
  }
  updateOtpControls();
  startOtpResendCountdown();
}
function handleOtpInput(event){
  if(otpIsLocked()||event.isComposing) return;
  const inputs=otpInputs();
  const index=inputs.indexOf(event.currentTarget);
  const replacement=event.inputType==='insertReplacementText' ? event.data||'' : '';
  const raw=replacement.length>event.currentTarget.value.length
    ? replacement : event.currentTarget.value;
  const digits=raw.replace(/\D/g,'');
  if(digits.length>1){
    distributeOtpDigits(index,digits);
    return;
  }
  event.currentTarget.value=digits.slice(-1);
  syncOtpFromInputs();
  if(event.currentTarget.value&&index<inputs.length-1) inputs[index+1].focus();
}
function handleOtpKeydown(event){
  const inputs=otpInputs();
  const index=inputs.indexOf(event.currentTarget);
  if(event.key==='Backspace'&&!event.currentTarget.value&&index>0){
    event.preventDefault();
    inputs[index-1].focus();
  }else if(event.key==='ArrowLeft'&&index>0){
    event.preventDefault();
    inputs[index-1].focus();
  }else if(event.key==='ArrowRight'&&index<inputs.length-1){
    event.preventDefault();
    inputs[index+1].focus();
  }
}
function handleOtpPaste(event){
  if(otpIsLocked()) return;
  event.preventDefault();
  const inputs=otpInputs();
  const start=inputs.indexOf(event.currentTarget);
  distributeOtpDigits(start,event.clipboardData?.getData('text')||'');
}
function distributeOtpDigits(start,value){
  const inputs=otpInputs();
  const digits=value.replace(/\D/g,'').slice(0,inputs.length-start);
  inputs.slice(start).forEach(input=>{input.value=''});
  [...digits].forEach((digit,offset)=>{inputs[start+offset].value=digit});
  syncOtpFromInputs();
  const destination=Math.min(start+Math.max(digits.length,1)-1,inputs.length-1);
  inputs[destination].focus();
}
function handleOtpCompositionEnd(event){
  if(otpIsLocked()) return;
  const inputs=otpInputs();
  const start=inputs.indexOf(event.currentTarget);
  const composed=event.currentTarget.value.length>String(event.data||'').length
    ? event.currentTarget.value : String(event.data||event.currentTarget.value);
  distributeOtpDigits(start,composed);
}
function renderOtpLockCountdown(deadline){
  const countdown=document.getElementById('otp-lock-countdown');
  if(!countdown) return;
  const remaining=Math.max(0,deadline-Date.now());
  countdown.hidden=remaining<=0;
  countdown.textContent=remaining>0
    ? `Try again in ${Math.ceil(remaining/1000)} seconds`
    : '';
}
function unlockOtp(deadline,ticker){
  clearAccountTimer(ticker);
  if(activeScr()!=='scr-auth-otp'||account.otpLockedUntil!==deadline) return;
  account.otpFailures=0;
  account.otpLockedUntil=0;
  clearOtpInputs();
  updateOtpControls();
  renderOtpLockCountdown(deadline);
  setOtpStatus('You can try again.');
}
function lockOtp(){
  const deadline=Date.now()+ACCOUNT_TIMING.otpLock;
  account.otpLockedUntil=deadline;
  updateOtpControls();
  setOtpStatus('Too many invalid attempts. Verification is temporarily locked.',{error:true});
  renderOtpLockCountdown(deadline);
  const updateCountdown=()=>{
    if(activeScr()!=='scr-auth-otp'||account.otpLockedUntil!==deadline) return;
    renderOtpLockCountdown(deadline);
  };
  const ticker=accountInterval(updateCountdown,1000);
  accountTimeout(()=>unlockOtp(deadline,ticker),ACCOUNT_TIMING.otpLock);
}
function verifyOtp(event){
  event.preventDefault();
  if(activeScr()!=='scr-auth-otp'||otpIsLocked()||account.otp.length!==6) return;
  if(account.otp==='246810'){
    clearOtpInputs();
    push('scr-wallet-create');
    return;
  }
  if(account.otp==='000000'){
    setOtpStatus('Code expired. Request a new code.',{error:true});
    return;
  }
  if(account.otp==='999998'){
    setOtpStatus('Service unavailable. Try again.',{error:true});
    return;
  }
  account.otpFailures+=1;
  if(account.otpFailures>=5){
    lockOtp();
    return;
  }
  setOtpStatus('Invalid code. Try again.',{error:true});
  updateOtpControls();
}
function resendOtp(){
  const resend=document.getElementById('otp-resend');
  if(activeScr()!=='scr-auth-otp'||otpIsLocked()||!resend||resend.disabled||Date.now()<account.otpExpiresAt) return;
  clearAccountTimers();
  clearOtpInputs();
  setOtpStatus('New code sent.');
  updateOtpControls();
  startOtpResendCountdown();
}
function walletDemoUnavailable(){
  return new URLSearchParams(location.search).get('demo')==='wallet-none';
}
function setWalletStatus(message,{error=false}={}){
  const status=document.getElementById('wallet-connect-state');
  if(!status) return;
  status.textContent=message;
  status.classList.toggle('is-error',error);
}
function renderExternalWallet(message=''){
  const idle=account.walletState==='idle';
  const terminal=['rejected','timeout','error'].includes(account.walletState);
  const signature=account.walletState==='signature';
  document.querySelectorAll('#wallet-detected-list input[type="radio"]').forEach(option=>{
    option.checked=option.value===account.selectedWallet;
    option.disabled=!idle;
  });
  const connect=document.getElementById('wallet-connect');
  if(connect) connect.disabled=!idle||!account.selectedWallet;
  const approve=document.getElementById('wallet-sign-approve');
  const reject=document.getElementById('wallet-sign-reject');
  const retry=document.getElementById('wallet-connect-retry');
  if(approve) approve.hidden=!signature;
  if(reject) reject.hidden=!signature;
  if(retry) retry.hidden=!terminal;
  setWalletStatus(message,{error:terminal});
}
function setupExternalWallet(){
  account.selectedWallet='';
  account.walletState='idle';
  const unavailable=walletDemoUnavailable();
  const detected=document.getElementById('wallet-detected');
  const empty=document.getElementById('wallet-empty-state');
  const connect=document.getElementById('wallet-connect');
  if(detected) detected.hidden=unavailable;
  if(empty) empty.hidden=!unavailable;
  if(connect) connect.hidden=unavailable;
  renderExternalWallet();
}
function selectExternalWallet(event){
  if(activeScr()!=='scr-auth-wallet'||account.walletState!=='idle') return;
  account.selectedWallet=event.currentTarget.value;
  renderExternalWallet();
}
function startExternalWalletConnection(){
  if(activeScr()!=='scr-auth-wallet'||account.walletState!=='idle'||!account.selectedWallet) return;
  const selected=account.selectedWallet;
  account.walletState='waiting';
  const label={demo:'Demo Wallet',timeout:'Timeout Wallet',failure:'Failure Wallet'}[selected];
  renderExternalWallet(`Connecting to ${label}…`);
  const delay=selected==='timeout' ? ACCOUNT_TIMING.walletTimeout : ACCOUNT_TIMING.walletSignature;
  accountTimeout(()=>{
    if(activeScr()!=='scr-auth-wallet'||account.walletState!=='waiting'||account.selectedWallet!==selected) return;
    if(selected==='demo'){
      account.walletState='signature';
      renderExternalWallet('Approve the signature request in this prototype. No real signature is created.');
      return;
    }
    if(selected==='timeout'){
      account.walletState='timeout';
      renderExternalWallet('Connection timed out. Try again.');
      return;
    }
    account.walletState='error';
    renderExternalWallet('Could not connect to this wallet. Try again.');
  },delay);
}
function approveExternalWallet(){
  if(activeScr()!=='scr-auth-wallet'||account.walletState!=='signature') return;
  account.walletState='connected';
  renderExternalWallet();
  completeOnboarding();
}
function rejectExternalWallet(){
  if(activeScr()!=='scr-auth-wallet'||account.walletState!=='signature') return;
  account.walletState='rejected';
  renderExternalWallet('Connection request rejected. No account was connected.');
}
function retryExternalWallet(){
  if(activeScr()!=='scr-auth-wallet'||!['rejected','timeout','error'].includes(account.walletState)) return;
  account.walletState='idle';
  renderExternalWallet();
}
function setCreateStatus(message,{error=false}={}){
  const status=document.getElementById('wallet-create-status');
  if(!status) return;
  status.textContent=message;
  status.classList.toggle('is-error',error);
}
function renderWalletCreate(message=''){
  const idle=account.createState==='idle';
  const creating=account.createState==='creating';
  const failed=account.createState==='error';
  const start=document.getElementById('wallet-create-start');
  const fail=document.getElementById('wallet-create-fail-demo');
  const retry=document.getElementById('wallet-create-retry');
  if(start) start.disabled=!idle;
  if(fail) fail.disabled=!idle;
  if(retry){retry.hidden=!failed;retry.disabled=!failed}
  setCreateStatus(message,{error:failed});
}
function setupWalletCreate(){
  account.createState='idle';
  renderWalletCreate();
}
function scheduleWalletCreation(shouldFail){
  account.createState='creating';
  renderWalletCreate('Creating simulated wallet…');
  accountTimeout(()=>{
    if(activeScr()!=='scr-wallet-create'||account.createState!=='creating') return;
    if(shouldFail){
      account.createState='error';
      renderWalletCreate('Wallet creation demo failed. Try again.');
      return;
    }
    account.createState='created';
    renderWalletCreate('Simulated wallet created.');
    push('scr-wallet-backup');
  },ACCOUNT_TIMING.walletCreate);
}
function beginWalletCreation(shouldFail=false){
  if(activeScr()!=='scr-wallet-create'||account.createState!=='idle') return;
  scheduleWalletCreation(shouldFail);
}
function retryWalletCreation(){
  if(activeScr()!=='scr-wallet-create'||account.createState!=='error') return;
  scheduleWalletCreation(false);
}

let pendingBackupChoice='';
function isValidBackupPanel(value){
  return typeof value==='string'&&BACKUP_PANELS.has(value);
}
function backupChoiceElement(panel){
  return document.querySelector(`#scr-wallet-backup [data-backup-choice="${panel}"]`);
}
function showBackupChoices(){
  pendingBackupChoice='';
  const choices=document.getElementById('backup-choice-view');
  const confirmation=document.getElementById('backup-confirmation');
  if(choices) choices.hidden=false;
  if(confirmation) confirmation.hidden=true;
}
function setupWalletBackup(){
  const panel=history.state?.backupPanel;
  if(isValidBackupPanel(panel)&&hasValidBackupPanelHistoryProvenance()){
    renderBackupConfirmation(panel);
    return;
  }
  if(panel!==undefined){
    const safeState={...(history.state||{})};
    delete safeState.backupPanel;
    delete safeState.accountPushed;
    delete safeState.accountEntryId;
    history.replaceState(safeState,'',location.href);
  }
  showBackupChoices();
}
function renderBackupConfirmation(method){
  if(!isValidBackupPanel(method)){
    showBackupChoices();
    return;
  }
  pendingBackupChoice=method;
  const choices=document.getElementById('backup-choice-view');
  const confirmation=document.getElementById('backup-confirmation');
  const title=document.getElementById('backup-confirm-title');
  const copy=document.getElementById('backup-confirm-copy');
  const note=document.getElementById('backup-simulation-note');
  const continueButton=document.getElementById('backup-confirm-continue');
  const skipButton=document.getElementById('backup-skip-confirm');
  if(choices) choices.hidden=true;
  if(confirmation) confirmation.hidden=false;
  if(method==='skipped'){
    if(confirmation) confirmation.classList.add('state-panel-danger');
    if(title) title.textContent='Back up later?';
    if(copy) copy.textContent='If this device is lost or damaged, you may permanently lose access to the wallet and its assets.';
    if(note) note.textContent='This first step does not complete setup. Use the separate destructive confirmation only if you accept permanent loss risk.';
    if(continueButton) continueButton.hidden=true;
    if(skipButton) skipButton.hidden=false;
    if(title) title.focus({preventScroll:true});
    return;
  }
  if(confirmation) confirmation.classList.remove('state-panel-danger');
  if(title) title.textContent=method==='cloud-simulated' ? 'Cloud backup' : 'Social recovery 2-of-3';
  if(copy) copy.textContent=method==='cloud-simulated'
    ? 'Continue with a local cloud-backup simulation.'
    : 'Continue with a local 2-of-3 social-recovery simulation. No guardians are configured.';
  if(note) note.textContent='Designed for Privy · simulated in this prototype';
  if(continueButton){continueButton.hidden=false;continueButton.disabled=false}
  if(skipButton) skipButton.hidden=true;
  if(title) title.focus({preventScroll:true});
}
function chooseBackupMethod(event){
  if(activeScr()!=='scr-wallet-backup') return;
  const method=event.currentTarget.dataset.backupChoice;
  if(method==='phrase'){
    push('scr-seed-show');
    return;
  }
  if(!isValidBackupPanel(method)) return;
  const nextState={...(history.state||{}),backupPanel:method};
  const pushed=accountHistoryProof.push(nextState,location.href,{
    kind:'backup-panel',route:'wallet-backup',stack:stack.slice(),panel:method,
    accountPushed:nextState.accountPushed===true,
  });
  if(!pushed){
    const safeState={...(history.state||{})};
    delete safeState.backupPanel;
    delete safeState.accountEntryId;
    history.replaceState(safeState,'',location.href);
  }
  renderBackupConfirmation(method);
}
function cancelBackupConfirmation(){
  if(activeScr()!=='scr-wallet-backup') return;
  if(hasValidBackupPanelHistoryProvenance()){
    history.back();
    return;
  }
  showBackupChoices();
}
function confirmBackupMethod(){
  if(activeScr()!=='scr-wallet-backup'||
      !['cloud-simulated','social-simulated'].includes(pendingBackupChoice)) return;
  completeOnboarding({recoveryMethod:pendingBackupChoice});
}
function confirmSkippedBackup(){
  if(activeScr()!=='scr-wallet-backup'||pendingBackupChoice!=='skipped') return;
  completeOnboarding({recoveryMethod:'skipped',backupIncomplete:true});
}

function resetSeedShow(){
  const words=document.getElementById('seed-words');
  if(words) words.replaceChildren();
  account.seedRevealed=false;
  const acknowledgement=document.getElementById('seed-show-ack');
  const reveal=document.getElementById('seed-show-reveal');
  const recorded=document.getElementById('seed-show-recorded');
  const proceed=document.getElementById('seed-show-continue');
  if(acknowledgement) acknowledgement.checked=false;
  if(reveal){reveal.disabled=true;reveal.setAttribute('aria-expanded','false')}
  if(recorded){recorded.checked=false;recorded.disabled=true}
  if(proceed) proceed.disabled=true;
}
function setupSeedShow(){
  resetSeedShow();
}
function updateSeedRevealGate(){
  const acknowledgement=document.getElementById('seed-show-ack');
  const reveal=document.getElementById('seed-show-reveal');
  if(reveal) reveal.disabled=account.seedRevealed||!acknowledgement?.checked;
}
function revealPrototypeSeed(){
  if(activeScr()!=='scr-seed-show'||account.seedRevealed||
      !document.getElementById('seed-show-ack')?.checked) return;
  const list=document.getElementById('seed-words');
  if(!list) return;
  const fragment=document.createDocumentFragment();
  PROTOTYPE_SEED_WORDS.forEach(word=>{
    const item=document.createElement('li');
    item.textContent=word;
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
  account.seedRevealed=true;
  const reveal=document.getElementById('seed-show-reveal');
  const recorded=document.getElementById('seed-show-recorded');
  if(reveal) reveal.disabled=true;
  if(reveal) reveal.setAttribute('aria-expanded','true');
  if(recorded) recorded.disabled=false;
}
function updateSeedRecordedGate(){
  const recorded=document.getElementById('seed-show-recorded');
  const proceed=document.getElementById('seed-show-continue');
  if(proceed) proceed.disabled=!account.seedRevealed||!recorded?.checked;
}
function continueSeedVerification(){
  if(activeScr()!=='scr-seed-show'||!account.seedRevealed||
      !document.getElementById('seed-show-recorded')?.checked) return;
  resetSeedShow();
  push('scr-seed-verify');
}
function blockSeedPhraseAction(event){
  event.preventDefault();
  event.stopPropagation();
}

const SEED_VERIFY_POSITIONS = Object.freeze([3,7,11]);
function seedVerifyInputs(){
  return SEED_VERIFY_POSITIONS.map(position=>document.getElementById(`seed-verify-${position}`))
    .filter(Boolean);
}
function seedVerifyIsLocked(){return account.verifyLockedUntil>Date.now()}
function seedVerifyFieldError(){return document.getElementById('seed-verify-field-error')}
function syncSeedVerifyFieldError(){
  const error=seedVerifyFieldError();
  if(error) error.hidden=!seedVerifyInputs().some(input=>input.getAttribute('aria-invalid')==='true');
}
function clearSeedVerifyInputError(input){
  input.removeAttribute('aria-invalid');
  input.setAttribute('aria-describedby','seed-verify-help');
  syncSeedVerifyFieldError();
}
function markSeedVerifyInputError(input){
  input.setAttribute('aria-invalid','true');
  input.setAttribute('aria-describedby','seed-verify-help seed-verify-field-error');
}
function clearSeedVerifyErrors(){
  seedVerifyInputs().forEach(input=>{
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby','seed-verify-help');
  });
  const error=seedVerifyFieldError();
  if(error) error.hidden=true;
}
function setSeedVerifyStatus(message,{error=false}={}){
  const status=document.getElementById('seed-verify-status');
  if(!status) return;
  status.textContent=message;
  status.classList.toggle('is-error',error);
}
function renderSeedVerifyAttempts(){
  const attempts=document.getElementById('seed-verify-attempts');
  if(!attempts) return;
  const remaining=Math.max(0,5-account.verifyFailures);
  attempts.textContent=`${remaining} attempt${remaining===1?'':'s'} remaining.`;
}
function renderSeedVerifyCountdown(deadline){
  const countdown=document.getElementById('seed-verify-countdown');
  if(!countdown) return;
  const remaining=Math.max(0,deadline-Date.now());
  countdown.textContent=remaining>0
    ? `Try again in ${Math.ceil(remaining/1000)} seconds`
    : '';
}
function updateSeedVerifyControls(){
  const inputs=seedVerifyInputs();
  const locked=seedVerifyIsLocked();
  inputs.forEach(input=>{input.disabled=locked});
  const submit=document.getElementById('seed-verify-submit');
  if(submit) submit.disabled=locked||inputs.length!==3||inputs.some(input=>!input.value.trim());
}
function handleSeedVerifyInput(event){
  clearSeedVerifyInputError(event.currentTarget);
  updateSeedVerifyControls();
}
function resetSeedVerifyView(){
  seedVerifyInputs().forEach(input=>{input.value='';input.removeAttribute('value');input.disabled=false});
  clearSeedVerifyErrors();
  account.verifyFailures=0;
  account.verifyLockedUntil=0;
  setSeedVerifyStatus('');
  renderSeedVerifyAttempts();
  renderSeedVerifyCountdown(0);
  updateSeedVerifyControls();
}
function setupSeedVerify(){
  resetSeedVerifyView();
}
function unlockSeedVerify(deadline,ticker){
  clearAccountTimer(ticker);
  if(activeScr()!=='scr-seed-verify'||account.verifyLockedUntil!==deadline) return;
  seedVerifyInputs().forEach(input=>{input.value='';input.removeAttribute('value')});
  clearSeedVerifyErrors();
  account.verifyFailures=0;
  account.verifyLockedUntil=0;
  renderSeedVerifyAttempts();
  renderSeedVerifyCountdown(deadline);
  updateSeedVerifyControls();
  setSeedVerifyStatus('You can try again.');
}
function lockSeedVerify(){
  const deadline=Date.now()+ACCOUNT_TIMING.seedVerifyLock;
  account.verifyLockedUntil=deadline;
  updateSeedVerifyControls();
  renderSeedVerifyAttempts();
  renderSeedVerifyCountdown(deadline);
  setSeedVerifyStatus('Too many incorrect attempts. Verification is locked for 30 seconds.',{error:true});
  const ticker=accountInterval(()=>{
    if(activeScr()==='scr-seed-verify'&&account.verifyLockedUntil===deadline){
      renderSeedVerifyCountdown(deadline);
    }
  },1000);
  accountTimeout(()=>unlockSeedVerify(deadline,ticker),ACCOUNT_TIMING.seedVerifyLock);
}
function verifySeedWords(event){
  event.preventDefault();
  if(activeScr()!=='scr-seed-verify'||seedVerifyIsLocked()) return;
  const inputs=seedVerifyInputs();
  if(inputs.length!==3||inputs.some(input=>!input.value.trim())) return;
  const expected=SEED_VERIFY_POSITIONS.map(position=>PROTOTYPE_SEED_WORDS[position-1]);
  const correct=inputs.map((input,index)=>input.value.trim().toLowerCase()===expected[index]);
  if(correct.every(Boolean)){
    inputs.forEach(input=>{input.value='';input.removeAttribute('value')});
    clearSeedVerifyErrors();
    account.verifyFailures=0;
    account.verifyLockedUntil=0;
    completeOnboarding({recoveryMethod:'phrase'});
    return;
  }
  account.verifyFailures+=1;
  inputs.forEach((input,index)=>{
    if(correct[index]) clearSeedVerifyInputError(input);
    else{
      input.value='';
      input.removeAttribute('value');
      markSeedVerifyInputError(input);
    }
  });
  syncSeedVerifyFieldError();
  if(account.verifyFailures>=5){
    lockSeedVerify();
    return;
  }
  setSeedVerifyStatus('One or more words were incorrect. Try again.',{error:true});
  renderSeedVerifyAttempts();
  updateSeedVerifyControls();
}
const IMPORT_MODE_COPY = Object.freeze({
  phrase:{label:'Recovery phrase',help:'Enter exactly 12 words from the labeled prototype fixture.',
    fixture:()=>`Prototype test phrase: ${DEMO_PHRASE.join(' ')}`},
  private:{label:'Private key',help:'Enter the labeled 0x-prefixed, 64-hex prototype key.',
    fixture:()=>`Prototype test private key: ${DEMO_PRIVATE_KEY}`},
  watch:{label:'Watch-only address',help:'Enter the labeled EVM or Solana prototype address.',
    fixture:()=>`Prototype EVM: ${DEMO_EVM_ADDRESS} · Prototype Solana: ${DEMO_SOLANA_ADDRESS}`}
});
function importMode(){return Object.prototype.hasOwnProperty.call(IMPORT_MODE_COPY,account.importMode) ? account.importMode : 'phrase'}
function setImportStatus(message,{error=false}={}){
  const status=document.getElementById('wallet-import-status');
  const field=document.getElementById('wallet-import-value');
  if(status){status.textContent=message;status.classList.toggle('is-error',Boolean(error))}
  if(field){
    if(error) field.setAttribute('aria-invalid','true');
    else field.removeAttribute('aria-invalid');
  }
}
function setImportLoading(loading){
  const screen=document.getElementById('scr-wallet-import');
  const submit=document.getElementById('wallet-import-submit');
  const field=document.getElementById('wallet-import-value');
  if(screen) screen.setAttribute('aria-busy',String(Boolean(loading)));
  document.querySelectorAll('[name="wallet-import-mode"]').forEach(option=>{option.disabled=Boolean(loading)});
  if(submit){submit.disabled=Boolean(loading);submit.textContent=loading ? 'Importing…' : 'Import wallet'}
  if(field) field.disabled=Boolean(loading);
}
function renderImportField(){
  const host=document.getElementById('wallet-import-field-host');
  const fixture=document.getElementById('wallet-import-fixture');
  if(!host||!fixture) return;
  const mode=importMode();
  const copy=IMPORT_MODE_COPY[mode];
  const label=document.createElement('label');
  label.htmlFor='wallet-import-value';
  label.textContent=copy.label;
  const field=document.createElement(mode==='phrase' ? 'textarea' : 'input');
  field.id='wallet-import-value';
  field.name=`wallet-import-${mode}`;
  field.autocomplete='off';
  field.spellcheck=false;
  field.setAttribute('data-sensitive','');
  field.setAttribute('aria-describedby','wallet-import-help wallet-import-status');
  if(mode==='phrase') field.rows=4;
  else field.type=mode==='private' ? 'password' : 'text';
  field.addEventListener('input',handleImportInput);
  const help=document.createElement('p');
  help.id='wallet-import-help';
  help.className='account-note';
  help.textContent=copy.help;
  host.replaceChildren(label,field,help);
  fixture.textContent=copy.fixture();
}
function resetWalletImportView(){
  const fixture=document.getElementById('wallet-import-fixture');
  const status=document.getElementById('wallet-import-status');
  if(fixture) fixture.textContent='';
  if(status){status.textContent='';status.classList.remove('is-error')}
  document.querySelectorAll('[name="wallet-import-mode"]').forEach(option=>{
    option.checked=option.value===ACCOUNT_DEFAULTS.importMode;
  });
  setImportLoading(false);
}
function setupWalletImport(){
  account.importMode=ACCOUNT_DEFAULTS.importMode;
  account.importValue='';
  document.querySelectorAll('[name="wallet-import-mode"]').forEach(option=>{
    option.checked=option.value===account.importMode;
  });
  setImportStatus('');
  renderImportField();
  setImportLoading(false);
}
function chooseImportMode(event){
  const mode=event.currentTarget.value;
  if(!Object.prototype.hasOwnProperty.call(IMPORT_MODE_COPY,mode)||mode===account.importMode) return;
  clearAccountTimers();
  setImportLoading(false);
  const previous=document.getElementById('wallet-import-value');
  if(previous){previous.value='';previous.removeAttribute('value')}
  account.importValue='';
  account.importMode=mode;
  setImportStatus('');
  renderImportField();
}
function handleImportInput(event){
  account.importValue=event.currentTarget.value;
  setImportStatus('');
}
function isDemoEvmAddress(value){return /^0x[0-9a-fA-F]{40}$/.test(value)}
function isDemoSolanaAddress(value){return value===DEMO_SOLANA_ADDRESS}
function validateImport(mode,value){
  const v=value.trim();
  if(mode==='phrase'){
    const words=v.toLowerCase().split(/\s+/).filter(Boolean);
    const normalized=words.join(' ');
    if(words.length!==12) return 'Enter exactly 12 recovery words.';
    if(words.some(word=>!DEMO_IMPORT_WORDS.has(word))) return 'One or more words are not recognized.';
    if(normalized===DEMO_BAD_CHECKSUM) return 'The recovery phrase checksum is invalid.';
    return '';
  }
  if(mode==='private'){
    if(!/^0x[0-9a-fA-F]{64}$/.test(v)) return 'Enter 0x followed by 64 hexadecimal characters.';
    return '';
  }
  if(!isDemoEvmAddress(v)&&!isDemoSolanaAddress(v)) return 'Enter a supported EVM or Solana address.';
  return '';
}
function scheduleWalletImportResult(error,watchOnly){
  setImportLoading(true);
  accountTimeout(()=>{
    if(activeScr()!=='scr-wallet-import') return;
    setImportLoading(false);
    if(error){
      setImportStatus(error,{error:true});
      document.getElementById('wallet-import-value')?.focus();
      return;
    }
    completeOnboarding(watchOnly ? {watchOnly:true} : {});
  },ACCOUNT_TIMING.walletImport);
}
function submitWalletImport(){
  if(activeScr()!=='scr-wallet-import') return;
  if(document.getElementById('scr-wallet-import').getAttribute('aria-busy')==='true') return;
  const field=document.getElementById('wallet-import-value');
  const mode=importMode();
  const value=field ? field.value : '';
  account.importValue=value;
  const error=validateImport(mode,value);
  if(field){field.value='';field.removeAttribute('value')}
  account.importValue='';
  setImportStatus('');
  const fixture=document.getElementById('wallet-import-fixture');
  if(fixture) fixture.textContent='';
  scheduleWalletImportResult(error,mode==='watch');
}
function setupAccountScreen(screen){
  if(!isAccountScreen(screen)) return;
  clearAccountTimers();
  if(screen==='scr-splash') setupSplash();
  if(screen==='scr-auth') setupAuth();
  if(screen==='scr-auth-otp') setupOtp();
  if(screen==='scr-auth-wallet') setupExternalWallet();
  if(screen==='scr-wallet-create') setupWalletCreate();
  if(screen==='scr-wallet-backup') setupWalletBackup();
  if(screen==='scr-seed-show') setupSeedShow();
  if(screen==='scr-seed-verify') setupSeedVerify();
  if(screen==='scr-wallet-import') setupWalletImport();
}
function focusActiveScreen({backupChoice=''}={}){
  const screen=document.getElementById(activeScr());
  if(!screen) return;
  const watchNotice=document.getElementById('watch-only-notice');
  let target=screen.id==='scr-home'
    ? (watchNotice&&!watchNotice.hidden&&screen.contains(watchNotice)
      ? watchNotice : document.getElementById('home-title'))
    : screen.querySelector('[data-route-focus]')||screen.querySelector('h1,h2')||
      screen.querySelector('input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled)');
  if(screen.id!=='scr-home'&&!screen.classList.contains('account-screen')&&
     !screen.classList.contains('platform-screen')) return;
  if(target?.matches('h1,h2')&&!target.hasAttribute('tabindex')) target.setAttribute('tabindex','-1');
  let focusImmediately=screen.id==='scr-home';
  if(screen.id==='scr-wallet-backup'){
    if(hasValidBackupPanelHistoryProvenance()){
      target=document.getElementById('backup-confirm-title');
      focusImmediately=true;
    }else if(isValidBackupPanel(backupChoice)){
      target=backupChoiceElement(backupChoice);
      focusImmediately=true;
    }
  }
  if(!target) return;
  if(focusImmediately){
    target.focus({preventScroll:true});
    return;
  }
  requestAnimationFrame(()=>{
    if(screen.id===activeScr()&&screen.classList.contains('active')&&!screen.hasAttribute('inert')){
      target.focus({preventScroll:true});
    }
  });
}
function isAccountRoute(routeName){return Boolean(ROUTES[routeName]&&ROUTES[routeName].account)}
function isAccountScreen(screen){return ACCOUNT_SCREENS.has(screen)}
function isValidStack(value){
  return Array.isArray(value)&&value.length>0&&
    value.every(screen=>typeof screen==='string'&&KNOWN_SCREENS.has(screen))&&
    Boolean(SCREEN_HASH[value[value.length-1]]);
}
function routeNameForAccountScreen(screen){
  const entry=Object.entries(ROUTES).find(([,route])=>route.account&&route.screen===screen);
  return entry ? entry[0] : '';
}
function sameStack(left,right){
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&
    left.every((screen,index)=>screen===right[index]);
}
const accountHistoryProof=(()=>{
  /* Keep runtime authorization bounded by both a conservative cap and the
     browser history entries this document can still reach. */
  const MAX_ACCOUNT_HISTORY_PROOFS=32;
  const issued=new Map();
  let fallbackSequence=0;
  const currentEntryKey=()=>globalThis.navigation?.currentEntry?.key||'';
  const accessibleEntryKeys=()=>{
    if(typeof globalThis.navigation?.entries!=='function') return null;
    try{
      return new Set(globalThis.navigation.entries()
        .map(entry=>entry?.key).filter(key=>typeof key==='string'&&key));
    }catch(error){return null}
  };
  const accessibleHistoryBudget=()=>{
    try{
      const length=Number(history.length);
      return Number.isFinite(length) ? Math.max(0,Math.floor(length)) : 0;
    }catch(error){return 0}
  };
  const prune=()=>{
    const keys=accessibleEntryKeys();
    if(keys){
      for(const [id,proof] of issued){
        if(!keys.has(proof.entryKey)) issued.delete(id);
      }
    }
    const browserBudget=keys ? Math.min(keys.size,accessibleHistoryBudget())
      : accessibleHistoryBudget();
    const limit=Math.min(MAX_ACCOUNT_HISTORY_PROOFS,browserBudget);
    while(issued.size>limit){
      issued.delete(issued.keys().next().value);
    }
  };
  const opaqueId=()=>{
    if(typeof globalThis.crypto?.randomUUID==='function') return globalThis.crypto.randomUUID();
    const bytes=new Uint32Array(4);
    if(typeof globalThis.crypto?.getRandomValues==='function'){
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map(value=>value.toString(16).padStart(8,'0')).join('');
    }
    fallbackSequence+=1;
    return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
  };
  const push=(state,url,descriptor)=>{
    const previousEntryKey=currentEntryKey();
    if(!previousEntryKey) return false;
    let id=opaqueId();
    while(issued.has(id)) id=opaqueId();
    history.pushState({...state,accountEntryId:id},'',url);
    const entryKey=currentEntryKey();
    if(!entryKey||entryKey===previousEntryKey){
      const safeState={...(history.state||{})};
      delete safeState.accountEntryId;
      delete safeState.accountPushed;
      delete safeState.backupPanel;
      history.replaceState(safeState,'',location.href);
      return true;
    }
    issued.set(id,Object.freeze({
      kind:descriptor.kind,
      route:descriptor.route,
      stack:Object.freeze(descriptor.stack.slice()),
      panel:descriptor.panel||'',
      accountPushed:descriptor.accountPushed===true,
      entryKey,
    }));
    prune();
    return true;
  };
  const matches=(state,descriptor)=>{
    prune();
    if(!state||typeof state.accountEntryId!=='string'||!state.accountEntryId) return false;
    const proof=issued.get(state.accountEntryId);
    if(!proof) return false;
    const entryKey=currentEntryKey();
    if(!entryKey||!proof.entryKey) return false;
    return proof.kind===descriptor.kind&&proof.route===descriptor.route&&
      sameStack(proof.stack,descriptor.stack)&&proof.panel===(descriptor.panel||'')&&
      proof.accountPushed===(descriptor.accountPushed===true)&&
      proof.entryKey===entryKey;
  };
  const clear=()=>issued.clear();
  return Object.freeze({push,matches,clear});
})();
function isValidAccountHistoryStack(value){
  if(!isValidStack(value)) return false;
  const routeName=routeNameForAccountScreen(value.at(-1));
  if(!routeName) return false;
  const route=ROUTES[routeName];
  if(sameStack(value,route.stack)) return true;
  const otpBranchSuffix={
    'wallet-create':['scr-wallet-create'],
    'wallet-backup':['scr-wallet-create','scr-wallet-backup'],
    'seed-show':['scr-wallet-create','scr-wallet-backup','scr-seed-show'],
    'seed-verify':['scr-wallet-create','scr-wallet-backup','scr-seed-show','scr-seed-verify']
  }[routeName];
  return Boolean(otpBranchSuffix&&sameStack(
    value,['scr-auth','scr-auth-otp',...otpBranchSuffix]));
}
function hasValidAccountHistoryProvenance(){
  const state=history.state;
  const route=routeNameForAccountScreen(activeScr());
  return state?.accountPushed===true&&Boolean(route)&&
    isValidAccountHistoryStack(state.stack)&&sameStack(state.stack,stack)&&
    state.stack.at(-1)===activeScr()&&accountHistoryProof.matches(state,{
      kind:'account-route',route,stack:state.stack,accountPushed:true,
    });
}
function hasValidBackupPanelHistoryProvenance(){
  const state=history.state;
  return activeScr()==='scr-wallet-backup'&&isValidBackupPanel(state?.backupPanel)&&
    isValidAccountHistoryStack(state.stack)&&sameStack(state.stack,stack)&&
    state.stack.at(-1)==='scr-wallet-backup'&&accountHistoryProof.matches(state,{
      kind:'backup-panel',route:'wallet-backup',stack:state.stack,panel:state.backupPanel,
      accountPushed:state.accountPushed===true,
    });
}
function accountParentStack(screen){
  const routeName=routeNameForAccountScreen(screen);
  if(!routeName) return null;
  const route=ROUTES[routeName];
  const hasParent=Object.prototype.hasOwnProperty.call(route,'parent');
  const parentName=hasParent ? route.parent : route.defaultParent;
  if(parentName===null) return null;
  if(typeof parentName!=='string'||!parentName) return null;
  const parent=ROUTES[parentName];
  if(!parent?.account||parent.screen===screen||!isValidStack(parent.stack)||
      parent.stack.at(-1)!==parent.screen) return null;
  return parent.stack.slice();
}
function guardAccountRoute(routeName){
  return onboardingFlag('complete')&&isAccountRoute(routeName) ? 'home' : routeName;
}
function guardAccountStack(nextStack){
  return onboardingFlag('complete')&&nextStack.some(isAccountScreen) ? ROUTES.home.stack.slice() : nextStack;
}

function completeOnboarding({recoveryMethod='',backupIncomplete=false,watchOnly=false}={}){
  clearSensitiveAccountState();
  accountHistoryProof.clear();
  setOnboardingFlag('complete',true);
  setOnboardingFlag('backupIncomplete',Boolean(backupIncomplete));
  setOnboardingFlag('watchOnly',Boolean(watchOnly));
  if(RECOVERY_METHODS.has(recoveryMethod)) setOnboardingFlag('recoveryMethod',recoveryMethod);
  else setOnboardingFlag('recoveryMethod','');
  navigate(ROUTES.home.stack.slice(),{replace:true});
}
function restartOnboarding(){
  accountHistoryProof.clear();
  Object.keys(ONBOARDING_KEYS).forEach(name=>{onboardingMemory[name]=''});
  Object.values(ONBOARDING_KEYS).forEach(key=>{
    try{sessionStorage.removeItem(key)}catch(e){}
  });
  let length=0;
  try{length=sessionStorage.length}catch(e){}
  for(let i=length-1;i>=0;i-=1){
    let key='';
    try{key=sessionStorage.key(i)||''}catch(e){continue}
    if(key&&key.startsWith(ONBOARDING_PREFIX)){
      try{sessionStorage.removeItem(key)}catch(e){}
    }
  }
  resetAccountState();
  navigate(ROUTES.splash.stack.slice(),{replace:true});
}

/* Ephemeral panel chrome only. Stream connection, call status and participants never
   enter application navigation/history/session state. */
const voicePanel={open:false,minimized:false};
let conversationMode='group';
let stack = ['scr-home'];
const navigationStorageProjection=(()=>{
  const getOwnPropertyDescriptors=Object.getOwnPropertyDescriptors;
  const getPrototypeOf=Object.getPrototypeOf;
  const ownKeys=Reflect.ownKeys;
  const reflectApply=Reflect.apply;
  const hasOwnProperty=Object.prototype.hasOwnProperty;
  const objectPrototype=Object.prototype;
  const arrayPrototype=Array.prototype;
  const arrayIsArray=Array.isArray;
  const isInteger=Number.isInteger;
  const setHas=Set.prototype.has;
  const jsonStringify=JSON.stringify;
  const freeze=Object.freeze;
  const hasOwn=(value,key)=>reflectApply(hasOwnProperty,value,[key]);
  const includes=(values,value)=>{
    for(let index=0;index<values.length;index+=1){
      if(values[index]===value)return true;
    }
    return false;
  };
  const exactKeys=(descriptors,expected)=>{
    const keys=ownKeys(descriptors);
    if(keys.length!==expected.length)return false;
    for(let index=0;index<keys.length;index+=1){
      if(typeof keys[index]!=='string'||!includes(expected,keys[index]))return false;
    }
    return true;
  };
  const ownData=(descriptors,key)=>{
    const descriptor=descriptors[key];
    return descriptor&&hasOwn(descriptor,'value')?descriptor.value:undefined;
  };
  const stackSnapshot=value=>{
    try{
      if(!arrayIsArray(value)||getPrototypeOf(value)!==arrayPrototype)return null;
      const descriptors=getOwnPropertyDescriptors(value);
      const length=ownData(descriptors,'length');
      if(!isInteger(length)||length<1||length>26||ownKeys(descriptors).length!==length+1){
        return null;
      }
      const safe=[];
      for(let index=0;index<length;index+=1){
        const screen=ownData(descriptors,String(index));
        if(typeof screen!=='string'||!reflectApply(setHas,KNOWN_SCREENS,[screen]))return null;
        safe[index]=screen;
      }
      return safe;
    }catch(_error){return null}
  };
  /* Live Stream objects and their projections are deliberately non-serializable. */
  const restore=candidate=>{
    try{
      if(!candidate||typeof candidate!=='object'||
         getPrototypeOf(candidate)!==objectPrototype)return null;
      const descriptors=getOwnPropertyDescriptors(candidate);
      if(!exactKeys(descriptors,['stack']))return null;
      const safeStack=stackSnapshot(ownData(descriptors,'stack'));
      return safeStack?{stack:safeStack}:null;
    }catch(_error){return null}
  };
  const forWrite=stackValue=>({stack:stackSnapshot(stackValue)||['scr-home']});
  const serialize=stackValue=>reflectApply(jsonStringify,JSON,[forWrite(stackValue)]);
  return freeze({restore,forWrite,serialize});
})();

function activeScr(){return stack[stack.length-1]}
function inCall(){return false}

function renderOnboardingFlags(){
  const backupIncomplete=onboardingFlag('backupIncomplete');
  const backup=document.getElementById('backup-warning');
  if(backup) backup.hidden=!backupIncomplete;
  const watchOnly=onboardingFlag('watchOnly');
  const watch=document.getElementById('watch-only-notice');
  if(watch) watch.hidden=!watchOnly;
  const explanation=document.getElementById('watch-only-explanation');
  if(explanation) explanation.hidden=!watchOnly;

  const detail=document.getElementById('profile-recovery-detail');
  const status=document.getElementById('profile-recovery-status');
  if(!detail||!status) return;
  const recovery={
    phrase:['Recovery phrase backed up','healthy','risk-low'],
    'cloud-simulated':['Cloud backup simulated','simulated','risk-low'],
    'social-simulated':['Social recovery simulated','simulated','risk-low'],
    skipped:['Recovery setup skipped','skipped','risk-med']
  }[onboardingFlag('recoveryMethod')]||['Recovery method not recorded','not set','risk-med'];
  const shown=backupIncomplete ? ['Backup incomplete','action needed','risk-med'] : recovery;
  detail.textContent=shown[0];
  status.textContent=shown[1];
  status.className='risk-pill '+shown[2];
  status.style.marginLeft='auto';
}

function render(){
  const cur = activeScr();
  document.querySelectorAll('.scr').forEach(s=>{
    const on = s.id===cur;
    s.classList.toggle('active', on);
    /* keep hidden screens out of the focus order + a11y tree */
    if(on){s.removeAttribute('inert'); s.removeAttribute('aria-hidden')}
    else {s.setAttribute('inert',''); s.setAttribute('aria-hidden','true')}
  });
  const tab = Object.keys(ROOTS).find(k=>ROOTS[k]===stack[0]);
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.tab===tab));

  /* bottom/top chrome follows the screen: secondary pages drop the tab bar,
     the group chat swaps it for a pinned header + composer */
  const isRoot = ROOT_SCREENS.has(cur);
  const isGroup = cur==='scr-group';
  const isAccount = ACCOUNT_SCREENS.has(cur);
  const phone = document.getElementById('phone');
  phone.classList.toggle('sub', !isRoot);
  phone.classList.toggle('group', isGroup);
  phone.classList.toggle('account-flow', isAccount);
  const tabbar = document.querySelector('.tabbar');
  tabbar.hidden=isAccount;
  if(isAccount){tabbar.setAttribute('inert','');tabbar.setAttribute('aria-hidden','true')}
  else {tabbar.removeAttribute('inert');tabbar.removeAttribute('aria-hidden')}
  const gh=document.getElementById('gcHead'), co=document.getElementById('composer');
  gh.hidden=!isGroup; co.hidden=!isGroup;
  if(isGroup){gh.removeAttribute('inert'); co.removeAttribute('inert')}
  else {gh.setAttribute('inert',''); co.setAttribute('inert','')}

  document.querySelectorAll('[data-conversation-view]').forEach(view=>{
    const on=isGroup&&view.dataset.conversationView===conversationMode;
    view.hidden=!on;
    if(on)view.removeAttribute('inert');else view.setAttribute('inert','');
  });
  const conversationTitle=document.getElementById('stream-conversation-title');
  const conversationSub=document.getElementById('stream-conversation-sub');
  if(conversationTitle)conversationTitle.textContent=conversationMode==='dm'?'shadowfax.eth':'Glyph Hunters';
  if(conversationSub)conversationSub.textContent=conversationMode==='dm'?
    'Direct message · offline preview · not connected':'Group · offline preview · not connected';
  if(isGroup&&conversationMode==='dm')voicePanel.open=false;

  renderVoice();
  renderOnboardingFlags();
  renderPlatformScreen(cur);
  renderPerpScreen(cur);
  renderPerpAccountScreen(cur);
  renderWalletFoundation(cur);
  applyRegionalCapabilityGates();
}

function walletPairCompatible(asset,chain){
  return Boolean(WALLET_ASSETS[asset]?.chains.includes(chain));
}
function canonicalWalletHash(routeName,params=walletRouteParams){
  return `${routeName}?asset=${params.asset}&chain=${params.chain}`;
}
function strictHashRoute(rawInput){
  const raw=rawInput===undefined?(location.hash||'').slice(1):rawInput;
  if(typeof raw!=='string') return {target:'home',params:null,canonical:'home'};
  const question=raw.indexOf('?');
  const routeName=question<0?raw:raw.slice(0,question);
  if(routeName!=='asset'&&routeName!=='receive'){
    return {target:routeName,params:null,canonical:routeName};
  }
  const defaults={...WALLET_ROUTE_DEFAULT};
  const rejected=()=>({target:routeName,params:defaults,
    canonical:canonicalWalletHash(routeName,defaults)});
  if(raw.length>256||/[\u0000-\u001f\u007f]/.test(raw)||
     /%(?![0-9a-fA-F]{2})/.test(raw)) return rejected();
  const query=question<0?'':raw.slice(question+1);
  const values=Object.create(null);
  const keys=new Set();
  if(query){
    for(const field of query.split('&')){
      const equal=field.indexOf('=');
      if(equal<0) return rejected();
      let key;
      let value;
      try{
        key=decodeURIComponent(field.slice(0,equal));
        value=decodeURIComponent(field.slice(equal+1));
      }catch(error){return rejected()}
      if(/[\u0000-\u001f\u007f]/.test(key)||/[\u0000-\u001f\u007f]/.test(value)||
         [...value].length>32||keys.has(key)) return rejected();
      keys.add(key);
      if(key==='asset'||key==='chain'){
        if(value==='') return rejected();
        values[key]=value;
      }
    }
  }
  const asset=typeof values.asset==='string'?values.asset.toUpperCase():defaults.asset;
  const chain=typeof values.chain==='string'?values.chain.toLowerCase():defaults.chain;
  if(!WALLET_ASSET_IDS.includes(asset)||!WALLET_CHAIN_IDS.includes(chain)||
     !walletPairCompatible(asset,chain)) return rejected();
  const params={asset,chain};
  return {target:routeName,params,canonical:canonicalWalletHash(routeName,params)};
}
function exactStack(value,expected){return sameStack(value,expected)}
function snapshotOwnDataRecord(candidate,expectedKeys,expectedPrototype){
  try{
    if(!candidate||typeof candidate!=='object'||
       Object.getPrototypeOf(candidate)!==expectedPrototype) return null;
    const descriptors=Object.getOwnPropertyDescriptors(candidate);
    const keys=Reflect.ownKeys(candidate);
    if(keys.length!==expectedKeys.length||keys.some(key=>typeof key!=='string'||
       !expectedKeys.includes(key)||
       !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))) return null;
    const result=Object.create(null);
    expectedKeys.forEach(key=>{result[key]=descriptors[key].value});
    return result;
  }catch(error){return null}
}
function snapshotWalletStack(candidate){
  try{
    if(!Array.isArray(candidate)||Object.getPrototypeOf(candidate)!==Array.prototype) return null;
    const descriptors=Object.getOwnPropertyDescriptors(candidate);
    const keys=Reflect.ownKeys(candidate);
    const lengthDescriptor=descriptors.length;
    if(!lengthDescriptor||!Object.prototype.hasOwnProperty.call(lengthDescriptor,'value')||
       !Number.isInteger(lengthDescriptor.value)||lengthDescriptor.value<1||
       lengthDescriptor.value>3) return null;
    const expected=[...Array(lengthDescriptor.value).keys()].map(String).concat('length');
    if(keys.length!==expected.length||keys.some(key=>typeof key!=='string'||
       !expected.includes(key)||
       !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))) return null;
    const result=expected.slice(0,-1).map(key=>descriptors[key].value);
    return result.every(value=>typeof value==='string')?result:null;
  }catch(error){return null}
}
function snapshotWalletHistoryState(candidate){
  const outer=snapshotOwnDataRecord(candidate,['stack'],Object.prototype);
  if(!outer) return null;
  const safeStack=snapshotWalletStack(outer.stack);
  return safeStack?{stack:safeStack}:null;
}
const walletPopstateStack=(()=>{
  const MAX_PROOFS=32;
  const MAX_ENTRY_KEY_LENGTH=256;
  const issued=new Map();
  const getOwnDescriptor=Object.getOwnPropertyDescriptor;
  const getPrototypeOf=Object.getPrototypeOf;
  const freeze=Object.freeze;
  const hasOwnProperty=Object.prototype.hasOwnProperty;
  const hasOwn=(value,key)=>hasOwnProperty.call(value,key);
  const captureAccessor=descriptor=>{
    if(!descriptor||typeof descriptor.get!=='function'||
       hasOwn(descriptor,'value')) return null;
    return freeze({get:descriptor.get,set:descriptor.set,
      configurable:descriptor.configurable,enumerable:descriptor.enumerable});
  };
  const sameAccessor=(descriptor,captured)=>Boolean(descriptor&&captured&&
    !hasOwn(descriptor,'value')&&descriptor.get===captured.get&&
    descriptor.set===captured.set&&
    descriptor.configurable===captured.configurable&&
    descriptor.enumerable===captured.enumerable);
  const initialNavigation=(()=>{
    try{
      const globalAccessor=captureAccessor(
        getOwnDescriptor(globalThis,'navigation'));
      if(!globalAccessor) return null;
      const value=globalAccessor.get.call(globalThis);
      if(!value||typeof value!=='object') return null;
      const navigationPrototype=getPrototypeOf(value);
      if(!navigationPrototype||hasOwn(value,'currentEntry')) return null;
      const currentEntryAccessor=captureAccessor(
        getOwnDescriptor(navigationPrototype,'currentEntry'));
      if(!currentEntryAccessor) return null;
      const entry=currentEntryAccessor.get.call(value);
      if(!entry||typeof entry!=='object'||hasOwn(entry,'key')) return null;
      const entryPrototype=getPrototypeOf(entry);
      if(!entryPrototype) return null;
      const keyAccessor=captureAccessor(
        getOwnDescriptor(entryPrototype,'key'));
      if(!keyAccessor) return null;
      const initialKey=keyAccessor.get.call(entry);
      if(typeof initialKey!=='string'||initialKey.length<1||
         initialKey.length>MAX_ENTRY_KEY_LENGTH) return null;
      return freeze({value,globalAccessor,navigationPrototype,
        currentEntryAccessor,entryPrototype,keyAccessor});
    }catch(error){return null}
  })();
  const currentKey=()=>{
    try{
      if(!initialNavigation) return '';
      const descriptor=getOwnDescriptor(globalThis,'navigation');
      if(!sameAccessor(descriptor,initialNavigation.globalAccessor)) return '';
      const live=initialNavigation.globalAccessor.get.call(globalThis);
      if(live!==initialNavigation.value||
         getPrototypeOf(live)!==initialNavigation.navigationPrototype||
         hasOwn(live,'currentEntry')) return '';
      const currentEntryDescriptor=getOwnDescriptor(
        initialNavigation.navigationPrototype,'currentEntry');
      if(!sameAccessor(currentEntryDescriptor,
        initialNavigation.currentEntryAccessor)) return '';
      const entry=initialNavigation.currentEntryAccessor.get.call(live);
      if(!entry||typeof entry!=='object'||hasOwn(entry,'key')||
         getPrototypeOf(entry)!==initialNavigation.entryPrototype) return '';
      const keyDescriptor=getOwnDescriptor(initialNavigation.entryPrototype,'key');
      if(!sameAccessor(keyDescriptor,initialNavigation.keyAccessor)) return '';
      const key=initialNavigation.keyAccessor.get.call(entry);
      return typeof key==='string'&&key.length>0&&
        key.length<=MAX_ENTRY_KEY_LENGTH?key:'';
    }catch(error){return ''}
  };
  const extended=value=>exactStack(value,
    ['scr-wallet','scr-asset','scr-receive']);
  const rememberExtended=()=>{
    const key=currentKey();
    if(!key||!extended(stack)||activeScr()!=='scr-receive'||
       strictHashRoute().target!=='receive') return;
    issued.set(key,Object.freeze(stack.slice()));
    while(issued.size>MAX_PROOFS) issued.delete(issued.keys().next().value);
  };
  const matches=value=>{
    const stored=issued.get(currentKey());
    return Boolean(stored&&extended(value)&&sameStack(stored,value));
  };
  let trustedAssetReceiveEvent=null;
  document.addEventListener('click',event=>{
    const control=document.getElementById('asset-receive');
    trustedAssetReceiveEvent=event.isTrusted&&event.target===control&&
      activeScr()==='scr-asset'&&exactStack(stack,['scr-wallet','scr-asset'])
        ?event:null;
  },{capture:true});
  document.addEventListener('click',event=>{
    if(trustedAssetReceiveEvent===event&&!event.defaultPrevented) rememberExtended();
    trustedAssetReceiveEvent=null;
  });
  window.addEventListener('pagehide',event=>{if(!event.persisted) issued.clear()});
  window.addEventListener('unload',()=>issued.clear());
  return (routeName,candidate)=>{
    if(routeName==='receive'&&extended(candidate)&&matches(candidate)){
      return candidate.slice();
    }
    return ROUTES[routeName].stack.slice();
  };
})();

/* hash is a projection of state, never a second source of truth */
function syncHash(replace,{accountPushed=false}={}){
  const url = '#'+expectedHash();
  const st={stack:stack.slice()};
  const sameEntry=location.hash===url&&Boolean(history.state);
  if(activeScr()==='scr-wallet-backup'&&hasValidBackupPanelHistoryProvenance()){
    st.backupPanel=history.state.backupPanel;
    st.accountEntryId=history.state.accountEntryId;
    if(history.state.accountPushed===true) st.accountPushed=true;
  }
  if(accountPushed&&!replace&&!sameEntry){
    st.accountPushed=true;
    const pushed=accountHistoryProof.push(st,url,{
      kind:'account-route',route:routeNameForAccountScreen(activeScr()),
      stack:stack.slice(),accountPushed:true,
    });
    if(!pushed){
      delete st.accountPushed;
      history.pushState(st,'',url);
    }
    return;
  }
  if(sameEntry){
    history.replaceState(st,'',url);
    return;
  }
  if(replace) history.replaceState(st,'',url); else history.pushState(st,'',url);
}
function persist(){
  try{sessionStorage.setItem(SS_KEY,navigationStorageProjection.serialize(stack))}catch(e){}
}
function navigate(nextStack,{replace=false, keepScroll=false, accountPushed=false}={}){
  consumeReviewForNavigation();
  clearSensitiveAccountState();
  stack = nextStack;
  render();
  setupAccountScreen(activeScr());
  focusActiveScreen();
  if(!keepScroll){const el=document.getElementById(activeScr()); if(el) el.scrollTop=0}
  syncHash(replace,{accountPushed});
  persist();
}
function goTab(t){
  if(stack[0]===ROOTS[t] && stack.length===1) return;
  navigate([ROOTS[t]], {replace:stack.length===1});
}
function push(id){
  if(activeScr()===id) return;
  navigate(stack.concat(id),{accountPushed:isAccountScreen(id)});
}
/* in-app back = one level up the app hierarchy (not "undo last navigation").
   the browser back button is handled separately by popstate, which retraces the real path. */
function back(){
  if(hasValidBackupPanelHistoryProvenance()){
    history.back();
    return;
  }
  if(activeScr()==='scr-wallet-backup'&&isValidBackupPanel(pendingBackupChoice)){
    showBackupChoices();
    return;
  }
  if(isAccountScreen(activeScr())&&hasValidAccountHistoryProvenance()){
    clearSensitiveAccountState();
    history.back();
    return;
  }
  if(isAccountScreen(activeScr())){
    const parentStack=accountParentStack(activeScr());
    if(parentStack){
      navigate(parentStack,{replace:true});
      return;
    }
  }
  if(stack.length<=1) return;
  navigate(stack.slice(0,-1), {replace:true});
}
window.addEventListener('popstate',e=>{
  if(handleReviewHistoryPopstate(e.state)) return;
  const walletProjection=strictHashRoute();
  if((walletProjection.target==='asset'||walletProjection.target==='receive')&&
     walletProjection.params){
    clearSensitiveAccountState();
    walletRouteParams={...walletProjection.params};
    const stateSnapshot=snapshotWalletHistoryState(e.state);
    stack=walletPopstateStack(walletProjection.target,stateSnapshot?.stack);
    const projection={stack:stack.slice()};
    history.replaceState(projection,'','#'+walletProjection.canonical);
    render();
    focusActiveScreen();
    persist();
    finishReviewOriginPopstate(e);
    return;
  }
  const backupChoiceToRestore=activeScr()==='scr-wallet-backup'&&
    isValidBackupPanel(pendingBackupChoice)&&e.state&&isValidStack(e.state.stack)&&
    e.state.stack.at(-1)==='scr-wallet-backup'&&!isValidBackupPanel(e.state.backupPanel)
      ? pendingBackupChoice : '';
  clearSensitiveAccountState();
  if(e.state && isValidStack(e.state.stack)){
    /* a real history traversal — every entry we create carries state, so replay it verbatim
       and never re-fire the demo side effects */
    const nextStack=guardAccountStack(e.state.stack.slice());
    if(nextStack[0]==='scr-home'&&e.state.stack.some(isAccountScreen)){
      navigate(nextStack,{replace:true});
      return;
    }
    stack = nextStack;
    const projected=strictHashRoute();
    const projectedRoute=SCREEN_HASH[stack.at(-1)]||'home';
    const safeProjectedState=snapshotWalletHistoryState(e.state);
    if((projectedRoute==='asset'||projectedRoute==='receive')&&
       projected.target===projectedRoute&&projected.params&&safeProjectedState){
      walletRouteParams={...projected.params};
      if(location.hash!=='#'+projected.canonical){
        history.replaceState(safeProjectedState,'','#'+projected.canonical);
      }
    }
    voicePanel.open=false;voicePanel.minimized=false;
    render(); setupAccountScreen(activeScr()); focusActiveScreen({backupChoice:backupChoiceToRestore}); persist();
    finishReviewOriginPopstate(e);
  }else{
    /* no state = an entry we did not create, i.e. a hash written from outside (address bar,
       or `location.hash = …`). Chrome fires this before hashchange, so treat it as a fresh
       deep link — demo side effects included. */
    route();
  }
});

/* ---------- Wallet foundation: normalized provider views ---------- */
const walletViewState={chainFilter:'all',
  selectedAsset:'ETH',selectedChain:'base',historyItems:[],historyCursor:null
};
const walletAuthority=(()=>{
  const operations=Object.freeze({
    'home-pay':'transfer','token-buy':'swap','group-token-buy':'swap',
    'group-copy-trade':'swap','wallet-send':'transfer','wallet-swap':'swap',
    'wallet-bridge':'bridge','wallet-dapps':'approve','swap-submit':'swap',
    'dapp-approve':'approve',
    'approval-limit':'approve',
    'approval-unlimited':'approve'
  });
  const capabilityKeys=Object.freeze([
    'balances','history','receive','transfer','swap','approve'
  ]);
  const expectedCapabilities=Object.freeze({
    privy_embedded:Object.freeze({balances:'supported',history:'supported',
      receive:'supported',transfer:'supported',swap:'supported',
      approve:'spike_required'}),
    connected_external:Object.freeze({balances:'provider_gap',history:'provider_gap',
      receive:'supported',transfer:'external_provider',swap:'provider_gap',
      approve:'external_provider'}),
    watch_only:Object.freeze({balances:'provider_gap',history:'provider_gap',
      receive:'supported',transfer:'unsupported',swap:'unsupported',
      approve:'unsupported'})
  });
  const dataRecord=(value,keys)=>{
    try{
      if(!value||typeof value!=='object'||Array.isArray(value)||
         Object.getPrototypeOf(value)!==Object.prototype) return null;
      const descriptors=Object.getOwnPropertyDescriptors(value);
      const ownKeys=Reflect.ownKeys(value);
      if(ownKeys.length!==keys.length||ownKeys.some(key=>typeof key!=='string'||
         !keys.includes(key)||
         !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))) return null;
      const result=Object.create(null);
      keys.forEach(key=>{result[key]=descriptors[key].value});
      return result;
    }catch(error){return null}
  };
  const dataArray=value=>{
    try{
      if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
         value.length<1||value.length>4) return null;
      const descriptors=Object.getOwnPropertyDescriptors(value);
      const expected=[...Array(value.length).keys()].map(String).concat('length');
      const keys=Reflect.ownKeys(value);
      if(keys.length!==expected.length||keys.some(key=>typeof key!=='string'||
         !expected.includes(key)||
         !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))) return null;
      return expected.slice(0,-1).map(key=>descriptors[key].value);
    }catch(error){return null}
  };
  const trustedProvider=(()=>{
    try{
      const provider=globalThis.LoopWalletProvider;
      const facade=dataRecord(provider,['createSimulatedAdapter','normalizeBalanceResponse',
        'normalizeTransactionPage','formatBaseUnits','addDecimalStrings']);
      if(!facade||!Object.isFrozen(provider)||
         typeof facade.createSimulatedAdapter!=='function') return null;
      return Object.freeze({provider});
    }catch(error){return null}
  })();
  const providerFactory=trustedProvider?dataRecord(trustedProvider.provider,
    ['createSimulatedAdapter','normalizeBalanceResponse','normalizeTransactionPage',
      'formatBaseUnits','addDecimalStrings']).createSimulatedAdapter:null;
  const readOnboardingFlag=onboardingFlag;
  const QueryParameters=globalThis.URLSearchParams;
  const capturedReflectApply=(()=>{
    try{
      const candidate=globalThis.Reflect?.apply;
      return typeof candidate==='function'&&candidate.name==='apply'&&
        candidate.length===3&&
        Function.prototype.toString.call(candidate).includes('[native code]')?
          candidate:null;
    }catch(error){return null}
  })();
  const queryGetDescriptor=(()=>{
    try{
      const descriptor=Object.getOwnPropertyDescriptor(QueryParameters?.prototype,'get');
      const record=dataRecord(descriptor,
        ['value','writable','enumerable','configurable']);
      if(!record||typeof record.value!=='function'||record.value.name!=='get'||
         record.value.length!==1||record.writable!==true||
         record.enumerable!==true||record.configurable!==true||
         !Function.prototype.toString.call(record.value).includes('[native code]')){
        return null;
      }
      return Object.freeze(record);
    }catch(error){return null}
  })();
  const queryGet=queryGetDescriptor?.value||null;
  const completedControl=document.getElementById('completed-provider-fixture');
  const completedParent=completedControl?.parentElement||null;
  const completedScreen=completedControl?.closest('.scr')||null;
  const completedPrevious=completedControl?.previousElementSibling||null;
  const completedNext=completedControl?.nextElementSibling||null;
  const completedLabelNode=completedControl?.firstChild||null;
  const completedAttributes=Object.freeze({
    class:'btn btn-ghost completed-provider-fixture',
    id:'completed-provider-fixture',type:'button',
    'aria-label':'Show completed provider fixture',
    'data-provider-fixture':'completed'
  });
  let key='',adapter=null,walletResult=null,completedSelected=false;
  const configuration=()=>{
    try{
      if(typeof QueryParameters!=='function'||!queryGet||!capturedReflectApply)return null;
      const demo=capturedReflectApply(queryGet,
        new QueryParameters(location.search),['demo'])||'';
      if(readOnboardingFlag('watchOnly')===true||demo==='wallet-watch-only'){
        return {walletClass:'watch_only',scenario:'watch_only',stale:false};
      }
      if(demo==='wallet-external-gap'){
        return {walletClass:'connected_external',scenario:'external_gap',stale:false};
      }
      const scenarios={
        'wallet-empty':'empty','wallet-loading':'loading','wallet-partial':'partial'
      };
      return {walletClass:'privy_embedded',
        scenario:completedSelected?'provider_succeeded_demo':
          scenarios[demo]||'normal',stale:demo==='wallet-stale'};
    }catch(error){return null}
  };
  const snapshot=()=>{
    try{
      const config=configuration();
      if(!trustedProvider||!providerFactory||!config) return null;
      const nextKey=`${config.walletClass}:${config.scenario}:${config.stale}`;
      if(key!==nextKey){
        key=nextKey;
        adapter=providerFactory.call(trustedProvider.provider,{
          walletClass:config.walletClass,scenario:config.scenario
        });
        walletResult=adapter.getWalletSnapshot();
        walletViewState.chainFilter='all';walletViewState.historyItems=[];
        walletViewState.historyCursor=null;
      }
      return Object.freeze({...config,adapter,walletResult});
    }catch(error){return null}
  };
  const normalizedWallet=()=>{
    try{
      const current=snapshot();
      if(!current) return null;
      const adapterRecord=dataRecord(current.adapter,['getWalletSnapshot','getBalanceSnapshot',
        'getTransactionHistorySnapshot','getWalletActionSnapshot','getReceiveTarget',
        'getReviewPreview','handoffReview']);
      if(!adapterRecord||!Object.isFrozen(current.adapter)||
         typeof adapterRecord.getWalletSnapshot!=='function') return null;
      const result=dataRecord(current.walletResult,['ok','value','meta']);
      if(!result||result.ok!==true) return null;
      const meta=dataRecord(result.meta,
        ['source','fetched_at_ms','stale','partial']);
      const wallet=dataRecord(result.value,
        ['wallet_class','wallet_ref','addresses','capabilities']);
      if(!meta||!wallet||wallet.wallet_class!==current.walletClass||
         typeof meta.source!=='string'||meta.source.length<1||meta.source.length>128||
         typeof meta.fetched_at_ms!=='number'||!Number.isFinite(meta.fetched_at_ms)||
         typeof meta.stale!=='boolean'||typeof meta.partial!=='boolean'||
         !(wallet.wallet_ref===null||typeof wallet.wallet_ref==='string')) return null;
      const capabilities=dataRecord(wallet.capabilities,capabilityKeys);
      const expected=expectedCapabilities[wallet.wallet_class];
      if(!capabilities||!expected||capabilityKeys.some(
        key=>capabilities[key]!==expected[key])) return null;
      const addresses=dataArray(wallet.addresses);
      if(!addresses||addresses.some(address=>{
        const item=dataRecord(address,['chain_type','address']);
        return !item||!['ethereum','solana'].includes(item.chain_type)||
          typeof item.address!=='string'||item.address.length<1||item.address.length>128;
      })) return null;
      return Object.freeze({walletClass:wallet.wallet_class,
        capabilities:Object.freeze({...capabilities})});
    }catch(error){return null}
  };
  const signingDecision=control=>{
    try{
      const operation=operations[control?.id]||'';
      const wallet=normalizedWallet();
      if(!wallet||!operation){
        return {allowed:false,reason:'Wallet capability information is unavailable.',
          walletClass:''};
      }
      if(wallet.walletClass==='watch_only'){
        return {allowed:false,reason:'Watch-only wallets cannot sign transactions.',
          walletClass:wallet.walletClass};
      }
      if(operation==='bridge'){
        return {allowed:false,reason:'bridge',walletClass:wallet.walletClass};
      }
      const capability=wallet.capabilities[operation];
      const allowed=operation==='transfer'?
        capability==='supported'||capability==='external_provider':
        operation==='swap'?capability==='supported':
          capability==='supported'||capability==='external_provider'||
            capability==='spike_required';
      if(allowed) return {allowed:true,reason:'',walletClass:wallet.walletClass};
      if(wallet.walletClass==='connected_external'&&operation==='swap'){
        return {allowed:false,reason:'Swap is not available for this external wallet.',
          walletClass:wallet.walletClass};
      }
      return {allowed:false,
        reason:`${operation[0].toUpperCase()+operation.slice(1)} is not available for this wallet provider.`,
        walletClass:wallet.walletClass};
    }catch(error){
      return {allowed:false,reason:'Wallet capability information is unavailable.',
        walletClass:''};
    }
  };
  const completedIntegrity=()=>{
    try{
      if(!completedControl||completedControl.tagName!=='BUTTON'||
         completedControl!==document.getElementById('completed-provider-fixture')||
         !completedControl.isConnected||completedControl.parentElement!==completedParent||
         completedControl.closest('.scr')!==completedScreen||
         completedPrevious!==completedControl.previousElementSibling||
         completedNext!==completedControl.nextElementSibling||
         completedControl.childNodes.length!==1||
         completedControl.firstChild!==completedLabelNode||
         completedLabelNode?.nodeType!==3||
         completedLabelNode.data!=='Show completed provider fixture'||
         completedControl.disabled||completedControl.hasAttribute('data-requires-signing')){
        return false;
      }
      const attributes=Object.fromEntries([...completedControl.attributes]
        .map(attribute=>[attribute.name,attribute.value]));
      return JSON.stringify(attributes)===JSON.stringify(completedAttributes);
    }catch(error){return false}
  };
  completedControl?.addEventListener('click',event=>{
    if(event.isTrusted!==true||event.currentTarget!==completedControl||
       event.target!==completedControl)return;
    const config=configuration(),wallet=normalizedWallet();
    if(!completedIntegrity()){
      showReviewProviderState({ok:true,value:{state:'provider_blocked',
        safe_message:'Completed provider fixture control integrity check failed.'}});
      return;
    }
    if(!config||!wallet||config.walletClass!=='privy_embedded'||
       config.scenario!=='normal'||wallet.walletClass!=='privy_embedded'){
      showReviewProviderState({ok:true,value:{state:'provider_blocked',
        safe_message:config?.walletClass==='watch_only'?
          'Completed provider fixture is unavailable for watch-only wallets.':
          'Completed provider fixture is unavailable for this wallet state.'}});
      return;
    }
    completedSelected=true;key='';adapter=null;walletResult=null;
    consumeReviewForNavigation();navigate(['scr-wallet'],{replace:true});
    showReviewProviderState({ok:true,value:{state:'provider_succeeded',
      safe_message:'Simulated provider succeeded'}});
  });
  return Object.freeze({snapshot,signingDecision});
})();
const ensureWalletAdapter=walletAuthority.snapshot;
const walletSigningDecision=walletAuthority.signingDecision;
function applySigningControlDecision(control,decision){
  control.disabled=!decision.allowed;
  if(decision.allowed){
    control.removeAttribute('aria-disabled');
    control.removeAttribute('aria-describedby');
    control.removeAttribute('title');
    return;
  }
  control.setAttribute('aria-disabled','true');
  if(decision.reason==='bridge'){
    control.setAttribute('aria-describedby','wallet-bridge-note');
    control.removeAttribute('title');
    return;
  }
  control.setAttribute('aria-describedby','watch-only-explanation');
  control.title=decision.reason;
}
function renderWalletSigningCapabilities(){
  const controls=[...document.querySelectorAll('[data-requires-signing]')];
  const decisions=controls.map(control=>{
    let decision=walletSigningDecision(control);
    if(decision.reason==='bridge'&&control.closest('.scr')?.id!==activeScr()){
      decision={...decision,allowed:true,reason:''};
    }
    applySigningControlDecision(control,decision);
    return [control,decision];
  });
  const watchOnly=decisions.some(([,decision])=>
    decision.walletClass==='watch_only');
  const watch=document.getElementById('watch-only-notice');
  if(watch) watch.hidden=!watchOnly;
  const activeReason=decisions.find(([control,decision])=>
    !decision.allowed&&decision.reason!=='bridge'&&control.closest('.scr')?.id===activeScr())?.[1].reason;
  const explanation=document.getElementById('watch-only-explanation');
  if(explanation){
    explanation.textContent=watchOnly?'Watch-only wallets cannot sign transactions.':
      activeReason||'Wallet capability information is unavailable.';
    explanation.hidden=!(watchOnly||activeReason);
  }
}
function walletSigningAllowed(controlId){
  const control=document.getElementById(controlId);
  const regional=regionalCapabilityDecision(control,{recheck:true});
  if(control&&!regional.allowed){
    applyRegionalControlDecision(control,regional);
    return false;
  }
  const decision=walletSigningDecision(control);
  if(control) applySigningControlDecision(control,decision);
  if(!decision.allowed&&decision.reason!=='bridge'){
    const explanation=document.getElementById('watch-only-explanation');
    if(explanation){explanation.textContent=decision.reason;explanation.hidden=false}
  }
  return decision.allowed;
}

/* ---------- F11: one LOOP review surface over the captured provider adapter ---------- */
const walletReviewFacade=(()=>{
  try{
    const facade=globalThis.LoopWalletReview;
    if(!facade||!Object.isFrozen(facade)||Object.getPrototypeOf(facade)!==Object.prototype) return null;
    const descriptors=Object.getOwnPropertyDescriptors(facade);
    const keys=Reflect.ownKeys(facade);
    if(keys.length!==2||!['decodeReviewSource','createController'].every(key=>
      Object.prototype.hasOwnProperty.call(descriptors,key)&&
      Object.prototype.hasOwnProperty.call(descriptors[key],'value')&&
      typeof descriptors[key].value==='function')) return null;
    return Object.freeze({createController:descriptors.createController.value});
  }catch(error){return null}
})();
const reviewClockStart=performance.now();
const sanitizeReviewProjectionForWrite=(()=>{
  const getOwnPropertyDescriptors=Object.getOwnPropertyDescriptors;
  const getPrototypeOf=Object.getPrototypeOf;
  const ownKeys=Reflect.ownKeys;
  const reflectApply=Reflect.apply;
  const hasOwnProperty=Object.prototype.hasOwnProperty;
  const objectPrototype=Object.prototype;
  const arrayPrototype=Array.prototype;
  const freeze=Object.freeze;
  const isInteger=Number.isInteger;
  const numberValue=Number;
  const indexPattern=/^\d+$/;
  const reviewIdPattern=/^[a-z0-9-]{1,128}$/;
  const regexpTest=RegExp.prototype.test;
  const knownScreens=freeze(['scr-splash','scr-auth','scr-auth-otp','scr-auth-wallet',
    'scr-wallet-create','scr-wallet-backup','scr-seed-show','scr-seed-verify',
    'scr-wallet-import','scr-home','scr-pay','scr-market',
    'scr-perp-markets','scr-perp-market','scr-perp-order','scr-perp-confirm',
    'scr-perp-positions','scr-perp-orders','scr-perp-position',
    'scr-token','scr-launchpad',
    'scr-chat','scr-group','scr-wallet','scr-asset','scr-send','scr-send-to',
    'scr-send-confirm','scr-receive','scr-tx-result','scr-swap','scr-dapp','scr-profile',
  ]);
  const hasOwn=(value,key)=>reflectApply(hasOwnProperty,value,[key]);
  const includes=(values,value)=>{
    for(let index=0;index<values.length;index+=1){
      if(values[index]===value)return true;
    }
    return false;
  };
  const stackSnapshot=value=>{
    try{
      if(!value||typeof value!=='object'||getPrototypeOf(value)!==arrayPrototype)return null;
      const descriptors=getOwnPropertyDescriptors(value),keys=ownKeys(value);
      const length=descriptors.length?.value;
      if(!isInteger(length)||length<1||length>26||keys.length!==length+1)return null;
      const result=[];
      for(let index=0;index<length;index+=1){
        const descriptor=descriptors[String(index)];
        if(!descriptor||!hasOwn(descriptor,'value')||
           typeof descriptor.value!=='string'||
           !includes(knownScreens,descriptor.value))return null;
        result[index]=descriptor.value;
      }
      for(let keyIndex=0;keyIndex<keys.length;keyIndex+=1){
        const key=keys[keyIndex];
        if(typeof key!=='string'||(key!=='length'&&
           (!reflectApply(regexpTest,indexPattern,[key])||numberValue(key)>=length)))return null;
      }
      return freeze(result);
    }catch(_error){return null}
  };
  const snapshot=candidate=>{
    try{
      if(!candidate||typeof candidate!=='object'||
         getPrototypeOf(candidate)!==objectPrototype)return null;
      const descriptors=getOwnPropertyDescriptors(candidate),keys=ownKeys(candidate);
      const stackDescriptor=descriptors.stack;
      if(keys.length!==1||keys[0]!=='stack'||!stackDescriptor||
         !hasOwn(stackDescriptor,'value'))return null;
      const safeStack=stackSnapshot(stackDescriptor.value);
      return safeStack?freeze({stack:safeStack}):null;
    }catch(_error){return null}
  };
  const clone=projection=>{
    if(!projection)return null;
    const safeStack=[];
    for(let index=0;index<projection.stack.length;index+=1){
      safeStack[index]=projection.stack[index];
    }
    return freeze({stack:freeze(safeStack)});
  };
  const live=()=>snapshot({stack})||freeze({stack:freeze(['scr-home'])});
  let ownedOrigin=null;
  const projection=candidate=>clone(snapshot(candidate)||ownedOrigin||live());
  const marker=(candidate,reviewId)=>{
    const safe=projection(candidate);
    const id=typeof reviewId==='string'&&
      reflectApply(regexpTest,reviewIdPattern,[reviewId])?reviewId:'';
    return id?freeze({stack:safe.stack,loop_review:1,review_id:id}):safe;
  };
  const captureOrigin=candidate=>{
    ownedOrigin=snapshot(candidate)||live();
    return clone(ownedOrigin);
  };
  const origin=()=>clone(ownedOrigin);
  const clear=()=>{ownedOrigin=null};
  return freeze({projection,marker,captureOrigin,origin,clear});
})();
const reviewRuntime=Object.seal({adapter:null,controller:null,openId:'',policyOperation:'',
  returningId:'',cancellingId:'',triggerId:'',originEntryKey:'',markerEntryKey:'',markerIssued:false,
  fallbackAllowed:false,result:null,expiryTimer:null,perpIntentRevision:'',
  legacyVeilOwned:false,background:new Map()});
const reviewMarkerProof=(()=>{
  const MAX_PROOFS=5;
  const proofs=new Map();
  const forget=markerKey=>{if(markerKey)proofs.delete(markerKey)};
  const remember=(markerKey,reviewId,originKey,origin)=>{
    if(typeof reviewId!=='string'||!markerKey||!originKey||markerKey===originKey)return false;
    const projection=sanitizeReviewProjectionForWrite.projection(origin);
    proofs.delete(markerKey);
    proofs.set(markerKey,Object.freeze({reviewId,originKey,projection}));
    while(proofs.size>MAX_PROOFS)proofs.delete(proofs.keys().next().value);
    return true;
  };
  const bound=(markerKey,reviewId,originKey,origin)=>{
    const proof=markerKey?proofs.get(markerKey):null;
    return Boolean(proof&&proof.reviewId===reviewId&&proof.originKey===originKey&&
      sameReviewProjection(proof.projection,origin));
  };
  const matches=(markerKey,reviewId,originKey,origin,candidate)=>
    bound(markerKey,reviewId,originKey,origin)&&
    sameReviewProjection(proofs.get(markerKey).projection,candidate);
  const origin=(markerKey,reviewId,originKey,runtimeOrigin)=>{
    if(!bound(markerKey,reviewId,originKey,runtimeOrigin))return null;
    return sanitizeReviewProjectionForWrite.projection(proofs.get(markerKey).projection);
  };
  return Object.freeze({forget,remember,matches,origin,clear:()=>proofs.clear()});
})();
function reviewNow(){return 100000+Math.max(0,Math.floor(performance.now()-reviewClockStart))}
function reviewOriginProjection(){
  return sanitizeReviewProjectionForWrite.projection({stack});
}
const reviewEntryKey=(()=>{
  const getOwnDescriptor=Object.getOwnPropertyDescriptor;
  const getPrototypeOf=Object.getPrototypeOf;
  const hasOwnProperty=Object.prototype.hasOwnProperty;
  const hasOwn=(value,key)=>hasOwnProperty.call(value,key);
  const captureAccessor=descriptor=>{
    if(!descriptor||typeof descriptor.get!=='function'||hasOwn(descriptor,'value'))return null;
    return Object.freeze({get:descriptor.get,set:descriptor.set,
      configurable:descriptor.configurable,enumerable:descriptor.enumerable});
  };
  const sameAccessor=(descriptor,captured)=>Boolean(descriptor&&captured&&
    !hasOwn(descriptor,'value')&&descriptor.get===captured.get&&
    descriptor.set===captured.set&&descriptor.configurable===captured.configurable&&
    descriptor.enumerable===captured.enumerable);
  const captured=(()=>{
    try{
      const globalAccessor=captureAccessor(getOwnDescriptor(globalThis,'navigation'));
      if(!globalAccessor)return null;
      const navigationValue=globalAccessor.get.call(globalThis);
      if(!navigationValue||typeof navigationValue!=='object')return null;
      const navigationPrototype=getPrototypeOf(navigationValue);
      if(!navigationPrototype||hasOwn(navigationValue,'currentEntry'))return null;
      const currentEntryAccessor=captureAccessor(
        getOwnDescriptor(navigationPrototype,'currentEntry'));
      if(!currentEntryAccessor)return null;
      const entry=currentEntryAccessor.get.call(navigationValue);
      if(!entry||typeof entry!=='object'||hasOwn(entry,'key'))return null;
      const entryPrototype=getPrototypeOf(entry);
      if(!entryPrototype)return null;
      const keyAccessor=captureAccessor(getOwnDescriptor(entryPrototype,'key'));
      if(!keyAccessor)return null;
      const key=keyAccessor.get.call(entry);
      if(typeof key!=='string'||key.length<1||key.length>256)return null;
      return Object.freeze({navigationValue,globalAccessor,navigationPrototype,
        currentEntryAccessor,entryPrototype,keyAccessor});
    }catch(error){return null}
  })();
  return ()=>{
    try{
      if(!captured)return '';
      const globalDescriptor=getOwnDescriptor(globalThis,'navigation');
      if(!sameAccessor(globalDescriptor,captured.globalAccessor))return '';
      const navigationValue=captured.globalAccessor.get.call(globalThis);
      if(navigationValue!==captured.navigationValue||
         getPrototypeOf(navigationValue)!==captured.navigationPrototype||
         hasOwn(navigationValue,'currentEntry'))return '';
      const currentEntryDescriptor=getOwnDescriptor(
        captured.navigationPrototype,'currentEntry');
      if(!sameAccessor(currentEntryDescriptor,captured.currentEntryAccessor))return '';
      const entry=captured.currentEntryAccessor.get.call(navigationValue);
      if(!entry||typeof entry!=='object'||hasOwn(entry,'key')||
         getPrototypeOf(entry)!==captured.entryPrototype)return '';
      const keyDescriptor=getOwnDescriptor(captured.entryPrototype,'key');
      if(!sameAccessor(keyDescriptor,captured.keyAccessor))return '';
      const key=captured.keyAccessor.get.call(entry);
      return typeof key==='string'&&key.length>0&&key.length<=256?key:'';
    }catch(error){return ''}
  };
})();
function forgetCurrentReviewMarkerProof(){
  reviewMarkerProof.forget(reviewRuntime.markerEntryKey);
}
function rememberCurrentReviewMarkerProof(reviewId,origin){
  const markerKey=reviewRuntime.markerEntryKey;
  const originKey=reviewRuntime.originEntryKey;
  if(typeof reviewId!=='string'||!markerKey||!originKey||markerKey===originKey||
     !sameReviewProjection(origin,sanitizeReviewProjectionForWrite.origin()))return false;
  return reviewMarkerProof.remember(markerKey,reviewId,originKey,origin);
}
function clearReviewEntryProof(){
  forgetCurrentReviewMarkerProof();
  reviewRuntime.originEntryKey='';reviewRuntime.markerEntryKey='';
  reviewRuntime.markerIssued=false;reviewRuntime.fallbackAllowed=false;
  sanitizeReviewProjectionForWrite.clear();
}
function currentReviewMarkerProofOrigin(reviewId){
  const key=reviewEntryKey();
  if(typeof reviewId!=='string'||!reviewRuntime.originEntryKey||
     !reviewRuntime.markerEntryKey||reviewRuntime.originEntryKey===
     reviewRuntime.markerEntryKey||key!==reviewRuntime.markerEntryKey)return null;
  return reviewMarkerProof.origin(key,reviewId,reviewRuntime.originEntryKey,
    sanitizeReviewProjectionForWrite.origin());
}
function validCurrentReviewMarkerEntry(reviewId,candidateProjection){
  const key=reviewEntryKey();
  return Boolean(typeof reviewId==='string'&&reviewRuntime.originEntryKey&&
    reviewRuntime.markerEntryKey&&
    reviewRuntime.originEntryKey!==reviewRuntime.markerEntryKey&&
    key===reviewRuntime.markerEntryKey&&reviewMarkerProof.matches(key,reviewId,
      reviewRuntime.originEntryKey,sanitizeReviewProjectionForWrite.origin(),
      candidateProjection));
}
function reviewEndpoint(reviewId){
  if(reviewId==='review-swap-external') return 'external_wallet:swap';
  if(reviewId.startsWith('review-perp')) return 'hyperliquid:testnet';
  if(reviewId.endsWith('-external')) return 'external_wallet:request';
  if(reviewId.startsWith('review-approve')) return 'eth_sendTransaction';
  return '/v1/wallets/fixture-wallet-1/actions';
}
function currentReviewLive(reviewId){
  const config=ensureWalletAdapter();
  const wallet=config.walletResult?.ok===true?config.walletResult.value:null;
  if(!wallet) return null;
  return {user_id:'fixture-user-1',wallet_id:wallet.wallet_ref,
    wallet_class:wallet.wallet_class,endpoint:reviewEndpoint(reviewId)};
}
function ensureReviewController(){
  const adapter=ensureWalletAdapter().adapter;
  const perpIntent=currentPerpIntentForReview();
  const perpIntentRevision=perpIntent?.intent_revision||'';
  if(reviewRuntime.adapter===adapter&&reviewRuntime.controller&&
     reviewRuntime.perpIntentRevision===perpIntentRevision)return reviewRuntime.controller;
  if(reviewRuntime.openId&&reviewRuntime.controller){
    reviewRuntime.controller.consume({review_id:reviewRuntime.openId});
    closeReviewSurface(false);
  }
  reviewRuntime.adapter=adapter;
  reviewRuntime.perpIntentRevision=perpIntentRevision;
  reviewRuntime.controller=walletReviewFacade?.createController({adapter,
    perpIntentProvider:currentPerpIntentForReview})||null;
  return reviewRuntime.controller;
}
function reviewDialog(){return document.getElementById('review-dialog')}
function reviewSurfaceOpen(){return Boolean(reviewDialog()?.classList.contains('open'))}
function rememberReviewBackground(){
  if(reviewRuntime.background.size) return;
  const dialog=reviewDialog(),veil=document.getElementById('veil');
  reviewRuntime.legacyVeilOwned=Boolean(veil?.classList.contains('open')&&
    document.querySelector('.sheet.open'));
  const outside=[...document.getElementById('phone').children,
    ...document.querySelectorAll('.pitch,.to-plan-mobile')];
  outside.forEach(node=>{
    if(node===dialog||node===veil) return;
    reviewRuntime.background.set(node,{inert:node.hasAttribute('inert'),
      ariaHidden:node.getAttribute('aria-hidden')});
    node.setAttribute('inert','');node.setAttribute('aria-hidden','true');
  });
}
function restoreReviewBackground(){
  for(const [node,state] of reviewRuntime.background){
    if(state.inert)node.setAttribute('inert','');else node.removeAttribute('inert');
    if(state.ariaHidden===null)node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden',state.ariaHidden);
  }
  reviewRuntime.background.clear();
}
function closeReviewSurface(restoreFocus=true){
  if(reviewRuntime.expiryTimer!==null){
    clearTimeout(reviewRuntime.expiryTimer);reviewRuntime.expiryTimer=null;
  }
  const dialog=reviewDialog();
  if(dialog){dialog.classList.remove('open');dialog.hidden=true;
    dialog.setAttribute('inert','');dialog.setAttribute('aria-hidden','true');
    dialog.dataset.state='closed';}
  const veil=document.getElementById('veil');
  veil?.classList.remove('open');
  restoreReviewBackground();
  if(reviewRuntime.legacyVeilOwned&&document.querySelector('.sheet.open')){
    veil?.classList.add('open');
  }
  reviewRuntime.legacyVeilOwned=false;
  if(restoreFocus&&reviewRuntime.triggerId){
    const trigger=document.getElementById(reviewRuntime.triggerId);
    if(trigger&&!trigger.disabled&&trigger.isConnected)trigger.focus({preventScroll:true});
  }
}
function reviewField(label,value,provenance){
  const row=walletElement('div','review-field');row.dataset.provenance=provenance;
  const term=walletElement('dt','',label),detail=walletElement('dd','',value);
  detail.append(walletElement('small','',provenance==='unavailable'?
    'Provider preview unavailable':'Digest-bound provider field'));
  row.append(term,detail);return row;
}
function reviewNetworkLabel(chainId){return chainId==='ethereum'?'Ethereum':
  chainId==='hyperliquid-testnet'?'Hyperliquid testnet':chainId}
function reviewApprovalAmount(baseUnits,assetId){
  const decimals=assetId==='USDC'?6:null;
  if(decimals===null||typeof baseUnits!=='string'||!/^[0-9]+$/.test(baseUnits)){
    return `${baseUnits} base units`;
  }
  const padded=baseUnits.padStart(decimals+1,'0');
  const whole=padded.slice(0,-decimals).replace(/^0+(?=\d)/,'');
  const fraction=padded.slice(-decimals).replace(/0+$/,'');
  const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return `${grouped}${fraction?'.'+fraction:''} ${assetId}`;
}
function renderReviewFields(model){
  const host=document.getElementById('review-fields');host.replaceChildren();
  const common=[
    ['Source',model.provenance,'digest_bound_provider'],
    ['Network',reviewNetworkLabel(model.chain_id),'digest_bound_provider'],
    ['Wallet',model.wallet_class==='privy_embedded'?
      `Privy embedded · ${model.wallet_ref}`:model.fields.wallet_address,
      model.fields.field_provenance.wallet]
  ];
  let fields=[];
  if(model.kind==='transfer'){
    fields=[['Destination',model.fields.destination,
      model.fields.field_provenance.destination],
    ['Amount',`${model.fields.amount_decimal} ${model.fields.asset_id} ${model.fields.amount_semantics}`,
      model.fields.field_provenance.amount],
    ['Amount type',model.fields.amount_type,model.fields.field_provenance.amount_type],
    ['Fee',model.fields.fee_display||'Unavailable',model.fields.field_provenance.fee]];
  }else if(model.kind==='approve'){
    fields=[['Spender',`${model.fields.spender_label} · ${model.fields.spender_address}`,
      model.fields.field_provenance.spender],
    ['Origin',model.fields.dapp_origin,model.fields.field_provenance.origin],
    ['Allowance',model.fields.allowance_kind==='unlimited'?'Unlimited':
      reviewApprovalAmount(model.fields.limit_base_units,model.fields.asset_id),
      model.fields.field_provenance.allowance]];
  }else if(model.kind==='swap'){
    fields=[['Spend',model.fields.input_amount_display,
      model.fields.field_provenance.input],
    ['Estimated output',model.fields.output_amount_display||'Unavailable',
      model.fields.field_provenance.estimated_output],
    ['Minimum output',model.fields.minimum_output_display||'Unavailable',
      model.fields.field_provenance.minimum_output],
    ['Fee',model.fields.fee_display||'Unavailable',model.fields.field_provenance.fees],
    ['Quote deadline',String(model.fields.freshness_deadline_ms),
      model.fields.field_provenance.deadline]];
  }else{
    fields=[['Provider',model.fields.provider,model.fields.field_provenance.provider],
    ['Environment',model.fields.environment,model.fields.field_provenance.environment],
    ['Market',model.fields.market,model.fields.field_provenance.market],
    ['Side',model.fields.side==='buy'?'Buy':'Sell',model.fields.field_provenance.side],
    ['Order type',model.fields.order_type==='market'?'Market':model.fields.order_type,
      model.fields.field_provenance.order_type],
    ['Reduce only',model.fields.reduce_only?'Yes':'No',
      model.fields.field_provenance.reduce_only],
    ['Size',model.fields.size,model.fields.field_provenance.size],
    ['Leverage',`${model.fields.leverage}×`,model.fields.field_provenance.leverage]];
  }
  [...common,...fields,['Expiry',String(model.expires_at_ms),'digest_bound_provider']]
    .forEach(field=>host.append(reviewField(...field)));
}
function renderReviewResult(result,{focus=false}={}){
  const dialog=reviewDialog();
  document.getElementById('review-cancel').disabled=false;
  if(!result?.ok||!result.value?.model){
    dialog.dataset.state='decode_failed';
    document.getElementById('review-summary').textContent=
      result?.error?.safe_message||'The wallet request could not be reviewed safely.';
    document.getElementById('review-status').textContent='Review unavailable';
    document.getElementById('review-fields').replaceChildren();
    document.getElementById('review-preview-ack').hidden=true;
    document.getElementById('review-continue').hidden=true;
    document.getElementById('review-refresh').hidden=true;
  }else{
    const view=result.value,model=view.model;
    reviewRuntime.result=result;dialog.dataset.state=view.state;
    document.getElementById('review-kind').textContent={transfer:'Transfer',approve:'Approval',
      swap:'Swap',perp_order:'Perp order'}[model.kind];
    document.getElementById('review-title').textContent='Review wallet request';
    document.getElementById('review-summary').textContent=model.summary;
    renderReviewFields(model);
    const ack=document.getElementById('review-preview-ack');
    const check=document.getElementById('review-preview-check');
    ack.hidden=!view.acknowledgement_required;check.checked=view.acknowledged===true;
    const primary=document.getElementById('review-continue');
    primary.textContent=model.primary_action||'Continue';
    primary.hidden=view.state==='blocked';primary.disabled=!view.handoff_eligible;
    const refresh=document.getElementById('review-refresh');
    refresh.hidden=!view.refreshable;
    document.getElementById('review-status').textContent=view.state==='blocked'?
      model.blocking_error?.safe_message||'This request is blocked.':
      view.state==='preview_unavailable'?'Action preview unavailable':'';
  }
  rememberReviewBackground();
  document.getElementById('veil').classList.add('open');
  dialog.hidden=false;dialog.removeAttribute('inert');
  dialog.setAttribute('aria-hidden','false');dialog.classList.add('open');
  if(reviewRuntime.expiryTimer!==null){
    clearTimeout(reviewRuntime.expiryTimer);reviewRuntime.expiryTimer=null;
  }
  const view=result?.ok?result.value:null;
  if(view?.state==='ready'&&view.model?.kind==='swap'){
    const id=view.review_id,deadline=view.model.fields.freshness_deadline_ms;
    reviewRuntime.expiryTimer=setTimeout(()=>{
      reviewRuntime.expiryTimer=null;
      if(reviewRuntime.openId!==id||!reviewRuntime.controller||!reviewSurfaceOpen())return;
      const expired=reviewRuntime.controller.forward({review_id:id,
        live_context:currentReviewLive(id),now_ms:reviewNow()});
      if(expired.ok)renderReviewResult(expired);
      else document.getElementById('review-status').textContent=expired.error.safe_message;
    },Math.max(0,deadline-reviewNow()));
  }
  if(focus)document.getElementById('review-cancel').focus({preventScroll:true});
}
function openWalletReview(reviewId,trigger=document.activeElement){
  const policyOperation=reviewOperation(reviewId);
  const regional=regionalOperationDecision({capability:'wallet_mutation',
    operation:policyOperation,stage:'review_open'});
  if(!regional.allowed){
    terminateReviewForRegionalPolicy(reviewId,regional);return false;
  }
  const controller=ensureReviewController();
  const live=currentReviewLive(reviewId);
  const origin=sanitizeReviewProjectionForWrite.captureOrigin(reviewOriginProjection());
  forgetCurrentReviewMarkerProof();
  reviewRuntime.triggerId=trigger?.id||'';
  reviewRuntime.originEntryKey=reviewEntryKey();reviewRuntime.markerEntryKey='';
  reviewRuntime.markerIssued=false;reviewRuntime.fallbackAllowed=false;
  const dialog=reviewDialog();dialog.dataset.state='decoding';
  const result=controller?.open({review_id:reviewId,origin,live_context:live,
    trigger_ref:reviewRuntime.triggerId||'review-trigger',now_ms:reviewNow()})||null;
  if(!result?.ok){renderReviewResult(result,{focus:true});return false}
  reviewRuntime.openId=reviewId;reviewRuntime.policyOperation=policyOperation;
  reviewRuntime.returningId='';reviewRuntime.cancellingId='';
  renderReviewResult(result,{focus:true});
  try{
    history.pushState(sanitizeReviewProjectionForWrite.marker(origin,reviewId),'',location.href);
    reviewRuntime.markerIssued=validReviewMarker(history.state,reviewId);
    reviewRuntime.markerEntryKey=reviewEntryKey();
    if(reviewRuntime.markerIssued&&!rememberCurrentReviewMarkerProof(reviewId,origin)){
      reviewRuntime.markerIssued=false;
    }
  }catch(error){reviewRuntime.markerIssued=false;reviewRuntime.markerEntryKey='';
    reviewRuntime.fallbackAllowed=true}
  return true;
}
function acknowledgeWalletReview(){
  if(!reviewRuntime.openId||!reviewRuntime.controller)return;
  const checked=document.getElementById('review-preview-check').checked;
  const result=reviewRuntime.controller.acknowledge({review_id:reviewRuntime.openId,
    acknowledged:checked});
  if(result.ok)renderReviewResult(result);
}
function cancelWalletReview(){
  if(reviewRuntime.returningId||reviewRuntime.cancellingId)return;
  if(!reviewRuntime.openId){
    if(reviewSurfaceOpen()&&reviewDialog().dataset.state==='decode_failed'){
      closeReviewSurface(true);reviewRuntime.result=null;
      clearReviewEntryProof();
    }
    return;
  }
  const id=reviewRuntime.openId;
  reviewRuntime.cancellingId=id;
  const dialog=reviewDialog();dialog.dataset.state='cancelling_to_origin';
  document.getElementById('review-cancel').disabled=true;
  document.getElementById('review-continue').disabled=true;
  reviewRuntime.controller?.consume({review_id:id});
  if(validReviewMarker(history.state,id)){history.back();return}
  const origin=sanitizeReviewProjectionForWrite.projection(
    sanitizeReviewProjectionForWrite.origin()||reviewOriginProjection());
  history.replaceState(origin,'','#'+expectedHash());
  closeReviewSurface(true);reviewRuntime.openId='';reviewRuntime.cancellingId='';
  reviewRuntime.result=null;clearReviewEntryProof();
}
function continueWalletReview(){
  const id=reviewRuntime.openId;
  if(!id||reviewRuntime.returningId||reviewRuntime.cancellingId||
     !reviewRuntime.controller)return;
  const regional=regionalOperationDecision({capability:'wallet_mutation',
    operation:reviewRuntime.policyOperation||reviewOperation(id),stage:'begin_handoff'});
  if(!regional.allowed){terminateReviewForRegionalPolicy(id,regional);return}
  const marker=reviewMarkerInfo(history.state).snapshot;
  const candidateProjection=marker&&marker.review_id===id?
    {stack:marker.stack}:null;
  const validEntryProof=validCurrentReviewMarkerEntry(id,candidateProjection);
  if((reviewRuntime.markerIssued&&
      (!validReviewMarker(history.state,id)||!validEntryProof))||
     (!reviewRuntime.markerIssued&&!reviewRuntime.fallbackAllowed)){
    reviewRuntime.controller.consume({review_id:id});
    const origin=sanitizeReviewProjectionForWrite.projection(
      sanitizeReviewProjectionForWrite.origin()||reviewOriginProjection());
    history.replaceState(origin,'','#'+expectedHash());
    closeReviewSurface(true);reviewRuntime.openId='';reviewRuntime.result=null;
    clearReviewEntryProof();return;
  }
  const result=reviewRuntime.controller.beginHandoff({review_id:id,
    live_context:currentReviewLive(id),now_ms:reviewNow()});
  if(!result.ok){document.getElementById('review-status').textContent=result.error.safe_message;return}
  reviewRuntime.returningId=id;
  const dialog=reviewDialog();dialog.dataset.state='returning_to_origin';
  document.getElementById('review-continue').disabled=true;
  document.getElementById('review-cancel').disabled=true;
  if(reviewRuntime.markerIssued&&validEntryProof&&validReviewMarker(history.state,id)){
    history.back();return;
  }
  const origin=sanitizeReviewProjectionForWrite.projection(
    sanitizeReviewProjectionForWrite.origin()||reviewOriginProjection());
  history.replaceState(origin,'','#'+expectedHash());
  completeReviewOriginReturn(origin);
}
const SWAP_REFRESH_WINDOWS=Object.freeze([
  Object.freeze({reviewId:'review-swap-refresh',received:100000,deadline:130000}),
  ...[130000,160000,190000,220000,250000,280000,310000,340000,370000,
    400000,430000,460000,490000].map(received=>Object.freeze({
      reviewId:received===130000?'review-swap-refresh-late':
        'review-swap-refresh-'+String(received/1000),
      received,deadline:Math.min(500000,received+30000)}))
]);
function nextSwapRefreshReviewId(now){
  const window=SWAP_REFRESH_WINDOWS.find(candidate=>
    candidate.received<=now&&now<candidate.deadline);
  return window?.reviewId||'';
}
function refreshWalletReview(){
  const id=reviewRuntime.openId;
  if(!id||!reviewRuntime.controller)return;
  const now=reviewNow();
  const replacementReviewId=nextSwapRefreshReviewId(now);
  if(!replacementReviewId){
    document.getElementById('review-status').textContent=
      'No fresh immutable quote is available for this review session.';
    return;
  }
  const result=reviewRuntime.controller.refresh({review_id:id,
    replacement_review_id:replacementReviewId,
    live_context:currentReviewLive(id),
    trigger_ref:reviewRuntime.triggerId||'review-trigger',now_ms:now});
  if(!result.ok){
    document.getElementById('review-status').textContent=result.error.safe_message;
    if(result.error.code==='SESSION_EXPIRED'){
      const dialog=reviewDialog();if(dialog)dialog.dataset.state='blocked';
      document.getElementById('review-refresh').hidden=true;
      document.getElementById('review-continue').hidden=true;
    }
    return;
  }
  reviewRuntime.openId=result.value.review_id;
  const refreshedOrigin=sanitizeReviewProjectionForWrite.captureOrigin(
    reviewOriginProjection());
  history.replaceState(sanitizeReviewProjectionForWrite.marker(refreshedOrigin,
    reviewRuntime.openId),'',location.href);
  if(reviewRuntime.markerIssued){
    rememberCurrentReviewMarkerProof(reviewRuntime.openId,refreshedOrigin);
  }
  renderReviewResult(result);
}
function showReviewProviderState(result){
  const banner=document.getElementById('review-provider-banner');
  banner.dataset.state=result.ok?result.value.state:'provider_failed';
  banner.textContent=result.ok?result.value.safe_message:result.error.safe_message;
  banner.hidden=false;
}
function terminateReviewForRegionalPolicy(reviewId,decision){
  if(reviewId)reviewRuntime.controller?.consume({review_id:reviewId});
  reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
  reviewRuntime.policyOperation='';reviewRuntime.result=null;clearReviewEntryProof();
  closeReviewSurface(true);
  const banner=document.getElementById('review-provider-banner');
  if(banner){banner.dataset.state='provider_blocked';
    banner.textContent=`Blocked · ${decision?.reason||'Regional eligibility is unavailable.'}`;
    banner.hidden=false}
  applyRegionalCapabilityGates();
}
function completeReviewOriginReturn(origin){
  const id=reviewRuntime.returningId;
  if(!id)return;
  const operation=reviewRuntime.policyOperation||reviewOperation(id);
  reviewRuntime.returningId='';reviewRuntime.cancellingId='';
  closeReviewSurface(true);reviewRuntime.openId='';reviewRuntime.result=null;
  clearReviewEntryProof();
  const controller=reviewRuntime.controller;
  const live=currentReviewLive(id);
  const now=reviewNow();
  queueMicrotask(()=>{
    const regional=regionalOperationDecision({capability:'wallet_mutation',
      operation,stage:'provider_handoff'});
    if(!regional.allowed){terminateReviewForRegionalPolicy(id,regional);return}
    const request={review_id:id,live_context:live,origin,now_ms:now};
    const pending=controller.handoff(request);
    showReviewProviderState(pending);
    if(!pending.ok||pending.value.state!=='handoff_pending')return;
    queueMicrotask(()=>{
      const finalRegional=regionalOperationDecision({capability:'wallet_mutation',
        operation,stage:'provider_handoff'});
      if(!finalRegional.allowed){terminateReviewForRegionalPolicy(id,finalRegional);return}
      showReviewProviderState(controller.handoff(request));
    });
  });
}
function consumeReviewForNavigation(){
  if(!reviewRuntime.openId){
    if(reviewSurfaceOpen())closeReviewSurface(false);
    reviewRuntime.cancellingId='';clearReviewEntryProof();return;
  }
  reviewRuntime.controller?.consume({review_id:reviewRuntime.openId});
  reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
  reviewRuntime.policyOperation='';reviewRuntime.result=null;
  clearReviewEntryProof();
  closeReviewSurface(false);
}
function restoreReviewFocusInside(){
  const dialog=reviewDialog();
  if(!reviewSurfaceOpen())return;
  if(!dialog.contains(document.activeElement)){
    const target=dialog.querySelector('button:not([hidden]):not(:disabled),input:not([hidden]):not(:disabled)');
    (target||dialog).focus({preventScroll:true});
  }
}
function handleReviewVeil(event){
  if(reviewSurfaceOpen()){
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    restoreReviewFocusInside();return;
  }
  closeSheets();
}
function handleReviewKeys(event){
  if(!reviewSurfaceOpen())return;
  if(event.key==='Escape'){
    event.preventDefault();event.stopPropagation();
    if(!reviewRuntime.returningId&&!reviewRuntime.cancellingId)cancelWalletReview();return;
  }
  if(event.key!=='Tab')return;
  const focusable=[...reviewDialog().querySelectorAll(
    'button:not([hidden]):not(:disabled),input:not([hidden]):not(:disabled)')]
    .filter(node=>node.offsetParent!==null);
  if(!focusable.length){event.preventDefault();reviewDialog().focus();return}
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
function snapshotReviewStack(candidate){
  try{
    if(!Array.isArray(candidate)||Object.getPrototypeOf(candidate)!==Array.prototype) return null;
    const descriptors=Object.getOwnPropertyDescriptors(candidate),keys=Reflect.ownKeys(candidate);
    const length=descriptors.length?.value;
    if(!Number.isInteger(length)||length<1||length>26)return null;
    const expected=[...Array(length).keys()].map(String).concat('length');
    if(keys.length!==expected.length||keys.some(key=>typeof key!=='string'||
       !expected.includes(key)||!Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
      return null;
    }
    const value=expected.slice(0,-1).map(key=>descriptors[key].value);
    return isValidStack(value)&&!value.some(screen=>REVIEW_ORIGIN_EXCLUDED.has(screen))?
      value:null;
  }catch(error){return null}
}
function reviewMarkerInfo(candidate){
  try{
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||
       Object.getPrototypeOf(candidate)!==Object.prototype)return {present:false,snapshot:null};
    const descriptors=Object.getOwnPropertyDescriptors(candidate),keys=Reflect.ownKeys(candidate);
    const present=Object.prototype.hasOwnProperty.call(descriptors,'loop_review')||
      Object.prototype.hasOwnProperty.call(descriptors,'review_id');
    if(!present)return {present:false,snapshot:null};
    const expected=['stack','loop_review','review_id'];
    if(keys.length!==expected.length||keys.some(key=>typeof key!=='string'||
       !expected.includes(key)||!Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
      return {present:true,snapshot:null};
    }
    const safeStack=snapshotReviewStack(descriptors.stack.value);
    const id=descriptors.review_id.value;
    if(!safeStack||descriptors.loop_review.value!==1||
       typeof id!=='string'||!/^[a-z0-9-]{1,128}$/.test(id)){
      return {present:true,snapshot:null};
    }
    return {present:true,snapshot:{stack:safeStack,loop_review:1,review_id:id}};
  }catch(error){return {present:true,snapshot:null}}
}
function validReviewMarker(candidate,reviewId){
  const snapshot=reviewMarkerInfo(candidate).snapshot;
  return Boolean(snapshot&&snapshot.review_id===reviewId);
}
function safeProjectionFromPossibleReview(candidate){
  try{
    if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&
       Object.getPrototypeOf(candidate)===Object.prototype){
      const descriptors=Object.getOwnPropertyDescriptors(candidate);
      if(Reflect.ownKeys(descriptors).length===1&&
         Object.prototype.hasOwnProperty.call(descriptors,'stack')&&
         Object.prototype.hasOwnProperty.call(descriptors.stack,'value')){
        const safeStack=snapshotReviewStack(descriptors.stack.value);
        if(safeStack)return {stack:safeStack};
      }
    }
  }catch(error){}
  return reviewOriginProjection();
}
function restoreReviewNavigation(projection){
  const safeProjection=sanitizeReviewProjectionForWrite.projection(projection);
  const safeStack=[];
  for(let index=0;index<safeProjection.stack.length;index+=1){
    safeStack[index]=safeProjection.stack[index];
  }
  stack=guardAccountStack(safeStack);
  voicePanel.open=false;voicePanel.minimized=false;
  const projected=strictHashRoute(),routeName=SCREEN_HASH[stack[stack.length-1]]||'home';
  if((routeName==='asset'||routeName==='receive')&&projected.target===routeName&&
     projected.params)walletRouteParams={...projected.params};
  render();setupAccountScreen(activeScr());persist();
}
function handleReviewHistoryPopstate(candidate){
  const marker=reviewMarkerInfo(candidate);
  if(!marker.present)return false;
  if(!marker.snapshot){
    const projection=sanitizeReviewProjectionForWrite.projection(
      safeProjectionFromPossibleReview(candidate));
    restoreReviewNavigation(projection);
    history.replaceState(projection,'','#'+expectedHash());
    if(reviewRuntime.openId)reviewRuntime.controller?.consume({review_id:reviewRuntime.openId});
    reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
    reviewRuntime.result=null;
    clearReviewEntryProof();
    closeReviewSurface(true);return true;
  }
  const projection={stack:marker.snapshot.stack};
  const controller=ensureReviewController();
  const proofOrigin=currentReviewMarkerProofOrigin(marker.snapshot.review_id);
  const proofValid=validCurrentReviewMarkerEntry(marker.snapshot.review_id,projection);
  if(!proofValid){
    const safeOrigin=sanitizeReviewProjectionForWrite.projection(proofOrigin||
      sanitizeReviewProjectionForWrite.origin()||reviewOriginProjection());
    restoreReviewNavigation(safeOrigin);
    if(reviewRuntime.openId)controller?.consume({review_id:reviewRuntime.openId});
    history.replaceState(safeOrigin,'','#'+expectedHash());
    reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
    reviewRuntime.result=null;
    clearReviewEntryProof();
    closeReviewSurface(true);return true;
  }
  restoreReviewNavigation(projection);
  const result=proofValid?controller?.forward({review_id:marker.snapshot.review_id,
    live_context:currentReviewLive(marker.snapshot.review_id),now_ms:reviewNow()}):null;
  if(!result?.ok){
    if(reviewRuntime.openId)controller?.consume({review_id:reviewRuntime.openId});
    const safeOrigin=sanitizeReviewProjectionForWrite.projection(proofOrigin||projection);
    restoreReviewNavigation(safeOrigin);
    history.replaceState(safeOrigin,'','#'+expectedHash());
    reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
    reviewRuntime.result=null;
    clearReviewEntryProof();
    closeReviewSurface(true);return true;
  }
  reviewRuntime.openId=marker.snapshot.review_id;
  sanitizeReviewProjectionForWrite.captureOrigin(projection);
  reviewRuntime.fallbackAllowed=false;reviewRuntime.markerIssued=true;
  renderReviewResult(result,{focus:true});return true;
}
function sameReviewProjection(left,right){
  return Boolean(left&&right&&sameStack(left.stack,right.stack));
}
function finishReviewOriginPopstate(event){
  const origin=reviewOriginProjection();
  if(reviewRuntime.cancellingId){
    const expected=sanitizeReviewProjectionForWrite.projection(
      sanitizeReviewProjectionForWrite.origin()||origin);
    if(!sameReviewProjection(origin,expected)||reviewMarkerInfo(history.state).present){
      restoreReviewNavigation(expected);
      history.replaceState(expected,'','#'+expectedHash());
    }
    reviewRuntime.openId='';reviewRuntime.cancellingId='';reviewRuntime.result=null;
    clearReviewEntryProof();
    closeReviewSurface(true);return;
  }
  if(reviewRuntime.returningId){
    const expected=sanitizeReviewProjectionForWrite.projection(
      sanitizeReviewProjectionForWrite.origin()||origin);
    const key=reviewEntryKey();
  const trusted=event?.isTrusted===true&&sameReviewProjection(origin,expected)&&
      Boolean(reviewRuntime.originEntryKey)&&key===reviewRuntime.originEntryKey&&
      !reviewMarkerInfo(history.state).present;
    if(trusted){completeReviewOriginReturn(origin);return}
    reviewRuntime.controller?.consume({review_id:reviewRuntime.returningId});
    restoreReviewNavigation(expected);
    history.replaceState(expected,'','#'+expectedHash());
    reviewRuntime.openId='';reviewRuntime.returningId='';reviewRuntime.cancellingId='';
    reviewRuntime.result=null;
    clearReviewEntryProof();
    closeReviewSurface(true);return;
  }
  if(reviewRuntime.openId)closeReviewSurface(true);
}
function restoreReviewFromCurrentEntry(){
  const marker=reviewMarkerInfo(history.state);
  if(!marker.present)return;
  if(!marker.snapshot){handleReviewHistoryPopstate(history.state);return}
  const projection={stack:marker.snapshot.stack};
  const controller=ensureReviewController();
  const proofOrigin=currentReviewMarkerProofOrigin(marker.snapshot.review_id);
  const proofValid=validCurrentReviewMarkerEntry(marker.snapshot.review_id,projection);
  if(proofValid)restoreReviewNavigation(projection);
  const result=proofValid?controller?.restore({
    review_id:marker.snapshot.review_id,
    live_context:currentReviewLive(marker.snapshot.review_id),now_ms:reviewNow()}):null;
  if(!result?.ok){
    if(reviewRuntime.openId)controller?.consume({review_id:reviewRuntime.openId});
    const safeOrigin=sanitizeReviewProjectionForWrite.projection(proofOrigin||
      sanitizeReviewProjectionForWrite.origin()||reviewOriginProjection());
    restoreReviewNavigation(safeOrigin);
    history.replaceState(safeOrigin,'','#'+expectedHash());
    reviewRuntime.openId='';reviewRuntime.cancellingId='';reviewRuntime.markerIssued=false;
    clearReviewEntryProof();closeReviewSurface(true);return;
  }
  reviewRuntime.openId=marker.snapshot.review_id;
  sanitizeReviewProjectionForWrite.captureOrigin(projection);
  reviewRuntime.cancellingId='';reviewRuntime.fallbackAllowed=false;
  reviewRuntime.markerIssued=true;
  renderReviewResult(result,{focus:true});
}
function walletElement(tag,className,textValue){
  let element=null;
  switch(tag){
    case 'article':element=document.createElement('article');break;
    case 'b':element=document.createElement('b');break;
    case 'button':element=document.createElement('button');break;
    case 'dd':element=document.createElement('dd');break;
    case 'div':element=document.createElement('div');break;
    case 'dt':element=document.createElement('dt');break;
    case 'h2':element=document.createElement('h2');break;
    case 'h3':element=document.createElement('h3');break;
    case 'p':element=document.createElement('p');break;
    case 'small':element=document.createElement('small');break;
    case 'span':element=document.createElement('span');break;
    case 'strong':element=document.createElement('strong');break;
    default:return null;
  }
  if(className) element.className=className;
  if(textValue!==undefined) element.textContent=textValue;
  return element;
}
function walletClassLabel(walletClass){
  return {privy_embedded:'Privy embedded',connected_external:'Connected external',
    watch_only:'Watch-only'}[walletClass]||'Wallet unavailable';
}
function shortWalletAddress(address){
  return address.length>16?`${address.slice(0,8)}…${address.slice(-6)}`:address;
}
function routeWalletPair(target,asset,chain,{replace=false}={}){
  const params=walletPairCompatible(asset,chain)?{asset,chain}:{...WALLET_ROUTE_DEFAULT};
  walletRouteParams=params;
  const destination=ROUTES[target]?.screen;
  if(!destination) return;
  if(replace||activeScr()===destination){
    navigate(stack.slice(),{replace:true,keepScroll:true});
    return;
  }
  const next=stack[0]==='scr-wallet'?stack.concat(destination):ROUTES[target].stack.slice();
  navigate(next);
}
function walletBalanceRequest(config){
  return config.stale?{asset_id:'ETH',chain_id:'arbitrum'}:{};
}
function walletStateCopy(result,walletClass){
  if(walletClass==='watch_only') return 'Watch-only — no signing actions are available';
  if(!result.ok) return result.error.safe_message;
  if(result.meta.stale) return 'Provider values are stale';
  if(result.value.status==='loading') return 'Loading provider balances';
  if(result.value.status==='empty') return 'No supported assets reported by Privy';
  if(result.value.status==='partial') return 'Some provider data is unavailable';
  return '';
}
function applyWalletCapabilityControls(wallet,address){
  document.getElementById('wallet-receive').disabled=
    wallet.capabilities.receive!=='supported'||!address;
}
function renderWalletAssets(result){
  const host=document.getElementById('wallet-assets');
  if(!host) return;
  host.replaceChildren();
  if(!result.ok) return;
  if(result.value.status==='loading'){
    const skeleton=walletElement('div','wallet-skeleton','Loading provider balances');
    skeleton.setAttribute('aria-label','Loading provider balances');
    host.append(skeleton);
    return;
  }
  const shown=result.value.items.filter(item=>walletViewState.chainFilter==='all'||
    item.chain_id===walletViewState.chainFilter);
  if(!shown.length){
    host.append(walletElement('p','wallet-empty-copy',
      result.value.status==='empty'?'No supported assets reported by Privy':
        'No holdings reported for this network'));
    return;
  }
  shown.forEach(item=>{
    const meta=WALLET_ASSETS[item.asset_id];
    const button=walletElement('button','asset-row wallet-asset-button');
    button.type='button';
    button.dataset.asset=item.asset_id;
    button.dataset.chain=item.chain_id;
    button.setAttribute('aria-label',`${meta.name} on ${WALLET_CHAINS[item.chain_id].label}, ${item.amount_display}, ${item.fiat_value===null?'value unavailable':item.fiat_value+' USD'}`);
    const logo=walletElement('span','tok-logo',meta.symbol.slice(0,1));
    logo.setAttribute('aria-hidden','true');
    const identity=walletElement('span','wallet-asset-identity');
    identity.append(walletElement('strong','tok-name',meta.name),
      walletElement('small','tok-sub',WALLET_CHAINS[item.chain_id].label));
    const quantity=walletElement('span','qty');
    quantity.append(walletElement('b','',item.amount_display),
      walletElement('span','',item.fiat_value===null?'Value unavailable':`${item.fiat_value} USD`));
    button.append(logo,identity,quantity);
    button.addEventListener('click',()=>{
      walletViewState.selectedAsset=item.asset_id;
      walletViewState.selectedChain=item.chain_id;
      routeWalletPair('asset',item.asset_id,item.chain_id);
    });
    host.append(button);
  });
}
function renderWalletFilters(result){
  const host=document.getElementById('wallet-chain-filters');
  if(!host) return;
  host.replaceChildren();
  const available=result.ok?
    [...new Set(result.value.items.map(item=>item.chain_id))]:[];
  [['all','All'],...available.map(chain=>[chain,WALLET_CHAINS[chain].label])]
    .forEach(([chain,label])=>{
      const button=walletElement('button','chip',label);
      button.type='button';
      const selected=chain===walletViewState.chainFilter;
      button.classList.toggle('on',selected);
      button.setAttribute('aria-pressed',String(selected));
      button.addEventListener('click',()=>{
        walletViewState.chainFilter=chain;
        renderWalletFilters(result);
        renderWalletAssets(result);
      });
      host.append(button);
    });
}
function renderWalletScreen(){
  const config=ensureWalletAdapter();
  const wallet=config.walletResult.value;
  const address=wallet.addresses[0]?.address||'';
  const request=walletBalanceRequest(config);
  const balances=config.adapter.getBalanceSnapshot(request);
  const content=document.getElementById('wallet-content');
  content.dataset.walletClass=wallet.wallet_class;
  content.dataset.provider=config.walletResult.meta.source;
  document.querySelector('#scr-wallet [data-wallet-class]').textContent=
    walletClassLabel(wallet.wallet_class);
  document.querySelector('#scr-wallet [data-wallet-address]').textContent=address;
  document.getElementById('wallet-address-short').textContent=address?shortWalletAddress(address):'Address unavailable';
  const providerState=document.querySelector('#scr-wallet [data-provider-state]');
  providerState.textContent=!balances.ok?'Provider capability unavailable':
    balances.meta.stale?'Stale provider values':
      balances.value.status==='ready'?'Provider data ready':`Provider data ${balances.value.status}`;
  const totalLabel=document.querySelector('#scr-wallet [data-total-provenance]');
  const totalValue=document.getElementById('wallet-total-value');
  const disclosure=document.getElementById('wallet-total-disclosure');
  if(balances.ok){
    totalLabel.textContent=balances.value.loop_total.label;
    totalValue.textContent=balances.value.loop_total.value===null?
      'Value unavailable':`${balances.value.loop_total.value} USD`;
    const excluded=balances.value.loop_total.excluded_asset_count;
    disclosure.textContent=excluded?
      `Excludes ${excluded} asset${excluded===1?'':'s'} without a provider USD value`:'';
  }else{
    totalLabel.textContent='LOOP total derived from Privy balances';
    totalValue.textContent='Value unavailable';
    disclosure.textContent='Provider balance total unavailable';
  }
  const state=document.getElementById('wallet-state');
  state.replaceChildren();
  const stateCopy=walletStateCopy(balances,wallet.wallet_class);
  if(stateCopy) state.append(walletElement('p','wallet-state-copy',stateCopy));
  if(balances.ok&&balances.meta.stale){
    state.append(walletElement('p','wallet-stale-time',
      `Last provider update: ${new Date(balances.meta.fetched_at_ms).toISOString()}`));
    state.lastElementChild.id='wallet-stale-time';
    const retry=walletElement('button','btn btn-ghost','Retry');
    retry.id='wallet-retry';retry.type='button';
    retry.addEventListener('click',()=>renderWalletScreen());
    state.append(retry);
  }
  if(balances.ok&&balances.value.status==='partial'){
    balances.value.chain_errors.forEach(error=>state.append(walletElement(
      'p','wallet-chain-warning',`${WALLET_CHAINS[error.chain_id]?.label||'Unknown network'}: ${error.code}`)));
  }
  const first=balances.ok?balances.value.items[0]:null;
  if(first){
    walletViewState.selectedAsset=first.asset_id;
    walletViewState.selectedChain=first.chain_id;
  }
  const sendButton=document.getElementById('wallet-send');
  const receiveButton=document.getElementById('wallet-receive');
  const swapButton=document.getElementById('wallet-swap');
  applyWalletCapabilityControls(wallet,address);
  sendButton.onclick=()=>routeWalletPair('asset',walletViewState.selectedAsset,walletViewState.selectedChain);
  receiveButton.onclick=()=>routeWalletPair('receive',walletViewState.selectedAsset,walletViewState.selectedChain);
  swapButton.onclick=()=>openSwap();
  renderWalletFilters(balances);
  renderWalletAssets(balances);
}
function assetCompatibleChains(asset){return WALLET_ASSETS[asset].chains.slice()}
function renderSelectOptions(select,values,selected,labelFor){
  select.replaceChildren();
  values.forEach(value=>{
    const option=document.createElement('option');
    option.value=value;option.textContent=labelFor(value);option.selected=value===selected;
    select.append(option);
  });
}
function renderAssetBalance(balanceResult){
  if(balanceResult===null) return;
  const summary=document.getElementById('asset-summary');
  const holdings=document.getElementById('asset-holdings');
  summary.replaceChildren();holdings.replaceChildren();
  const card=walletElement('div','asset-summary-card card');
  card.append(walletElement('h2','asset-symbol',walletRouteParams.asset));
  if(!balanceResult.ok){
    card.append(walletElement('p','wallet-state-copy',balanceResult.error.safe_message));
    holdings.append(walletElement('p','wallet-empty-copy','Per-chain holdings unavailable'));
  }else if(balanceResult.value.status==='loading'){
    card.append(walletElement('p','asset-quantity','Loading provider quantity…'));
    card.append(walletElement('p','asset-fiat','Loading provider value…'));
    card.append(walletElement('p','asset-provenance','Waiting for Privy balance data.'));
    holdings.append(walletElement(
      'p','wallet-state-copy','Loading supported holdings from the provider…'));
  }else{
    const selected=balanceResult.value.items.find(item=>item.chain_id===walletRouteParams.chain);
    card.append(walletElement('p','asset-quantity',selected?.amount_display||'Provider quantity unavailable'));
    card.append(walletElement('p','asset-fiat',selected?.fiat_value===null||!selected?
      'Value unavailable':`${selected.fiat_value} USD`));
    card.append(walletElement('p','asset-provenance',selected?
      'Provider quantity from Privy balance data':'No quantity reported for the selected network'));
    if(balanceResult.value.status==='partial'){
      card.append(walletElement('p','wallet-state-copy','Some provider balance records were unavailable.'));
    }
    if(!balanceResult.value.items.length){
      holdings.append(walletElement('p','wallet-empty-copy','No supported holdings reported for this asset'));
    }else{
      balanceResult.value.items.forEach(item=>{
        const row=walletElement('div','holding-row');
        row.append(walletElement('strong','',WALLET_CHAINS[item.chain_id].label),
          walletElement('span','mono',item.amount_display),
          walletElement('small','',item.fiat_value===null?'Value unavailable':`${item.fiat_value} USD`));
        holdings.append(row);
      });
    }
  }
  summary.append(card);
}
function renderAssetHistory(historyResult,append){
  const status=document.getElementById('asset-history-status');
  const host=document.getElementById('asset-history');
  const pagination=document.getElementById('asset-pagination');
  if(!append){walletViewState.historyItems=[];host.replaceChildren()}
  pagination.replaceChildren();
  if(!historyResult.ok){
    status.textContent=historyResult.error.safe_message;
    walletViewState.historyCursor=null;
    return;
  }
  if(historyResult.value.status==='loading'){
    status.textContent='Loading provider transaction history…';
    walletViewState.historyCursor=null;
    return;
  }
  const known=new Set(walletViewState.historyItems.map(item=>item.id));
  historyResult.value.items.forEach(item=>{
    if(!known.has(item.id)){known.add(item.id);walletViewState.historyItems.push(item)}
  });
  host.replaceChildren();
  walletViewState.historyItems.forEach(item=>{
    const row=walletElement('article','transaction-row');
    row.dataset.transactionId=item.id;
    const pending=item.provider_status.toLowerCase()==='pending'||
      item.details_present===false;
    const activity=pending?'Transaction details pending':
      item.direction==='other'?'Wallet activity':
        item.direction==='incoming'?'Incoming':'Outgoing';
    row.append(walletElement('h3','transaction-direction',activity),
      walletElement('p','transaction-amount',item.amount_display||activity),
      walletElement('p','transaction-counterparty',item.counterparty||'Counterparty unavailable'),
      walletElement('p','transaction-status',item.provider_status));
    host.append(row);
  });
  if(historyResult.value.status==='partial'){
    status.textContent='Some transaction records were omitted because the provider supplied no ID.';
  }else if(!walletViewState.historyItems.length){
    status.textContent='No transaction history reported by the provider.';
  }else{
    status.textContent='Provider transaction history';
  }
  walletViewState.historyCursor=historyResult.value.next_cursor;
  if(walletViewState.historyCursor!==null){
    const more=walletElement('button','btn btn-ghost','Load more');
    more.id='asset-load-more';more.type='button';
    more.addEventListener('click',loadMoreAssetHistory);
    pagination.append(more);
  }
}
function renderAssetSnapshots(balanceResult,historyResult,append=false){
  renderAssetBalance(balanceResult);
  if(historyResult) renderAssetHistory(historyResult,append);
}
function loadMoreAssetHistory(){
  if(walletViewState.historyCursor===null) return;
  const result=ensureWalletAdapter().adapter.getTransactionHistorySnapshot({
    asset_id:walletRouteParams.asset,chain_id:walletRouteParams.chain,
    cursor:walletViewState.historyCursor
  });
  renderAssetSnapshots(null,result,true);
}
function renderAssetScreen(){
  const config=ensureWalletAdapter();
  const asset=walletRouteParams.asset;
  const chain=walletRouteParams.chain;
  const chainSelect=document.getElementById('asset-chain');
  renderSelectOptions(chainSelect,assetCompatibleChains(asset),chain,
    value=>WALLET_CHAINS[value].label);
  chainSelect.onchange=()=>routeWalletPair('asset',asset,chainSelect.value,{replace:true});
  const balances=config.adapter.getBalanceSnapshot({asset_id:asset});
  const historyResult=config.adapter.getTransactionHistorySnapshot({
    asset_id:asset,chain_id:chain
  });
  renderAssetSnapshots(balances,historyResult,false);
  const receiveButton=document.getElementById('asset-receive');
  receiveButton.onclick=()=>routeWalletPair('receive',asset,chain);
  const review=document.getElementById('asset-review-transfer');
  const note=document.getElementById('asset-action-note');
  const walletClass=config.walletResult.value.wallet_class;
  const providerLoading=balances.ok&&balances.value.status==='loading'||
    historyResult.ok&&historyResult.value.status==='loading';
  review.disabled=walletClass!=='privy_embedded'||providerLoading;
  note.textContent=providerLoading?
    'Provider data is still loading. Transfer review is unavailable.':
    walletClass==='watch_only'?
    'Watch-only wallets cannot authorize signing requests.':
    walletClass==='connected_external'?
      'Transfer review is not available through this provider in this slice.':'';
  review.onclick=()=>{
    if(!openWalletReview('review-transfer',review)){
      note.textContent='The wallet request could not be reviewed safely.';
    }
  };
}
function receiveWarning(asset,chain){
  return `Only send ${asset} on ${WALLET_CHAINS[chain].label} to this address. Using another asset or network may result in permanent loss.`;
}
function createPinnedReceiveQrSvg(factory,address,alternative){
  if(!capturePinnedQrFactory(factory)) return null;
  try{
    const qr=factory(0,'M');
    if(!qr||typeof qr.addData!=='function'||typeof qr.make!=='function'||
       typeof qr.createSvgTag!=='function') return null;
    qr.addData(address,'Byte');
    qr.make();
    const markup=qr.createSvgTag({cellSize:4,margin:4,scalable:true,alt:alternative});
    if(typeof markup!=='string'||markup.length>200000||
       /<(?:script|foreignObject)\b|\s(?:on\w+|href|src)\s*=/i.test(markup)) return null;
    const parsed=new DOMParser().parseFromString(markup,'image/svg+xml');
    if(parsed.querySelector('parsererror')) return null;
    const svg=parsed.documentElement;
    const allowedTags=new Set(['svg','description','rect','path']);
    const allowedAttributes=new Set(['version','xmlns','viewBox','preserveAspectRatio',
      'role','aria-labelledby','id','width','height','fill','cx','cy','d','stroke']);
    const nodes=[svg,...svg.querySelectorAll('*')];
    if(svg.localName!=='svg'||svg.namespaceURI!=='http://www.w3.org/2000/svg'||
       nodes.some(node=>!allowedTags.has(node.localName)||
         [...node.attributes].some(attribute=>!allowedAttributes.has(attribute.name)))){
      return null;
    }
    const description=svg.querySelector('description');
    if(!description||description.textContent!==alternative) return null;
    const safeSvg=document.importNode(svg,true);
    safeSvg.dataset.qrPayload=address;
    safeSvg.setAttribute('aria-label',alternative);
    return safeSvg;
  }catch(_error){return null}
}
function renderReceiveQr(address,chain){
  const host=document.getElementById('receive-qr');
  host.replaceChildren();
  const alternative=`Receive address ${address} on ${WALLET_CHAINS[chain].label}`;
  const svg=createPinnedReceiveQrSvg(PINNED_QR_FACTORY,address,alternative);
  if(!svg) return false;
  host.replaceChildren(svg);
  return true;
}
function manualReceiveCopy(addressField,status){
  addressField.focus();
  addressField.select();
  status.textContent='Copy unavailable — select the address manually.';
}
function copyReceiveAddress(){
  const address=document.getElementById('receive-address');
  const status=document.getElementById('receive-copy-status');
  if(!navigator.clipboard||typeof navigator.clipboard.writeText!=='function'){
    manualReceiveCopy(address,status);
    return;
  }
  navigator.clipboard.writeText(address.value).then(()=>{
    status.textContent='Address copied.';
  }).catch(()=>manualReceiveCopy(address,status));
}
function renderReceiveScreen(){
  const config=ensureWalletAdapter();
  const asset=walletRouteParams.asset;
  const chain=walletRouteParams.chain;
  const assetSelect=document.getElementById('receive-asset');
  const chainSelect=document.getElementById('receive-chain');
  renderSelectOptions(assetSelect,WALLET_ASSET_IDS,asset,value=>value);
  renderSelectOptions(chainSelect,assetCompatibleChains(asset),chain,
    value=>WALLET_CHAINS[value].label);
  assetSelect.onchange=()=>{
    const nextAsset=assetSelect.value;
    routeWalletPair('receive',nextAsset,WALLET_ASSETS[nextAsset].chains[0],{replace:true});
  };
  chainSelect.onchange=()=>routeWalletPair('receive',asset,chainSelect.value,{replace:true});
  document.getElementById('receive-wallet-class').textContent=
    `${walletClassLabel(config.walletResult.value.wallet_class)} wallet`;
  const target=config.adapter.getReceiveTarget({asset_id:asset,chain_id:chain});
  const address=document.getElementById('receive-address');
  const warning=document.getElementById('receive-warning');
  const copy=document.getElementById('receive-copy');
  document.getElementById('receive-copy-status').textContent='';
  if(!target.ok){
    address.value='';warning.textContent=target.error.safe_message;copy.disabled=true;
    document.getElementById('receive-qr').replaceChildren();
    return;
  }
  address.value=target.value.address;
  warning.textContent=receiveWarning(asset,chain);
  copy.disabled=false;copy.onclick=copyReceiveAddress;
  if(!renderReceiveQr(target.value.address,chain)){
    document.getElementById('receive-copy-status').textContent=
      'QR unavailable — use the exact public address shown below.';
  }
}
function renderWalletFoundation(screen){
  if(screen==='scr-wallet') renderWalletScreen();
  if(screen==='scr-asset') renderAssetScreen();
  if(screen==='scr-receive') renderReceiveScreen();
  renderWalletSigningCapabilities();
}

/* ---------- D1-D7: read-only Hyperliquid Core Perp presentation ---------- */
const PERP_MAX_AGE_MS=2000;
let perpReadFailure='unavailable';
function formatPerpDecimal(value){
  const sign=value.startsWith('-')?'−':'';
  const unsigned=value.replace(/^-/,''),parts=unsigned.split('.');
  const integer=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return sign+integer+(parts.length===2?'.'+parts[1]:'');
}
function formatPerpMoney(value){return '$'+formatPerpDecimal(value)}
function clearPerpTimer(){
  if(perpFreshnessTimer!==null){clearTimeout(perpFreshnessTimer);perpFreshnessTimer=null}
}
function schedulePerpFreshness(ageMs){
  clearPerpTimer();
  const delay=Math.max(0,PERP_MAX_AGE_MS-ageMs+1);
  perpFreshnessTimer=setTimeout(()=>{perpFreshnessTimer=null;render()},delay);
}
function resetPerpProjection(screen){
  const host=document.getElementById(screen);
  if(!host)return;
  host.querySelectorAll('[data-perp-provider-fact]').forEach(node=>{
    node.textContent='';node.hidden=true;
  });
  host.querySelectorAll('[data-perp-provider-action]').forEach(node=>{node.disabled=true});
  ['perp-market-list','perp-position-list','perp-open-order-list','perp-order-history']
    .forEach(id=>host.querySelector('#'+id)?.replaceChildren());
}
function setPerpStatus(screen,message){
  const node=document.querySelector('#'+screen+' [data-perp-provider-status]');
  if(node)node.textContent=message;
}
function projectPerpRecord(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.getPrototypeOf(value)!==Object.prototype)return null;
  const descriptors=Object.getOwnPropertyDescriptors(value),found=Reflect.ownKeys(descriptors);
  if(found.length!==keys.length||found.some(key=>typeof key!=='string'||
     !keys.includes(key)||!Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
    return null;
  }
  const projected={};
  for(const key of keys)projected[key]=descriptors[key].value;
  return projected;
}
function projectPerpArray(value,max=20){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
     value.length>max)return null;
  const descriptors=Object.getOwnPropertyDescriptors(value),expected=['length'];
  for(let index=0;index<value.length;index++)expected.push(String(index));
  const found=Reflect.ownKeys(descriptors);
  if(found.length!==expected.length||found.some(key=>typeof key!=='string'||
     !expected.includes(key)||(key!=='length'&&
       !Object.prototype.hasOwnProperty.call(descriptors[key],'value'))))return null;
  return Array.from({length:value.length},(_item,index)=>descriptors[String(index)].value);
}
function perpText(value,max=128){
  return typeof value==='string'&&value.length>0&&value.length<=max&&
    value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
}
function perpToken(value,max=96){
  return perpText(value,max)&&/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)?value:null;
}
function perpNumber(value,min,max,{integer=false}={}){
  if(typeof value!=='string'||value.length>40||
     !/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value))return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)&&!Object.is(parsed,-0)&&parsed>=min&&parsed<=max&&
    (!integer||Number.isInteger(parsed))?value:null;
}
function perpUsdcUnits(value,{positive=false}={}){
  if(typeof value!=='string'||
     !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');
  const units=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6));
  if(units>1000000000000000000000n||(positive&&units===0n))return null;
  return units;
}
function perpCoreCoin(value){return ['BTC','ETH','SOL'].includes(value)?value:null}
const PERP_MARKET_KEYS=Object.freeze(['coin','display_name','mark_px','change_24h',
  'volume_24h','funding','open_interest','best_bid','best_ask','freshness_ms',
  'source_revision']);
function projectPerpMarket(value){
  const row=projectPerpRecord(value,PERP_MARKET_KEYS);
  if(!row||!perpCoreCoin(row.coin)||!perpText(row.display_name,32)||
     !perpNumber(row.mark_px,0.00000001,1e12)||
     !perpNumber(row.change_24h,-10000,10000)||
     !perpNumber(row.volume_24h,0,1e15)||!perpNumber(row.funding,-1,1)||
     !perpNumber(row.open_interest,0,1e15)||!perpNumber(row.best_bid,0,1e12)||
     !perpNumber(row.best_ask,0,1e12)||Number(row.best_bid)>Number(row.best_ask)||
     !Number.isInteger(row.freshness_ms)||row.freshness_ms<0||
     row.freshness_ms>PERP_MAX_AGE_MS||!perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpMarkets(value){
  const rows=projectPerpArray(value,3);
  if(!rows||rows.length!==3)return null;
  const projected=rows.map(projectPerpMarket);
  if(projected.some(row=>!row)||
     projected.some((row,index)=>row.coin!==['BTC','ETH','SOL'][index]))return null;
  return Object.freeze(projected);
}
const PERP_POSITION_KEYS=Object.freeze(['id','coin','side','size','entry_px','mark_px',
  'leverage','margin','unrealized_pnl','liquidation_px','freshness_ms','source_revision']);
function projectPerpPosition(value){
  const row=projectPerpRecord(value,PERP_POSITION_KEYS);
  if(!row||!perpToken(row.id)||!perpCoreCoin(row.coin)||
     !['long','short'].includes(row.side)||!perpNumber(row.size,0.00000001,1e12)||
     !perpNumber(row.entry_px,0.00000001,1e12)||
     !perpNumber(row.mark_px,0.00000001,1e12)||
     !perpNumber(row.leverage,1,100,{integer:true})||!perpNumber(row.margin,0,1e15)||
     !perpNumber(row.unrealized_pnl,-1e15,1e15)||
     !perpNumber(row.liquidation_px,0.00000001,1e12)||
     !Number.isInteger(row.freshness_ms)||row.freshness_ms<0||
     row.freshness_ms>PERP_MAX_AGE_MS||!perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpPositions(value){
  const rows=projectPerpArray(value),projected=rows?.map(projectPerpPosition);
  if(!projected||projected.some(row=>!row)||
     new Set(projected.map(row=>row.id)).size!==projected.length)return null;
  return Object.freeze(projected);
}
const PERP_ORDER_KEYS=Object.freeze(['id','coin','side','type','size','price','status',
  'filled_size','created_label','freshness_ms','source_revision']);
function projectPerpOrder(value){
  const row=projectPerpRecord(value,PERP_ORDER_KEYS);
  if(!row||!perpToken(row.id)||!perpCoreCoin(row.coin)||
     !['buy','sell'].includes(row.side)||!['Limit','Market · IOC'].includes(row.type)||
     !perpNumber(row.size,0.00000001,1e12)||
     !perpNumber(row.price,0.00000001,1e12)||
     !['Open','Filled','Cancelled'].includes(row.status)||
     !perpNumber(row.filled_size,0,1e12)||Number(row.filled_size)>Number(row.size)||
     !perpText(row.created_label,64)||!Number.isInteger(row.freshness_ms)||
     row.freshness_ms<0||row.freshness_ms>PERP_MAX_AGE_MS||
     !perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpOrders(value){
  const rows=projectPerpArray(value),projected=rows?.map(projectPerpOrder);
  if(!projected||projected.some(row=>!row)||
     new Set(projected.map(row=>row.id)).size!==projected.length)return null;
  return Object.freeze(projected);
}
const PERP_INTENT_KEYS=Object.freeze(['market','side','order_type','size','leverage',
  'reduce_only','mark_px','margin_estimate','trading_fee_estimate','builder_fee',
  'liquidation_estimate','freshness_ms','source_revision','intent_revision']);
function projectPerpIntent(value){
  const intent=projectPerpRecord(value,PERP_INTENT_KEYS);
  if(!intent||!perpCoreCoin(intent.market)||!['buy','sell'].includes(intent.side)||
     !['market','limit'].includes(intent.order_type)||
     !perpNumber(intent.size,0.00000001,1e12)||
     !perpNumber(intent.leverage,1,20,{integer:true})||
     typeof intent.reduce_only!=='boolean'||
     !perpNumber(intent.mark_px,0.00000001,1e12)||
     !perpText(intent.margin_estimate)||!perpText(intent.trading_fee_estimate)||
     intent.builder_fee!=='0.00'||!perpText(intent.liquidation_estimate)||
     !Number.isInteger(intent.freshness_ms)||intent.freshness_ms<0||
     intent.freshness_ms>PERP_MAX_AGE_MS||!perpToken(intent.source_revision)||
     !perpToken(intent.intent_revision))return null;
  return Object.freeze({...intent});
}
const PERP_MUTATION_MESSAGE=
  'Trading is unavailable until Hyperliquid credentials, eligibility evidence, and the Privy signer handoff are approved.';
const PERP_MUTATION_RECHECKS=Object.freeze([
  'region','eligibility','policy','nonce','unknown submission'
]);
function projectPerpMutationRequest(value){
  const request=projectPerpRecord(value,['kind','coin','intent_revision']);
  if(!request||!['order','close_position'].includes(request.kind)||
     !perpCoreCoin(request.coin)||!perpToken(request.intent_revision))return null;
  return Object.freeze({...request});
}
function projectPerpMutationBinding(value,expected){
  const binding=projectPerpRecord(value,['kind','coin','intent_revision']);
  if(!binding||!expected||!['order','close_position'].includes(binding.kind)||
     !perpCoreCoin(binding.coin)||!perpToken(binding.intent_revision)||
     binding.kind!==expected.kind||binding.coin!==expected.coin||
     binding.intent_revision!==expected.intent_revision)return null;
  return Object.freeze({...binding});
}
function projectPerpMutationDecision(value,expected){
  try{
    const envelope=projectPerpRecord(value,['ok','binding','error']);
    const binding=envelope?.ok===false?
      projectPerpMutationBinding(envelope.binding,expected):null;
    const error=envelope?.ok===false?
      projectPerpRecord(envelope.error,
        ['code','retryable','safe_message','rechecks']):null;
    const rechecks=error?projectPerpArray(error.rechecks,5):null;
    if(!binding||!error||error.code!=='PENDING_default_deny'||
       error.retryable!==false||error.safe_message!==PERP_MUTATION_MESSAGE||
       !rechecks||rechecks.length!==PERP_MUTATION_RECHECKS.length||
       rechecks.some((entry,index)=>entry!==PERP_MUTATION_RECHECKS[index]))return null;
    return Object.freeze({ok:false,binding,error:Object.freeze({
      code:'PENDING_default_deny',retryable:false,safe_message:PERP_MUTATION_MESSAGE,
      rechecks:Object.freeze([...PERP_MUTATION_RECHECKS])
    })});
  }catch(_error){return null}
}
function projectPerpAdapterRequest(method,value){
  try{
    if(['getMarketsSnapshot','getPositionsSnapshot','getOrdersSnapshot'].includes(method))
      return value===undefined?Object.freeze({}):null;
    if(method==='getMarketSnapshot'){
      const request=projectPerpRecord(value,['coin']);
      return request&&perpCoreCoin(request.coin)?Object.freeze({...request}):null;
    }
    if(method==='getPositionSnapshot'){
      const request=projectPerpRecord(value,['position_id']);
      return request&&perpToken(request.position_id)?Object.freeze({...request}):null;
    }
    if(method==='prepareOrderIntent'){
      const request=projectPerpRecord(value,
        ['coin','side','order_type','size','leverage','reduce_only']);
      if(!request||!perpCoreCoin(request.coin)||
         !['buy','sell'].includes(request.side)||
         !['market','limit'].includes(request.order_type)||
         !perpNumber(request.size,0.00000001,1e12)||
         !perpNumber(request.leverage,1,20,{integer:true})||
         typeof request.reduce_only!=='boolean')return null;
      return Object.freeze({...request});
    }
  }catch(_error){}
  return null;
}
function projectPerpAdapterValue(method,value,request){
  try{
    if(method==='getMarketsSnapshot')return projectPerpMarkets(value);
    if(method==='getMarketSnapshot'){
      const projected=projectPerpMarket(value);
      if(!projected||projected.coin!==request.coin)return null;
      return projected;
    }
    if(method==='getPositionsSnapshot')return projectPerpPositions(value);
    if(method==='getOrdersSnapshot')return projectPerpOrders(value);
    if(method==='getPositionSnapshot'){
      const projected=projectPerpPosition(value);
      if(!projected||projected.id!==request.position_id)return null;
      return projected;
    }
    if(method==='prepareOrderIntent'){
      const intent=projectPerpIntent(value);
      if(!intent||intent.market!==request.coin||intent.side!==request.side||
         intent.order_type!==request.order_type||intent.size!==request.size||
         intent.leverage!==request.leverage||intent.reduce_only!==request.reduce_only)return null;
      return intent;
    }
  }catch(_error){}
  return null;
}
function projectPerpMeta(value){
  const meta=projectPerpRecord(value,['source','mode','network','label','fetched_at_ms',
    'age_ms','stale','partial']);
  if(!meta||meta.source!=='hyperliquid_offline_fixture'||meta.mode!=='offline_readonly'||
     meta.network!=='testnet'||meta.label!==
       'Simulated Hyperliquid testnet fixture — no network, signing, or submission'||
     !Number.isFinite(meta.fetched_at_ms)||meta.fetched_at_ms<0||
     !Number.isInteger(meta.age_ms)||meta.age_ms<0||meta.age_ms>PERP_MAX_AGE_MS||
     meta.stale!==false||meta.partial!==false)return null;
  return Object.freeze({...meta});
}
function showPerpFact(selector,value){
  const node=document.querySelector(selector);
  if(!node)return;
  node.textContent=value;node.hidden=false;
}
function enablePerpActions(screen){
  document.querySelectorAll('#'+screen+' [data-perp-provider-action]')
    .forEach(node=>{node.disabled=false});
}
function perpUnavailableMessage(subject){
  return perpReadFailure==='stale'?`Hyperliquid ${subject} stale — facts cleared and actions blocked.`:
    perpReadFailure==='malformed'?`Hyperliquid ${subject} malformed — facts cleared and actions blocked.`:
    `Hyperliquid ${subject} unavailable — adapter PENDING.`;
}
function perpSnapshot(method,request){
  try{
    if(!perpReadAdapter||typeof perpReadAdapter[method]!=='function')return null;
    const canonicalRequest=projectPerpAdapterRequest(method,request);
    if(!canonicalRequest){clearPerpTimer();perpReadFailure='malformed';return null}
    const result=Reflect.ownKeys(canonicalRequest).length===0?perpReadAdapter[method]():
      perpReadAdapter[method](canonicalRequest);
    const envelope=projectPerpRecord(result,['ok','value','meta']);
    const rawMeta=envelope?.ok===true?projectPerpRecord(envelope.meta,
      ['source','mode','network','label','fetched_at_ms','age_ms','stale','partial']):null;
    const meta=envelope?.ok===true?projectPerpMeta(envelope.meta):null;
    if(!meta){
      clearPerpTimer();
      perpReadFailure=rawMeta?.stale===true?'stale':'unavailable';
      return null;
    }
    const projected=projectPerpAdapterValue(method,envelope.value,canonicalRequest);
    if(projected===null){clearPerpTimer();perpReadFailure='malformed';return null}
    perpReadFailure='';
    schedulePerpFreshness(meta.age_ms);
    return Object.freeze({ok:true,value:projected,meta});
  }catch(_error){clearPerpTimer();perpReadFailure='unavailable';return null}
}
function renderPerpMarkets(){
  resetPerpProjection('scr-perp-markets');
  const result=perpSnapshot('getMarketsSnapshot');
  const host=document.getElementById('perp-market-list');
  if(!host||!result){setPerpStatus('scr-perp-markets',perpUnavailableMessage('market data'));return}
  setPerpStatus('scr-perp-markets',result.meta.label);
  const summary=document.querySelectorAll('#scr-perp-markets [data-perp-provider-fact]');
  if(summary[0]){summary[0].textContent=result.value.length+' Core';summary[0].hidden=false}
  if(summary[1]){summary[1].textContent=result.meta.age_ms+' ms';summary[1].hidden=false}
  result.value.forEach(market=>{
    const button=document.createElement('button');
    button.className='perp-market-row perp-touch';button.type='button';
    button.dataset.perpCoin=market.coin;button.setAttribute('data-perp-provider-action','');
    const identity=document.createElement('span'),coin=document.createElement('b'),
      name=document.createElement('small'),quote=document.createElement('span'),
      price=document.createElement('b'),change=document.createElement('small');
    coin.textContent=market.coin;name.textContent=market.display_name;
    price.textContent=formatPerpMoney(market.mark_px);
    change.textContent=(market.change_24h.startsWith('-')?'':'+')+
      formatPerpDecimal(market.change_24h)+'%';
    change.className=market.change_24h.startsWith('-')?'down':'up';
    identity.append(coin,name);quote.append(price,change);button.append(identity,quote);
    button.addEventListener('click',()=>openPerpMarket(market.coin));host.append(button);
  });
  enablePerpActions('scr-perp-markets');
}
function renderPerpMarket(){
  resetPerpProjection('scr-perp-market');
  const result=perpSnapshot('getMarketSnapshot',{coin:perpViewState.coin});
  if(!result){setPerpStatus('scr-perp-market',perpUnavailableMessage('market detail'));return}
  const market=result.value;
  setPerpStatus('scr-perp-market',result.meta.label);
  document.querySelectorAll('[data-perp-selected-coin]').forEach(node=>{
    node.textContent=perpViewState.coin;
  });
  const change=document.querySelector('[data-perp-change]');
  showPerpFact('[data-perp-mark-price]',formatPerpMoney(market.mark_px));
  showPerpFact('[data-perp-change]',(market.change_24h.startsWith('-')?'':'+')+
    formatPerpDecimal(market.change_24h)+'% · 24h');
  if(change)change.className='perp-change '+(market.change_24h.startsWith('-')?'down':'up');
  showPerpFact('[data-perp-funding]',formatPerpDecimal(market.funding)+' / 8h');
  showPerpFact('[data-perp-open-interest]',formatPerpMoney(market.open_interest));
  showPerpFact('[data-perp-volume]',formatPerpMoney(market.volume_24h));
  showPerpFact('[data-perp-bbo]',formatPerpMoney(market.best_bid)+' / '+
    formatPerpMoney(market.best_ask));
  showPerpFact('[data-perp-freshness]',`Snapshot age ${result.meta.age_ms} ms · ${market.source_revision}`);
  enablePerpActions('scr-perp-market');
}
function renderPerpOrder(){
  resetPerpProjection('scr-perp-order');
  const result=perpSnapshot('getMarketSnapshot',{coin:'ETH'});
  if(!result){perpViewState.intent=null;perpViewState.intentDeadlineMs=0;
    setPerpStatus('scr-perp-order',perpUnavailableMessage('order preview'));return}
  setPerpStatus('scr-perp-order',result.meta.label);
  const estimates=document.querySelectorAll('#scr-perp-order [data-perp-provider-fact]');
  ['Calculated only after validation','Calculated only after validation','Disabled · $0.00']
    .forEach((text,index)=>{if(estimates[index]){estimates[index].textContent=text;estimates[index].hidden=false}});
  enablePerpActions('scr-perp-order');
}
function renderPerpConfirmation(){
  resetPerpProjection('scr-perp-confirm');
  const intent=currentPerpIntent();
  if(!intent){setPerpStatus('scr-perp-confirm',perpUnavailableMessage('immutable intent'));return}
  setPerpStatus('scr-perp-confirm','Validated immutable intent · '+
    'Simulated Hyperliquid testnet fixture — no network, signing, or submission');
  const fields={
    '[data-perp-confirm-direction]':intent.side==='buy'?'Buy / Long':'Sell / Short',
    '[data-perp-confirm-type]':intent.order_type==='market'?'Market':'Limit',
    '[data-perp-confirm-price]':formatPerpMoney(intent.mark_px)+' mark',
    '[data-perp-confirm-size]':intent.size+' ETH',
    '[data-perp-confirm-leverage]':intent.leverage+'× isolated',
    '[data-perp-confirm-margin]':intent.margin_estimate,
    '[data-perp-confirm-fee]':intent.trading_fee_estimate,
    '[data-perp-confirm-builder]':'Disabled · '+formatPerpMoney(intent.builder_fee),
    '[data-perp-confirm-liquidation]':intent.liquidation_estimate,
    '[data-perp-confirm-freshness]':'Source age below '+PERP_MAX_AGE_MS+' ms · '+intent.source_revision
  };
  Object.entries(fields).forEach(([selector,value])=>showPerpFact(selector,value));
  enablePerpActions('scr-perp-confirm');
}
function positionButton(position){
  const button=document.createElement('button');button.type='button';
  button.className='perp-position-card card perp-touch';
  button.setAttribute('data-perp-provider-action','');
  const title=document.createElement('span'),name=document.createElement('b'),lev=document.createElement('small');
  title.className='perp-position-title';name.textContent=position.coin+' · '+
    (position.side==='long'?'Long':'Short');lev.textContent=position.leverage+'× isolated';title.append(name,lev);
  const pairs=[['Size',position.size+' '+position.coin],['Entry / Mark',
    formatPerpMoney(position.entry_px)+' / '+formatPerpMoney(position.mark_px)],
    ['Unrealized PnL',formatPerpMoney(position.unrealized_pnl)]];
  button.append(title);
  pairs.forEach(([label,value])=>{const span=document.createElement('span'),small=document.createElement('small'),bold=document.createElement('b');small.textContent=label;bold.textContent=value;span.append(small,bold);button.append(span)});
  button.addEventListener('click',()=>openPerpPosition(position.id));return button;
}
function renderPerpPositions(){
  resetPerpProjection('scr-perp-positions');
  const result=perpSnapshot('getPositionsSnapshot'),host=document.getElementById('perp-position-list');
  if(!result||!host){setPerpStatus('scr-perp-positions',perpUnavailableMessage('positions'));return}
  setPerpStatus('scr-perp-positions',result.meta.label);
  showPerpFact('[data-perp-position-count]',result.value.length+' open');
  result.value.forEach(position=>host.append(positionButton(position)));
}
function orderRow(order){
  const article=document.createElement('article');article.className='perp-order-row card';
  article.setAttribute('data-perp-provider-fact','');
  const identity=document.createElement('span'),name=document.createElement('b'),type=document.createElement('small'),
    terms=document.createElement('span'),size=document.createElement('b'),price=document.createElement('small'),status=document.createElement('span');
  name.textContent=order.coin+' · '+(order.side==='buy'?'Buy':'Sell');type.textContent=order.type;
  size.textContent=order.size+' '+order.coin;price.textContent='@ '+formatPerpMoney(order.price);
  status.className=order.status==='Filled'?'risk-pill risk-low':'chip';status.textContent=order.status;
  identity.append(name,type);terms.append(size,price);article.append(identity,terms,status);return article;
}
function renderPerpOrders(){
  resetPerpProjection('scr-perp-orders');
  const result=perpSnapshot('getOrdersSnapshot'),open=document.getElementById('perp-open-order-list'),
    history=document.getElementById('perp-order-history');
  if(!result||!open||!history){setPerpStatus('scr-perp-orders',perpUnavailableMessage('orders'));return}
  setPerpStatus('scr-perp-orders',result.meta.label);
  result.value.forEach(order=>(order.status==='Open'?open:history).append(orderRow(order)));
}
function renderPerpPosition(){
  resetPerpProjection('scr-perp-position');
  let id=perpViewState.positionId;
  if(!id){const positions=perpSnapshot('getPositionsSnapshot');id=positions?.value[0]?.id||''}
  const result=id?perpSnapshot('getPositionSnapshot',{position_id:id}):null;
  if(!result){setPerpStatus('scr-perp-position',perpUnavailableMessage('position'));return}
  const position=result.value;perpViewState.positionId=position.id;
  setPerpStatus('scr-perp-position',result.meta.label);
  showPerpFact('[data-perp-position-title]',position.coin+' '+
    (position.side==='long'?'Long':'Short'));
  showPerpFact('[data-perp-position-badge]',formatPerpMoney(position.unrealized_pnl));
  const hero=document.querySelector('[data-perp-position-hero]');
  if(hero){const label=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small');label.textContent=position.coin+' '+(position.side==='long'?'Long':'Short');strong.textContent=position.size+' '+position.coin;small.textContent=position.leverage+'× isolated';hero.append(label,strong,small);hero.hidden=false}
  showPerpFact('[data-perp-position-entry]',formatPerpMoney(position.entry_px));
  showPerpFact('[data-perp-position-mark]',formatPerpMoney(position.mark_px));
  showPerpFact('[data-perp-position-margin]',formatPerpMoney(position.margin));
  showPerpFact('[data-perp-position-pnl]',formatPerpMoney(position.unrealized_pnl));
  showPerpFact('[data-perp-position-liquidation]',formatPerpMoney(position.liquidation_px));
  enablePerpActions('scr-perp-position');
}
function renderPerpScreen(screen){
  if(!screen.startsWith('scr-perp-')){clearPerpTimer();return}
  if(screen==='scr-perp-markets')renderPerpMarkets();
  else if(screen==='scr-perp-market')renderPerpMarket();
  else if(screen==='scr-perp-order')renderPerpOrder();
  else if(screen==='scr-perp-confirm')renderPerpConfirmation();
  else if(screen==='scr-perp-positions')renderPerpPositions();
  else if(screen==='scr-perp-orders')renderPerpOrders();
  else if(screen==='scr-perp-position')renderPerpPosition();
}
function goPerpMarkets(){
  navigate(ROUTES['perp-markets'].stack.slice());
}
function openPerpMarket(coin){
  const result=perpSnapshot('getMarketSnapshot',{coin});
  if(!result)return;
  perpViewState.coin=coin;
  navigate(ROUTES['perp-market'].stack.slice());
}
function openPerpOrder(){
  if(perpViewState.coin!=='ETH'){
    toast('This offline order review is pinned to ETH; no provider request was made.');
    return;
  }
  navigate(ROUTES['perp-order'].stack.slice());
}
function openPerpConfirmation(){
  const riskRequired=perpRiskAcknowledgementRequired();
  if(riskRequired!==false){
    perpViewState.intent=null;perpViewState.intentDeadlineMs=0;
    setPerpStatus('scr-perp-order',riskRequired===true?
      'First-use risk acknowledgement is required before order confirmation.':
      'Risk acknowledgement status unavailable — order review blocked.');
    if(riskRequired===true)navigate(ROUTES['perp-risk-notice'].stack.slice());
    return false;
  }
  const size=document.getElementById('perp-order-size')?.value||'';
  const leverage=document.getElementById('perp-leverage')?.value||'';
  const result=perpSnapshot('prepareOrderIntent',{
    coin:'ETH',side:'buy',order_type:'market',size,leverage,reduce_only:false
  });
  if(!result){perpViewState.intent=null;perpViewState.intentDeadlineMs=0;
    resetPerpProjection('scr-perp-order');
    setPerpStatus('scr-perp-order','Order draft invalid or stale — review blocked.');return false}
  perpViewState.intent=result.value;
  perpViewState.intentDeadlineMs=performance.now()+Math.max(0,PERP_MAX_AGE_MS-result.meta.age_ms);
  navigate(ROUTES['perp-confirm'].stack.slice());
  return true;
}
function updatePerpDraft(){
  const leverage=document.getElementById('perp-leverage');
  const label=document.getElementById('perp-leverage-value');
  if(leverage&&label)label.textContent=leverage.value+'×';
  perpViewState.intent=null;perpViewState.intentDeadlineMs=0;
}
function currentPerpIntent(){
  const intent=perpViewState.intent;
  if(!intent||performance.now()>=perpViewState.intentDeadlineMs){
    perpReadFailure=intent?'stale':'unavailable';perpViewState.intent=null;
    perpViewState.intentDeadlineMs=0;return null;
  }
  const market=perpSnapshot('getMarketSnapshot',{coin:intent.market});
  if(!market||market.value.source_revision!==intent.source_revision||
     market.value.mark_px!==intent.mark_px){
    perpViewState.intent=null;perpViewState.intentDeadlineMs=0;return null;
  }
  return intent;
}
function currentPerpIntentForReview(){
  const intent=currentPerpIntent();
  return intent?Object.freeze({market:intent.market,side:intent.side,
    order_type:intent.order_type,size:intent.size,leverage:intent.leverage,
    reduce_only:intent.reduce_only,intent_revision:intent.intent_revision}):null;
}
function openPerpPositions(){
  navigate(ROUTES['perp-positions'].stack.slice());
}
function openPerpOrders(){
  navigate(ROUTES['perp-orders'].stack.slice());
}
function openPerpPosition(positionId){
  if(typeof positionId!=='string'||!positionId)return;
  const result=perpSnapshot('getPositionSnapshot',{position_id:positionId});
  if(!result)return;
  perpViewState.positionId=positionId;
  navigate(ROUTES['perp-position'].stack.slice());
}
function perpMutationDecision(kind){
  const intent=kind==='order'?currentPerpIntent():null;
  if(kind==='order'&&!intent)return null;
  try{
    if(!perpReadAdapter||typeof perpReadAdapter.prepareMutationReview!=='function')return null;
    const request=projectPerpMutationRequest({
      kind,coin:kind==='order'?intent.market:'ETH',
      intent_revision:kind==='order'?intent.intent_revision:'fixture-close-position-eth-1'
    });
    if(!request)return null;
    const raw=perpReadAdapter.prepareMutationReview(request);
    const projected=projectPerpMutationDecision(raw,request);
    return projected;
  }catch(_error){return null}
}
function openPerpSharedReview(trigger){
  const decision=perpMutationDecision('order');
  const status=document.getElementById('perp-review-status');
  if(!decision||decision.ok!==false||decision.error?.code!=='PENDING_default_deny'){
    if(status)status.textContent='The Hyperliquid policy decision was unavailable. Request blocked.';
    return false;
  }
  if(status)status.textContent=decision.error.safe_message;
  return openWalletReview('review-perp',trigger);
}
function openPerpCloseConfirmation(){
  const decision=perpMutationDecision('close_position');
  const status=document.getElementById('perp-close-status');
  if(status)status.textContent=decision?.ok===false?
    decision.error.safe_message:'The Hyperliquid policy decision was unavailable. Request blocked.';
  status?.focus({preventScroll:true});
  return false;
}

/* ---------- D8-D12: Hyperliquid account-side presentation ---------- */
const PERP_ACCOUNT_MAX_AGE_MS=2000;
const PERP_ACCOUNT_LABEL=
  'Simulated Hyperliquid account fixture — read-only, no network, signing, or submission';
const PERP_ACCOUNT_PENDING_MESSAGE=
  'Account action unavailable until Hyperliquid credentials, eligibility evidence, and the Privy signer handoff are approved.';
const PERP_ACCOUNT_RECHECKS=Object.freeze([
  'region','eligibility','policy','nonce','unknown submission'
]);
const PERP_ACCOUNT_INTENT_KEYS=Object.freeze(['kind','account_ref','asset','coin','network',
  'direction','amount','notice_id','notice_revision','accepted','context_revision',
  'intent_revision']);
let perpAccountReadFailure='unavailable';
function clearPerpAccountTimer(){
  if(perpAccountFreshnessTimer!==null){
    clearTimeout(perpAccountFreshnessTimer);perpAccountFreshnessTimer=null;
  }
}
function schedulePerpAccountFreshness(ageMs){
  clearPerpAccountTimer();
  const delay=Math.max(0,PERP_ACCOUNT_MAX_AGE_MS-ageMs+1);
  perpAccountFreshnessTimer=setTimeout(()=>{
    perpAccountFreshnessTimer=null;render();
  },delay);
}
function resetPerpAccountProjection(screen){
  const host=document.getElementById(screen);
  if(!host)return;
  host.querySelectorAll('[data-perp-account-provider-fact]').forEach(node=>{
    node.textContent='';node.hidden=true;
  });
  host.querySelectorAll('[data-perp-account-provider-action]').forEach(node=>{
    node.disabled=true;
  });
  ['perp-funding-history','perp-risk-sections'].forEach(id=>
    host.querySelector('#'+id)?.replaceChildren());
}
function setPerpAccountStatus(screen,message){
  const node=document.querySelector('#'+screen+' [data-perp-account-provider-status]');
  if(node)node.textContent=message;
}
function setPerpAccountActionStatus(screen,message){
  const node=document.querySelector('#'+screen+' [data-perp-account-action-status]');
  if(node)node.textContent=message;
}
function showPerpAccountFact(selector,value){
  const node=document.querySelector(selector);
  if(node){node.textContent=value;node.hidden=false}
}
function enablePerpAccountActions(screen){
  document.querySelectorAll('#'+screen+' [data-perp-account-provider-action]')
    .forEach(node=>{node.disabled=false});
}
function perpAccountUnavailableMessage(subject){
  return perpAccountReadFailure==='stale'?`Hyperliquid ${subject} stale — facts cleared and actions blocked.`:
    perpAccountReadFailure==='malformed'?`Hyperliquid ${subject} malformed — facts cleared and actions blocked.`:
    `Hyperliquid ${subject} unavailable — adapter PENDING.`;
}
function projectPerpAccount(value){
  const row=projectPerpRecord(value,['account_ref','equity','available_margin','used_margin',
    'maintenance_margin','maintenance_margin_ratio','risk_level','freshness_ms','source_revision']);
  if(!row||!perpToken(row.account_ref)||!perpNumber(row.equity,0,1e15)||
     !perpNumber(row.available_margin,0,1e15)||!perpNumber(row.used_margin,0,1e15)||
     !perpNumber(row.maintenance_margin,0,1e15)||
     !perpNumber(row.maintenance_margin_ratio,0,100)||
     !['healthy','elevated','near_liquidation'].includes(row.risk_level)||
     !Number.isInteger(row.freshness_ms)||row.freshness_ms<0||
     row.freshness_ms>PERP_ACCOUNT_MAX_AGE_MS||!perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpTransferContext(value){
  const row=projectPerpRecord(value,['account_ref','asset','spot_available','perp_available',
    'minimum_amount','arrival_label','failure_policy','freshness_ms','source_revision']);
  if(!row||!perpToken(row.account_ref)||row.asset!=='USDC'||
     perpUsdcUnits(row.spot_available)===null||perpUsdcUnits(row.perp_available)===null||
     perpUsdcUnits(row.minimum_amount,{positive:true})===null||
     row.arrival_label!=='Provider-confirmed after official account transfer'||
     row.failure_policy!=='No local balance mutation; reconcile official account state'||
     !Number.isInteger(row.freshness_ms)||row.freshness_ms<0||
     row.freshness_ms>PERP_ACCOUNT_MAX_AGE_MS||!perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpBridgeContext(value){
  const row=projectPerpRecord(value,['account_ref','asset','network','deposit_minimum',
    'withdraw_minimum','arrival_label','bridge_authority','freshness_ms','source_revision']);
  if(!row||!perpToken(row.account_ref)||row.asset!=='USDC'||row.network!=='arbitrum'||
     perpUsdcUnits(row.deposit_minimum,{positive:true})===null||
     perpUsdcUnits(row.withdraw_minimum,{positive:true})===null||
     row.arrival_label!=='Provider-confirmed after official bridge finality'||
     row.bridge_authority!=='hyperliquid_official_bridge'||
     !Number.isInteger(row.freshness_ms)||row.freshness_ms<0||
     row.freshness_ms>PERP_ACCOUNT_MAX_AGE_MS||!perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpFundingRow(value,coin){
  const row=projectPerpRecord(value,['id','coin','settled_at_ms','rate','payment','plot_y',
    'source_revision']);
  if(!row||!perpToken(row.id)||!perpCoreCoin(row.coin)||row.coin!==coin||
     !Number.isSafeInteger(row.settled_at_ms)||row.settled_at_ms<0||
     !perpNumber(row.rate,-1,1)||!perpNumber(row.payment,-1e15,1e15)||
     !Number.isInteger(row.plot_y)||row.plot_y<0||row.plot_y>100||
     !perpToken(row.source_revision))return null;
  return Object.freeze({...row});
}
function projectPerpFundingSnapshot(value){
  const row=projectPerpRecord(value,['coin','current_rate','next_settlement_in_ms','history',
    'freshness_ms','source_revision']);
  if(!row||!perpCoreCoin(row.coin)||!perpNumber(row.current_rate,-1,1)||
     !Number.isInteger(row.next_settlement_in_ms)||row.next_settlement_in_ms<0||
     row.next_settlement_in_ms>28800000||!Number.isInteger(row.freshness_ms)||
     row.freshness_ms<0||row.freshness_ms>PERP_ACCOUNT_MAX_AGE_MS||
     !perpToken(row.source_revision))return null;
  const history=projectPerpArray(row.history,16)?.map(item=>projectPerpFundingRow(item,row.coin));
  if(!history||history.some(item=>!item)||
     new Set(history.map(item=>item.id)).size!==history.length)return null;
  return Object.freeze({...row,history:Object.freeze(history)});
}
const PERP_RISK_COPY=Object.freeze([
  Object.freeze({id:'leverage',heading:'Leverage amplifies loss',
    body:'Losses can accelerate as leverage increases. A small market move can consume posted margin.'}),
  Object.freeze({id:'liquidation',heading:'Liquidation is provider controlled',
    body:'Hyperliquid may liquidate a position when maintenance requirements are not met.'}),
  Object.freeze({id:'funding',heading:'Funding changes over time',
    body:'Funding payments can increase the cost of holding a position and are not fixed.'})
]);
function projectPerpRiskNotice(value){
  const row=projectPerpRecord(value,['account_ref','notice_id','revision','title','sections',
    'acknowledgement_required','freshness_ms','source_revision']);
  if(!row||!perpToken(row.account_ref)||row.notice_id!=='core-perp-risk'||
     row.revision!=='risk-notice-2026-08'||
     row.title!=='Core perpetual leverage and liquidation risk'||
     typeof row.acknowledgement_required!=='boolean'||!Number.isInteger(row.freshness_ms)||
     row.freshness_ms<0||row.freshness_ms>PERP_ACCOUNT_MAX_AGE_MS||
     !perpToken(row.source_revision))return null;
  const sections=projectPerpArray(row.sections,8);
  if(!sections||sections.length!==PERP_RISK_COPY.length)return null;
  const projected=sections.map((value,index)=>{
    const item=projectPerpRecord(value,['id','heading','body']),expected=PERP_RISK_COPY[index];
    return item&&item.id===expected.id&&item.heading===expected.heading&&
      item.body===expected.body?expected:null;
  });
  if(projected.some(item=>!item))return null;
  return Object.freeze({...row,sections:Object.freeze(projected)});
}
function projectPerpAccountIntent(value){
  const intent=projectPerpRecord(value,PERP_ACCOUNT_INTENT_KEYS);
  if(!intent||!['usd_class_transfer','bridge_deposit','bridge_withdraw',
     'risk_acknowledgement'].includes(intent.kind)||!perpToken(intent.account_ref)||
     !perpToken(intent.context_revision)||!perpToken(intent.intent_revision))return null;
  if(intent.kind==='usd_class_transfer'){
    if(intent.asset!=='USDC'||intent.coin!==null||intent.network!=='hyperliquid'||
       !['spot_to_perp','perp_to_spot'].includes(intent.direction)||
       perpUsdcUnits(intent.amount,{positive:true})===null||intent.notice_id!==null||
       intent.notice_revision!==null||intent.accepted!==null)return null;
  }else if(intent.kind==='bridge_deposit'||intent.kind==='bridge_withdraw'){
    if(intent.asset!=='USDC'||intent.coin!==null||intent.network!=='arbitrum'||
       intent.direction!==null||perpUsdcUnits(intent.amount,{positive:true})===null||
       intent.notice_id!==null||intent.notice_revision!==null||intent.accepted!==null)return null;
  }else if(intent.asset!==null||intent.coin!==null||intent.network!==null||
           intent.direction!==null||intent.amount!==null||intent.notice_id!=='core-perp-risk'||
           intent.notice_revision!=='risk-notice-2026-08'||intent.accepted!==true)return null;
  return Object.freeze({...intent});
}
function projectPerpAccountAdapterRequest(method,value){
  try{
    let request=null;
    if(method==='getMarginAccountSnapshot'){
      request=projectPerpRecord(value,['account_ref']);
      if(!request||!perpToken(request.account_ref))return null;
    }else if(method==='getTransferContext'){
      request=projectPerpRecord(value,['account_ref','asset']);
      if(!request||!perpToken(request.account_ref)||request.asset!=='USDC')return null;
    }else if(method==='getBridgeContext'){
      request=projectPerpRecord(value,['account_ref','asset','network']);
      if(!request||!perpToken(request.account_ref)||request.asset!=='USDC'||
         request.network!=='arbitrum')return null;
    }else if(method==='getFundingSnapshot'){
      request=projectPerpRecord(value,['coin']);
      if(!request||!perpCoreCoin(request.coin))return null;
    }else if(method==='getRiskNotice'){
      request=projectPerpRecord(value,['account_ref','notice_id']);
      if(!request||!perpToken(request.account_ref)||request.notice_id!=='core-perp-risk')return null;
    }else if(method==='prepareAccountIntent'){
      request=projectPerpRecord(value,['kind','account_ref','asset','coin','network','direction',
        'amount','notice_id','notice_revision','accepted','context_revision']);
      const placeholder=request?projectPerpAccountIntent({...request,
        intent_revision:'request-validation-placeholder'}):null;
      if(!placeholder)return null;
    }else if(method==='prepareMutationReview'){
      return projectPerpAccountIntent(value);
    }
    return request?Object.freeze({...request}):null;
  }catch(_error){return null}
}
function projectPerpAccountAdapterValue(method,value,request){
  try{
    let projected=null;
    if(method==='getMarginAccountSnapshot'){
      projected=projectPerpAccount(value);
      if(!projected||projected.account_ref!==request.account_ref)return null;
    }else if(method==='getTransferContext'){
      projected=projectPerpTransferContext(value);
      if(!projected||projected.account_ref!==request.account_ref||
         projected.asset!==request.asset)return null;
    }else if(method==='getBridgeContext'){
      projected=projectPerpBridgeContext(value);
      if(!projected||projected.account_ref!==request.account_ref||
         projected.asset!==request.asset||projected.network!==request.network)return null;
    }else if(method==='getFundingSnapshot'){
      projected=projectPerpFundingSnapshot(value);
      if(!projected||projected.coin!==request.coin)return null;
    }else if(method==='getRiskNotice'){
      projected=projectPerpRiskNotice(value);
      if(!projected||projected.account_ref!==request.account_ref||
         projected.notice_id!==request.notice_id)return null;
    }else if(method==='prepareAccountIntent'){
      projected=projectPerpAccountIntent(value);
      const keys=['kind','account_ref','asset','coin','network','direction','amount','notice_id',
        'notice_revision','accepted','context_revision'];
      if(!projected||keys.some(key=>projected[key]!==request[key]))return null;
    }
    return projected;
  }catch(_error){return null}
}
function projectPerpAccountMeta(value){
  const meta=projectPerpRecord(value,['source','mode','network','label','fetched_at_ms',
    'age_ms','stale','partial']);
  const now=performance.now();
  const elapsed=Number.isFinite(meta?.fetched_at_ms)?
    Math.max(0,Math.floor(now-meta.fetched_at_ms)):Number.POSITIVE_INFINITY;
  if(!meta||meta.source!=='hyperliquid_account_offline_fixture'||
     meta.mode!=='offline_readonly'||meta.network!=='testnet'||
     meta.label!==PERP_ACCOUNT_LABEL||!Number.isFinite(meta.fetched_at_ms)||
     meta.fetched_at_ms<0||meta.fetched_at_ms>now||!Number.isInteger(meta.age_ms)||
     meta.age_ms<elapsed||meta.age_ms<0||
     meta.age_ms>PERP_ACCOUNT_MAX_AGE_MS||meta.stale!==false||meta.partial!==false)return null;
  return Object.freeze({...meta});
}
function projectPerpAccountMutationDecision(value,expected){
  try{
    const envelope=projectPerpRecord(value,['ok','binding','error']);
    const binding=envelope?.ok===false?projectPerpAccountIntent(envelope.binding):null;
    const error=envelope?.ok===false?projectPerpRecord(envelope.error,
      ['code','retryable','safe_message','rechecks']):null;
    const rechecks=error?projectPerpArray(error.rechecks,5):null;
    if(!binding||!expected||PERP_ACCOUNT_INTENT_KEYS.some(key=>binding[key]!==expected[key])||
       !error||error.code!=='PENDING_default_deny'||error.retryable!==false||
       error.safe_message!==PERP_ACCOUNT_PENDING_MESSAGE||!rechecks||
       rechecks.length!==PERP_ACCOUNT_RECHECKS.length||
       rechecks.some((item,index)=>item!==PERP_ACCOUNT_RECHECKS[index]))return null;
    return Object.freeze({ok:false,binding,error:Object.freeze({
      code:'PENDING_default_deny',retryable:false,
      safe_message:PERP_ACCOUNT_PENDING_MESSAGE,
      rechecks:Object.freeze([...PERP_ACCOUNT_RECHECKS])
    })});
  }catch(_error){return null}
}
function perpAccountSnapshot(method,request){
  try{
    if(!perpAccountAdapter||typeof perpAccountAdapter[method]!=='function')return null;
    const canonicalRequest=projectPerpAccountAdapterRequest(method,request);
    if(!canonicalRequest){clearPerpAccountTimer();perpAccountReadFailure='malformed';return null}
    const raw=perpAccountAdapter[method](canonicalRequest);
    const envelope=projectPerpRecord(raw,['ok','value','meta']);
    const rawMeta=envelope?.ok===true?projectPerpRecord(envelope.meta,
      ['source','mode','network','label','fetched_at_ms','age_ms','stale','partial']):null;
    const meta=envelope?.ok===true?projectPerpAccountMeta(envelope.meta):null;
    if(!meta){clearPerpAccountTimer();
      perpAccountReadFailure=rawMeta?.stale===true?'stale':'unavailable';return null}
    const projected=projectPerpAccountAdapterValue(method,envelope.value,canonicalRequest);
    if(!projected||(Number.isInteger(projected.freshness_ms)&&
       meta.age_ms<projected.freshness_ms)){
      clearPerpAccountTimer();perpAccountReadFailure='malformed';return null}
    perpAccountReadFailure='';schedulePerpAccountFreshness(meta.age_ms);
    return Object.freeze({ok:true,value:projected,meta});
  }catch(_error){clearPerpAccountTimer();perpAccountReadFailure='unavailable';return null}
}
function renderPerpAccount(){
  resetPerpAccountProjection('scr-perp-account');
  const result=perpAccountSnapshot('getMarginAccountSnapshot',{
    account_ref:PERP_ACCOUNT_REQUEST.account_ref
  });
  if(!result){setPerpAccountStatus('scr-perp-account',
    perpAccountUnavailableMessage('margin account'));return}
  const account=result.value;perpAccountViewState.contexts.account=account;
  setPerpAccountStatus('scr-perp-account',result.meta.label);
  const hero=document.querySelector('#scr-perp-account .perp-account-summary');
  if(hero){const label=document.createElement('span'),strong=document.createElement('strong'),
    small=document.createElement('small');label.textContent='Account equity';
    strong.textContent=formatPerpMoney(account.equity);
    small.textContent='Provider source · '+account.source_revision;
    hero.append(label,strong,small);hero.hidden=false}
  showPerpAccountFact('[data-perp-account-available]',formatPerpMoney(account.available_margin));
  showPerpAccountFact('[data-perp-account-used]',formatPerpMoney(account.used_margin));
  showPerpAccountFact('[data-perp-account-maintenance]',formatPerpMoney(account.maintenance_margin));
  showPerpAccountFact('[data-perp-account-ratio]',formatPerpDecimal(account.maintenance_margin_ratio)+'%');
  showPerpAccountFact('[data-perp-account-risk]',account.risk_level.replace('_',' '));
  showPerpAccountFact('[data-perp-account-freshness]',result.meta.age_ms+' ms');
  enablePerpAccountActions('scr-perp-account');
}
function renderPerpTransfer(){
  resetPerpAccountProjection('scr-perp-transfer');invalidatePerpAccountIntent();
  const result=perpAccountSnapshot('getTransferContext',{
    account_ref:PERP_ACCOUNT_REQUEST.account_ref,asset:PERP_ACCOUNT_REQUEST.asset
  });
  if(!result){setPerpAccountStatus('scr-perp-transfer',
    perpAccountUnavailableMessage('transfer context'));return}
  const context=result.value;perpAccountViewState.contexts.transfer=context;
  setPerpAccountStatus('scr-perp-transfer',result.meta.label);
  showPerpAccountFact('[data-perp-transfer-spot]',formatPerpMoney(context.spot_available));
  showPerpAccountFact('[data-perp-transfer-perp]',formatPerpMoney(context.perp_available));
  showPerpAccountFact('[data-perp-transfer-minimum]',context.minimum_amount+' '+context.asset);
  showPerpAccountFact('[data-perp-transfer-arrival]',context.arrival_label);
  enablePerpAccountActions('scr-perp-transfer');
}
function renderPerpDeposit(){
  resetPerpAccountProjection('scr-perp-deposit');invalidatePerpAccountIntent();
  const result=perpAccountSnapshot('getBridgeContext',{
    account_ref:PERP_ACCOUNT_REQUEST.account_ref,asset:PERP_ACCOUNT_REQUEST.asset,
    network:PERP_ACCOUNT_REQUEST.network
  });
  if(!result){setPerpAccountStatus('scr-perp-deposit',
    perpAccountUnavailableMessage('official bridge context'));return}
  const context=result.value;perpAccountViewState.contexts.bridge=context;
  setPerpAccountStatus('scr-perp-deposit',result.meta.label);
  showPerpAccountFact('[data-perp-bridge-network]','Arbitrum · '+context.asset);
  showPerpAccountFact('[data-perp-bridge-deposit-min]',context.deposit_minimum+' '+context.asset);
  showPerpAccountFact('[data-perp-bridge-withdraw-min]',context.withdraw_minimum+' '+context.asset);
  showPerpAccountFact('[data-perp-bridge-arrival]',context.arrival_label);
  enablePerpAccountActions('scr-perp-deposit');
}
function renderPerpFunding(){
  resetPerpAccountProjection('scr-perp-funding');
  const result=perpAccountSnapshot('getFundingSnapshot',{coin:PERP_ACCOUNT_REQUEST.coin});
  if(!result){setPerpAccountStatus('scr-perp-funding',
    perpAccountUnavailableMessage('funding history'));return}
  const funding=result.value;perpAccountViewState.contexts.funding=funding;
  setPerpAccountStatus('scr-perp-funding',result.meta.label);
  showPerpAccountFact('[data-perp-funding-current]',formatPerpDecimal(funding.current_rate)+' / 8h');
  showPerpAccountFact('[data-perp-funding-countdown]',
    Math.ceil(funding.next_settlement_in_ms/60000)+' min');
  const curve=document.getElementById('perp-funding-curve');
  if(curve){funding.history.slice().reverse().forEach(item=>{
    const bar=document.createElement('span');bar.style.setProperty('--funding-y',item.plot_y+'%');
    bar.setAttribute('aria-hidden','true');curve.append(bar);
  });curve.hidden=false}
  const history=document.getElementById('perp-funding-history');
  funding.history.forEach(item=>{
    const article=document.createElement('article');article.className='perp-funding-row card';
    article.setAttribute('data-perp-account-provider-fact','');
    const time=document.createElement('time'),rate=document.createElement('b'),payment=document.createElement('span');
    time.dateTime=new Date(item.settled_at_ms).toISOString();
    time.textContent=new Date(item.settled_at_ms).toLocaleString([],{
      month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    rate.textContent=formatPerpDecimal(item.rate)+' / 8h';
    payment.textContent=formatPerpMoney(item.payment);article.append(time,rate,payment);
    history?.append(article);
  });
  showPerpAccountFact('[data-perp-funding-freshness]',
    'Snapshot age '+result.meta.age_ms+' ms · '+funding.source_revision);
}
function renderPerpRiskNotice(){
  resetPerpAccountProjection('scr-perp-risk-notice');invalidatePerpAccountIntent();
  const result=perpAccountSnapshot('getRiskNotice',{
    account_ref:PERP_ACCOUNT_REQUEST.account_ref,notice_id:PERP_ACCOUNT_REQUEST.notice_id
  });
  if(!result){setPerpAccountStatus('scr-perp-risk-notice',
    perpAccountUnavailableMessage('risk notice'));return}
  const notice=result.value;perpAccountViewState.contexts.risk=notice;
  setPerpAccountStatus('scr-perp-risk-notice',result.meta.label);
  showPerpAccountFact('[data-perp-risk-title]',notice.title);
  const host=document.getElementById('perp-risk-sections');
  notice.sections.forEach(item=>{
    const article=document.createElement('article');article.className='perp-risk-section card';
    article.setAttribute('data-perp-account-provider-fact','');
    const heading=document.createElement('h3'),body=document.createElement('p');
    heading.textContent=item.heading;body.textContent=item.body;article.append(heading,body);
    host?.append(article);
  });
  if(notice.acknowledgement_required)enablePerpAccountActions('scr-perp-risk-notice');
  const ack=document.getElementById('perp-risk-ack'),review=document.getElementById('perp-risk-review');
  if(ack){ack.checked=false;ack.disabled=!notice.acknowledgement_required}
  if(review)review.disabled=true;
  if(!notice.acknowledgement_required)setPerpAccountActionStatus('scr-perp-risk-notice',
    'Provider confirms this account already completed the current risk acknowledgement.');
}
function renderPerpAccountScreen(screen){
  const accountScreens=['scr-perp-account','scr-perp-transfer','scr-perp-deposit',
    'scr-perp-funding','scr-perp-risk-notice'];
  const intentOrigins=['scr-perp-transfer','scr-perp-deposit','scr-perp-risk-notice'];
  if(!intentOrigins.includes(screen))invalidatePerpAccountIntent();
  if(!accountScreens.includes(screen)){clearPerpAccountTimer();return}
  if(screen==='scr-perp-account')renderPerpAccount();
  else if(screen==='scr-perp-transfer')renderPerpTransfer();
  else if(screen==='scr-perp-deposit')renderPerpDeposit();
  else if(screen==='scr-perp-funding')renderPerpFunding();
  else renderPerpRiskNotice();
}
function invalidatePerpAccountIntent(){
  perpAccountViewState.intent=null;perpAccountViewState.intentDeadlineMs=0;
  const ack=document.getElementById('perp-risk-ack'),review=document.getElementById('perp-risk-review');
  if(review&&ack)review.disabled=ack.disabled||!ack.checked;
}
function currentPerpAccountIntentForReview(){
  const intent=perpAccountViewState.intent;
  if(!intent||performance.now()>=perpAccountViewState.intentDeadlineMs){
    perpAccountViewState.intent=null;perpAccountViewState.intentDeadlineMs=0;return null;
  }
  return Object.freeze({...intent});
}
function preparePerpAccountDraft(kind){
  if(kind==='transfer'){
    const context=perpAccountViewState.contexts.transfer;
    const direction=document.getElementById('perp-transfer-direction')?.value||'';
    const amount=document.getElementById('perp-transfer-amount')?.value||'';
    const available=direction==='spot_to_perp'?context?.spot_available:
      direction==='perp_to_spot'?context?.perp_available:null;
    const amountUnits=perpUsdcUnits(amount,{positive:true});
    const minimumUnits=perpUsdcUnits(context?.minimum_amount,{positive:true});
    const availableUnits=perpUsdcUnits(available);
    if(!context||amountUnits===null||minimumUnits===null||availableUnits===null||
       amountUnits<minimumUnits||amountUnits>availableUnits)return null;
    return {kind:'usd_class_transfer',account_ref:context.account_ref,asset:context.asset,
      coin:null,network:'hyperliquid',direction,amount,notice_id:null,
      notice_revision:null,accepted:null,context_revision:context.source_revision};
  }
  if(kind==='bridge'){
    const context=perpAccountViewState.contexts.bridge;
    const operation=document.getElementById('perp-deposit-operation')?.value||'';
    const amount=document.getElementById('perp-deposit-amount')?.value||'';
    const minimum=operation==='deposit'?context?.deposit_minimum:
      operation==='withdraw'?context?.withdraw_minimum:null;
    const amountUnits=perpUsdcUnits(amount,{positive:true});
    const minimumUnits=perpUsdcUnits(minimum,{positive:true});
    if(!context||amountUnits===null||minimumUnits===null||amountUnits<minimumUnits)return null;
    return {kind:operation==='deposit'?'bridge_deposit':'bridge_withdraw',
      account_ref:context.account_ref,asset:context.asset,coin:null,network:context.network,
      direction:null,amount,
      notice_id:null,notice_revision:null,accepted:null,
      context_revision:context.source_revision};
  }
  const notice=perpAccountViewState.contexts.risk;
  const accepted=document.getElementById('perp-risk-ack')?.checked===true;
  return notice?.acknowledgement_required===true?
    {kind:'risk_acknowledgement',account_ref:notice.account_ref,asset:null,
    coin:null,network:null,direction:null,amount:null,notice_id:notice.notice_id,
    notice_revision:notice.revision,accepted,context_revision:notice.source_revision}:null;
}
function perpRiskAcknowledgementRequired(){
  const result=perpAccountSnapshot('getRiskNotice',{
    account_ref:PERP_ACCOUNT_REQUEST.account_ref,notice_id:PERP_ACCOUNT_REQUEST.notice_id
  });
  return result?result.value.acknowledgement_required:null;
}
function reviewPerpAccountAction(kind,trigger){
  const screen=kind==='transfer'?'scr-perp-transfer':kind==='bridge'?
    'scr-perp-deposit':'scr-perp-risk-notice';
  const draft=preparePerpAccountDraft(kind);
  const prepared=draft?perpAccountSnapshot('prepareAccountIntent',draft):null;
  if(!prepared){invalidatePerpAccountIntent();
    setPerpAccountActionStatus(screen,'The account intent was invalid, changed, or stale. Request blocked.');
    trigger?.focus({preventScroll:true});return false}
  perpAccountViewState.intent=prepared.value;
  perpAccountViewState.intentDeadlineMs=performance.now()+
    Math.max(0,PERP_ACCOUNT_MAX_AGE_MS-prepared.meta.age_ms);
  const intent=currentPerpAccountIntentForReview();
  if(!intent){setPerpAccountActionStatus(screen,'The immutable account intent expired. Request blocked.');return false}
  let decision=null;
  try{
    const request=projectPerpAccountAdapterRequest('prepareMutationReview',intent);
    const raw=request&&perpAccountAdapter?.prepareMutationReview(request);
    decision=projectPerpAccountMutationDecision(raw,request);
  }catch(_error){decision=null}
  if(!decision){invalidatePerpAccountIntent();
    setPerpAccountActionStatus(screen,'The Hyperliquid policy decision was unavailable. Request blocked.');
    return false}
  setPerpAccountActionStatus(screen,decision.error.safe_message+
    ' Required rechecks: '+decision.error.rechecks.join(' · ')+'.');
  return false;
}
function openPerpAccount(){navigate(ROUTES['perp-account'].stack.slice())}
function openPerpTransfer(){navigate(ROUTES['perp-transfer'].stack.slice())}
function openPerpDeposit(){navigate(ROUTES['perp-deposit'].stack.slice())}
function openPerpFunding(){navigate(ROUTES['perp-funding'].stack.slice())}
function openPerpRiskNotice(){navigate(ROUTES['perp-risk-notice'].stack.slice())}


/* ---------- market list + sparklines ---------- */
let notificationFilter='all';
function platformElement(tag,className,text){
  const element=document.createElement(tag);
  if(className) element.className=className;
  if(text!==undefined) element.textContent=text;
  return element;
}
const PLATFORM_SEARCH_ROUTE_BY_KIND=Object.freeze({token:'token',contract:'token',
  group:'chat',user:'profile',perp:'market'});
function resolvePlatformSearchRoute(item){
  try{
    if(!item||typeof item!=='object'||Array.isArray(item)||!Object.isFrozen(item)||
       Object.getPrototypeOf(item)!==Object.prototype)return '';
    const descriptors=Object.getOwnPropertyDescriptors(item);
    const keys=Reflect.ownKeys(descriptors);
    const expected=['id','authority','kind','title','subtitle','route'];
    if(keys.length!==expected.length||expected.some(key=>
      !descriptors[key]||!Object.prototype.hasOwnProperty.call(descriptors[key],'value')))return '';
    const kind=descriptors.kind.value,target=PLATFORM_SEARCH_ROUTE_BY_KIND[kind];
    if(!target||descriptors.route.value!=='#'+target||!ROUTES[target]||
       ROUTES[target].account||ROUTES[target].sensitive)return '';
    const canonical=strictHashRoute(target);
    if(canonical.target!==target||canonical.canonical!==target||
       guardAccountRoute(target)!==target)return '';
    return target;
  }catch(_error){return ''}
}
function openPlatformRoute(candidate){
  const target=typeof candidate==='string'&&
    ['search','notifications','privacy','security'].includes(candidate)?candidate:
    resolvePlatformSearchRoute(candidate);
  if(!target||!ROUTES[target]||ROUTES[target].account||ROUTES[target].sensitive)return false;
  const guarded=guardAccountRoute(target);
  if(guarded!==target)return false;
  navigate(ROUTES[target].stack.slice());return true;
}
async function renderNotifications(){
  const list=document.getElementById('notifications-list');
  const status=document.getElementById('notifications-status');
  if(!list||!status)return;
  status.textContent='Loading bounded provider projections…';list.replaceChildren();
  try{
    const response=await PLATFORM_ADAPTER.notifications({limit:20});
    if(activeScr()!=='scr-notifications')return;
    const items=response.items.filter(item=>notificationFilter==='all'||
      item.category===notificationFilter);
    status.textContent=items.length
      ?`${items.length} fixture events · durable read sync PENDING`
      :'No fixture events in this category.';
    items.forEach(item=>{
      const article=platformElement('article','platform-row');
      const head=platformElement('div','platform-row-head');
      head.append(platformElement('span',`platform-kind kind-${item.category}`,item.category),
        platformElement('time','',item.occurred_at.slice(11,16)));
      article.append(head,platformElement('h2','',item.title),
        platformElement('p','',item.detail),
        platformElement('small','',`${item.authority} official-event fixture · ${item.read?'read projection':'unread projection'}`));
      list.append(article);
    });
  }catch(_error){status.textContent='Provider notification projection unavailable.'}
}
async function submitPlatformSearch(){
  const input=document.getElementById('platform-search-input');
  const status=document.getElementById('platform-search-status');
  const list=document.getElementById('platform-search-results');
  const query=input.value.trim();
  list.replaceChildren();
  if(!query){status.textContent='Enter a query.';input.focus();return}
  status.textContent='Searching up to 4 injected providers…';
  try{
    const response=await PLATFORM_ADAPTER.search({query});
    if(activeScr()!=='scr-search')return;
    status.textContent=response.results.length
      ?`${response.results.length} offline fixture results · no LOOP index`
      :'No provider fixture results.';
    response.results.forEach(item=>{
      const button=platformElement('button','platform-row platform-result');
      button.type='button';
      button.append(platformElement('span','platform-kind',item.kind),
        platformElement('h2','',item.title),platformElement('p','',item.subtitle),
        platformElement('small','',`${item.authority} projection`));
      button.addEventListener('click',()=>openPlatformRoute(item));
      list.append(button);
    });
  }catch(_error){status.textContent='Search provider projection unavailable.'}
}
async function renderSecurityFacts(){
  const capabilities=document.getElementById('privy-security-capabilities');
  const list=document.getElementById('security-facts');
  const status=document.getElementById('security-facts-status');
  if(!capabilities||!list||!status)return;
  capabilities.replaceChildren();list.replaceChildren();
  status.textContent='Loading Privy security capabilities and secondary facts…';
  try{
    const [privy,response]=await Promise.all([
      PLATFORM_ADAPTER.privySecurity(),PLATFORM_ADAPTER.securityFacts()
    ]);
    if(activeScr()!=='scr-security')return;
    status.textContent=`Privy: ${privy.capabilities.length} capability states · ${response.facts.length} secondary facts`;
    privy.capabilities.forEach(item=>{
      const row=platformElement('div','set-row');
      const copy=platformElement('div');
      copy.append(platformElement('p','sr-t',item.label),platformElement('p','sr-s',item.detail));
      row.append(copy,platformElement('span',item.state==='PENDING'?
        'risk-pill risk-med':'chip',item.state));capabilities.append(row);
    });
    response.facts.forEach(item=>{
      const article=platformElement('article','platform-row');
      const head=platformElement('div','platform-row-head');
      head.append(platformElement('span',`platform-kind severity-${item.severity}`,item.authority),
        platformElement('time','',item.observed_at.slice(11,16)));
      article.append(head,platformElement('h2','',item.label),
        platformElement('p','',item.value));list.append(article);
    });
  }catch(_error){status.textContent='Privy security authority unavailable · H5 fails closed.'}
}
async function requestPrivacy(kind){
  const status=document.getElementById('privacy-operation-status');
  const policy=regionalOperationDecision({capability:'privacy_mutation',
    operation:`privacy_${kind}`,stage:'provider_mutation'});
  if(!policy.allowed){
    status.textContent=`Blocked · ${policy.reason}`;applyRegionalCapabilityGates();return;
  }
  status.textContent='Checking provider/server capability…';
  try{
    const response=await PLATFORM_ADAPTER.requestPrivacyOperation({kind});
    if(activeScr()!=='scr-privacy')return;
    status.textContent=`${response.status} · ${kind} was not submitted; no mutation occurred.`;
  }catch(_error){status.textContent='PENDING · provider/server capability unavailable.'}
}
function renderPlatformScreen(screen){
  if(screen==='scr-notifications')renderNotifications();
  if(screen==='scr-search')submitPlatformSearch();
  if(screen==='scr-security')renderSecurityFacts();
}
function rng(seed){let s=seed*9301+49297;return()=>{s=(s*1664525+1013904223)>>>0;return s/2**32}}
function series(seed,drift,n){const r=rng(seed);let v=50,out=[];for(let i=0;i<n;i++){v=Math.max(8,v+(r()-drift)*-9);out.push(v)}return out}
function sparkSVG(t){
  const d=series(t.seed,t.drift,24),min=Math.min(...d),max=Math.max(...d);
  const pts=d.map((v,i)=>`${(i/(d.length-1)*64).toFixed(1)},${(24-((v-min)/(max-min+.001))*22).toFixed(1)}`).join(' ');
  const c=t.up?'var(--mint)':'var(--red)';
  return `<svg class="spark" viewBox="0 0 64 26"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function buildMarket(){
  document.getElementById('mkt-list').innerHTML = MKT.map(k=>{const t=TOKENS[k];return `
  <div class="tok-row" onclick="openToken('${k}')">
    <div class="tok-logo" style="background:${t.grad}">${t.logo}</div>
    <div><p class="tok-name">${t.name}</p><p class="tok-sub"><span class="mono">${t.sym}</span> · ${t.chain} · <span class="risk-pill ${t.pill[0]}" style="padding:1px 7px;font-size:9px">${t.pill[1]}</span></p></div>
    ${sparkSVG(t)}
    <div class="tok-price"><p class="p">${t.price}</p><p class="c ${t.up?'up':'dn'}">${t.chg.split(' · ')[0]}</p></div>
  </div>`}).join('');
}

/* ---------- token detail ---------- */
let curTok='GLYPH';
function fillToken(k){
  curTok=k; const t=TOKENS[k];
  tkset('tk-name',t.name); tkset('tk-sym',t.sym); tkset('tk-price',t.price);
  tkset('tk-chain',t.chain); tkset('tk-liq',t.liq); tkset('tk-hold',t.hold); tkset('tk-vol',t.vol);
  tkset('tk-comm-n',t.comm[0]); tkset('tk-groups',t.comm[1]); tkset('tk-ch',t.comm[2]); tkset('tk-kol',t.comm[3]);
  const chg=document.getElementById('tk-chg'); chg.textContent=t.chg; chg.className='tk-chg '+(t.up?'up':'dn');
  const lg=document.getElementById('tk-logo'); lg.textContent=t.logo; lg.style.background=t.grad;
  const rp=document.getElementById('tk-riskpill'); rp.className='risk-pill '+t.pill[0]; rp.style.marginLeft='auto'; rp.textContent=t.pill[1];
  /* The badge counts findings instead of assigning an opaque numeric score. */
  const flags=t.sec.filter(([i])=>i!=='🟢').length;
  const crit=t.sec.filter(([i])=>i==='🔴').length;
  const fc=document.getElementById('tk-factcount');
  fc.textContent = flags ? `${flags} to review` : 'nothing flagged';
  fc.className = 'risk-pill ' + (crit ? 'risk-high' : flags ? 'risk-med' : 'risk-low');
  document.getElementById('tk-sec').innerHTML=t.sec.map(([i,s])=>`<div class="sec-item"><span>${i}</span><span><b>${s}</b></span></div>`).join('');
}
function openToken(k){
  fillToken(k);
  push('scr-token');
  requestAnimationFrame(()=>drawChart());
}
function tkset(id,v){document.getElementById(id).textContent=v}
function toggleWatch(b){const on=b.textContent.includes('★');b.textContent=on?'☆ Watch':'★ Watching';toast(on?'Removed from watchlist':TOKENS[curTok].sym+' added to watchlist')}

/* candles */
function drawChart(){
  const cv=document.getElementById('chart'); const t=TOKENS[curTok];
  const w=cv.clientWidth, h=190, dpr=window.devicePixelRatio||1;
  cv.width=w*dpr; cv.height=h*dpr;
  const x=cv.getContext('2d'); x.scale(dpr,dpr); x.clearRect(0,0,w,h);
  const r=rng(t.seed*13+1); let p=50; const cd=[];
  for(let i=0;i<36;i++){const o=p,c2=Math.max(6,o+(r()-t.drift)*-11);cd.push({o,c:c2,hi:Math.max(o,c2)+r()*3,lo:Math.min(o,c2)-r()*3});p=c2}
  const all=cd.flatMap(c=>[c.hi,c.lo]),mn=Math.min(...all),mx=Math.max(...all);
  const Y=v=>10+(1-(v-mn)/(mx-mn))*(h-30);
  x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;
  for(let g=0;g<4;g++){const gy=10+g*(h-30)/3;x.beginPath();x.moveTo(0,gy);x.lineTo(w,gy);x.stroke()}
  const bw=w/36;
  cd.forEach((c,i)=>{
    const cx=i*bw+bw/2, up=c.c>=c.o, col=up?'#3df0ae':'#ff5c7a';
    x.strokeStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(cx,Y(c.hi));x.lineTo(cx,Y(c.lo));x.stroke();
    x.fillStyle=col; const y1=Y(Math.max(c.o,c.c)), y2=Y(Math.min(c.o,c.c));
    x.globalAlpha=up?1:.9; x.fillRect(cx-bw*.32,y1,bw*.64,Math.max(2,y2-y1)); x.globalAlpha=1;
  });
  const last=Y(cd[cd.length-1].c);
  x.setLineDash([3,4]);x.strokeStyle='rgba(233,238,244,.35)';x.beginPath();x.moveTo(0,last);x.lineTo(w,last);x.stroke();x.setLineDash([]);
}
document.querySelectorAll('.tf').forEach(f=>f.onclick=()=>{document.querySelectorAll('.tf').forEach(x=>x.classList.remove('on'));f.classList.add('on');TOKENS[curTok].seed+=2;drawChart()});

/* ---------- flows ---------- */
function openGroup(){
  conversationMode='group';
  voicePanel.open=false;voicePanel.minimized=false;
  if(activeScr()==='scr-group'){render();syncHash(true);persist();return}
  navigate(['scr-chat','scr-group'], {replace:false});
}
function openDM(){
  conversationMode='dm';
  voicePanel.open=false;voicePanel.minimized=false;
  if(activeScr()==='scr-group'){render();syncHash(true);persist();return}
  navigate(['scr-chat','scr-group'], {replace:false});
}
function streamPreviewState(button,state){
  if(!button||!['preview','loading','empty','offline'].includes(state))return;
  document.querySelectorAll('[data-stream-list-state]').forEach(panel=>{
    const on=panel.dataset.streamListState===state;
    panel.hidden=!on;if(on)panel.removeAttribute('inert');else panel.setAttribute('inert','');
  });
  document.querySelectorAll('.stream-state-tab').forEach(tab=>{
    const on=tab===button;tab.classList.toggle('on',on);tab.setAttribute('aria-selected',String(on));
  });
}
function streamMutationPending(operation){
  const error=new Error('STREAM_CHAT_PROVIDER_MUTATION_PENDING');
  error.code='STREAM_CHAT_PROVIDER_MUTATION_PENDING';
  toast(`${operation} · Stream credentialed write audit PENDING`);
  return Object.freeze({ok:false,error:Object.freeze({code:error.code})});
}

/* ---------- Stream Video read-only projection preview ---------- */
function renderHomeAudioRoomProjection(providerProjection){
  const room=document.getElementById('home-audio-room');
  const title=document.getElementById('home-audio-title');
  const status=document.getElementById('home-audio-status');
  const action=document.getElementById('home-audio-preview');
  if(!room||!title||!status||!action)return false;
  let accepted=false;
  try{
    if(!providerProjection||typeof providerProjection!=='object'||
       Object.getPrototypeOf(providerProjection)!==Object.prototype)throw new Error('INVALID_STREAM_AUDIO_PROJECTION');
    const descriptors=Object.getOwnPropertyDescriptors(providerProjection);
    const expected=['authority','mode','connection','status','participant_count',
      'visible_participants','complete_roster_status'];
    const keys=Reflect.ownKeys(descriptors);
    if(keys.length!==expected.length||keys.some(key=>typeof key!=='string'||
       !expected.includes(key)||!Object.prototype.hasOwnProperty.call(descriptors[key],'value'))){
      throw new Error('INVALID_STREAM_AUDIO_PROJECTION');
    }
    const value=key=>descriptors[key].value;
    const visible_participants=value('visible_participants');
    if(value('authority')!=='stream_video_sdk_call_state'||value('mode')!=='offline_preview'||
       value('connection')!=='disconnected'||value('status')!=='unavailable'||
       value('participant_count')!==0||!Array.isArray(visible_participants)||
       visible_participants.length!==0||value('complete_roster_status')!=='PENDING'){
      throw new Error('UNVERIFIED_STREAM_AUDIO_PROJECTION');
    }
    accepted=true;
  }catch(_error){accepted=false}
  room.dataset.streamMode='offline_preview';
  room.dataset.streamConnection='disconnected';
  room.dataset.streamStatus='unavailable';
  room.dataset.streamParticipantCount='0';
  title.textContent='Voice room';
  status.textContent='Unavailable · Stream Video not connected · 0 participants';
  action.textContent='Open preview';
  if(!accepted)return false;
  return true;
}
function openVoiceRoom(){
  conversationMode='group';
  voicePanel.open=true;voicePanel.minimized=false;
  if(activeScr()!=='scr-group')navigate(['scr-chat','scr-group'],{replace:false});
  renderVoice(); syncHash(true); persist();
}
function toggleVoiceRoom(){
  if(!voicePanel.open)return;
  voicePanel.minimized=!voicePanel.minimized;
  renderVoice(); syncHash(true); persist();
}
function returnToVoiceRoom(){
  conversationMode='group';
  if(activeScr()!=='scr-group')navigate(['scr-chat','scr-group']);
  voicePanel.open=true;voicePanel.minimized=false;
  renderVoice(); syncHash(true); persist();
}
function joinVoiceRoom(){streamMutationPending('join_audio_room')}
function leaveVoiceRoom(){streamMutationPending('leave_audio_room')}
function toggleMute(){streamMutationPending('set_microphone_enabled')}
function toggleHand(){streamMutationPending('request_speaking_permission')}
function toggleSpeaker(){streamMutationPending('set_speaker_output')}

function renderVoice(){
  const card=document.getElementById('voiceRoomCard');
  if(!card) return;
  const phone=document.getElementById('phone');
  const visible=voicePanel.open&&conversationMode==='group';
  card.style.display=visible?'block':'none';
  card.classList.toggle('minimized',voicePanel.minimized);
  const tg=document.getElementById('vrToggleBtn');
  tg.textContent=voicePanel.minimized?'+':'−';
  tg.setAttribute('aria-expanded',String(!voicePanel.minimized));
  const tgl=(voicePanel.minimized?'Expand':'Minimize')+' voice room preview';
  tg.setAttribute('aria-label', tgl); tg.title=tgl;
  phone.classList.remove('in-call','voice-live');
  phone.classList.toggle('voice-preview',visible&&voicePanel.minimized);
}
function openSwap(){push('scr-swap')}
function openDapp(){push('scr-dapp')}
function openPay(){navigate(['scr-home','scr-pay'])}
function openSheet(id){
  document.getElementById('veil').classList.add('open');
  const s=document.getElementById(id); s.classList.add('open'); s.removeAttribute('inert'); s.removeAttribute('aria-hidden');
}
function openRiskSheet(){openSheet('sheet-risk')}
function openApproveSheet(){
  if(!walletSigningAllowed('dapp-approve')) return;
  openSheet('sheet-approve');
}
function closeSheets(){
  document.getElementById('veil').classList.remove('open');
  document.querySelectorAll('.sheet').forEach(s=>{s.classList.remove('open'); s.setAttribute('inert',''); s.setAttribute('aria-hidden','true')});
}
function chooseApprovalReview(button){
  const limited=document.getElementById('approval-limit');
  const unlimited=document.getElementById('approval-unlimited');
  const semantic=button===limited?'limited':button===unlimited?'unlimited':'';
  if(!semantic||!button.isConnected||
     !document.getElementById('sheet-approve').classList.contains('open'))return;
  const decision=walletSigningDecision(button);applySigningControlDecision(button,decision);
  const ids={privy_embedded:{limited:'review-approve-limited',
    unlimited:'review-approve-unlimited'},connected_external:{
    limited:'review-approve-external',
    unlimited:'review-approve-unlimited-external'}};
  const expected=decision.allowed?ids[decision.walletClass]?.[semantic]||'':'';
  if(!expected){
    const notice=document.getElementById('approval-review-notice');
    if(notice)notice.textContent='The active wallet authority could not select a safe review.';
    return;
  }
  closeSheets();
  if(!openWalletReview(expected,button)){
    const notice=document.getElementById('approval-review-notice');
    if(notice)notice.textContent='The wallet request could not be reviewed safely.';
  }
}

function doSwap(btn){
  const control=document.getElementById('swap-submit');
  const pay=document.getElementById('pay-amt');
  const receive=document.getElementById('receive-amt');
  const payToken=document.getElementById('pay-token');
  const receiveToken=document.getElementById('receive-token');
  const exactScreen=pay?.tagName==='INPUT'&&pay.readOnly===true&&
    pay.getAttribute('value')==='500'&&pay.value==='500'&&pay.inputMode==='decimal'&&
    receive?.tagName==='INPUT'&&receive.readOnly===true&&
    receive.getAttribute('value')==='216,450'&&receive.value==='216,450'&&
    payToken?.dataset.assetId==='USDC'&&payToken.textContent.trim().endsWith('USDC ▾')&&
    receiveToken?.dataset.assetId==='GLYPH'&&
    receiveToken.textContent.trim().endsWith('GLYPH ▾');
  if(!control||btn!==control||control.tagName!=='BUTTON'||
     !control.isConnected||control.textContent.trim()!=='Review swap'||!exactScreen||
     !walletSigningAllowed('swap-submit')){
    const note=document.getElementById('swap-review-note');
    if(note)note.textContent='The fixed simulated Privy quote no longer matches this Swap screen.';
    return;
  }
  if(!openWalletReview('review-swap-fresh',control)){
    const note=document.getElementById('swap-review-note');
    if(note)note.textContent='The simulated Privy quote could not be reviewed safely.';
  }
}
/* alias */
const ALIASES=['Voyager_7','Nomad_42','Cipher_9','Drift_88','Umbra_3','Halcyon_5'];
let ai=0;
function shuffleAlias(){ai=(ai+1)%ALIASES.length;const a=ALIASES[ai];
  ['alias-home','alias-chat','alias-pf'].forEach(id=>document.getElementById(id).textContent=a);
  toast('New anonymous identity: '+a)}

/* toast */
let toastT;
function toast(msg){const t=document.getElementById('toast');t.textContent=String(msg);t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2600)}

/* ---------- global provider/system states ---------- */
const GLOBAL_BLOCKING_IDS=['global-server-error','global-region-restriction','force-update-dialog'];
function reviewOperation(reviewId){
  if(typeof reviewId!=='string')return 'unknown_review';
  if(reviewId.startsWith('review-transfer'))return 'transfer';
  if(reviewId.startsWith('review-swap'))return 'swap';
  if(reviewId.startsWith('review-approve'))return 'approval';
  if(reviewId.startsWith('review-perp'))return 'perp_order';
  return 'unknown_review';
}
function regionalControlOperation(control){
  if(control?.dataset?.privacyOperation)return `privacy_${control.dataset.privacyOperation}`;
  if(control?.id==='review-continue')return reviewRuntime.policyOperation||
    reviewOperation(reviewRuntime.openId);
  return typeof control?.id==='string'&&control.id?`control_${control.id}`:'unknown_operation';
}
function latchRegionalBlock(decision){
  if(decision?.state!=='blocked'||decision.verified!==true)return;
  regionalBlockedLatch=true;
  regionalSessionAuthority.persistBlocked();
}
function refreshRegionalBlockedSessionLatch(){
  const storage=regionalSessionAuthority.recheck();
  if(storage.blockedObserved)regionalBlockedLatch=true;
  return Object.freeze({latched:regionalBlockedLatch,storage});
}
function regionalStorageUnavailableDecision(){
  return Object.freeze({allowed:false,state:'unknown',revision:0,policy_id:'',
    verified:false,source:'regional_storage_unavailable',
    reason:'Regional eligibility cannot be verified because session persistence is unavailable.'});
}
function regionalLatchedDecision(decision,storage=regionalSessionAuthority.snapshot()){
  latchRegionalBlock(decision);
  if(storage.blockedObserved)regionalBlockedLatch=true;
  if(regionalBlockedLatch){
    return Object.freeze({allowed:false,state:'blocked',revision:decision?.revision||0,
      policy_id:decision?.policy_id||'',verified:true,source:'session_blocked_latch',
      reason:'Regional policy blocked this session. Reload and history cannot restore restricted actions.'});
  }
  if(!storage.trusted)return regionalStorageUnavailableDecision();
  return decision;
}
function regionalOperationDecision({capability,operation,stage}){
  try{
    const persistence=refreshRegionalBlockedSessionLatch();
    if(persistence.latched)return regionalLatchedDecision(
      REGIONAL_POLICY.decision({capability}),persistence.storage);
    if(!persistence.storage.trusted)return regionalStorageUnavailableDecision();
    const decision=REGIONAL_POLICY.recheck({capability,operation,stage});
    if(!decision||!Object.isFrozen(decision)||typeof decision.allowed!=='boolean'||
       typeof decision.reason!=='string'||typeof decision.state!=='string'||
       typeof decision.verified!=='boolean')throw new TypeError('regional decision');
    return regionalLatchedDecision(decision,persistence.storage);
  }catch(_error){
    return regionalLatchedDecision(Object.freeze({allowed:false,state:'unknown',revision:0,
      policy_id:'',verified:false,source:'regional_policy_unavailable',
      reason:'Regional eligibility is unavailable.'}));
  }
}
function regionalCapabilityDecision(control,{recheck=false}={}){
  try{
    const capability=control?.hasAttribute('data-requires-signing')?
      'wallet_mutation':control?.dataset?.providerMutation||'';
    const decision=recheck?regionalOperationDecision({capability,
      operation:regionalControlOperation(control),stage:'entry_gate'}):
      regionalLatchedDecision(REGIONAL_POLICY.decision({capability}));
    if(!decision||!Object.isFrozen(decision)||typeof decision.allowed!=='boolean'||
       typeof decision.reason!=='string'||typeof decision.state!=='string'||
       typeof decision.verified!=='boolean'){
      return Object.freeze({allowed:false,state:'unknown',
        reason:'Regional eligibility is unavailable.'});
    }
    return decision;
  }catch(_error){
    return Object.freeze({allowed:false,state:'unknown',
      reason:'Regional eligibility is unavailable.'});
  }
}
function applyRegionalControlDecision(control,decision){
  control.setAttribute('data-regional-policy-control',
    control.hasAttribute('data-requires-signing')?
      'wallet_mutation':control.dataset.providerMutation||'unknown');
  if(decision.allowed){
    if(control.getAttribute('aria-describedby')==='regional-policy-explanation'){
      control.removeAttribute('aria-describedby');control.removeAttribute('aria-disabled');
      if(control.hasAttribute('data-provider-mutation'))control.disabled=false;
      else applySigningControlDecision(control,walletSigningDecision(control));
    }
    return;
  }
  control.disabled=true;control.setAttribute('aria-disabled','true');
  control.setAttribute('aria-describedby','regional-policy-explanation');
}
function applyRegionalCapabilityGates(){
  const controls=[...document.querySelectorAll(
    '[data-requires-signing],[data-provider-mutation]')];
  let blocked=false;
  controls.forEach(control=>{
    const decision=regionalCapabilityDecision(control);blocked=blocked||!decision.allowed;
    applyRegionalControlDecision(control,decision);
  });
  const explanation=document.getElementById('regional-policy-explanation');
  if(explanation){
    const snapshot=REGIONAL_POLICY.snapshot();
    explanation.textContent=blocked?
      `Regional policy (${snapshot.state}) prevents restricted actions.`:'';
    explanation.hidden=!blocked;
  }
}
function clearSystemQuery(){
  const url=new URL(location.href);url.searchParams.delete('system');
  history.replaceState(history.state,'',url.pathname+url.search+url.hash);
}
function hideGlobalSystemStates(){
  document.getElementById('global-offline-banner').hidden=true;
  GLOBAL_BLOCKING_IDS.forEach(id=>{
    const surface=document.getElementById(id);surface.hidden=true;
    surface.setAttribute('inert','');surface.setAttribute('aria-hidden','true');
  });
  const viewport=document.getElementById('viewport-shell');
  viewport.removeAttribute('inert');viewport.removeAttribute('aria-hidden');
}
function recoverGlobalSystemState({home=false,preserveRestriction=false}={}){
  if(!preserveRestriction)clearSystemQuery();
  hideGlobalSystemStates();
  if(preserveRestriction)document.getElementById('phone').dataset.regionalRestriction='active';
  if(home&&activeScr()!=='scr-home')navigate(ROUTES.home.stack.slice(),{replace:true});
  focusActiveScreen();
}
function activateOfflineReadOnlyPreview(){
  const status=document.getElementById('global-offline-preview-status');
  if(PLATFORM_RUNTIME!=='offline_fixture'||
     typeof REGIONAL_POLICY.activateReadOnlyPreview!=='function'){
    if(status)status.textContent='Read-only preview is unavailable in this runtime.';
    return false;
  }
  const snapshot=REGIONAL_POLICY.activateReadOnlyPreview();
  applyRegionalCapabilityGates();
  if(status)status.textContent=snapshot.state==='eligible_readonly'?
    'Read-only eligibility preview enabled. Signing and provider mutations remain blocked.':
    'Read-only preview remains unavailable.';
  return snapshot.state==='eligible_readonly';
}
function showBlockingGlobalState(id){
  hideGlobalSystemStates();
  const viewport=document.getElementById('viewport-shell');
  viewport.setAttribute('inert','');viewport.setAttribute('aria-hidden','true');
  const surface=document.getElementById(id);surface.hidden=false;
  surface.removeAttribute('inert');surface.setAttribute('aria-hidden','false');surface.focus();
}
function setupGlobalSystemState(){
  const state=new URLSearchParams(location.search).get('system');
  document.getElementById('phone').dataset.platformRuntime=PLATFORM_RUNTIME;
  hideGlobalSystemStates();
  if(state==='offline'){
    const banner=document.getElementById('global-offline-banner');banner.hidden=false;
    document.getElementById('global-offline-retry').focus();
  }else if(state==='server-error')showBlockingGlobalState('global-server-error');
  else if(state==='regional'){
    document.getElementById('phone').dataset.regionalRestriction='active';
    showBlockingGlobalState('global-region-restriction');
  }
  else if(state==='force-update')showBlockingGlobalState('force-update-dialog');
  applyRegionalCapabilityGates();
}
function handleGlobalSystemKeys(event){
  const surface=GLOBAL_BLOCKING_IDS.map(id=>document.getElementById(id)).find(item=>!item.hidden);
  if(!surface)return;
  if(event.key==='Escape'){event.preventDefault();return}
  if(event.key!=='Tab')return;
  const controls=[...surface.querySelectorAll('button:not(:disabled)')];
  if(!controls.length){event.preventDefault();surface.focus();return}
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}

/* ---------- guided demos (desktop aside) ---------- */
function demoTokenCard(){openGroup();toast('Tickers in chat become live, executable cards')}
function demoSecurity(){goTab('market');setTimeout(()=>{openToken('GLYPH');toast('AI security is a layer, not a tab — it follows the token')},350)}
function demoApproval(){goTab('wallet');setTimeout(()=>{openDapp();setTimeout(()=>{openApproveSheet();toast('Choose an allowance to review in the shared wallet flow')},700)},350)}
function demoBuy(){openGroup();toast('Tap Buy on the $GLYPH card → swap → wallet')}

/* ---------- phone scaling ---------- */
function fit(){
  const ph=document.getElementById('phone');
  if(window.innerWidth<=640){ph.style.transform='';return}
  const s=Math.min(1,(window.innerHeight-48)/880);
  ph.style.transform=`scale(${s})`;
}
window.addEventListener('resize',fit);

/* ---------- routing: hash → state (deep links from the plan page) ---------- */
function route({silent=false}={}){
  consumeReviewForNavigation();
  const parsed=strictHashRoute();
  const h=parsed.target;
  let target = h ? (ROUTES[h] ? h : 'home') : (onboardingFlag('complete')?'home':'splash');
  if(!h&&!onboardingFlag('complete')) resetAccountState();
  target=guardAccountRoute(target);
  if((target==='asset'||target==='receive')&&parsed.params){
    walletRouteParams={...parsed.params};
  }
  if(target==='dm')conversationMode='dm';
  else if(target==='group'||target==='voiceroom')conversationMode='group';
  if(target==='token') fillToken('GLYPH');
  closeSheets();
  navigate(ROUTES[target].stack.slice(), {replace:true});
  if(target==='token') requestAnimationFrame(drawChart);
  if(target==='voiceroom') openVoiceRoom();
  /* the #dapp deep link exists to show the approval firewall — keep that on hand-entered hashes,
     but never re-fire it while the user is traversing browser history */
  if(target==='dapp' && !silent) setTimeout(openApproveSheet,900);
}
function expectedHash(){
  let h = SCREEN_HASH[activeScr()] || 'home';
  if(h==='asset'||h==='receive') h=canonicalWalletHash(h);
  if(activeScr()==='scr-group')h=voicePanel.open?'voiceroom':
    (conversationMode==='dm'?'dm':'group');
  return h;
}
/* an externally edited hash (address bar) re-enters through here */
window.addEventListener('hashchange',()=>{
  if((location.hash||'').slice(1)!==expectedHash()) route();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&activeScr()==='scr-seed-show') resetSeedShow();
});
window.addEventListener('pagehide',event=>{
  clearSensitiveAccountState();
  invalidatePerpAccountIntent();
  clearPerpAccountTimer();
  if(!event.persisted){
    accountHistoryProof.clear();
    reviewMarkerProof.clear();
  }
});
window.addEventListener('unload',()=>{
  accountHistoryProof.clear();
  reviewMarkerProof.clear();
});
window.addEventListener('pageshow',event=>{
  if(!event.persisted) return;
  refreshRegionalBlockedSessionLatch();
  voicePanel.open=false;voicePanel.minimized=false;
  renderVoice();
  renderPerpAccountScreen(activeScr());
  setupAccountScreen(activeScr());
  focusActiveScreen();
  restoreReviewFromCurrentEntry();
  applyRegionalCapabilityGates();
});

/* ---------- session restore ---------- */
function restore(){
  let s=null;
  try{s=JSON.parse(sessionStorage.getItem(SS_KEY)||'null')}catch(e){}
  const restored=navigationStorageProjection.restore(s);
  if(!restored) return false;
  const restoredStack=guardAccountStack(restored.stack);
  const parsed=strictHashRoute();
  const h=parsed.target;
  const expect = SCREEN_HASH[restoredStack[restoredStack.length-1]] || 'home';
  /* only restore when the URL still points at the same place we left */
  if(h!==expect && !((h==='voiceroom'||h==='dm') &&
     restoredStack[restoredStack.length-1]==='scr-group')) return false;
  if((h==='asset'||h==='receive')&&parsed.params){
    walletRouteParams={...parsed.params};
  }
  conversationMode=h==='dm'?'dm':'group';
  voicePanel.open=h==='voiceroom';voicePanel.minimized=false;
  if(restoredStack[restoredStack.length-1]==='scr-token') fillToken(curTok);
  navigate(restoredStack, {replace:true});
  if(restoredStack[restoredStack.length-1]==='scr-token') requestAnimationFrame(drawChart);
  if(voicePanel.open)document.getElementById('voiceRoomCard').style.display='block';
  renderVoice();
  return true;
}

buildMarket(); fit();
document.getElementById('splash-retry').addEventListener('click',retrySplashMaintenance);
document.getElementById('splash-reset').addEventListener('click',resetSplashDemo);
document.querySelectorAll('[data-auth-method]').forEach(button=>button.addEventListener('click',chooseAuthMethod));
document.getElementById('otp-form').addEventListener('submit',verifyOtp);
document.getElementById('otp-resend').addEventListener('click',resendOtp);
otpInputs().forEach(input=>{
  input.addEventListener('input',handleOtpInput);
  input.addEventListener('keydown',handleOtpKeydown);
  input.addEventListener('paste',handleOtpPaste);
  input.addEventListener('compositionend',handleOtpCompositionEnd);
});
document.querySelectorAll('#wallet-detected-list input[type="radio"]')
  .forEach(option=>option.addEventListener('change',selectExternalWallet));
document.getElementById('wallet-connect').addEventListener('click',startExternalWalletConnection);
document.getElementById('wallet-sign-approve').addEventListener('click',approveExternalWallet);
document.getElementById('wallet-sign-reject').addEventListener('click',rejectExternalWallet);
document.getElementById('wallet-connect-retry').addEventListener('click',retryExternalWallet);
document.getElementById('wallet-create-start').addEventListener('click',()=>beginWalletCreation(false));
document.getElementById('wallet-create-fail-demo').addEventListener('click',()=>beginWalletCreation(true));
document.getElementById('wallet-create-retry').addEventListener('click',retryWalletCreation);
document.querySelectorAll('[data-backup-choice]').forEach(button=>button.addEventListener('click',chooseBackupMethod));
document.getElementById('backup-confirm-continue').addEventListener('click',confirmBackupMethod);
document.getElementById('backup-skip-confirm').addEventListener('click',confirmSkippedBackup);
document.getElementById('backup-confirm-cancel').addEventListener('click',cancelBackupConfirmation);
document.getElementById('seed-show-ack').addEventListener('change',updateSeedRevealGate);
document.getElementById('seed-show-reveal').addEventListener('click',revealPrototypeSeed);
document.getElementById('seed-show-recorded').addEventListener('change',updateSeedRecordedGate);
document.getElementById('seed-show-continue').addEventListener('click',continueSeedVerification);
['copy','cut','contextmenu'].forEach(type=>
  document.getElementById('seed-phrase-panel').addEventListener(type,blockSeedPhraseAction));
document.getElementById('seed-verify-form').addEventListener('submit',verifySeedWords);
seedVerifyInputs().forEach(input=>input.addEventListener('input',handleSeedVerifyInput));
document.querySelectorAll('[name="wallet-import-mode"]')
  .forEach(option=>option.addEventListener('change',chooseImportMode));
document.getElementById('wallet-import-submit').addEventListener('click',submitWalletImport);
document.getElementById('veil').addEventListener('click',handleReviewVeil);
document.getElementById('review-preview-check').addEventListener('change',acknowledgeWalletReview);
document.getElementById('review-cancel').addEventListener('click',cancelWalletReview);
document.getElementById('review-continue').addEventListener('click',continueWalletReview);
document.getElementById('review-refresh').addEventListener('click',refreshWalletReview);
document.getElementById('review-dialog').addEventListener('keydown',handleReviewKeys);
document.querySelectorAll('[data-notification-filter]').forEach(button=>button.addEventListener('click',()=>{
  notificationFilter=button.dataset.notificationFilter;
  document.querySelectorAll('[data-notification-filter]').forEach(item=>
    item.classList.toggle('on',item===button));renderNotifications();
}));
document.getElementById('platform-search-form').addEventListener('submit',event=>{
  event.preventDefault();submitPlatformSearch();
});
document.querySelectorAll('[data-privacy-operation]').forEach(button=>
  button.addEventListener('click',()=>requestPrivacy(button.dataset.privacyOperation)));
document.getElementById('global-offline-retry').addEventListener('click',()=>recoverGlobalSystemState());
document.getElementById('global-offline-preview').addEventListener('click',activateOfflineReadOnlyPreview);
document.getElementById('global-server-retry').addEventListener('click',()=>recoverGlobalSystemState());
document.getElementById('global-region-home').addEventListener('click',()=>
  recoverGlobalSystemState({home:true,preserveRestriction:true}));
document.addEventListener('keydown',handleGlobalSystemKeys);
document.addEventListener('click',event=>{
  const mutationControl=event.target.closest?.(
    '[data-requires-signing],[data-provider-mutation]');
  if(!mutationControl)return;
  const regional=regionalCapabilityDecision(mutationControl,{recheck:true});
  applyRegionalControlDecision(mutationControl,regional);
  if(!regional.allowed){
    event.preventDefault();event.stopImmediatePropagation();
    const explanation=document.getElementById('regional-policy-explanation');
    if(explanation){explanation.textContent=regional.reason;explanation.hidden=false}
    return;
  }
  const signingControl=mutationControl.closest?.('[data-requires-signing]');
  if(!signingControl)return;
  const decision=walletSigningDecision(signingControl);
  applySigningControlDecision(signingControl,decision);
  if(decision.allowed) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const explanation=document.getElementById('watch-only-explanation');
  if(explanation&&decision.reason!=='bridge'){
    explanation.textContent=decision.reason;
    explanation.hidden=false;
  }
},{capture:true});
renderHomeAudioRoomProjection({authority:'stream_video_sdk_call_state',mode:'offline_preview',
  connection:'disconnected',status:'unavailable',participant_count:0,
  visible_participants:[],complete_roster_status:'PENDING'});
if(!restore()) route();
setupGlobalSystemState();
