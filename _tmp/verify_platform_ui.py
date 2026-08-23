#!/usr/bin/env python3
"""Focused contract for the first non-wallet platform/UI slice."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

from playwright.sync_api import sync_playwright
from platform_policy_test_app import production_policy_test_app


ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
APP = ROOT / "app.html"
SCREENS = [
    "splash", "auth", "auth-otp", "auth-wallet", "wallet-create",
    "wallet-backup", "seed-show", "seed-verify", "wallet-import",
    "home", "pay", "notifications", "search", "market",
    "perp-markets", "perp-market", "perp-order", "perp-confirm",
    "perp-positions", "perp-orders", "perp-position", "perp-account",
    "perp-transfer", "perp-deposit", "perp-funding", "perp-risk-notice", "token",
    "launchpad", "chat", "group", "wallet", "asset", "send", "send-to",
    "send-confirm", "receive", "tx-result", "swap", "dapp", "profile",
    "privacy", "security",
]
SCRIPTS = [
    "vendor/qrcode-generator-1.4.4.js", "wallet-provider.js",
    "wallet-review.js", "wallet-transfer.js", "stream-chat-provider.js",
    "platform-provider.js",
    "platform-offline-fixture.js", "perp-read-provider.js",
    "perp-offline-fixture.js", "perp-account-provider.js",
    "perp-account-offline-fixture.js", "app.js",
]
ROUTES = {
    "notifications": "B3", "search": "B4", "privacy": "H3",
    "security": "H5",
}
fails = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        fails.append(message)


def read(relative):
    path = ROOT / relative
    return path.read_text() if path.is_file() else ""


def lines(relative):
    return [line.strip() for line in read(relative).splitlines() if line.strip()]


print("== RED/GREEN source contract ==")
check(lines("src/screens-order.txt") == SCREENS,
      "exact canonical 42-screen routed manifest")
check(lines("src/scripts-order.txt") == SCRIPTS,
      "exact twelve-script Stream/platform/Perp provider/fixture/app order")
check("exact pinned 42-screen order" in read("build.py") and
      "exact pinned twelve-script order" in read("build.py"),
      "builder pins the expanded exact manifests")

for route, inventory_id in ROUTES.items():
    fragment = read(f"src/screens/{route}.html")
    check(len(re.findall(r'<section\b[^>]*\bclass="[^"]*\bscr\b', fragment)) == 1 and
          f'id="scr-{route}"' in fragment,
          f"{inventory_id} {route} owns one routed screen")
    check(len(re.findall(r"<h1\b", fragment)) == 1 and
          "data-route-focus" in fragment and "onclick=\"back()\"" in fragment,
          f"{inventory_id} {route} has one route heading and safe back")
check(all(f'data-notification-filter="{kind}"' in read("src/screens/notifications.html")
          for kind in ("all", "transaction", "community", "security", "system")),
      "B3 exposes all canonical notification groups")
check(all(copy in read("src/screens/search.html") for copy in
          ("Recent searches", "Trending searches", "no local or durable history store")),
      "B4 history/trending states are explicit without a LOOP store")
check(all(copy in read("src/screens/security.html") +
          read("src/platform-offline-fixture.js") for copy in
          ("MFA", "App lock", "Devices &amp; sessions", "Recovery", "Login history")),
      "H5 covers the canonical account-protection rows")

provider = read("src/platform-provider.js")
fixture = read("src/platform-offline-fixture.js")
app = read("src/app.js")
shell = read("src/shell-close.html")
style = read("src/style.css")
catalog = json.loads(read("contracts/integration-catalog/catalog.json") or "{}")
inventory = json.loads(read("contracts/integration-catalog/screen-inventory.json") or "{}")
all_platform = "\n".join((provider, fixture, app, shell,
                           *(read(f"src/screens/{name}.html") for name in ROUTES)))
for token in ("notification_inbox", "federated_search_indexing",
              "provider_event_ingestion", "whole_app_core_selection_pending"):
    check(token in provider or token in fixture, f"catalog selection gate is explicit: {token}")
check(all(authority in provider for authority in
          ("firebase", "stream", "hyperliquid", "privy")),
      "notification projection allowlists the four official event authorities")
check("MAX_QUERY_LENGTH" in provider and "MAX_SOURCES" in provider and
      "MAX_RESULTS_PER_SOURCE" in provider,
      "search is bounded provider fan-out, not a LOOP index")
check("PENDING" in provider and "requestOperation" in provider,
      "privacy export/delete is an async provider/server request contract")
check("privySecurity" in provider and "securityFacts" in provider and
      "risk_score" not in provider,
      "H5 Privy authority is primary and B9 facts stay a separate secondary projection")
mapping = {item.get("screen_id"): item for item in catalog.get("screen_mappings", [])}
screen = {item.get("id"): item for item in inventory.get("screens", [])}
check(screen.get("H5", {}).get("route") == "#security" and
      mapping.get("H5", {}).get("profile") == "privy_wallet" and
      mapping.get("H5", {}).get("thin_adapter_owner") ==
      "lib/integrations/privy/security/*" and
      mapping.get("B9", {}).get("profile") == "security_facts",
      "H5 route is bound to canonical privy_wallet authority; B9 remains security_facts")
check("createOfflineAdapter" in provider and "createProductionAdapter" in provider and
      "createProductionRegionalPolicy" in provider and
      "createAdapter(configuration)" not in provider and "mode:'offline_fixture'" not in fixture,
      "offline and production adapter/policy factories are separate with no caller-selected mode")
check("SEARCH_DESTINATIONS" in provider and
      "exactKeys(raw,['id','kind','title','subtitle']" in provider and
      "['id','kind','title','subtitle','route']" not in provider,
      "provider search DTO is typed and cannot inject a route")
check(not re.search(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|indexedDB|"
                    r"localStorage|sessionStorage)\b", provider + "\n" + fixture),
      "platform boundary and fixture own no network or durable storage")
check(not re.search(r"\b(?:api[_-]?key|secret|token|credential|password)\b\s*[:=]",
                    provider + "\n" + fixture, re.I),
      "offline fixture embeds no credential material")
check(not re.search(r"(?:notification inbox|search index|social graph|security engine)",
                    provider + "\n" + fixture, re.I),
      "no custom durable notification/search/social/security core")

node_probe = subprocess.run(["node", "-e", r"""
'use strict';
require(process.argv[1]); require(process.argv[2]);
const P=globalThis.LoopPlatformProvider,F=globalThis.LoopPlatformOfflineFixture;
const adapter=F.createAdapter();
const policy=F.regionalPolicy();
const initial=policy.decision({capability:'wallet_mutation'});
const initialSnapshot=policy.snapshot();
const previewSnapshot=policy.activateReadOnlyPreview();
const preview=policy.recheck({capability:'wallet_mutation',operation:'transfer',stage:'entry_gate'});
const unknownOperation=policy.recheck({capability:'wallet_mutation',operation:'unknown_review',stage:'review_open'});
const unknownCapability=policy.decision({capability:'new_unmapped_mutation'});
let policyGetterRead=false;
const accessorPolicy=policy.decision(Object.defineProperty({},'capability',{
  get(){policyGetterRead=true;return 'wallet_mutation'},enumerable:true}));
