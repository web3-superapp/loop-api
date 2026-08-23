#!/usr/bin/env python3
"""Focused structural, mutation and runtime verifier for Hyperliquid D8-D12."""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCREENS = (
    "perp-account", "perp-transfer", "perp-deposit", "perp-funding",
    "perp-risk-notice",
)
SCRIPTS = ("perp-account-provider.js", "perp-account-offline-fixture.js")
METHODS = (
    "getMarginAccountSnapshot", "getTransferContext", "getBridgeContext",
    "getFundingSnapshot", "getRiskNotice", "prepareAccountIntent",
    "prepareMutationReview",
)
LABEL = "Simulated Hyperliquid account fixture — read-only, no network, signing, or submission"


def fail(message: str) -> None:
    raise AssertionError(message)


def read(relative: str, root: pathlib.Path = ROOT) -> str:
    path = root / relative
    if not path.is_file():
        fail(f"missing {relative}")
    return path.read_text()


def require(text: str, pattern: str, message: str) -> None:
    if re.search(pattern, text, re.MULTILINE | re.DOTALL) is None:
        fail(message)


def exact_expected_screens(root: pathlib.Path = ROOT) -> tuple[str, ...]:
    current = tuple(read("src/screens-order.txt", root).splitlines())
    if len(current) != 42:
        fail(f"screen manifest must pin exact pre-Stream count 42, got {len(current)}")
    if len(current) != len(set(current)):
        fail("screen manifest contains duplicates")
    expected_slice = (
        "perp-markets", "perp-market", "perp-order", "perp-confirm",
        "perp-positions", "perp-orders", "perp-position", *SCREENS,
    )
    start = current.index("perp-markets") if "perp-markets" in current else -1
    if start < 0 or current[start:start + len(expected_slice)] != expected_slice:
        fail("D1-D12 must be one exact contiguous routed slice")
    return current


