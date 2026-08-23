#!/usr/bin/env python3
"""Focused structural and mutation verifier for the D1-D7 Perp UI slice."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from platform_policy_test_app import production_policy_test_app

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCREENS = (
    "perp-markets",
    "perp-market",
    "perp-order",
    "perp-confirm",
    "perp-positions",
    "perp-orders",
    "perp-position",
)
SCRIPTS = ("perp-read-provider.js", "perp-offline-fixture.js")
ACCOUNT_SCREENS = ("perp-account", "perp-transfer", "perp-deposit",
                   "perp-funding", "perp-risk-notice")
ACCOUNT_SCRIPTS = ("perp-account-provider.js", "perp-account-offline-fixture.js")
EXPECTED_SCREENS = (
    "splash", "auth", "auth-otp", "auth-wallet", "wallet-create",
    "wallet-backup", "seed-show", "seed-verify", "wallet-import",
    "home", "pay", "notifications", "search", "market",
    *SCREENS, *ACCOUNT_SCREENS,
    "token", "launchpad", "chat", "group", "wallet", "asset", "send",
    "send-to", "send-confirm", "receive", "tx-result", "swap", "dapp",
    "profile", "privacy", "security",
)
EXPECTED_SCRIPTS = (
    "vendor/qrcode-generator-1.4.4.js", "wallet-provider.js", "wallet-review.js",
    "wallet-transfer.js", "stream-chat-provider.js", "platform-provider.js",
    "platform-offline-fixture.js", *SCRIPTS, *ACCOUNT_SCRIPTS, "app.js",
)
LABEL = "Simulated Hyperliquid testnet fixture — no network, signing, or submission"


def fail(message: str) -> None:
    raise AssertionError(message)


def read(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        fail(f"missing {relative}")
    return path.read_text()


def require(text: str, pattern: str, label: str) -> None:
    if re.search(pattern, text, re.MULTILINE | re.DOTALL) is None:
        fail(label)


def verify() -> None:
    order = read("src/screens-order.txt").splitlines()
    if len(order) != len(set(order)):
        fail("screen order contains duplicates")
    if tuple(order) != EXPECTED_SCREENS:
        fail("screen order must equal the exact 42-screen platform + Perp manifest")
    positions = [order.index(name) if name in order else -1 for name in SCREENS]
    if -1 in positions or positions != sorted(positions):
        fail("D1-D7 screens must appear once in route order")

    scripts = read("src/scripts-order.txt").splitlines()
    if tuple(scripts) != EXPECTED_SCRIPTS:
        fail("script order must equal the exact twelve-script production manifest")
    if any(script not in scripts for script in SCRIPTS):
        fail("perp provider scripts missing from script order")
    if scripts.index(SCRIPTS[1]) != scripts.index(SCRIPTS[0]) + 1:
        fail("offline fixture must immediately follow the provider")
    if scripts.index(SCRIPTS[1]) > scripts.index("app.js"):
        fail("perp adapters must be captured before app.js")

    build = read("build.py")
    for screen in SCREENS:
        require(build, rf"['\"]{re.escape(screen)}['\"]", f"build missing {screen}")
    for script in SCRIPTS:
        require(build, rf"['\"]{re.escape(script)}['\"]", f"build missing {script}")
    require(build, r"exact pinned 42-screen order", "builder must pin 42 screens")
    require(build, r"exact pinned twelve-script order", "builder must pin twelve scripts")

    fragments = {name: read(f"src/screens/{name}.html") for name in SCREENS}
    expected_ids = {
        "perp-markets": "scr-perp-markets",
        "perp-market": "scr-perp-market",
        "perp-order": "scr-perp-order",
        "perp-confirm": "scr-perp-confirm",
        "perp-positions": "scr-perp-positions",
        "perp-orders": "scr-perp-orders",
        "perp-position": "scr-perp-position",
    }
    for name, screen_id in expected_ids.items():
        require(fragments[name], rf'id="{screen_id}"', f"{name} missing routed screen id")
        require(fragments[name], r'class="scr(?:\s|\")', f"{name} missing screen class")
        require(fragments[name], r'data-perp-provider-status',
                f"{name} missing fail-closed provider status")

    require(fragments["perp-markets"], r"Core perpetuals", "D1 must identify Core scope")
    if re.search(r"\$(?:\d)|\b(?:64280|3842|3718|63120|142\.36|0\.42|51\.95)\b",
                 "\n".join(fragments.values())):
        fail("HTML fragments must not contain provider market/position/order truths")
    require(fragments["perp-market"], r"Funding", "D2 missing funding")
    require(fragments["perp-market"], r"Open interest", "D2 missing open interest")
    require(fragments["perp-order"], r"Limit|Market", "D3 missing order type")
    require(fragments["perp-order"], r"Leverage", "D3 missing leverage")
    require(fragments["perp-order"], r"Review order", "D3 missing review transition")

    confirm = fragments["perp-confirm"]
    for field in (
        "Direction", "Order type", "Price", "Size", "Leverage", "Margin",
        "Trading fee", "Builder fee", "Liquidation estimate", "Freshness",
    ):
        require(confirm, re.escape(field), f"D4 missing {field}")
    require(confirm, r"Builder fee.*?Disabled", "builder fee must be visibly disabled")
    for gate in ("region", "eligibility", "policy", "nonce", "unknown submission"):
        require(confirm.lower(), re.escape(gate), f"D4 missing {gate} handoff recheck")
    require(confirm, r'id="perp-shared-review"', "D4 missing shared review trigger")
    if "review-dialog" in confirm or "aria-modal=\"true\"" in confirm:
        fail("D4 must not define a second signing modal")

    require(fragments["perp-positions"], r'id="perp-position-list"',
            "D5 missing provider positions host")
    require(fragments["perp-orders"], r"Open orders", "D6 missing open orders")
    require(fragments["perp-orders"], r"Fill history", "D6 missing fill history")
    require(fragments["perp-position"], r"Liquidation", "D7 missing liquidation detail")
    require(fragments["perp-position"], r"Review close", "D7 missing close review")

    provider = read("src/perp-read-provider.js")
    fixture = read("src/perp-offline-fixture.js")
    require(provider, r"PENDING_default_deny", "provider must default deny mutations")
    require(provider, r"HIP-3", "provider must reject HIP-3")
    require(provider, r"Core", "provider must name Core scope")
    require(provider, r"ADAPTER_METHODS=Object\.freeze\(\[.*?'prepareMutationReview'.*?\]\)",
            "provider missing mutation review boundary")
    require(provider, r"ADAPTER_METHODS=Object\.freeze\(\[.*?'prepareOrderIntent'.*?\]\)",
            "provider missing typed intent adapter method")
    require(provider, r"prepareOrderIntent", "provider missing typed order intent boundary")
    require(provider, r"stale:age>2000", "provider must expire elapsed freshness")
    require(provider, r"function captureAdapter\(", "provider missing capture boundary")
    require(fixture, re.escape(LABEL), "fixture missing exact simulation label")
    require(fixture, r"mode:'offline_readonly',label:LABEL", "fixture mode must be explicit")
    require(fixture, r"const snapshot=Object\.freeze\(", "fixture snapshot must be frozen")
    forbidden_runtime = r"\b(?:fetch|WebSocket|XMLHttpRequest|localStorage|sessionStorage)\b"
    if re.search(forbidden_runtime, provider + fixture):
        fail("perp adapters may not create network or storage infrastructure")
    forbidden_signing = r"\b(?:privateKey|signTypedData|eth_sendTransaction|sendTransaction)\b"
    if re.search(forbidden_signing, provider + fixture):
        fail("perp adapters may not implement signing")
    if re.search(r"(?:xyz:|HIP-3 enabled|builder_fee[^\n]*[1-9])", provider + fixture, re.I):
        fail("HIP-3 or builder fee escaped the Core-only boundary")

    app = read("src/app.js")
    for name in SCREENS:
        require(app, rf"['\"]{re.escape(name)}['\"]\s*:\s*\{{screen:['\"]scr-{re.escape(name)}['\"]", f"route missing {name}")
    require(app, r"function openPerpSharedReview", "missing D4 to F11 bridge")
    require(app, r"openWalletReview\(['\"]review-perp['\"]", "D4 must use the existing F11 review")
    require(app, r"prepareMutationReview", "app must consult provider mutation gate")
    require(app, r"function renderPerpPositions\(\)", "D5 must consume adapter DTOs")
    require(app, r"function renderPerpOrders\(\)", "D6 must consume adapter DTOs")
    require(app, r"function renderPerpPosition\(\)", "D7 must consume adapter DTOs")
    require(app, r"perpIntentProvider:currentPerpIntentForReview",
            "F11 must receive the immutable typed Perp intent")
    require(app, r"meta\.age_ms>PERP_MAX_AGE_MS\|\|\s*meta\.stale!==false",
            "app must reject stale Perp DTOs")
    require(app, r"function projectPerpAdapterValue\(method,value,request\)",
            "app missing method-specific nested DTO projection boundary")
    require(app, r"function projectPerpAdapterRequest\(method,value\)",
            "app missing exact canonical request projector for all adapter methods")
    require(app, r"const canonicalRequest=projectPerpAdapterRequest\(method,request\)",
            "adapter invocation must use only a canonical projected request")
    require(app, r"const projected=projectPerpAdapterValue\(method,envelope\.value,canonicalRequest\)",
            "UI must consume only a canonical projected adapter value")
    require(app, r"const projected=projectPerpMarket\(value\);\s*if\(!projected\|\|projected\.coin!==request\.coin\)",
            "market response must bind the exact requested Core coin")
    require(app, r"projected\.id!==request\.position_id",
            "position response must bind the exact requested position identity")
    for field in ("market", "side", "order_type", "size", "leverage", "reduce_only"):
        request_field = "coin" if field == "market" else field
        require(app, rf"intent\.{field}!==request\.{request_field}",
                f"typed intent response must bind request field {request_field}")
    for projector in ("projectPerpMarkets", "projectPerpMarket",
                      "projectPerpPositions", "projectPerpOrders",
                      "projectPerpPosition", "projectPerpIntent"):
        require(app, rf"function {projector}\(",
                f"app missing exact nested DTO decoder {projector}")
    require(app, r"function projectPerpMutationBinding\(value,expected\)",
            "prepareMutationReview missing exact Core/revision binding projector")
    require(app, r"function projectPerpMutationRequest\(value\)",
            "prepareMutationReview request must cross an exact canonical projector")
    require(app, r"function projectPerpMutationDecision\(value,expected\)",
            "prepareMutationReview missing exact descriptor-safe decision projector")
    require(app, r"const projected=projectPerpMutationDecision\(raw,request\)",
            "prepareMutationReview result must cross its canonical projector")
    require(app, r"const raw=perpReadAdapter\.prepareMutationReview\(request\)",
            "app must invoke only the captured mutation review method")
    require(app, r"binding\.intent_revision!==expected\.intent_revision",
            "prepareMutationReview must bind the exact intent revision")
    require(app, r"!perpCoreCoin\(binding\.coin\)",
            "prepareMutationReview must enforce the Core allowlist")
    if "PERP_DISPLAY" in app:
        fail("app must not maintain a parallel static Perp market truth")
    wallet_review = read("src/wallet-review.js")
    require(wallet_review, r"function perpFixture\(intent\)",
            "F11 must build its source from the validated typed intent")
    require(wallet_review, r"perpIntentProvider", "F11 missing typed intent provider")
    if len(re.findall(r'id="review-dialog"', "\n".join(fragments.values()))) != 0:
        fail("perp slice introduced another review dialog")
    shell = read("src/shell-close.html")
    if shell.count('id="review-dialog"') != 1:
        fail("F11 must remain the one shared review surface")
    require(app, r"length>26", "F11 stack safety cap must remain 26")

    css = read("src/style.css")
    require(css, r"\.perp-touch[^\{]*\{[^}]*min-height:\s*(?:4[4-9]|[5-9]\d)px",
            "perp controls must be at least 44px")
    require(css, r"@media\s*\(prefers-reduced-motion:\s*reduce\)", "missing reduced-motion handling")
    require(css, r"@media\s*\(min-width:\s*\d+px\)", "missing desktop layout")

    market = read("src/screens/market.html")
    require(market, r"goPerpMarkets", "market screen missing Perp entry")

    combined = "\n".join(fragments.values()) + "\n" + app
    if re.search(r"(?:approveBuilderFee|perpDeploy|agentSetAbstraction|userSetAbstraction)", combined):
        fail("forbidden Hyperliquid capability referenced by UI")


MUTATIONS = (
    ("src/perp-read-provider.js", "PENDING_default_deny", "approved"),
    ("src/perp-read-provider.js", "HIP-3", "HIP3"),
    ("src/perp-read-provider.js", "prepareMutationReview", "prepareOrder"),
    ("src/perp-read-provider.js", "prepareOrderIntent", "makeOrderIntent"),
    ("src/perp-read-provider.js", "stale:age>2000", "stale:false"),
    ("src/perp-read-provider.js", "captureAdapter", "captureAny"),
    ("src/perp-offline-fixture.js", "offline_readonly", "production"),
    ("src/perp-offline-fixture.js", LABEL, "Hyperliquid connected"),
    ("src/perp-offline-fixture.js", "Object.freeze", "Object.seal"),
    ("src/screens/perp-confirm.html", "Builder fee", "Partner fee"),
    ("src/screens/perp-confirm.html", "Disabled", "0.05%"),
    ("src/screens/perp-confirm.html", "unknown submission", "submission"),
    ("src/screens/perp-confirm.html", 'id="perp-shared-review"', 'id="perp-confirm-now"'),
    ("src/screens/perp-position.html", "Review close", "Close now"),
    ("src/screens/market.html", "goPerpMarkets", "openPerps"),
    ("src/app.js", "openWalletReview('review-perp'", "openWalletReview('review-swap-fresh'"),
    ("src/app.js", "const raw=perpReadAdapter.prepareMutationReview(request)",
     "const raw=perpReadAdapter.prepareOrder(request)"),
    ("src/app.js", "perpIntentProvider:currentPerpIntentForReview",
     "perpDraftProvider:currentPerpIntentForReview"),
    ("src/app.js", "meta.stale!==false", "meta.stale===false"),
    ("src/app.js", "function projectPerpAdapterRequest(method,value)",
     "function trustPerpAdapterRequest(method,value)"),
    ("src/app.js", "function projectPerpAdapterValue(method,value,request)",
     "function trustPerpAdapterValue(method,value,request)"),
    ("src/app.js", "const canonicalRequest=projectPerpAdapterRequest(method,request)",
     "const canonicalRequest=request"),
    ("src/app.js", "const projected=projectPerpAdapterValue(method,envelope.value,canonicalRequest)",
     "const projected=result.value"),
    ("src/app.js", "projected.coin!==request.coin", "projected.coin===request.coin"),
    ("src/app.js", "projected.id!==request.position_id",
     "projected.id===request.position_id"),
    ("src/app.js", "intent.size!==request.size", "intent.size===request.size"),
    ("src/app.js", "intent.leverage!==request.leverage",
     "intent.leverage===request.leverage"),
    ("src/app.js", "function projectPerpMarkets(", "function trustPerpMarkets("),
    ("src/app.js", "function projectPerpMarket(", "function trustPerpMarket("),
    ("src/app.js", "function projectPerpPositions(", "function trustPerpPositions("),
    ("src/app.js", "function projectPerpOrders(", "function trustPerpOrders("),
    ("src/app.js", "function projectPerpPosition(", "function trustPerpPosition("),
    ("src/app.js", "function projectPerpIntent(", "function trustPerpIntent("),
    ("src/app.js", "function projectPerpMutationBinding(value,expected)",
     "function trustPerpMutationBinding(value,expected)"),
    ("src/app.js", "function projectPerpMutationRequest(value)",
     "function trustPerpMutationRequest(value)"),
    ("src/app.js", "function projectPerpMutationDecision(value,expected)",
     "function trustPerpMutationDecision(value,expected)"),
    ("src/app.js", "const projected=projectPerpMutationDecision(raw,request)",
     "const projected=raw"),
    ("src/app.js", "binding.intent_revision!==expected.intent_revision",
     "binding.intent_revision===expected.intent_revision"),
    ("src/app.js", "!perpCoreCoin(binding.coin)", "perpCoreCoin(binding.coin)"),
    ("src/app.js", "function renderPerpPositions()", "function renderCachedPositions()"),
    ("src/wallet-review.js", "function perpFixture(intent)", "function perpFixture()"),
    ("src/style.css", ".perp-touch{min-height:46px}", ".perp-touch{min-height:42px}"),
)


def run_mutations() -> None:
    verify()
    killed = 0
    for relative, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix="loop-hyper-ui-mutant-") as temp:
            mutant = pathlib.Path(temp) / "repo"
            shutil.copytree(ROOT, mutant, ignore=shutil.ignore_patterns(".git", "app.html", "docs.html", "._*"))
            path = mutant / relative
            text = path.read_text()
            if old not in text:
                fail(f"mutation token missing: {relative}: {old}")
            path.write_text(text.replace(old, new, 1))
            completed = subprocess.run(
                [sys.executable, str(mutant / "_tmp/verify_hyperliquid_ui.py")],
                cwd=mutant, capture_output=True, text=True,
            )
            if completed.returncode == 0:
                fail(f"surviving mutation: {relative}: {old} -> {new}")
            killed += 1
    print(f"Hyperliquid D1-D7 UI contract: VERIFIED ({killed}/{len(MUTATIONS)} mutations killed)")


def run_runtime() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        fail(f"Playwright unavailable: {error}")
    routes = list(SCREENS)
    app_uri = (ROOT / "app.html").as_uri()
    eligible_uri = production_policy_test_app(ROOT).as_uri()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            def new_page(*, viewport):
                page = browser.new_page(viewport=viewport)
                page.add_init_script("""(()=>{
                  let realProvider=null;
                  Object.defineProperty(globalThis,'LoopHyperliquidAccount',{configurable:false,
                    set(value){realProvider=value},get(){
                      if(!realProvider)return undefined;
                      return Object.freeze({
                        createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                        createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                        captureAdapter(adapter){
                          const captured=realProvider.captureAdapter(adapter);
                          if(!captured)return null;
                          return Object.freeze({...captured,getRiskNotice(request){
                            const honest=captured.getRiskNotice(request);
                            if(honest?.ok!==true)return honest;
                            return Object.freeze({...honest,value:Object.freeze({...honest.value,
                              acknowledgement_required:false})});
                          }});
                        }
                      });
                    }});
                })()""")
                return page

            for width, height in ((375, 667), (1440, 900)):
                page = new_page(viewport={"width": width, "height": height})
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                for route in routes:
                    page.goto(f"{app_uri}#{route}")
                    page.wait_for_timeout(60)
                    state = page.evaluate(
                        """route => {
                          const active=[...document.querySelectorAll('.scr.active')].map(node=>node.id);
                          const screen=document.getElementById('scr-'+route);
                          const heights=[...screen.querySelectorAll('.perp-touch')]
                            .map(node=>node.getBoundingClientRect().height);
                          return {active,inert:screen.hasAttribute('inert'),
                            overflow:document.documentElement.scrollWidth>
                              document.documentElement.clientWidth,
                            undersized:heights.filter(value=>value<43.5)};
                        }""",
                        route,
                    )
                    if state != {"active": [f"scr-{route}"], "inert": False,
                                 "overflow": False, "undersized": []}:
                        fail(f"runtime layout {width}x{height} #{route}: {state}")
                review_page = new_page(viewport={"width": width, "height": height})
                review_page.on("pageerror", lambda error: errors.append(str(error)))
                review_page.goto(f"{app_uri}#perp-order")
                review_page.click("#perp-review-order")
                review_page.click("#perp-shared-review")
                review_page.wait_for_timeout(60)
                review = review_page.evaluate(
                    """() => {
                      const dialog=document.getElementById('review-dialog');
                      return {open:dialog.classList.contains('open'),
                        state:dialog.dataset.state,
                        status:document.getElementById('review-status').textContent,
                        reviewSurfaces:document.querySelectorAll('.review-dialog').length};
                    }"""
                )
                if not (not review["open"] and review["state"] in ("", "closed") and
                        review["reviewSurfaces"] == 1):
                    fail(f"F11 runtime bridge {width}x{height}: {review}")
                review_page.close()
                if errors:
                    fail(f"runtime page errors {width}x{height}: {errors}")
                page.close()

            canonical = new_page(viewport={"width": 375, "height": 667})
            canonical.goto(f"{app_uri}#perp-markets")
            canonical_state = canonical.evaluate(
                """() => {
                  const raw=perpReadAdapter.getMarketsSnapshot();
                  const projected=perpSnapshot('getMarketsSnapshot');
                  const request={kind:'order',coin:'ETH',
                    intent_revision:'fixture-revision-test'};
                  const rawDecision=perpReadAdapter.prepareMutationReview(request);
                  const projectedDecision=projectPerpMutationDecision(rawDecision,request);
                  return {differentEnvelope:projected!==raw,
                    differentArray:projected?.value!==raw.value,
                    differentRows:projected?.value.every((row,index)=>row!==raw.value[index]),
                    frozen:Object.isFrozen(projected)&&Object.isFrozen(projected?.meta)&&
                      Object.isFrozen(projected?.value)&&projected?.value.every(Object.isFrozen),
                    coins:projected?.value.map(row=>row.coin),
                    decisionDifferent:projectedDecision!==rawDecision&&
                      projectedDecision?.binding!==rawDecision.binding&&
                      projectedDecision?.error!==rawDecision.error&&
                      projectedDecision?.error.rechecks!==rawDecision.error.rechecks,
                    decisionFrozen:Object.isFrozen(projectedDecision)&&
                      Object.isFrozen(projectedDecision?.binding)&&
                      Object.isFrozen(projectedDecision?.error)&&
                      Object.isFrozen(projectedDecision?.error.rechecks),
                    decisionBinding:projectedDecision?.binding};
                }"""
            )
            if canonical_state != {"differentEnvelope": True, "differentArray": True,
                                    "differentRows": True, "frozen": True,
                                    "coins": ["BTC", "ETH", "SOL"],
                                    "decisionDifferent": True, "decisionFrozen": True,
                                    "decisionBinding": {"kind": "order", "coin": "ETH",
                                      "intent_revision": "fixture-revision-test"}}:
                fail(f"adapter boundary must return a fresh frozen canonical projection: "
                     f"{canonical_state}")
            canonical.close()

            unavailable = new_page(viewport={"width": 375, "height": 667})
            unavailable.add_init_script(
                """Object.defineProperty(globalThis,'LoopHyperliquidPerpOfflineFixture',
                {get(){return undefined},set(_value){},configurable:false})"""
            )
            unavailable_errors: list[str] = []
            unavailable.on("pageerror", lambda error: unavailable_errors.append(str(error)))
            for route in routes:
                unavailable.goto(f"{app_uri}#{route}")
                unavailable.wait_for_timeout(50)
                state = unavailable.evaluate(
                    """() => ({
                      facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim()).map(node=>node.textContent.trim()),
                      enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                        .filter(node=>!node.disabled).map(node=>node.id||node.textContent.trim()),
                      status:[...document.querySelectorAll('.scr.active [data-perp-provider-status]')]
                        .map(node=>node.textContent.trim()).join(' | ')
                    })"""
                )
                if state["facts"] or state["enabled"] or not re.search(
                        r"unavailable|PENDING|blocked", state["status"], re.I):
                    fail(f"provider unavailable must clear/disable #{route}: {state}")
            if unavailable_errors:
                fail(f"provider unavailable page errors: {unavailable_errors}")
            unavailable.close()

            missing = new_page(viewport={"width": 375, "height": 667})
            missing.add_init_script(
                """Object.defineProperty(globalThis,'LoopHyperliquidPerp',
                {get(){return undefined},set(_value){},configurable:false})"""
            )
            missing.goto(f"{app_uri}#perp-markets")
            missing_state = missing.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                    .filter(node=>!node.disabled).length})"""
            )
            if missing_state != {"facts": 0, "enabled": 0}:
                fail(f"missing provider must fail closed: {missing_state}")
            missing.close()

            malformed = new_page(viewport={"width": 375, "height": 667})
            malformed.add_init_script(
                """let realProvider=null;
                Object.defineProperty(globalThis,'LoopHyperliquidPerp',{configurable:false,
                  set(value){realProvider=value},get(){
                    if(!realProvider)return undefined;
                    const bad=()=>Object.freeze({ok:true,value:Object.freeze([]),
                      meta:Object.freeze({mode:'offline_readonly',
                        label:'Simulated Hyperliquid testnet fixture — no network, signing, or submission',
                        stale:false,partial:false,age_ms:'malformed'})});
                    return Object.freeze({
                      createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                      createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                      captureAdapter:()=>Object.freeze({getMarketsSnapshot:bad,
                        getMarketSnapshot:bad,getPositionsSnapshot:bad,getOrdersSnapshot:bad,
                        getPositionSnapshot:bad,prepareOrderIntent:bad,
                        prepareMutationReview:bad})});
                  }});"""
            )
            malformed.goto(f"{app_uri}#perp-markets")
            malformed_state = malformed.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                    .filter(node=>!node.disabled).length})"""
            )
            if malformed_state != {"facts": 0, "enabled": 0}:
                fail(f"malformed provider DTO must fail closed: {malformed_state}")
            malformed.close()

            malicious_values = (
                ("perp-markets", "getMarketsSnapshot", False),
                ("perp-market", "getMarketSnapshot", False),
                ("perp-positions", "getPositionsSnapshot", False),
                ("perp-orders", "getOrdersSnapshot", False),
                ("perp-position", "getPositionSnapshot", False),
                ("perp-order", "prepareOrderIntent", True),
            )
            for route, method, submit_draft in malicious_values:
                malicious = new_page(viewport={"width": 375, "height": 667})
                malicious_errors: list[str] = []
                malicious.on("pageerror", lambda error: malicious_errors.append(str(error)))
                malicious.add_init_script(
                    f"""(()=>{{
                      const target={json.dumps(method)};let realProvider=null;
                      globalThis.__perpGetterCalled=false;
                      const meta=Object.freeze({{source:'hyperliquid_offline_fixture',
                        mode:'offline_readonly',network:'testnet',label:{json.dumps(LABEL)},
                        fetched_at_ms:0,age_ms:10,stale:false,partial:false}});
                      const market={{coin:'ETH',display_name:'Ethereum',mark_px:'3842.1',
                        change_24h:'3.82',volume_24h:'684000000',funding:'0.00008',
                        open_interest:'446000000',best_bid:'3842.0',best_ask:'3842.1',
                        freshness_ms:420,source_revision:'fixture-epoch-1:42:eth'}};
                      function badValue(){{
                        if(target==='getMarketsSnapshot')return [{{...market,coin:'xyz:HIP3',
                          display_name:'Injected market'}}];
                        if(target==='getMarketSnapshot'){{
                          const value={{...market}};delete value.coin;
                          Object.defineProperty(value,'coin',{{enumerable:true,
                            get(){{globalThis.__perpGetterCalled=true;return 'ETH'}}}});
                          return value;
                        }}
                        if(target==='getPositionsSnapshot'){{
                          const row={{id:'duplicate-position',coin:'ETH',side:'long',size:'1.25',
                            entry_px:'3700',mark_px:'3842.1',leverage:'20',margin:'240.13',
                            unrealized_pnl:'177.62',liquidation_px:'3500',freshness_ms:10,
                            source_revision:'malicious-position'}};
                          return [row,{{...row}}];
                        }}
                        if(target==='getOrdersSnapshot')return [{{id:'bad-order',coin:'ETH',
                          side:'buy',type:'Limit',size:'1.25',price:'1e309',status:'Open',
                          filled_size:'0',created_label:'Now',freshness_ms:10,
                          source_revision:'malicious-order'}}];
                        if(target==='getPositionSnapshot')return {{id:'hip3-position',
                          coin:'xyz:HIP3',side:'long',size:'1.25',entry_px:'3700',
                          mark_px:'3842.1',leverage:'20',margin:'240.13',
                          unrealized_pnl:'177.62',liquidation_px:'3500',freshness_ms:10,
                          source_revision:'malicious-position'}};
                        return {{market:'ETH',side:'buy',order_type:'market',size:'1e309',
                          leverage:'20',reduce_only:false,mark_px:'3842.1',
                          margin_estimate:'Unavailable in read-only fixture',
                          trading_fee_estimate:'Unavailable in read-only fixture',
                          builder_fee:'0.00',
                          liquidation_estimate:'Unavailable in read-only fixture',
                          freshness_ms:10,source_revision:'fixture-epoch-1:42:eth',
                          intent_revision:'malicious-intent',unknown_key:'must-reject'}};
                      }}
                      Object.defineProperty(globalThis,'LoopHyperliquidPerp',{{configurable:false,
                        set(value){{realProvider=value}},get(){{
                          if(!realProvider)return undefined;
                          return Object.freeze({{
                            createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                            createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                            captureAdapter(adapter){{
                              const methods=['getMarketsSnapshot','getMarketSnapshot',
                                'getPositionsSnapshot','getOrdersSnapshot','getPositionSnapshot',
                                'prepareOrderIntent','prepareMutationReview'];
                              return Object.freeze(Object.fromEntries(methods.map(name=>[name,
                                request=>name===target?Object.freeze({{ok:true,
                                  value:badValue(),meta}}):adapter[name](request)])));
                            }}
                          }});
                        }}}});
                    }})()"""
                )
                malicious.goto(f"{app_uri}#{route}")
                malicious.wait_for_timeout(50)
                if submit_draft:
                    malicious.fill("#perp-order-size", "1.25")
                    malicious.locator("#perp-leverage").evaluate(
                        """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
                    )
                    malicious.click("#perp-review-order")
                    malicious.wait_for_timeout(30)
                malicious_state = malicious.evaluate(
                    """() => ({route:location.hash,facts:
                      [...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim())
                        .map(node=>node.textContent.trim()),
                      enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                        .filter(node=>!node.disabled).map(node=>node.id||node.textContent.trim()),
                      status:[...document.querySelectorAll('.scr.active [data-perp-provider-status]')]
                        .map(node=>node.textContent.trim()).join(' | '),
                      getterCalled:globalThis.__perpGetterCalled})"""
                )
                if (malicious_state["facts"] or malicious_state["enabled"] or
                        malicious_state["getterCalled"] or not re.search(
                            r"unavailable|invalid|blocked|malformed",
                            malicious_state["status"], re.I)):
                    fail(f"valid meta + malicious {method} value must fail closed: "
                         f"{malicious_state}")
                if malicious_errors:
                    fail(f"malicious {method} value page errors: {malicious_errors}")
                malicious.close()

            mismatched_responses = (
                ("perp-market", "getMarketSnapshot", False),
                ("perp-position", "getPositionSnapshot", False),
                ("perp-order", "prepareOrderIntent", True),
            )
            for route, method, submit_draft in mismatched_responses:
                mismatch = new_page(viewport={"width": 375, "height": 667})
                mismatch_errors: list[str] = []
                mismatch.on("pageerror", lambda error: mismatch_errors.append(str(error)))
                mismatch.add_init_script(
                    f"""(()=>{{
                      const target={json.dumps(method)};let realProvider=null;
                      Object.defineProperty(globalThis,'LoopHyperliquidPerp',{{configurable:false,
                        set(value){{realProvider=value}},get(){{
                          if(!realProvider)return undefined;
                          return Object.freeze({{
                            createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                            createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                            captureAdapter(adapter){{
                              const methods=['getMarketsSnapshot','getMarketSnapshot',
                                'getPositionsSnapshot','getOrdersSnapshot','getPositionSnapshot',
                                'prepareOrderIntent','prepareMutationReview'];
                              return Object.freeze(Object.fromEntries(methods.map(name=>[name,
                                request=>{{
                                  if(name!==target)return adapter[name](request);
                                  if(target==='getMarketSnapshot')
                                    return adapter.getMarketSnapshot({{coin:'BTC'}});
                                  const honest=adapter[name](request);
                                  if(target==='getPositionSnapshot')return Object.freeze({{
                                    ok:true,value:Object.freeze({{...honest.value,
                                      id:'position-other-valid'}}),meta:honest.meta}});
                                  return Object.freeze({{ok:true,value:Object.freeze({{
                                    ...honest.value,size:'9.99',leverage:'1',
                                    intent_revision:'fixture-order:'+
                                      honest.value.source_revision+':9.99:1'}}),meta:honest.meta}});
                                }}])));
                            }}
                          }});
                        }}}});
                    }})()"""
                )
                mismatch.goto(f"{eligible_uri}#{route}")
                mismatch.wait_for_timeout(40)
                if submit_draft:
                    mismatch.fill("#perp-order-size", "1.25")
                    mismatch.locator("#perp-leverage").evaluate(
                        """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
                    )
                    mismatch.click("#perp-review-order")
                    mismatch.wait_for_timeout(30)
                    mismatch.evaluate(
                        """() => document.getElementById('perp-shared-review')?.click()"""
                    )
                    mismatch.wait_for_timeout(30)
                mismatch_state = mismatch.evaluate(
                    """() => ({route:location.hash,
                      facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim()).length,
                      enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                        .filter(node=>!node.disabled).length,
                      status:[...document.querySelectorAll('.scr.active [data-perp-provider-status]')]
                        .map(node=>node.textContent.trim()).join(' | '),
                      reviewOpen:document.getElementById('review-dialog').classList.contains('open'),
                      reviewText:document.getElementById('review-fields').textContent})"""
                )
                if (mismatch_state["facts"] or mismatch_state["enabled"] or
                        mismatch_state["reviewOpen"] or "9.99" in mismatch_state["reviewText"] or
                        not re.search(r"invalid|malformed|blocked", mismatch_state["status"], re.I)):
                    fail(f"valid but mismatched {method} response must fail closed: "
                         f"{mismatch_state}")
                if mismatch_errors:
                    fail(f"mismatched {method} response errors: {mismatch_errors}")
                mismatch.close()

            request_page = new_page(viewport={"width": 375, "height": 667})
            request_page.goto(f"{app_uri}#perp-markets")
            unexpected_request = request_page.evaluate(
                """() => ({markets:perpSnapshot('getMarketsSnapshot',{coin:'ETH'}),
                  positions:perpSnapshot('getPositionsSnapshot',{coin:'ETH'}),
                  orders:perpSnapshot('getOrdersSnapshot',{coin:'ETH'})})"""
            )
            if unexpected_request != {"markets": None, "positions": None, "orders": None}:
                fail(f"no-request methods must reject injected request identity: {unexpected_request}")
            request_page.close()

            stale = new_page(viewport={"width": 375, "height": 667})
            stale.add_init_script(
                """globalThis.__perpTestNow=0;
                Object.defineProperty(performance,'now',
                  {value:()=>globalThis.__perpTestNow,configurable:false})"""
            )
            stale.goto(f"{app_uri}#perp-markets")
            fresh_count = stale.locator(".scr.active [data-perp-provider-fact]:not([hidden])").count()
            if fresh_count == 0:
                fail("fake-clock fixture did not begin fresh")
            stale.evaluate("""() => {globalThis.__perpTestNow=2501;render()}""")
            for route in routes:
                stale.evaluate("route=>{location.hash=route}", route)
                stale.wait_for_timeout(30)
                stale_state = stale.evaluate(
                    """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim()).length,
                      enabled:[...document.querySelectorAll('.scr.active [data-perp-provider-action]')]
                        .filter(node=>!node.disabled).length})"""
                )
                if stale_state != {"facts": 0, "enabled": 0}:
                    fail(f"elapsed freshness must clear/disable #{route}: {stale_state}")
            stale.close()

            mutation_decision_cases = (
                "outer_unknown", "binding_unknown", "nested_unknown", "outer_accessor",
                "accessor_code", "retryable_type", "hip3_core", "revision_drift",
                "custom_copy",
            )
            for decision_case in mutation_decision_cases:
                decision_page = new_page(viewport={"width": 375, "height": 667})
                decision_errors: list[str] = []
                decision_page.on("pageerror", lambda error: decision_errors.append(str(error)))
                decision_page.add_init_script(
                    f"""(()=>{{
                      const badCase={json.dumps(decision_case)};let realProvider=null;
                      globalThis.__perpMutationGetterCalled=false;
                      const message='Trading is unavailable until Hyperliquid credentials, eligibility evidence, and the Privy signer handoff are approved.';
                      const rechecks=['region','eligibility','policy','nonce','unknown submission'];
                      function bad(request){{
                        const binding={{kind:'order',coin:'ETH',
                          intent_revision:request.intent_revision}};
                        const error={{code:'PENDING_default_deny',retryable:false,
                          safe_message:message,rechecks:[...rechecks]}};
                        if(badCase==='outer_unknown')return {{ok:false,binding,error,
                          unknown_outer:'reject'}};
                        if(badCase==='binding_unknown')return {{ok:false,
                          binding:{{...binding,unknown_binding:'reject'}},error}};
                        if(badCase==='nested_unknown')return {{ok:false,binding,
                          error:{{...error,unknown_nested:'reject'}}}};
                        if(badCase==='outer_accessor'){{
                          const result={{binding,error}};
                          Object.defineProperty(result,'ok',{{enumerable:true,get(){{
                            globalThis.__perpMutationGetterCalled=true;return false;
                          }}}});
                          return result;
                        }}
                        if(badCase==='accessor_code'){{
                          delete error.code;
                          Object.defineProperty(error,'code',{{enumerable:true,get(){{
                            globalThis.__perpMutationGetterCalled=true;
                            return 'PENDING_default_deny';
                          }}}});
                          return {{ok:false,binding,error}};
                        }}
                        if(badCase==='retryable_type')return {{ok:false,binding,
                          error:{{...error,retryable:'false'}}}};
                        if(badCase==='hip3_core')return {{ok:false,
                          binding:{{...binding,coin:'xyz:HIP3'}},error}};
                        if(badCase==='revision_drift')return {{ok:false,
                          binding:{{...binding,intent_revision:'attacker-revision'}},error}};
                        return {{ok:false,binding,error:{{...error,
                          safe_message:'PROVIDER_INJECTED_COPY'}}}};
                      }}
                      Object.defineProperty(globalThis,'LoopHyperliquidPerp',{{configurable:false,
                        set(value){{realProvider=value}},get(){{
                          if(!realProvider)return undefined;
                          return Object.freeze({{
                            createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                            createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                            captureAdapter(adapter){{
                              const methods=['getMarketsSnapshot','getMarketSnapshot',
                                'getPositionsSnapshot','getOrdersSnapshot','getPositionSnapshot',
                                'prepareOrderIntent','prepareMutationReview'];
                              return Object.freeze(Object.fromEntries(methods.map(name=>[name,
                                request=>name==='prepareMutationReview'?bad(request):
                                  adapter[name](request)])));
                            }}
                          }});
                        }}}});
                    }})()"""
                )
                decision_page.goto(f"{eligible_uri}#perp-order")
                decision_page.fill("#perp-order-size", "1.25")
                decision_page.locator("#perp-leverage").evaluate(
                    """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
                )
                decision_page.click("#perp-review-order")
                decision_page.click("#perp-shared-review")
                decision_page.wait_for_timeout(40)
                decision_state = decision_page.evaluate(
                    """() => ({open:document.getElementById('review-dialog').classList.contains('open'),
                      state:document.getElementById('review-dialog').dataset.state,
                      providerStatus:document.getElementById('perp-review-status').textContent,
                      reviewStatus:document.getElementById('review-status').textContent,
                      body:document.body.textContent.includes('PROVIDER_INJECTED_COPY'),
                      getterCalled:globalThis.__perpMutationGetterCalled})"""
                )
                if (decision_state["open"] or decision_state["state"] not in (None, "", "closed") or
                        decision_state["body"] or decision_state["getterCalled"] or
                        not re.search(r"unavailable|blocked", decision_state["providerStatus"], re.I)):
                    fail(f"malicious prepareMutationReview {decision_case} must fail before F11: "
                         f"{decision_state}")
                if decision_errors:
                    fail(f"malicious prepareMutationReview {decision_case} errors: {decision_errors}")
                decision_page.close()

            intent_page = new_page(viewport={"width": 375, "height": 667})
            intent_errors: list[str] = []
            intent_page.on("pageerror", lambda error: intent_errors.append(str(error)))
            intent_page.goto(f"{eligible_uri}#perp-order")
            intent_page.fill("#perp-order-size", "1.25")
            intent_page.locator("#perp-leverage").evaluate(
                """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
            )
            intent_page.click("#perp-review-order")
            d4 = intent_page.evaluate(
                """() => ({hash:location.hash,
                  size:document.querySelector('[data-perp-confirm-size]').textContent,
                  leverage:document.querySelector('[data-perp-confirm-leverage]').textContent,
                  reviewDisabled:document.getElementById('perp-shared-review').disabled})"""
            )
            if d4 != {"hash": "#perp-confirm", "size": "1.25 ETH",
                      "leverage": "20× isolated", "reviewDisabled": False}:
                fail(f"typed intent drifted between D3 and D4: {d4}")
            intent_page.click("#perp-shared-review")
            intent_page.wait_for_timeout(50)
            f11 = intent_page.evaluate(
                """() => ({open:document.getElementById('review-dialog').classList.contains('open'),
                  state:document.getElementById('review-dialog').dataset.state,
                  fields:Object.fromEntries([...document.querySelectorAll('#review-fields .review-field')]
                    .map(row=>[row.querySelector('dt').textContent,
                      row.querySelector('dd').firstChild.nodeValue]))})"""
            )
            if not (f11["open"] and f11["state"] == "blocked" and
                    f11["fields"].get("Size") == "1.25" and
                    f11["fields"].get("Leverage") == "20×"):
                fail(f"typed intent drifted between D4 and F11: {f11}")
            intent_page.click("#review-cancel")
            intent_page.wait_for_timeout(80)
            intent_page.go_back()
            intent_page.wait_for_timeout(50)
            intent_page.fill("#perp-order-size", "0.50")
            intent_page.go_forward()
            intent_page.wait_for_timeout(50)
            invalidated = intent_page.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  disabled:document.getElementById('perp-shared-review').disabled,
                  status:document.querySelector('.scr.active [data-perp-provider-status]').textContent})"""
            )
            if invalidated["facts"] or not invalidated["disabled"] or not re.search(
                    r"unavailable|changed|blocked", invalidated["status"], re.I):
                fail(f"back/forward draft mutation must invalidate intent: {invalidated}")
            intent_page.goto(f"{eligible_uri}?size=9.99&leverage=50#perp-confirm")
            injected = intent_page.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  disabled:document.getElementById('perp-shared-review').disabled})"""
            )
            if injected != {"facts": 0, "disabled": True}:
                fail(f"URL injection must not create a Perp intent: {injected}")
            intent_page.goto(f"{eligible_uri}#perp-order")
            intent_page.fill("#perp-order-size", "1.25")
            intent_page.locator("#perp-leverage").evaluate(
                """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
            )
            intent_page.click("#perp-review-order")
            intent_page.reload()
            reloaded = intent_page.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  disabled:document.getElementById('perp-shared-review').disabled})"""
            )
            if reloaded != {"facts": 0, "disabled": True}:
                fail(f"reload must discard unpersisted Perp intent: {reloaded}")
            intent_page.goto(f"{eligible_uri}#perp-order")
            intent_page.fill("#perp-order-size", "1.25")
            intent_page.locator("#perp-leverage").evaluate(
                """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
            )
            intent_page.click("#perp-review-order")
            intent_page.evaluate(
                """() => {perpViewState.intent=Object.freeze({...perpViewState.intent,
                  source_revision:'stale-revision'});render()}"""
            )
            stale_revision = intent_page.evaluate(
                """() => ({facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  disabled:document.getElementById('perp-shared-review').disabled})"""
            )
            if stale_revision != {"facts": 0, "disabled": True}:
                fail(f"stale revision must invalidate intent: {stale_revision}")
            intent_page.goto(f"{eligible_uri}#perp-order")
            intent_page.fill("#perp-order-size", "1.25")
            intent_page.locator("#perp-leverage").evaluate(
                """node=>{node.value='20';node.dispatchEvent(new Event('input',{bubbles:true}))}"""
            )
            intent_page.click("#perp-review-order")
            intent_page.goto("about:blank")
            intent_page.go_back()
            bfcache = intent_page.evaluate(
                """() => ({size:document.querySelector('[data-perp-confirm-size]')?.textContent||'',
                  leverage:document.querySelector('[data-perp-confirm-leverage]')?.textContent||'',
                  facts:[...document.querySelectorAll('.scr.active [data-perp-provider-fact]')]
                    .filter(node=>!node.hidden&&node.textContent.trim()).length,
                  disabled:document.getElementById('perp-shared-review').disabled})"""
            )
            preserved = bfcache["size"] == "1.25 ETH" and bfcache["leverage"] == "20× isolated" and not bfcache["disabled"]
            blocked = bfcache["facts"] == 0 and bfcache["disabled"]
            if not (preserved or blocked):
                fail(f"BFCache must preserve the exact intent or fail closed: {bfcache}")
            if intent_errors:
                fail(f"typed intent page errors: {intent_errors}")
            intent_page.close()
        finally:
            browser.close()
    print("Hyperliquid D1-D7 runtime: VERIFIED (mobile + desktop + regional gate before single F11)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mutations", action="store_true")
    parser.add_argument("--runtime", action="store_true")
    args = parser.parse_args()
    try:
        if args.mutations:
            run_mutations()
        else:
            verify()
            print("Hyperliquid D1-D7 UI contract: VERIFIED")
        if args.runtime:
            run_runtime()
    except AssertionError as error:
        print(f"Hyperliquid D1-D7 UI contract: FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