policy.applyTrustedFixtureTransition('blocked');
const blocked=policy.decision({capability:'wallet_mutation'});
const frozenSnapshot=policy.snapshot();
try{frozenSnapshot.state='eligible'}catch(_error){}
const stillBlocked=policy.decision({capability:'wallet_mutation'});
const failClosedStates=['unknown','stale','malformed'].map(state=>{
  policy.applyTrustedFixtureTransition(state);
  return policy.decision({capability:'privacy_mutation'});
});
policy.applyTrustedFixtureTransition('eligible');
const forgedUnlock=policy.decision({capability:'wallet_mutation'});
let forgedOffline=false,forgedProduction=false,argumentSmuggle=false,
  policySmuggle=false,globalSwap=false;
try{P.createOfflineAdapter(Object.freeze({kind:'offline_fixture'}),{});forgedOffline=true}catch(_error){}
try{P.createProductionAdapter(Object.freeze({kind:'production_injected'}),{});forgedProduction=true}catch(_error){}
try{F.createAdapter({mode:'production_injected'});argumentSmuggle=true}catch(_error){}
try{F.regionalPolicy({state:'eligible'});policySmuggle=true}catch(_error){}
try{globalThis.LoopPlatformOfflineFixture={createAdapter:()=>({})};globalSwap=true}catch(_error){}
Promise.all([
  adapter.notifications({limit:20}),
  adapter.search({query:'eth'}),
  adapter.privySecurity(), adapter.securityFacts(),
  adapter.requestPrivacyOperation({kind:'export'})
]).then(([notifications,search,privy,security,privacy])=>{
  try{notifications.status='production_injected';notifications.items[0].title='spoof'}catch(_error){}
  const ok=Object.isFrozen(P)&&Object.isFrozen(F)&&Object.isFrozen(notifications)&&
    notifications.status==='offline_fixture'&&notifications.items.length===4&&
    notifications.items[0].title!=='spoof'&&
    notifications.items.every(x=>['firebase','stream','hyperliquid','privy'].includes(x.authority))&&
    search.status==='offline_fixture'&&search.results.length>0&&search.results.length<=20&&
    search.results.every(item=>({token:'#token',contract:'#token',group:'#chat',
      user:'#profile',perp:'#market'})[item.kind]===item.route)&&
    privy.status==='offline_fixture'&&privy.profile==='privy_wallet'&&
    security.status==='offline_fixture'&&security.profile==='security_facts'&&
    privacy.status==='PENDING'&&privacy.mutation_performed===false&&
    !initial.allowed&&initial.state==='unknown'&&initialSnapshot.state==='unknown'&&
    initialSnapshot.revision===0&&initialSnapshot.verified===false&&
    !preview.allowed&&preview.state==='eligible_readonly'&&
    previewSnapshot.state==='eligible_readonly'&&previewSnapshot.verified===true&&
    !unknownOperation.allowed&&unknownOperation.state==='unknown'&&
    !unknownCapability.allowed&&unknownCapability.state==='unknown'&&
    !accessorPolicy.allowed&&!policyGetterRead&&
    !blocked.allowed&&!stillBlocked.allowed&&failClosedStates.every(item=>!item.allowed)&&
    !forgedUnlock.allowed&&
    !forgedOffline&&!forgedProduction&&!argumentSmuggle&&!policySmuggle&&!globalSwap&&
    globalThis.LoopPlatformOfflineFixture===F;
  process.stdout.write(JSON.stringify({ok,forgedOffline,forgedProduction,
    argumentSmuggle,policySmuggle,globalSwap,initial,initialSnapshot,previewSnapshot,preview,unknownOperation,unknownCapability,
    accessorPolicy,policyGetterRead,blocked,
    stillBlocked,failClosedStates,forgedUnlock,notifications,search,privy,security,privacy}));
  if(!ok)process.exitCode=1;
}).catch(error=>{process.stderr.write(String(error));process.exitCode=1});
""", str(SRC / "platform-provider.js"),
    str(SRC / "platform-offline-fixture.js")], cwd=ROOT, text=True,
    capture_output=True, check=False)
check(node_probe.returncode == 0,
      f"unforgeable frozen offline identity and fail-closed production boundary: "
      f"{node_probe.stderr.strip() or node_probe.stdout[:300]}")

production_probe = subprocess.run(["node", "-e", r"""
'use strict';
require(process.argv[1]);
const P=globalThis.LoopPlatformProvider,B=globalThis.LoopPlatformProviderBootstrap;
const handle=B.claimProductionHandle();
let response={state:'eligible',revision:1,policy_id:'provider-policy-1',verified:true},calls=0;
const adapter=P.createProductionAdapter(handle,{
  eventSources:[{authority:'firebase',read:async()=>[]}],
  searchSources:[{authority:'market_data',read:async()=>[{id:'evil',kind:'token',title:'Evil',
    subtitle:'route injection',route:'#seed-show'}]}],
  securitySources:[{authority:'goplus',read:async()=>[]}],
  privySecuritySource:{authority:'privy',read:async()=>[]},privacyClient:null
});
const configuration={authoritativeRecheck(request){
  calls+=1;
  if(!Object.isFrozen(request)||Object.keys(request).sort().join(',')!==
     'capability,operation,stage')throw new Error('unsafe request');
  return response;
}};
const installed=P.installProductionRegionalPolicy(handle,configuration);
let pendingReplay=false;
try{P.installProductionRegionalPolicy(handle,{authoritativeRecheck(){return response}});
  pendingReplay=true}catch(_error){}