def verify(root: pathlib.Path = ROOT) -> None:
    exact_expected_screens(root)
    scripts = tuple(read("src/scripts-order.txt", root).splitlines())
    if len(scripts) != 12 or len(scripts) != len(set(scripts)):
        fail("script manifest must pin exact pre-Stream count 12 without duplicates")
    if tuple(scripts[-5:]) != (
        "perp-read-provider.js", "perp-offline-fixture.js", *SCRIPTS, "app.js"
    ):
        fail("Hyperliquid providers/fixtures must be paired before app.js")

    fragments: dict[str, str] = {}
    screen_ids = {
        "perp-account": "scr-perp-account",
        "perp-transfer": "scr-perp-transfer",
        "perp-deposit": "scr-perp-deposit",
        "perp-funding": "scr-perp-funding",
        "perp-risk-notice": "scr-perp-risk-notice",
    }
    for name, screen_id in screen_ids.items():
        fragment = read(f"src/screens/{name}.html", root)
        fragments[name] = fragment
        require(fragment, rf'id="{screen_id}"', f"{name} exact screen id missing")
        require(fragment, r"data-perp-account-provider-status", f"{name} fail-closed status missing")
        if re.search(r"\$\s*\d|\b\d+(?:\.\d+)?\s*(?:USDC|ETH|BTC|SOL|%)", fragment):
            fail(f"{name} stores provider account truth in HTML")
    for name in ("perp-account", "perp-funding"):
        require(fragments[name], r"data-perp-account-provider-fact[^>]*hidden|hidden[^>]*data-perp-account-provider-fact",
                f"{name} provider fact hosts must begin empty")
    for name in ("perp-transfer", "perp-deposit", "perp-risk-notice"):
        require(fragments[name], r"data-perp-account-provider-action[^>]*disabled|disabled[^>]*data-perp-account-provider-action",
                f"{name} mutation actions must begin disabled")
    require(fragments["perp-transfer"], r"Spot.*Perp|Perp.*Spot", "D9 must identify official account transfer directions")
    require(fragments["perp-deposit"], r"official Hyperliquid bridge", "D10 must identify official bridge only")
    require(fragments["perp-deposit"], r"no custom router", "D10 must disclaim custom routing")
    require(fragments["perp-funding"], r"funding", "D11 funding semantics missing")
    require(fragments["perp-risk-notice"], r'type="checkbox"', "D12 mandatory acknowledgement missing")
    require(fragments["perp-risk-notice"], r"unchecked|not checked|must confirm", "D12 unchecked block copy missing")

    provider = read("src/perp-account-provider.js", root)
    fixture = read("src/perp-account-offline-fixture.js", root)
    app = read("src/app.js", root)
    style = read("src/style.css", root)
    build = read("build.py", root)
    for method in METHODS:
        require(provider, re.escape(method), f"provider missing {method}")
        require(app, re.escape(method), f"app missing {method} projection")
    for token in (
        "Object.getOwnPropertyDescriptors", "Reflect.ownKeys", "Object.freeze",
        "PENDING_default_deny", "CORE_COINS", "intent_revision",
        "source_revision", "freshness_ms",
    ):
        require(provider, re.escape(token), f"provider boundary missing {token}")
    require(provider, r"function captureAdapter\(value\)", "provider capture boundary missing")
    for token in (
        "projectPerpAccountAdapterRequest", "projectPerpAccountAdapterValue",
        "projectPerpAccountMeta", "projectPerpAccountMutationDecision",
        "PERP_ACCOUNT_MAX_AGE_MS", "currentPerpAccountIntentForReview",
        "perpRiskAcknowledgementRequired", "meta.age_ms<elapsed",
        "renderPerpAccountScreen(activeScr())",
        "if(!intentOrigins.includes(screen))invalidatePerpAccountIntent()",
        "riskRequired!==false",
    ):
        require(app, re.escape(token), f"app projector missing {token}")
    require(provider, re.escape("amount<minimum||amount>available"),
            "provider must bind transfer amount to minimum and available balance")
    precision_anchor = "const units=BigInt(whole)*1000000n+BigInt"
    require(provider, re.escape(precision_anchor),
            "provider must compare USDC as exact six-decimal base units")
    require(app, re.escape(precision_anchor),
            "app must independently compare USDC as exact six-decimal base units")
    require(fixture, re.escape(LABEL), "offline fixture exact label missing")
    require(fixture, r"mode:'offline_readonly'", "offline fixture mode missing")
    require(provider, r"stale:age>2000", "freshness must expire with current time")
    require(build, r"exact pinned 42-screen order", "builder must lock exact 42 screens")
    require(build, r"exact pinned twelve-script order", "builder must lock exact 12 scripts")
    require(style, r"\.perp-account-touch[^\{]*\{[^\}]*min-height:(?:44|4[5-9]|[5-9]\d)px",
            "D8-D12 controls must be at least 44px")
    require(style, r"prefers-reduced-motion", "reduced motion support missing")

    combined = "\n".join((provider, fixture, *fragments.values()))
    forbidden = {
        "HIP-3 adapter": r"(?:enable|allow|support)[^\n]{0,40}HIP-3",
        "builder fee": r"approveBuilderFee|builder[_ -]?fee\s*[:=]\s*(?!['\"]?0)",
        "custom ledger": r"create(?:Custom)?Ledger|class\s+Ledger",
        "custom bridge/router": r"class\s+(?:Bridge|Router)|create(?:Bridge|Router)",
        "second dialog": r'id="(?:perp|hyper)[^"]*(?:dialog|modal|sheet)"',
        "signer": r"private[_ -]?key|signTypedData|eth_signTypedData",
    }
    for label, pattern in forbidden.items():
        if re.search(pattern, combined, re.I):
            fail(f"forbidden {label} found")


def mutate(relative: str, old: str, new: str, label: str) -> None:
    with tempfile.TemporaryDirectory(prefix="hyper-account-ui-mutation-") as directory:
        case = pathlib.Path(directory) / "repo"
        shutil.copytree(ROOT, case, symlinks=True)
        path = case / relative
        text = path.read_text()
        if old not in text:
            fail(f"mutation anchor missing: {label}")
        path.write_text(text.replace(old, new, 1))
        try:
            verify(case)
        except AssertionError:
            return
        fail(f"mutation survived: {label}")