const policy=P.consumeProductionRegionalPolicy();
const consumedAgain=P.consumeProductionRegionalPolicy();
let replayAfterConsume=false,createAfterConsume=false,adapterAfterConsume=false;
try{P.installProductionRegionalPolicy(handle,configuration);replayAfterConsume=true}catch(_error){}
try{P.createProductionRegionalPolicy(handle,configuration);createAfterConsume=true}catch(_error){}
try{P.createProductionAdapter(handle,{
  eventSources:[{authority:'firebase',read:async()=>[]}],
  searchSources:[{authority:'market_data',read:async()=>[]}],
  securitySources:[{authority:'goplus',read:async()=>[]}],
  privySecuritySource:{authority:'privy',read:async()=>[]},privacyClient:null
});adapterAfterConsume=true}catch(_error){}
const consumedAfterReplay=P.consumeProductionRegionalPolicy();
const initial=policy.decision({capability:'wallet_mutation'});
const eligible=policy.recheck({capability:'wallet_mutation',operation:'transfer',stage:'entry_gate'});
const unknownOperation=policy.recheck({capability:'wallet_mutation',operation:'unknown_review',stage:'review_open'});
response={state:'blocked',revision:2,policy_id:'provider-policy-1',verified:true};
const blocked=policy.recheck({capability:'wallet_mutation',operation:'transfer',stage:'provider_handoff'});
response={state:'eligible',revision:3,policy_id:'provider-policy-1',verified:true};
const monotonic=policy.recheck({capability:'wallet_mutation',operation:'transfer',stage:'provider_handoff'});
let forged=false,forgedInstall=false;
try{P.createProductionRegionalPolicy(Object.freeze(Object.create(null)),{
  authoritativeRecheck(){return response}});forged=true}catch(_error){}
try{P.installProductionRegionalPolicy(Object.freeze(Object.create(null)),{
  authoritativeRecheck(){return response}});forgedInstall=true}catch(_error){}
adapter.search({query:'eth'}).then(()=>{throw new Error('route injection accepted')},error=>{
  const ok=!initial.allowed&&initial.state==='unknown'&&eligible.allowed&&
    !unknownOperation.allowed&&unknownOperation.state==='unknown'&&calls===3&&
    !blocked.allowed&&blocked.state==='blocked'&&!monotonic.allowed&&
    monotonic.state==='blocked'&&!forged&&!forgedInstall&&installed===policy&&
    !pendingReplay&&!replayAfterConsume&&!createAfterConsume&&!adapterAfterConsume&&
    consumedAgain===null&&consumedAfterReplay===null&&/search result/.test(String(error));
  process.stdout.write(JSON.stringify({ok,calls,initial,eligible,unknownOperation,blocked,
    monotonic,forged,forgedInstall,pendingReplay,replayAfterConsume,createAfterConsume,
    adapterAfterConsume,consumedAgain,consumedAfterReplay,error:String(error)}));
  if(!ok)process.exitCode=1;
}).catch(error=>{process.stderr.write(String(error));process.exitCode=1});
""", str(SRC / "platform-provider.js")], cwd=ROOT, text=True,
    capture_output=True, check=False)
check(production_probe.returncode == 0,
      f"production policy requires an unforgeable handle, rechecks, latches blocked, "
      f"and rejects search routes: {production_probe.stderr.strip() or production_probe.stdout[:400]}")

check("regionalPolicy" in fixture and "regionalCapabilityDecision" in app and
      "regionalOperationDecision" in app and "data-regional-policy-control" in app and
      "capture:true" in app,
      "I5 regional policy authority is consumed by mutation controls in capture phase")
check("REGIONAL_POLICY.applyTrustedFixtureTransition(policyState)" not in app and
      "const policyState={regional:" not in app and
      "addEventListener('pageshow'" in app and "event.persisted" in app and
      "REGIONAL_BLOCKED_SESSION_KEY" in app,
      "URL is display-only and trusted blocked policy is a BFCache/reload monotonic latch")
check("const regionalSessionAuthority=(()=>{" in app and
      all(token in app for token in ("storageReadable", "storageWritable",
                                     "roundtripConfirmed")) and
      "regionalSessionAuthority.recheck()" in app and
      "activateTrustedFixture" not in app and
      "REGIONAL_POLICY.activateReadOnlyPreview()" in app and
      "consumeProductionRegionalPolicy" in app,
      "every new document starts default-deny and only an explicit read-only preview or branded production policy can transition")
check(all(token in app for token in
          ("review_open", "begin_handoff", "provider_handoff")) and
      "terminateReviewForRegionalPolicy" in app,
      "F11 rechecks policy per operation at open, begin handoff, and provider handoff")
check("PLATFORM_SEARCH_ROUTE_BY_KIND" in app and
      "resolvePlatformSearchRoute" in app and "guardAccountRoute" in app and
      "item.route.slice(1)" not in app,
      "provider search uses canonical typed route resolution and account/sensitive guards")
check("data-platform-runtime" not in shell and "platform-fixture-badge" in all_platform and
      "dataset.platformRuntime=PLATFORM_RUNTIME" in app,
      "static prototype explicitly starts and visibly labels offline fixture runtime")
check(app.count("length>26") == 3 and "length>30" not in app and
      "stack=array(item.stack,26,'stack')" in read("src/wallet-review.js"),
      "navigation and F11 retain the approved 26-entry cap")
check(all(name in app for name in ("scr-notifications", "scr-search",
                                   "scr-privacy", "scr-security")) and
      "REVIEW_ORIGIN_EXCLUDED" in app,
      "new platform routes are explicitly excluded from F11 origin projection")

for marker in ("global-offline-banner", "global-server-error",
               "force-update-dialog", "global-region-restriction"):
    check(marker in shell, f"global system surface exists: {marker}")
check("aria-modal=\"true\"" in shell and "inert" in shell,
      "blocking system surfaces declare modal/inert semantics")
check("prefers-reduced-motion: reduce" in style and "min-height:44px" in style,
      "reduced-motion and 44px platform controls are explicit")

storage_probe = subprocess.run(["node", "-e", r"""
'use strict';
const fs=require('fs'),vm=require('vm'),source=fs.readFileSync(process.argv[1],'utf8');
const start=source.indexOf("const REGIONAL_BLOCKED_SESSION_KEY='loop.prototype.regional-blocked.v1';");
const end=source.indexOf('\nconst ROUTES = {',start);
if(start<0||end<start)throw new Error('regional session authority section unavailable');
const section=source.slice(start,end);
function storage(mode){
  const values=new Map();
  return {
    getItem(key){if(mode==='get_throw'||mode==='both_throw')throw new Error('get denied');
      if(mode==='mismatch'&&String(key).includes('regional-probe'))return 'mismatch';
      return values.has(key)?values.get(key):null},
    setItem(key,value){if(mode==='set_throw'||mode==='both_throw')throw new Error('set denied');
      if(mode!=='ignored')values.set(String(key),String(value))},
    removeItem(key){values.delete(String(key))}
  };
}
const modes=['normal','get_throw','set_throw','both_throw','accessor_throw','ignored','mismatch'];
const results={};
for(const mode of modes){
  const sandbox={performance:{timeOrigin:1700000000000,now:()=>12.5}};
  if(mode==='accessor_throw')Object.defineProperty(sandbox,'sessionStorage',{
    configurable:true,get(){throw new Error('accessor denied')}});
  else sandbox.sessionStorage=storage(mode);
  vm.runInNewContext(section+';globalThis.answer=regionalSessionAuthority.snapshot()',sandbox);
  results[mode]=sandbox.answer;
}
const normal=results.normal;
const denied=modes.slice(1).every(mode=>{
  const item=results[mode];return item.trusted===false&&item.roundtripConfirmed===false;
});
const ok=normal.storageReadable===true&&normal.storageWritable===true&&
  normal.roundtripConfirmed===true&&normal.trusted===true&&denied&&
  results.get_throw.storageReadable===false&&results.set_throw.storageWritable===false&&
  results.accessor_throw.storageReadable===false&&results.ignored.storageWritable===false&&
  results.mismatch.roundtripConfirmed===false;