def run_mutations() -> None:
    cases = (
        ("src/screens-order.txt", "perp-account\n", "", "missing D8 route"),
        ("src/scripts-order.txt", "perp-account-provider.js\n", "", "missing provider"),
        ("src/perp-account-provider.js", "PENDING_default_deny", "approved", "default allow"),
        ("src/perp-account-provider.js", "stale:age>2000", "stale:false", "freshness bypass"),
        ("src/perp-account-provider.js", "captureAdapter", "captureAny", "uncaptured adapter"),
        ("src/screens/perp-deposit.html", "no custom router", "fast routing", "custom router disclaimer"),
        ("src/screens/perp-risk-notice.html", 'type="checkbox"', 'type="text"', "risk acknowledgement"),
        ("src/style.css", ".perp-account-touch{min-height:46px}",
         ".perp-account-touch{min-height:32px}", "touch target"),
        ("src/app.js", "meta.age_ms<elapsed", "false", "self-reported freshness bypass"),
        ("src/perp-account-provider.js", "amount<minimum||amount>available",
         "false", "transfer amount bounds bypass"),
        ("src/app.js", "renderPerpAccountScreen(activeScr());",
         "clearPerpAccountTimer();", "persisted BFCache revalidation bypass"),
        ("src/app.js", "if(!intentOrigins.includes(screen))invalidatePerpAccountIntent();",
         "if(false)invalidatePerpAccountIntent();", "SPA intent retention"),
        ("src/app.js", "riskRequired!==false", "false", "D12 first-use gate bypass"),
        ("src/perp-account-provider.js", "const units=BigInt(whole)*1000000n+BigInt",
         "const units=Number(whole)*1000000+Number", "USDC precision downgrade"),
    )
    for case in cases:
        mutate(*case)
    print(f"Hyperliquid D8-D12 static mutations: VERIFIED ({len(cases)}/{len(cases)})")


def run_runtime() -> None:
    build = subprocess.run([sys.executable, "build.py"], cwd=ROOT, text=True,
                           capture_output=True)
    if build.returncode:
        fail(f"build failed: {(build.stderr or build.stdout).strip()}")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        fail(f"Playwright unavailable: {error}")
    uri = (ROOT / "app.html").as_uri()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for viewport in ({"width": 375, "height": 667}, {"width": 1280, "height": 900}):
                page = browser.new_page(viewport=viewport)
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                for route in SCREENS:
                    page.goto(f"{uri}#{route}")
                    page.wait_for_timeout(30)
                    state = page.evaluate("""() => ({hash:location.hash,
                      facts:[...document.querySelectorAll('.scr.active [data-perp-account-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim()).length,
                      controls:[...document.querySelectorAll('.scr.active button,.scr.active input,.scr.active select')]
                        .map(node=>({h:node.getBoundingClientRect().height,disabled:node.disabled}))})""")
                    if state["hash"] != f"#{route}":
                        fail(f"route drift for {route}: {state}")
                    if route in ("perp-account", "perp-funding") and state["facts"] == 0:
                        fail(f"explicit fixture did not project {route}")
                    if any(item["h"] and item["h"] < 44 for item in state["controls"]):
                        fail(f"small control in {route}: {state['controls']}")
                if errors:
                    fail(f"runtime page errors: {errors}")
                page.close()

            stale = browser.new_page(viewport={"width": 375, "height": 667})
            stale.add_init_script("""globalThis.__perpAccountTestNow=0;
              Object.defineProperty(performance,'now',
                {value:()=>globalThis.__perpAccountTestNow,configurable:false})""")
            stale.goto(f"{uri}#perp-account")
            stale.evaluate("""() => {globalThis.__perpAccountTestNow=2501;render()}""")
            stale_state = stale.evaluate("""() => ({
              facts:[...document.querySelectorAll('.scr.active [data-perp-account-provider-fact]')]
                .filter(node=>!node.hidden&&node.textContent.trim()).length,
              enabled:[...document.querySelectorAll('.scr.active [data-perp-account-provider-action]')]
                .filter(node=>!node.disabled).length})""")
            if stale_state != {"facts": 0, "enabled": 0}:
                fail(f"elapsed account facts did not fail closed: {stale_state}")
            stale.close()

            forged_age = browser.new_page(viewport={"width": 375, "height": 667})
            forged_age.add_init_script(
                f"""(()=>{{
                  Object.defineProperty(performance,'now',{{value:()=>100000,configurable:false}});
                  let realProvider=null;const methods={json.dumps(list(METHODS))};
                  Object.defineProperty(globalThis,'LoopHyperliquidAccount',{{configurable:false,
                    set(value){{realProvider=value}},get(){{
                      if(!realProvider)return undefined;
                      return Object.freeze({{
                        createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                        createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                        captureAdapter(adapter){{
                          return Object.freeze(Object.fromEntries(methods.map(name=>[name,request=>{{
                            const honest=adapter[name](request);
                            if(name!=='getMarginAccountSnapshot'||honest.ok!==true)return honest;
                            return Object.freeze({{...honest,meta:Object.freeze({{...honest.meta,
                              fetched_at_ms:0,age_ms:0,stale:false}})}});
                          }}])));
                        }}
                      }});
                    }}}});
                }})()"""
            )
            forged_age.goto(f"{uri}#perp-account")
            forged_age_state = forged_age.evaluate("""() => ({
              facts:[...document.querySelectorAll('.scr.active [data-perp-account-provider-fact]')]
                .filter(node=>!node.hidden&&node.textContent.trim()).length,
              enabled:[...document.querySelectorAll('.scr.active [data-perp-account-provider-action]')]
                .filter(node=>!node.disabled).length})""")
            if forged_age_state != {"facts": 0, "enabled": 0}:
                fail(f"self-reported fresh but old account meta must fail closed: {forged_age_state}")
            forged_age.close()

            bfcache = browser.new_page(viewport={"width": 375, "height": 667})
            bfcache.add_init_script("""globalThis.__perpAccountTestNow=0;
              Object.defineProperty(performance,'now',
                {value:()=>globalThis.__perpAccountTestNow,configurable:false})""")
            bfcache.goto(f"{uri}#perp-account")
            bfcache.evaluate("""() => {
              dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
              globalThis.__perpAccountTestNow=2501;
              dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
            }""")
            bfcache_state = bfcache.evaluate("""() => ({
              facts:[...document.querySelectorAll('.scr.active [data-perp-account-provider-fact]')]
                .filter(node=>!node.hidden&&node.textContent.trim()).length,
              enabled:[...document.querySelectorAll('.scr.active [data-perp-account-provider-action]')]
                .filter(node=>!node.disabled).length})""")
            if bfcache_state != {"facts": 0, "enabled": 0}:
                fail(f"persisted BFCache restore must revalidate and clear stale account facts: {bfcache_state}")
            bfcache.close()

            risk_gate = browser.new_page(viewport={"width": 375, "height": 667})
            risk_gate.goto(f"{uri}#perp-order")
            risk_gate.fill("#perp-order-size", "1.25")
            risk_gate.fill("#perp-leverage", "20")
            risk_gate.click("#perp-review-order")
            risk_gate_state = risk_gate.evaluate("""() => ({hash:location.hash,
              orderIntent:currentPerpIntent(),reviewOpen:
                document.getElementById('review-dialog').classList.contains('open')})""")
            if (risk_gate_state["hash"] != "#perp-risk-notice" or
                    risk_gate_state["orderIntent"] is not None or risk_gate_state["reviewOpen"]):
                fail(f"D12 acknowledgement must gate first D3 order review: {risk_gate_state}")
            risk_gate.close()

            malicious_methods = (
                ("getMarginAccountSnapshot", "perp-account", False),
                ("getTransferContext", "perp-transfer", False),
                ("getBridgeContext", "perp-deposit", False),
                ("getFundingSnapshot", "perp-funding", False),
                ("getRiskNotice", "perp-risk-notice", False),
                ("prepareAccountIntent", "perp-transfer", True),
                ("prepareMutationReview", "perp-transfer", True),
            )
            for method, route, submit in malicious_methods:
                bad_cases = ("unknown", "mismatch", "accessor", "type",
                             "outer_unknown", "outer_accessor")
                if method == "getFundingSnapshot":
                    bad_cases += ("hip3",)
                for bad_case in bad_cases:
                    page = browser.new_page(viewport={"width": 375, "height": 667})
                    errors: list[str] = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.add_init_script(
                        f"""(()=>{{
                          const target={json.dumps(method)},badCase={json.dumps(bad_case)};
                          let realProvider=null;globalThis.__perpAccountGetterCalled=false;
                          const methods={json.dumps(list(METHODS))};
                          function malformed(name,honest){{
                            if(badCase==='outer_unknown')return Object.freeze({{...honest,
                              unknown_outer:'reject'}});
                            if(badCase==='outer_accessor'){{
                              const outer={{...honest}};delete outer.ok;
                              Object.defineProperty(outer,'ok',{{enumerable:true,get(){{
                                globalThis.__perpAccountGetterCalled=true;return honest.ok;
                              }}}});return Object.freeze(outer);
                            }}
                            const key=name==='getFundingSnapshot'?'coin':
                              name==='prepareAccountIntent'?'amount':'account_ref';
                            if(name==='prepareMutationReview'){{
                              if(badCase==='unknown')return Object.freeze({{...honest,
                                binding:Object.freeze({{...honest.binding,unknown_nested:'reject'}})}});
                              if(badCase==='mismatch')return Object.freeze({{...honest,
                                binding:Object.freeze({{...honest.binding,amount:'9.99'}})}});
                              if(badCase==='type')return Object.freeze({{...honest,
                                binding:Object.freeze({{...honest.binding,amount:Object.freeze({{}})}})}});
                              const binding={{...honest.binding}};delete binding.amount;
                              Object.defineProperty(binding,'amount',{{enumerable:true,get(){{
                                globalThis.__perpAccountGetterCalled=true;return honest.binding.amount;
                              }}}});return Object.freeze({{...honest,binding}});
                            }}
                            const value={{...honest.value}};
                            if(badCase==='unknown'){{
                              if(name==='getFundingSnapshot')value.history=Object.freeze([
                                Object.freeze({{...value.history[0],unknown_nested:'reject'}}),
                                ...value.history.slice(1)]);
                              else if(name==='getRiskNotice')value.sections=Object.freeze([
                                Object.freeze({{...value.sections[0],unknown_nested:'reject'}}),
                                ...value.sections.slice(1)]);
                              else value.unknown_value='reject';
                            }}else if(badCase==='mismatch'){{
                              if(name==='getFundingSnapshot'){{value.coin='BTC';value.history=
                                Object.freeze(value.history.map(row=>Object.freeze({{...row,coin:'BTC'}})));}}
                              else if(name==='prepareAccountIntent'){{value.amount='9.99';
                                value.intent_revision='fixture-intent:usd_class_transfer:spot_to_perp:9.99:fixture-transfer-context-8';}}
                              else value.account_ref='fixture-account-other';
                            }}else if(badCase==='type'){{
                              value[key]=Object.freeze({{}});
                            }}else if(badCase==='hip3'){{
                              value.coin='xyz:HIP3';value.history=Object.freeze(
                                value.history.map(row=>Object.freeze({{...row,coin:'xyz:HIP3'}})));
                            }}else{{
                              delete value[key];Object.defineProperty(value,key,{{enumerable:true,get(){{
                                globalThis.__perpAccountGetterCalled=true;return honest.value[key];
                              }}}});
                            }}
                            return Object.freeze({{ok:true,value:Object.freeze(value),meta:honest.meta}});
                          }}
                          Object.defineProperty(globalThis,'LoopHyperliquidAccount',{{configurable:false,
                            set(value){{realProvider=value}},get(){{
                              if(!realProvider)return undefined;
                              return Object.freeze({{
                                createOfflineReadOnlyAdapter:realProvider.createOfflineReadOnlyAdapter,
                                createPendingProductionAdapter:realProvider.createPendingProductionAdapter,
                                captureAdapter(adapter){{
                                  return Object.freeze(Object.fromEntries(methods.map(name=>[name,request=>{{
                                    const honest=adapter[name](request);
                                    return name===target?malformed(name,honest):honest;
                                  }}])));
                                }}
                              }});
                            }}}});
                        }})()"""
                    )
                    page.goto(f"{uri}#{route}")
                    if submit:
                        page.fill("#perp-transfer-amount", "1.25")
                        page.click("#perp-transfer-review")
                    page.wait_for_timeout(30)
                    state = page.evaluate("""() => ({
                      facts:[...document.querySelectorAll('.scr.active [data-perp-account-provider-fact]')]
                        .filter(node=>!node.hidden&&node.textContent.trim()).length,
                      enabled:[...document.querySelectorAll('.scr.active [data-perp-account-provider-action]')]
                        .filter(node=>!node.disabled).length,
                      reviewOpen:document.getElementById('review-dialog').classList.contains('open'),
                      getterCalled:globalThis.__perpAccountGetterCalled,
                      status:[...document.querySelectorAll('.scr.active [role=status],.scr.active [data-perp-account-provider-status]')]
                        .map(node=>node.textContent).join(' | ')})""")
                    if (state["reviewOpen"] or state["getterCalled"] or
                            (not submit and (state["facts"] or state["enabled"])) or
                            not re.search(r"malformed|invalid|changed|blocked|unavailable",
                                          state["status"], re.I)):
                        fail(f"malicious {method}/{bad_case} must fail closed: {state}")
                    if errors:
                        fail(f"malicious {method}/{bad_case} page errors: {errors}")
                    page.close()

            intent_page = browser.new_page(viewport={"width": 375, "height": 667})
            intent_page.goto(f"{uri}#perp-transfer")
            for amount, label in (("0.999999999999999999", "rounded-below minimum"),
                                  ("4200.000000000000001", "rounded-above balance")):
                intent_page.fill("#perp-transfer-amount", amount)
                intent_page.click("#perp-transfer-review")
                if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                    fail(f"D9 {label} amount must not create an intent")
            intent_page.fill("#perp-transfer-amount", "0.50")
            intent_page.click("#perp-transfer-review")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("D9 amount below provider minimum must not create an intent")
            intent_page.fill("#perp-transfer-amount", "5000.00")
            intent_page.click("#perp-transfer-review")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("D9 amount above source balance must not create an intent")
            intent_page.fill("#perp-transfer-amount", "1.25")
            intent_page.click("#perp-transfer-review")
            transfer_intent = intent_page.evaluate("""() => {
              const value=currentPerpAccountIntentForReview();
              return value&&{kind:value.kind,amount:value.amount,direction:value.direction,
                account_ref:value.account_ref,asset:value.asset,network:value.network};
            }""")
            expected_transfer = {"kind": "usd_class_transfer", "amount": "1.25",
                                 "direction": "spot_to_perp",
                                 "account_ref": "fixture-account-1", "asset": "USDC",
                                 "network": "hyperliquid"}
            if transfer_intent != expected_transfer:
                fail(f"D9 typed intent drifted: {transfer_intent}")
            intent_page.evaluate("() => openPerpAccount()")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("SPA navigation away from the D9 origin must invalidate its account intent")
            intent_page.goto(f"{uri}#perp-transfer")
            intent_page.fill("#perp-transfer-amount", "1.25")
            intent_page.click("#perp-transfer-review")
            intent_page.fill("#perp-transfer-amount", "9.99")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("D9 edit must invalidate the immutable typed intent")
            intent_page.goto(f"{uri}?amount=9.99#perp-transfer")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("URL injection must not create an account intent")
            intent_page.fill("#perp-transfer-amount", "1.25")
            intent_page.click("#perp-transfer-review")
            intent_page.reload()
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("reload must discard the account intent")
            intent_page.fill("#perp-transfer-amount", "1.25")
            intent_page.click("#perp-transfer-review")
            intent_page.goto("about:blank")
            intent_page.go_back()
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("BFCache return must fail closed for account intents")
            intent_page.goto(f"{uri}#perp-deposit")
            intent_page.select_option("#perp-deposit-operation", "withdraw")
            intent_page.fill("#perp-deposit-amount", "9.999999999999999999")
            intent_page.click("#perp-deposit-review")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("D10 rounded-below withdrawal minimum must not create an intent")
            intent_page.fill("#perp-deposit-amount", "1.25")
            intent_page.click("#perp-deposit-review")
            if intent_page.evaluate("() => currentPerpAccountIntentForReview()") is not None:
                fail("D10 withdrawal below provider minimum must not create an intent")
            intent_page.fill("#perp-deposit-amount", "12.50")
            intent_page.click("#perp-deposit-review")
            bridge_intent = intent_page.evaluate("""() => {
              const value=currentPerpAccountIntentForReview();
              return value&&{kind:value.kind,amount:value.amount,network:value.network,
                account_ref:value.account_ref,asset:value.asset};
            }""")
            if bridge_intent != {"kind": "bridge_withdraw", "amount": "12.50",
                                  "network": "arbitrum",
                                  "account_ref": "fixture-account-1", "asset": "USDC"}:
                fail(f"D10 typed intent drifted: {bridge_intent}")
            intent_page.goto(f"{uri}#perp-risk-notice")
            intent_page.check("#perp-risk-ack")
            intent_page.click("#perp-risk-review")
            risk_intent = intent_page.evaluate("""() => {
              const value=currentPerpAccountIntentForReview();
              return value&&{kind:value.kind,accepted:value.accepted,
                notice_id:value.notice_id,notice_revision:value.notice_revision,
                account_ref:value.account_ref};
            }""")
            if risk_intent != {"kind": "risk_acknowledgement", "accepted": True,
                                "notice_id": "core-perp-risk",
                                "notice_revision": "risk-notice-2026-08",
                                "account_ref": "fixture-account-1"}:
                fail(f"D12 typed intent drifted: {risk_intent}")
            intent_page.close()

            for route, action in (("perp-transfer", "perp-transfer-review"),
                                  ("perp-deposit", "perp-deposit-review"),
                                  ("perp-risk-notice", "perp-risk-review")):
                page = browser.new_page(viewport={"width": 375, "height": 667})
                page.goto(f"{uri}#{route}")
                if route == "perp-risk-notice":
                    page.check("#perp-risk-ack")
                else:
                    page.fill(f"#{route}-amount", "1.25")
                page.click(f"#{action}")
                state = page.evaluate("""() => ({
                  reviewOpen:document.getElementById('review-dialog').classList.contains('open'),
                  accountDialogs:document.querySelectorAll('.perp-account-screen [role=dialog]').length,
                  status:[...document.querySelectorAll('.scr.active [role=status]')]
                    .map(node=>node.textContent).join(' | ')})""")
                if state["reviewOpen"] or state["accountDialogs"] != 0 or not re.search(
                        r"PENDING|blocked|unavailable", state["status"], re.I):
                    fail(f"{route} must stop before sole F11 while policy is pending: {state}")
                page.close()
        finally:
            browser.close()
    print("Hyperliquid D8-D12 runtime: VERIFIED (mobile + desktop + stale + sole F11)")


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
            print("Hyperliquid D8-D12 UI contract: VERIFIED")
        if args.runtime:
            run_runtime()
    except AssertionError as error:
        print(f"Hyperliquid D8-D12 UI contract: FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