process.stdout.write(JSON.stringify({ok,results}));if(!ok)process.exitCode=1;
""", str(SRC / "app.js")], cwd=ROOT, text=True, capture_output=True, check=False)
check(storage_probe.returncode == 0,
      f"Node storage mutations require readable, writable, exact roundtrip authority: "
      f"{storage_probe.stderr.strip() or storage_probe.stdout[:700]}")

print("\n== Deterministic build ==")
build = subprocess.run([sys.executable, "build.py"], cwd=ROOT, text=True,
                       capture_output=True, check=False)
check(build.returncode == 0 and "42 screens" in build.stdout,
      f"42-screen build succeeds: {(build.stderr or build.stdout).strip()}")
first = hashlib.sha256(APP.read_bytes()).hexdigest() if APP.is_file() else None
build_again = subprocess.run([sys.executable, "build.py"], cwd=ROOT, text=True,
                             capture_output=True, check=False)
second = hashlib.sha256(APP.read_bytes()).hexdigest() if APP.is_file() else None
check(build_again.returncode == 0 and first == second,
      f"double build is deterministic: {first} / {second}")
PRODUCTION_TEST_APP = production_policy_test_app(ROOT)

print("\n== Routed and global UI matrix ==")
if build.returncode == 0 and "42 screens" in build.stdout and APP.is_file():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        default_page = browser.new_page(viewport={"width": 390, "height": 844})
        default_page.goto(APP.as_uri() + "#swap")
        default_page.wait_for_timeout(80)
        initial_default = default_page.evaluate("""() => {
          const all=[...document.querySelectorAll('[data-requires-signing],'
            +'[data-provider-mutation]')];
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          const banner=document.getElementById('review-provider-banner');
          return {policy:REGIONAL_POLICY.snapshot(),runtime:PLATFORM_RUNTIME,
            disabled:all.every(node=>node.disabled),signing:
              document.querySelectorAll('[data-requires-signing]').length,
            privacy:document.querySelectorAll('[data-privacy-operation]').length,
            opened,review:reviewSurfaceOpen(),reviewRuntime:reviewRuntime.openId,
            state:banner.dataset.state,text:banner.textContent};
        }""")
        check(initial_default['policy']['state'] == 'unknown' and
              initial_default['policy']['verified'] is False and
              initial_default['runtime'] == 'offline_fixture' and
              initial_default['disabled'] and initial_default['signing'] == 12 and
              initial_default['privacy'] == 2 and not initial_default['opened'] and
              not initial_default['review'] and initial_default['reviewRuntime'] == '' and
              initial_default['state'] == 'provider_blocked' and
              'pending' not in initial_default['text'].lower(),
              f"new offline document is unknown/default-deny before verification: {initial_default}")
        default_page.goto(APP.as_uri() + "?system=offline#swap")
        preview_exists = default_page.locator('#global-offline-preview').count() == 1
        if preview_exists:
            default_page.locator('#global-offline-preview').click()
        default_page.wait_for_timeout(40)
        readonly_preview = default_page.evaluate("""() => {
          const all=[...document.querySelectorAll('[data-requires-signing],'
            +'[data-provider-mutation]')];
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          const banner=document.getElementById('review-provider-banner');
          return {policy:REGIONAL_POLICY.snapshot(),disabled:all.every(node=>node.disabled),
            opened,review:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
            state:banner.dataset.state,text:banner.textContent,
            disclosure:document.getElementById('global-offline-preview-status')?.textContent||''};
        }""")
        check(preview_exists and readonly_preview['policy']['state'] == 'eligible_readonly' and
              readonly_preview['policy']['verified'] is True and
              readonly_preview['disabled'] and not readonly_preview['opened'] and
              not readonly_preview['review'] and readonly_preview['runtime'] == '' and
              readonly_preview['state'] == 'provider_blocked' and
              'pending' not in readonly_preview['text'].lower() and
              'read-only' in readonly_preview['disclosure'].lower(),
              f"explicit offline eligibility preview remains read-only: {readonly_preview}")
        default_page.close()
        for viewport in ({"width": 375, "height": 667},
                         {"width": 1440, "height": 900}):
            page = browser.new_page(viewport=viewport)
            errors, requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text)
                    if message.type == "error" else None)
            page.on("request", lambda request: requests.append(request.url)
                    if not request.url.startswith("file:") else None)
            for route in ROUTES:
                page.goto(APP.as_uri() + f"#{route}")
                page.wait_for_timeout(120)
                check(page.locator(".scr.active").count() == 1 and
                      page.locator(f"#scr-{route}.active").count() == 1,
                      f"{viewport['width']}px #{route} is the sole active route")
                focused = page.evaluate("() => document.activeElement?.matches('[data-route-focus]')")
                check(focused, f"{viewport['width']}px #{route} receives route focus")
                min_control = page.evaluate("""() => Math.min(...[...document.querySelectorAll('.scr.active button:not(:disabled),.scr.active input:not(:disabled)')].map(el=>el.getBoundingClientRect().height))""")
                check(min_control >= 44, f"{viewport['width']}px #{route} controls are >=44px ({min_control})")
            page.goto(APP.as_uri() + "?system=offline#home")
            page.wait_for_timeout(100)
            check(page.locator("#global-offline-banner:not([hidden])").count() == 1 and
                  page.locator("#global-offline-retry").is_enabled(),
                  f"{viewport['width']}px I1 complete-offline is recoverable")
            page.locator("#global-offline-retry").click()
            check(page.locator("#global-offline-banner[hidden]").count() == 1,
                  f"{viewport['width']}px I1 retry restores the shell")
            for system, marker, recoverable in (
                    ("server-error", "global-server-error", True),
                    ("regional", "global-region-restriction", True),
                    ("force-update", "force-update-dialog", False)):
                page.goto(APP.as_uri() + f"?system={system}#home")
                page.wait_for_timeout(100)
                check(page.locator(f"#{marker}:not([hidden])").count() == 1,
                      f"{viewport['width']}px {system} surface is visible")
                check(page.locator("#viewport-shell").get_attribute("inert") is not None,
                      f"{viewport['width']}px {system} makes app content inert")
                check(page.evaluate(f"() => document.activeElement && document.getElementById('{marker}').contains(document.activeElement)"),
                      f"{viewport['width']}px {system} owns focus")
                if recoverable:
                    action = "#global-server-retry" if system == "server-error" else "#global-region-home"
                    check(page.locator(action).is_enabled(),
                          f"{viewport['width']}px {system} exposes its allowed recovery")
                    if system == "regional":
                        visual_only = page.evaluate("""() => ({
                          policy:REGIONAL_POLICY.snapshot(),
                          enabled:[...document.querySelectorAll('[data-requires-signing],'
                            +'[data-provider-mutation]')].every(node=>!node.disabled||
                              node.id==='wallet-bridge')
                        })""")
                        check(visual_only['policy']['state'] == 'unknown' and
                              not visual_only['enabled'],
                              f"{viewport['width']}px regional URL cannot become policy authority: {visual_only}")
                        page.evaluate("""() => {
                          REGIONAL_POLICY.applyTrustedFixtureTransition('blocked');
                          applyRegionalCapabilityGates();
                        }""")
                        page.locator(action).click()
                        regional = page.evaluate("""() => ({
                          query:new URLSearchParams(location.search).get('system'),
                          active:document.getElementById('phone').dataset.regionalRestriction,
                          dialog:document.getElementById('global-region-restriction').hidden,
                          route:location.hash,
                          signing:[...document.querySelectorAll('[data-requires-signing]')]
                            .map(node=>({id:node.id,disabled:node.disabled,
                              describedby:node.getAttribute('aria-describedby')})),
                          mutations:[...document.querySelectorAll('[data-provider-mutation]')]
                            .map(node=>({id:node.id,disabled:node.disabled,
                              describedby:node.getAttribute('aria-describedby')}))
                        })""")
                        check(regional['query'] == 'regional' and
                              regional['active'] == 'active' and regional['dialog'] and
                              regional['route'] == '#home' and
                              len(regional['signing']) == 12 and
                              len(regional['mutations']) >= 3 and
                              all(item['disabled'] and
                                  item['describedby'] == 'regional-policy-explanation'
                                  for item in regional['signing'] + regional['mutations']),
                              f"{viewport['width']}px regional gate remains non-bypassable: {regional}")
                        bypass = page.evaluate("""() => {
                          const control=document.getElementById('home-pay');
                          let reached=false;control.disabled=false;
                          control.removeAttribute('aria-disabled');
                          control.removeAttribute('aria-describedby');
                          control.addEventListener('click',()=>{reached=true},{once:true});
                          control.click();
                          return {reached,disabled:control.disabled,
                            describedby:control.getAttribute('aria-describedby'),hash:location.hash};
                        }""")
                        check(bypass == {'reached': False, 'disabled': True,
                                         'describedby': 'regional-policy-explanation',
                                         'hash': '#home'},
                              f"{viewport['width']}px synchronous DOM/DTO bypass is capture-blocked: {bypass}")
                        page.evaluate("""() => {
                          history.pushState(history.state,'','#swap');
                          dispatchEvent(new PopStateEvent('popstate',{state:history.state}));
                          dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
                        }""")
                        page.go_back(); page.go_forward()
                        page.evaluate("""() => {
                          const url=new URL(location.href);url.searchParams.delete('system');
                          history.replaceState(history.state,'',url.pathname+url.hash);
                        }""")
                        page.reload(); page.wait_for_timeout(100)
                        replay = page.evaluate("""() => ({
                          query:new URLSearchParams(location.search).get('system'),
                          route:location.hash,
                          blocked:[...document.querySelectorAll('[data-requires-signing]')]
                            .every(node=>node.disabled&&node.getAttribute('aria-describedby')===
                              'regional-policy-explanation')
                        })""")
                        check(replay['query'] is None and replay['blocked'],
                              f"{viewport['width']}px Back/BFCache/query removal/reload cannot bypass I5: {replay}")
                else:
                    check(page.locator("#force-update-action").is_disabled(),
                          f"{viewport['width']}px force update fails closed while store link is PENDING")
            check(not errors, f"{viewport['width']}px matrix has no page/console errors: {errors[:3]}")
            check(not requests, f"{viewport['width']}px offline fixture issues no network requests: {requests[:3]}")
            page.close()

        storage_mutations = {
            "get_throw": """Object.defineProperty(Storage.prototype,'getItem',{configurable:true,value:function(){throw new Error('get denied')}});""",
            "set_throw": """Object.defineProperty(Storage.prototype,'setItem',{configurable:true,value:function(){throw new Error('set denied')}});""",
            "get_set_throw": """Object.defineProperty(Storage.prototype,'getItem',{configurable:true,value:function(){throw new Error('get denied')}});Object.defineProperty(Storage.prototype,'setItem',{configurable:true,value:function(){throw new Error('set denied')}});""",
            "accessor_throw": """Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('accessor denied')}});""",
            "set_ignored": """Object.defineProperty(Storage.prototype,'setItem',{configurable:true,value:function(){}});""",
            "roundtrip_mismatch": """const originalGet=Storage.prototype.getItem;Object.defineProperty(Storage.prototype,'getItem',{configurable:true,value:function(key){return String(key).includes('regional-probe')?'mismatch':originalGet.call(this,key)}});""",
        }
        for mutation, init_script in storage_mutations.items():
            context = browser.new_context(viewport={"width": 390, "height": 844})
            context.add_init_script(init_script)
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(APP.as_uri() + "#home")
            page.wait_for_timeout(80)
            denied = page.evaluate("""async () => {
              const signing=[...document.querySelectorAll('[data-requires-signing]')];
              const privacy=[...document.querySelectorAll('[data-privacy-operation]')];
              const all=[...signing,...privacy,document.getElementById('review-continue')];
              all.forEach(control=>{control.disabled=false;control.removeAttribute('aria-disabled');
                control.removeAttribute('aria-describedby');control.click()});
              await requestPrivacy('export');await requestPrivacy('delete');
              const opened=openWalletReview('review-swap-fresh',
                document.getElementById('swap-submit'));
              continueWalletReview();await new Promise(resolve=>setTimeout(resolve,30));
              const banner=document.getElementById('review-provider-banner');
              return {storage:regionalSessionAuthority.snapshot(),opened,
                signing:signing.map(node=>({disabled:node.disabled,
                  describedby:node.getAttribute('aria-describedby')})),
                privacy:privacy.map(node=>({disabled:node.disabled,
                  describedby:node.getAttribute('aria-describedby')})),
                review:{open:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
                  state:banner.dataset.state,text:banner.textContent},
                privacyStatus:document.getElementById('privacy-operation-status').textContent};
            }""")
            page.reload(); page.wait_for_timeout(60)
            reload_denied = page.evaluate("""() => ({
              storage:regionalSessionAuthority.snapshot(),
              signing:[...document.querySelectorAll('[data-requires-signing]')]
                .every(node=>node.disabled&&node.getAttribute('aria-describedby')===
                  'regional-policy-explanation'),
              privacy:[...document.querySelectorAll('[data-privacy-operation]')]
                .every(node=>node.disabled&&node.getAttribute('aria-describedby')===
                  'regional-policy-explanation')
            })""")
            page.goto(APP.as_uri() + "?system=offline#home")
            page.go_back(); page.wait_for_timeout(60)
            back_denied = page.evaluate("""() => ({
              signing:[...document.querySelectorAll('[data-requires-signing]')]
                .every(node=>node.disabled),
              privacy:[...document.querySelectorAll('[data-privacy-operation]')]
                .every(node=>node.disabled)
            })""")
            check(denied['storage']['trusted'] is False and
                  denied['storage']['roundtripConfirmed'] is False and
                  not denied['opened'] and not denied['review']['open'] and
                  denied['review']['runtime'] == '' and
                  denied['review']['state'] == 'provider_blocked' and
                  'pending' not in denied['review']['text'].lower() and
                  'pending' not in denied['privacyStatus'].lower() and
                  len(denied['signing']) == 12 and len(denied['privacy']) == 2 and
                  all(item['disabled'] and item['describedby'] ==
                      'regional-policy-explanation'
                      for item in denied['signing'] + denied['privacy']) and
                  reload_denied['storage']['trusted'] is False and
                  reload_denied['signing'] and reload_denied['privacy'] and
                  back_denied['signing'] and back_denied['privacy'] and not errors,
                  f"storage {mutation} fails closed across 12+2/F11/reload/Back/BFCache: "
                  f"{denied} / {reload_denied} / {back_denied} / {errors}")
            page.close(); context.close()

        transient_recovery_mutations = {
            "quota_set_throw": ("""Object.defineProperty(Storage.prototype,'setItem',{configurable:true,value:function(){throw new DOMException('quota','QuotaExceededError')}});""", ""),
            "silent_ignore": ("""Object.defineProperty(Storage.prototype,'setItem',{configurable:true,value:function(){}});""", ""),
            "roundtrip_mismatch": ("""const originalGet=Storage.prototype.getItem;Object.defineProperty(Storage.prototype,'getItem',{configurable:true,value:function(key){return String(key).includes('regional-probe')?'mismatch':originalGet.call(this,key)}});""", ""),
            "storage_cleared": ("", "sessionStorage.clear();"),
        }
        for mutation, (mutate_storage, after_block) in transient_recovery_mutations.items():
            page = browser.new_page(viewport={"width": 390, "height": 844})
            errors, requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: requests.append(request.url)
                    if not request.url.startswith("file:") else None)
            page.goto(APP.as_uri() + "?system=offline#swap")
            page.locator('#global-offline-preview').click()
            before_reload = page.evaluate(f"""async () => {{
              const preview=REGIONAL_POLICY.snapshot();
              {mutate_storage}
              REGIONAL_POLICY.applyTrustedFixtureTransition('blocked');
              applyRegionalCapabilityGates();
              {after_block}
              const signing=[...document.querySelectorAll('[data-requires-signing]')];
              const privacy=[...document.querySelectorAll('[data-privacy-operation]')];
              [...signing,...privacy,document.getElementById('review-continue')].forEach(control=>{{
                control.disabled=false;control.removeAttribute('aria-disabled');
                control.removeAttribute('aria-describedby');control.click();
              }});
              await requestPrivacy('export');await requestPrivacy('delete');
              const opened=openWalletReview('review-swap-fresh',
                document.getElementById('swap-submit'));
              continueWalletReview();await new Promise(resolve=>setTimeout(resolve,30));
              const banner=document.getElementById('review-provider-banner');
              return {{preview,storage:regionalSessionAuthority.snapshot(),opened,
                review:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
                state:banner.dataset.state,text:banner.textContent,
                privacyStatus:document.getElementById('privacy-operation-status').textContent,
                denied:[...signing,...privacy].every(node=>node.disabled&&
                  node.getAttribute('aria-describedby')==='regional-policy-explanation')}};
            }}""")
            page.reload();page.wait_for_timeout(70)
            after_reload = page.evaluate("""() => {
              const signing=[...document.querySelectorAll('[data-requires-signing]')];
              const privacy=[...document.querySelectorAll('[data-privacy-operation]')];
              const opened=openWalletReview('review-swap-fresh',
                document.getElementById('swap-submit'));
              const banner=document.getElementById('review-provider-banner');
              return {policy:REGIONAL_POLICY.snapshot(),storage:regionalSessionAuthority.snapshot(),
                denied:[...signing,...privacy].every(node=>node.disabled&&
                  node.getAttribute('aria-describedby')==='regional-policy-explanation'),
                opened,review:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
                state:banner.dataset.state,text:banner.textContent};
            }""")
            check(before_reload['preview']['state'] == 'eligible_readonly' and
                  before_reload['denied'] and not before_reload['opened'] and
                  not before_reload['review'] and before_reload['runtime'] == '' and
                  before_reload['state'] == 'provider_blocked' and
                  'pending' not in before_reload['text'].lower() and
                  'pending' not in before_reload['privacyStatus'].lower() and
                  after_reload['policy']['state'] == 'unknown' and
                  after_reload['policy']['verified'] is False and
                  after_reload['denied'] and not after_reload['opened'] and
                  not after_reload['review'] and after_reload['runtime'] == '' and
                  after_reload['state'] == 'provider_blocked' and
                  'pending' not in after_reload['text'].lower() and
                  not errors and not requests,
                  f"transient {mutation} cannot recover eligible mutation authority after reload: "
                  f"{before_reload} / {after_reload} / {errors} / {requests}")
            page.close()

        runtime_context = browser.new_context(viewport={"width": 390, "height": 844})
        begin_storage_page = runtime_context.new_page()
        begin_storage_page.goto(PRODUCTION_TEST_APP.as_uri() + "#swap")
        begin_storage_race = begin_storage_page.evaluate("""async () => {
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          Object.defineProperty(Storage.prototype,'getItem',{configurable:true,
            value:function(){throw new Error('runtime get denied')}});
          continueWalletReview();await new Promise(resolve=>setTimeout(resolve,40));
          const banner=document.getElementById('review-provider-banner');
          return {opened,storage:regionalSessionAuthority.snapshot(),open:reviewSurfaceOpen(),
            runtime:reviewRuntime.openId,state:banner.dataset.state,text:banner.textContent};
        }""")
        check(begin_storage_race['opened'] and not begin_storage_race['storage']['trusted'] and
              not begin_storage_race['open'] and begin_storage_race['runtime'] == '' and
              begin_storage_race['state'] == 'provider_blocked' and
              'pending' not in begin_storage_race['text'].lower(),
              f"storage failure before F11 beginHandoff terminates: {begin_storage_race}")
        begin_storage_page.close()

        final_storage_page = runtime_context.new_page()
        final_storage_page.goto(PRODUCTION_TEST_APP.as_uri() + "#swap")
        final_storage_race = final_storage_page.evaluate("""async () => {
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          continueWalletReview();
          Object.defineProperty(Storage.prototype,'setItem',{configurable:true,
            value:function(){}});
          await new Promise(resolve=>setTimeout(resolve,80));
          const banner=document.getElementById('review-provider-banner');
          return {opened,storage:regionalSessionAuthority.snapshot(),open:reviewSurfaceOpen(),
            runtime:reviewRuntime.openId,state:banner.dataset.state,text:banner.textContent};
        }""")
        check(final_storage_race['opened'] and not final_storage_race['storage']['trusted'] and
              not final_storage_race['open'] and final_storage_race['runtime'] == '' and
              final_storage_race['state'] == 'provider_blocked' and
              'pending' not in final_storage_race['text'].lower(),
              f"silent storage loss before final Privy handoff terminates: {final_storage_race}")
        final_storage_page.close(); runtime_context.close()

        attack_context = browser.new_context(viewport={"width": 390, "height": 844})
        search_page = attack_context.new_page()
        search_page.goto(APP.as_uri() + "#search")
        search_attacks = search_page.evaluate("""() => {
          const before=location.hash;
          const blocked=['seed-show','seed-verify','wallet-import','auth','auth-otp',
            'auth-wallet','wallet-create','wallet-backup','unknown-route'].map(route=>({
              route,stringResult:openPlatformRoute(route),hash:location.hash
            }));
          const injected=['#seed-show','#seed-verify','#wallet-import','#auth','#unknown'].map(route=>{
            const item=Object.freeze({id:'evil',authority:'privy',kind:'token',title:'Evil',
              subtitle:'Injected provider route',route});
            return {route,result:openPlatformRoute(item),hash:location.hash};
          });
          return {before,blocked,injected};
        }""")
        check(search_attacks['before'] == '#search' and
              all(not item['stringResult'] and item['hash'] == '#search'
                  for item in search_attacks['blocked']) and
              all(not item['result'] and item['hash'] == '#search'
                  for item in search_attacks['injected']),
              f"search cannot navigate to account/sensitive/unknown provider routes: {search_attacks}")
        search_page.fill("#platform-search-input", "eth")
        search_page.locator("#platform-search-form").evaluate("form => form.requestSubmit()")
        search_page.wait_for_timeout(80)
        check(search_page.locator("#platform-search-results button").count() == 4,
              "canonical provider search renders four bounded typed fixtures")
        search_page.locator("#platform-search-results button").first.click()
        check(search_page.evaluate("location.hash") == '#token',
              "valid typed search result traverses the canonical router")
        search_page.close()

        begin_page = attack_context.new_page()
        begin_page.goto(PRODUCTION_TEST_APP.as_uri() + "#swap")
        begin_race = begin_page.evaluate("""async () => {
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          __LoopPlatformPolicyTest.state='blocked';
          __LoopPlatformPolicyTest.revision+=1;
          continueWalletReview();
          await new Promise(resolve=>setTimeout(resolve,40));
          return {opened,open:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
            state:document.getElementById('review-provider-banner').dataset.state,
            text:document.getElementById('review-provider-banner').textContent};
        }""")
        check(begin_race['opened'] and not begin_race['open'] and
              begin_race['runtime'] == '' and begin_race['state'] == 'provider_blocked' and
              'pending' not in begin_race['text'].lower(),
              f"F11 policy transition before beginHandoff terminates without pending: {begin_race}")
        begin_page.close()

        replay_page = attack_context.new_page()
        replay_requests = []
        replay_page.on("request", lambda request: replay_requests.append(request.url)
                       if not request.url.startswith("file:") else None)
        replay_page.goto(PRODUCTION_TEST_APP.as_uri() + "#swap")
        replay_attack = replay_page.evaluate("""async () => {
          const pendingReplayRejected=__LoopPlatformPolicyTest.pendingReplayRejected;
          const replayAfterConsume=__LoopPlatformPolicyTest.replayAfterConsume();
          __LoopPlatformPolicyTest.state='blocked';
          __LoopPlatformPolicyTest.revision+=1;
          applyRegionalCapabilityGates();
          const signing=[...document.querySelectorAll('[data-requires-signing]')];
          const privacy=[...document.querySelectorAll('[data-privacy-operation]')];
          [...signing,...privacy,document.getElementById('review-continue')].forEach(control=>{
            control.disabled=false;control.removeAttribute('aria-disabled');
            control.removeAttribute('aria-describedby');control.click();
          });
          await requestPrivacy('export');await requestPrivacy('delete');
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          continueWalletReview();await new Promise(resolve=>setTimeout(resolve,40));
          const banner=document.getElementById('review-provider-banner');
          return {pendingReplayRejected,replayAfterConsume,opened,
            signing:signing.every(node=>node.disabled&&node.getAttribute('aria-describedby')===
              'regional-policy-explanation'),
            privacy:privacy.every(node=>node.disabled&&node.getAttribute('aria-describedby')===
              'regional-policy-explanation'),
            review:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
            state:banner.dataset.state,text:banner.textContent,
            privacyStatus:document.getElementById('privacy-operation-status').textContent};
        }""")
        check(replay_attack['pendingReplayRejected'] and
              not replay_attack['replayAfterConsume'] and
              replay_attack['signing'] and replay_attack['privacy'] and
              not replay_attack['opened'] and not replay_attack['review'] and
              replay_attack['runtime'] == '' and
              replay_attack['state'] == 'provider_blocked' and
              'pending' not in replay_attack['text'].lower() and
              'pending' not in replay_attack['privacyStatus'].lower() and
              not replay_requests,
              f"same valid production handle cannot replay/interleave or restore 12+2/F11: "
              f"{replay_attack} / {replay_requests}")
        replay_page.close()

        handoff_page = attack_context.new_page()
        handoff_page.goto(PRODUCTION_TEST_APP.as_uri() + "#swap")
        handoff_race = handoff_page.evaluate("""async () => {
          const opened=openWalletReview('review-swap-fresh',
            document.getElementById('swap-submit'));
          continueWalletReview();
          __LoopPlatformPolicyTest.state='blocked';
          __LoopPlatformPolicyTest.revision+=1;
          await new Promise(resolve=>setTimeout(resolve,80));
          const banner=document.getElementById('review-provider-banner');
          return {opened,open:reviewSurfaceOpen(),runtime:reviewRuntime.openId,
            state:banner.dataset.state,text:banner.textContent};
        }""")
        check(handoff_race['opened'] and not handoff_race['open'] and
              handoff_race['runtime'] == '' and handoff_race['state'] == 'provider_blocked' and
              'pending' not in handoff_race['text'].lower(),
              f"F11 policy transition before Simulated Privy handoff terminates: {handoff_race}")
        handoff_page.close()

        bfcache_page = attack_context.new_page()
        bfcache_page.goto(APP.as_uri() + "#home")
        bfcache_page.evaluate("""() => {
          REGIONAL_POLICY.applyTrustedFixtureTransition('blocked');
          applyRegionalCapabilityGates();
        }""")
        bfcache_page.goto(APP.as_uri() + "?system=offline#home")
        cross_document = bfcache_page.evaluate("""() => ({
          query:new URLSearchParams(location.search).get('system'),
          blocked:[...document.querySelectorAll('[data-requires-signing]')]
            .every(node=>node.disabled&&node.getAttribute('aria-describedby')===
              'regional-policy-explanation')
        })""")
        bfcache_page.go_back(); bfcache_page.wait_for_timeout(60)
        restored_document = bfcache_page.evaluate("""() => ({
          query:new URLSearchParams(location.search).get('system'),
          blocked:[...document.querySelectorAll('[data-requires-signing]')]
            .every(node=>node.disabled&&node.getAttribute('aria-describedby')===
              'regional-policy-explanation')
        })""")
        check(cross_document == {'query': 'offline', 'blocked': True} and
              restored_document == {'query': None, 'blocked': True},
              f"cross-document navigation and actual Back/BFCache preserve blocked latch: "
              f"{cross_document} / {restored_document}")
        bfcache_page.close()
        attack_context.close()
        browser.close()

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} checks failed"))
for failure in fails:
    print(" -", failure)
sys.exit(1 if fails else 0)
