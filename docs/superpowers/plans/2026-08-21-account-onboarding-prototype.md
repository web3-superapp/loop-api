# LOOP Account Onboarding Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the nine approved A-tier account screens (A1 and A3–A10) as a complete, safe, accessible HTML onboarding prototype without regressing the existing LOOP demo.

**Architecture:** Keep `app.html` generated from focused screen fragments, shared CSS, and one application script. Upgrade routing to declarative route metadata, add a small account-flow state machine with centralized teardown, and persist only the four approved non-sensitive onboarding flags. Extend the Playwright-style Python verifier before each implementation increment.

**Tech Stack:** Static HTML5, CSS, vanilla JavaScript, Python 3 build scripts, Playwright Python sync API.

---

## Working constraints

- Source of truth: `src/`; never edit generated `app.html` directly.
- Design authority: `docs/superpowers/specs/2026-08-21-account-onboarding-prototype-design.md`.
- Screen scope authority: A1 and A3–A10, exactly nine new fragments.
- The directory is intentionally not a Git repository. Worktree and commit steps from the generic workflow are not available. After each task, record the equivalent checkpoint by running the named focused and regression tests; do not initialize Git.
- Use @test-driven-development for every behavior change and @verification-before-completion before claiming the slice is done.
- Do not add dependencies, network requests, real wallet generation, secret persistence, or clipboard writes.

## File responsibility map

### Create

- `src/screens/splash.html` — A1 session-check and system-variant shell.
- `src/screens/auth.html` — A3 method picker and import entry.
- `src/screens/auth-otp.html` — A4 six-digit OTP form and lifecycle feedback.
- `src/screens/auth-wallet.html` — A5 detected wallets, WalletConnect placeholder, and connection states.
- `src/screens/wallet-create.html` — A6 embedded-wallet simulation and retry state.
- `src/screens/wallet-backup.html` — A7 recovery choices and two-step skip warning.
- `src/screens/seed-show.html` — A8 explicit reveal and recorded acknowledgement; no static phrase text.
- `src/screens/seed-verify.html` — A9 three-position verification form and lock state.
- `src/screens/wallet-import.html` — A10 mode-specific import form and validation feedback.
- `_tmp/verify_account.py` — focused routing, behavior, security, accessibility, and mobile-layout suite.

### Modify

- `src/screens-order.txt` — place nine onboarding fragments before existing signed-in roots.
- `src/app.js` — route metadata, account state machine, deterministic fixtures, teardown, completion guard, handlers, and restart action.
- `src/style.css` — shared account layout, form, OTP, recovery, warning, error, responsive, focus, and reduced-motion styles.
- `src/screens/home.html` — backup-incomplete banner and watch-only hook on Pay.
- `src/screens/token.html` — watch-only hook on Buy.
- `src/screens/group.html` — watch-only hooks on Token Buy and Copy trade.
- `src/screens/swap.html` — watch-only hook on Swap submission.
- `src/screens/dapp.html` — watch-only hook on DApp approval.
- `src/screens/wallet.html` — watch-only notice and hooks on all signing actions.
- `src/shell-close.html` — watch-only hooks on global approval/signing actions.
- `src/screens/profile.html` — dynamic recovery status and Restart onboarding demo action.
- `_tmp/verify_split.py` — include the nine new hashes in shared routing/a11y regression coverage without duplicating focused cases.
- `README.md` — document the account verifier and current generated screen count; do not rewrite the unresolved global inventory count in this slice.
- `app.html` — regenerated only through `python3 build.py`.

## Shared implementation contract

Use these exact IDs and constants so screen fragments and tests do not drift:

```javascript
const ONBOARDING_KEYS = {
  complete: 'loop.proto.onboarding.complete',
  backupIncomplete: 'loop.proto.onboarding.backupIncomplete',
  watchOnly: 'loop.proto.onboarding.watchOnly',
  recoveryMethod: 'loop.proto.onboarding.recoveryMethod'
};

const ACCOUNT_SCREEN_IDS = new Set([
  'scr-splash', 'scr-auth', 'scr-auth-otp', 'scr-auth-wallet',
  'scr-wallet-create', 'scr-wallet-backup', 'scr-seed-show',
  'scr-seed-verify', 'scr-wallet-import'
]);

const DEMO_PHRASE = Object.freeze([
  'orbit', 'velvet', 'cactus', 'harbor', 'lunar', 'maple',
  'echo', 'raven', 'silver', 'tunnel', 'pixel', 'anchor'
]);

const DEMO_BAD_CHECKSUM = 'orbit velvet cactus harbor lunar maple echo raven silver tunnel pixel pixel';
const DEMO_PRIVATE_KEY = '0x' + '1'.repeat(64);
const DEMO_EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const DEMO_SOLANA_ADDRESS = '11111111111111111111111111111111';
const DEMO_IMPORT_WORDS = new Set([...DEMO_PHRASE, 'pixel']);

const ACCOUNT_TIMING = Object.freeze({
  splash:800, socialAuth:450, walletSignature:500, walletTimeout:10000,
  walletCreate:700, otpResend:60000, otpLock:30000, seedVerifyLock:30000
});

const ACCOUNT_DEFAULTS = Object.freeze({
  otp: '', otpFailures: 0, otpLockedUntil: 0, otpExpiresAt: 0,
  selectedWallet: '', walletState: 'idle', createState: 'idle',
  seedRevealed: false, verifyFailures: 0, verifyLockedUntil: 0,
  importMode: 'phrase', importValue: '', timers: []
});
const account = {...ACCOUNT_DEFAULTS, timers:[]};
```

`DEMO_PHRASE` is immutable public fixture data, not wallet entropy. It may exist in source but must only be inserted into screen DOM after reveal. No mutable account property may contain the full phrase.

---

### Task 1: Add the focused verifier and nine routable screen shells

**Files:**
- Create: `_tmp/verify_account.py`
- Create: `src/screens/splash.html`
- Create: `src/screens/auth.html`
- Create: `src/screens/auth-otp.html`
- Create: `src/screens/auth-wallet.html`
- Create: `src/screens/wallet-create.html`
- Create: `src/screens/wallet-backup.html`
- Create: `src/screens/seed-show.html`
- Create: `src/screens/seed-verify.html`
- Create: `src/screens/wallet-import.html`
- Modify: `src/screens-order.txt:1`
- Modify: `src/app.js:30-112,411-466`

- [x] **Step 1: Write the failing inventory and deep-link tests**

Start `_tmp/verify_account.py` with the existing verifier's `check`/`fresh` pattern and these constants/assertions:

```python
ACCOUNT = {
    'splash': 'scr-splash',
    'auth': 'scr-auth',
    'auth-otp': 'scr-auth-otp',
    'auth-wallet': 'scr-auth-wallet',
    'wallet-create': 'scr-wallet-create',
    'wallet-backup': 'scr-wallet-backup',
    'seed-show': 'scr-seed-show',
    'seed-verify': 'scr-seed-verify',
    'wallet-import': 'scr-wallet-import',
}

def clear_onboarding_namespace(pg):
    pg.evaluate("""() => {
      for (let i=sessionStorage.length-1; i>=0; i--) {
        const key=sessionStorage.key(i);
        if (key && key.startsWith('loop.proto.onboarding.')) sessionStorage.removeItem(key);
      }
    }""")

def fresh_incomplete(pg, route, query=''):
    pg.goto(f'{URL}#home')
    clear_onboarding_namespace(pg)
    pg.goto(f'{URL}{query}#{route}')
    pg.wait_for_load_state('networkidle')

def fresh_completed(pg, route):
    pg.goto(f'{URL}#home')
    clear_onboarding_namespace(pg)
    pg.evaluate("sessionStorage.setItem('loop.proto.onboarding.complete','true')")
    pg.goto(f'{URL}#{route}')
    pg.wait_for_load_state('networkidle')

for route, screen_id in ACCOUNT.items():
    fresh_incomplete(pg, route)
    active = pg.locator('.scr.active:not([inert])')
    check(active.count() == 1, f'#{route} has exactly one active screen')
    check(active.get_attribute('id') == screen_id, f'#{route} activates {screen_id}')
    check(not pg.locator('.tabbar').is_visible(), f'#{route} hides signed-in tabs')
```

History tests use a fresh browser context so earlier entries cannot affect Back/Forward assertions. Query-fixture cases also use a fresh context and close it after the case. Never reuse the existing `verify_split.py` helper for account tests because it intentionally preserves session state.

- [x] **Step 2: Run the focused verifier and confirm the expected failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: build fails because the ordered fragments do not exist, or the verifier fails because account routes resolve to Home.

- [x] **Step 3: Create minimal semantic screen shells**

Each file must contain exactly one section with the approved ID, a `.account-screen` class, an `h1`, and any initial controls referenced by later tasks. Example pattern:

```html
<section class="scr account-screen" id="scr-auth">
  <div class="account-pad">
    <p class="account-kicker">LOOP account</p>
    <h1>Choose how to continue</h1>
    <p class="account-lede">Your identity stays separate from what you share.</p>
    <div id="auth-methods" class="account-stack"></div>
  </div>
</section>
```

Use empty phrase container `<ol id="seed-words"></ol>` in `seed-show.html`; never include fixture words in HTML.

- [x] **Step 4: Add the screen names to the top of the order manifest**

Prepend, in flow order:

```text
splash
auth
auth-otp
auth-wallet
wallet-create
wallet-backup
seed-show
seed-verify
wallet-import
```

- [x] **Step 5: Replace parallel route maps with declarative route metadata**

In `src/app.js`, define each route once:

```javascript
const ROUTES = {
  splash:{screen:'scr-splash', stack:['scr-splash'], parent:null, account:true},
  auth:{screen:'scr-auth', stack:['scr-auth'], parent:'splash', account:true},
  'auth-otp':{screen:'scr-auth-otp', stack:['scr-auth','scr-auth-otp'], defaultParent:'auth', account:true, sensitive:true},
  'auth-wallet':{screen:'scr-auth-wallet', stack:['scr-auth','scr-auth-wallet'], parent:'auth', account:true},
  'wallet-create':{screen:'scr-wallet-create', stack:['scr-auth','scr-wallet-create'], defaultParent:'auth', account:true},
  'wallet-backup':{screen:'scr-wallet-backup', stack:['scr-auth','scr-wallet-create','scr-wallet-backup'], parent:'wallet-create', account:true},
  'seed-show':{screen:'scr-seed-show', stack:['scr-auth','scr-wallet-create','scr-wallet-backup','scr-seed-show'], parent:'wallet-backup', account:true, sensitive:true},
  'seed-verify':{screen:'scr-seed-verify', stack:['scr-auth','scr-wallet-create','scr-wallet-backup','scr-seed-show','scr-seed-verify'], parent:'seed-show', account:true, sensitive:true},
  'wallet-import':{screen:'scr-wallet-import', stack:['scr-auth','scr-wallet-import'], parent:'auth', account:true, sensitive:true},
  home:{screen:'scr-home', stack:['scr-home'], root:'home'},
  // preserve every existing route with its exact current stack
};
```

Derive hash lookup from `route.screen`, change direct deep-link routing to use `route.stack.slice()`, and classify chrome with `route.account` rather than treating account screens as ordinary secondary pages. Preserve token, voiceroom, and dapp side effects. Normal branch navigation must extend the live stack instead of reconstructing a default stack: OTP success uses `push('scr-wallet-create')`, so in-app Back returns to OTP; Google/Apple/Passkey begin from Auth and push Wallet creation, so Back returns to Auth. Browser history stores the exact live stack for the branch. `defaultParent` applies only to direct `#wallet-create` deep links.

- [x] **Step 6: Build and run the focused route checks**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: nine route checks pass; behavior sections not yet implemented may be skipped with an explicit `TASK 1 ONLY` flag, not counted as passes.

- [x] **Step 7: Run existing regression tests**

Run: `python3 _tmp/verify_split.py`

Expected: all existing checks pass.

- [x] **Step 8: Record checkpoint (Git unavailable)**

Record in the task log: `Task 1 — build + account routes + verify_split PASS`. Do not initialize Git.

---

### Task 2: Implement the account state boundary, teardown, and completion guard

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/app.js:30-112,411-466`
- Modify: `src/screens/profile.html:30-50`
- Modify: `src/screens/home.html:1-12`
- Modify: `src/screens/wallet.html:1-30`

- [x] **Step 1: Add failing storage, stale-history, and teardown tests**

Add browser checks for:

```python
SENSITIVE_KEYS = ['otp', 'phrase', 'private', 'seed', '246810']

fresh(pg, 'auth-otp')
pg.evaluate("account.otp='246810'")
pg.evaluate("navigate(ROUTES.auth.stack.slice())")
snapshot = pg.evaluate("""() => ({
  storage: JSON.stringify({...localStorage, ...sessionStorage}),
  history: JSON.stringify(history.state),
  values: [...document.querySelectorAll('input,textarea')].map(x => x.value),
  hiddenText: [...document.querySelectorAll('.scr[inert]')].map(x => x.innerText).join(' '),
  aria: [...document.querySelectorAll('[aria-label],[aria-description]')].map(x => `${x.getAttribute('aria-label')||''} ${x.getAttribute('aria-description')||''}`).join(' '),
  account: {otp:account.otp, importValue:account.importValue, seedRevealed:account.seedRevealed}
})""")
check('246810' not in json.dumps(snapshot), 'OTP is absent after route exit')
```

Keep Task 2 security coverage limited to programmatically seeded generic teardown: seed `account.otp` and `account.importValue`, navigate away, and inspect mutable account properties, inputs, hidden text/ARIA, history, storage, console, and toast text. Also verify the guard/history primitives without depending on later UI. Feature-specific secret fixtures move with their implementations: OTP scans and OTP branch history in Task 4, wallet transitions in Task 5, phrase scans in Task 6, and import/private-key/network/clipboard checks in Task 7. Run the complete transition/security matrix again in Task 8.

Also set `loop.proto.onboarding.complete=true`, navigate directly to each account hash, and assert immediate `#home`. At this stage exercise generic incomplete Push/Replace/Back/Forward helpers with programmatically constructed stacks; feature-specific transition rows are added in their later tasks. After completion exercise repeated Back, Forward, refresh, and stale direct hashes. Set backup/watch-only flags and assert their available Home/Profile/Wallet hooks, then click restart and assert every `loop.proto.onboarding.*` key is gone.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: failures for missing teardown, completion redirection, and flag UI.

- [x] **Step 3: Add central account state and safe persistence helpers**

Implement the shared constants from this plan plus:

```javascript
function onboardingFlag(name){
  try{return sessionStorage.getItem(ONBOARDING_KEYS[name]) || ''}catch(e){return ''}
}
function setOnboardingFlag(name, value){
  try{sessionStorage.setItem(ONBOARDING_KEYS[name], String(value))}catch(e){}
}
function isAccountScreen(id){return ACCOUNT_SCREEN_IDS.has(id)}
function clearSensitiveAccountState(){
  account.otp=''; account.importValue=''; account.seedRevealed=false;
  document.querySelectorAll('[data-sensitive]').forEach(el=>{
    if('value' in el) el.value='';
    else el.textContent='';
  });
}

function resetAccountState(){
  (account.timers||[]).forEach(clearTimeout);
  clearSensitiveAccountState();
  Object.keys(account).forEach(k=>delete account[k]);
  Object.assign(account, ACCOUNT_DEFAULTS, {timers:[]});
}
```

Call the same teardown unconditionally before stack, render, or history mutation in `navigate()`; `back()` and internal pushes delegate to `navigate()`. Call it explicitly before direct stack/render mutations in `popstate`, and on `pagehide`; external `hashchange` delegates through `route()`→`navigate()`. `completeOnboarding()` calls it before setting flags and navigating. Do not persist the `account` object through existing `persist()`.

- [x] **Step 4: Add completion and stale-route guards**

```javascript
function completeOnboarding({recoveryMethod='', backupIncomplete=false, watchOnly=false}={}){
  clearSensitiveAccountState();
  setOnboardingFlag('complete','true');
  setOnboardingFlag('backupIncomplete', backupIncomplete ? 'true' : 'false');
  setOnboardingFlag('watchOnly', watchOnly ? 'true' : 'false');
  const allowed=new Set(['phrase','cloud-simulated','social-simulated','skipped']);
  if(allowed.has(recoveryMethod)) setOnboardingFlag('recoveryMethod', recoveryMethod);
  else try{sessionStorage.removeItem(ONBOARDING_KEYS.recoveryMethod)}catch(e){}
  navigate(ROUTES.home.stack.slice(), {replace:true});
}

function guardAccountRoute(routeName){
  return ROUTES[routeName]?.account && onboardingFlag('complete')==='true';
}
```

Apply the guard in `route()`, `restore()`, and `popstate` before rendering. Stale entries are replaced with Home; no claim is made that older browser entries are deleted. With no hash and no completion guard, the default route is Splash. With no hash and a completed onboarding guard, the default route is Home. Explicit signed-in deep links such as `#market` remain available for prototype review.

- [x] **Step 5: Implement non-sensitive post-onboarding UI flags**

Add `#backup-warning` to Home, `#watch-only-notice`, and `#restart-onboarding` to Profile. Add `renderOnboardingFlags()` to hide/show banners and enforce signing restrictions. Restart must remove every storage key whose name starts with `loop.proto.onboarding.`, call `resetAccountState()` (clearing all timers and every mutable property), and replace navigation with Splash. Initial demo start also calls `resetAccountState()`. Test that external-wallet and import completion omit the `recoveryMethod` key entirely rather than storing an empty value.

- [x] **Step 6: Build and run Task 1–2 focused plus existing tests**

Run: `python3 build.py && python3 _tmp/verify_account.py && python3 _tmp/verify_split.py`

Expected: the Task 1–2 route shells, programmatically seeded teardown, generic history, guard, reset, and flag assertions pass; no Task 4–7 behavior is required yet. Existing tests stay green.

- [x] **Step 7: Record checkpoint (Git unavailable)**

Record: `Task 2 — teardown + guard + flags PASS`.

---

### Task 3: Build Splash and authentication method selection

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/screens/splash.html`
- Modify: `src/screens/auth.html`
- Modify: `src/app.js`
- Modify: `src/style.css`

- [x] **Step 1: Add failing Splash and auth transition tests**

Cover normal Splash→Auth replacement, `?demo=splash-force-update#splash`, `?demo=splash-maintenance#splash`, maintenance Retry, maintenance Reset demo, all method availability, and exact destinations. Check WebAuthn absence disables Passkey with explanation. Retry reruns the check and remains in Maintenance. Reset removes the `demo=splash-maintenance` query state, replaces the route with normal Splash, and reaches Auth after the normal 800 ms check.

Expected transition table in tests:

```python
destinations = {
    'auth-email': 'auth-otp', 'auth-phone': 'auth-otp',
    'auth-google': 'wallet-create', 'auth-apple': 'wallet-create',
    'auth-wallet': 'auth-wallet', 'auth-import': 'wallet-import',
}
```

- [x] **Step 2: Run tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: Splash variants and auth transitions fail.

- [x] **Step 3: Implement Splash states**

Use `data-demo` from `new URLSearchParams(location.search).get('demo')`. Normal state shows deterministic progress, then calls `navigate(ROUTES.auth.stack.slice(), {replace:true})`. Force-update blocks with a disabled “Update required” action. Maintenance Retry reruns the simulated check and remains blocked; a separate “Reset demo” action removes the query parameter with `history.replaceState`, resets account state, and reruns normal Splash. No timer may leak after leaving Splash.

- [x] **Step 4: Implement auth method cards and routing**

Render semantic buttons with IDs from the destination table. Google/Apple use a 450 ms “Signing in…” simulated state before Wallet creation. Passkey is enabled only when `window.PublicKeyCredential` exists. No button claims a real provider connection.

- [x] **Step 5: Add shared account styles**

Create reusable `.account-screen`, `.account-pad`, `.account-top`, `.account-stack`, `.method-card`, `.field`, `.field-error`, `.account-actions`, `.account-note`, `.state-panel`, and `:focus-visible` styles. Add `.phone.account-flow` rules that hide tabbar and signed-in chrome while retaining the phone shell.

- [x] **Step 6: Build, test, and inspect at desktop/mobile sizes**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: normal and variant flows pass; no console error.

- [x] **Step 7: Record checkpoint**

Record: `Task 3 — Splash/Auth PASS`.

---

### Task 4: Implement the deterministic OTP lifecycle

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/screens/auth-otp.html`
- Modify: `src/app.js`
- Modify: `src/style.css`

- [x] **Step 1: Add failing OTP interaction tests**

Test numeric filtering, six-box focus advance/backspace, full-code paste, success `246810`, expired `000000`, service failure `999998`, invalid code, 60-second resend, five-invalid-attempt lock for 30 seconds, recovery after lock, and route-exit cleanup. Capture the exact OTP across inputs, mutable state, hidden DOM/ARIA, history, both storage areas, console, and toast after in-app Back, browser Back/Forward, hashchange, completion, and `pagehide`. `visibilitychange` is not an OTP cleanup requirement.

Use the installed Playwright clock API explicitly: call `pg.clock.install()` before starting a timer and `pg.clock.run_for(60000)` or `pg.clock.run_for(30000)` to cross the production boundary. Never shorten production constants.

- [x] **Step 2: Run focused tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: OTP behavior assertions fail.

- [x] **Step 3: Implement accessible OTP inputs**

Use a visually grouped fieldset with six `inputmode="numeric"`, `maxlength="1"` inputs, a combined hidden label, live error/status region, Verify button, and Resend button. Keep `#otp-code` as a non-persisted hidden aggregate only if tests require it; clear it synchronously with the visible boxes.

- [x] **Step 4: Implement timers and fixture transitions**

Define `OTP_RESEND_MS=60000`, `OTP_LOCK_MS=30000`, and exact fixture branches. Keep timer IDs under account state and clear them on route exit. Successful OTP clears all digits before pushing Wallet creation.

- [x] **Step 5: Run focused and regression tests**

Run: `python3 build.py && python3 _tmp/verify_account.py && python3 _tmp/verify_split.py`

Expected: OTP suite and all regressions pass.

- [x] **Step 6: Record checkpoint**

Record: `Task 4 — OTP lifecycle PASS`.

---

### Task 5: Implement external-wallet and embedded-wallet simulations

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/screens/auth-wallet.html`
- Modify: `src/screens/wallet-create.html`
- Modify: `src/app.js`
- Modify: `src/style.css`

- [x] **Step 1: Add failing wallet-state tests**

Cover detected Demo/Timeout/Failure wallets, no-wallet query fixture, WalletConnect placeholder, idle→waiting→signature-requested→connected, explicit Reject, 10-second timeout, generic failure Retry, wallet-creation loading/success, visible service-failure trigger, Retry success, and branch-specific browser/in-app Back behavior. OTP→Create must return to OTP; social Auth→Create must return to Auth.

- [x] **Step 2: Run tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: wallet-state tests fail.

- [x] **Step 3: Implement external-wallet state machine**

Use explicit states `idle | waiting | signature | rejected | timeout | error | connected`. Every state renders into `#wallet-connect-state`; no toast contains request material. Connected calls `completeOnboarding()` only after teardown; an external wallet does not set an embedded-wallet recovery method.

- [x] **Step 4: Implement wallet-creation state machine**

Use `idle | creating | error | created`. The normal Create action waits 700 ms then advances to Backup. “Simulate service failure” enters the exact retry panel; Retry succeeds. Copy must say “Designed for Privy · simulated in this prototype.”

- [x] **Step 5: Clear pending timeouts on every route exit**

Store timeout IDs in `account.timers`, clear them in `clearSensitiveAccountState()`, and assert a delayed wallet result never navigates after the user leaves. Use the exact `ACCOUNT_TIMING` constants from the shared contract.

- [x] **Step 6: Build and run focused plus regression tests**

Run: `python3 build.py && python3 _tmp/verify_account.py && python3 _tmp/verify_split.py`

Expected: all checks pass.

- [x] **Step 7: Record checkpoint**

Record: `Task 5 — wallet simulations PASS`.

---

### Task 6: Implement backup choice, phrase reveal, and phrase verification

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/screens/wallet-backup.html`
- Modify: `src/screens/seed-show.html`
- Modify: `src/screens/seed-verify.html`
- Modify: `src/app.js`
- Modify: `src/style.css`

- [x] **Step 1: Add failing recovery-flow tests**

Cover phrase branch; cloud/social simulated confirmation to Home; social copy explicitly says guardians are not configured; Skip first confirmation remains; Skip second confirmation completes with `backupIncomplete=true`; reveal acknowledgement; phrase absent before reveal; phrase removed on navigation/Back/hashchange/pagehide/visibility loss; no copy action; positions 3/7/11; wrong answers; remaining attempts; five-failure 30-second lock; correct completion. `visibilitychange` assertions apply only to A8 phrase DOM/state, exactly as specified.

- [x] **Step 2: Run focused tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: recovery tests fail.

- [x] **Step 3: Implement all A7 terminal branches**

Use inline confirmation panels or existing accessible sheet patterns. Cloud completes with `recoveryMethod:'cloud-simulated'`; social with `social-simulated`; skip with `skipped` plus `backupIncomplete:true`. The second Skip action must be visually destructive and cannot be the initial focused action.

- [x] **Step 4: Implement just-in-time phrase rendering**

On reveal, create twelve `<li>` nodes from `DEMO_PHRASE` with `textContent`. On hide or exit, `replaceChildren()` immediately. Disable selection/copy UI, block the `copy` event inside the phrase panel, and show the native screenshot limitation warning. `visibilitychange` hides and tears down the phrase when the document becomes hidden.

- [x] **Step 5: Implement verification without retaining a mutable phrase**

Render labeled inputs for positions 3, 7, and 11. Compare normalized answers directly to `DEMO_PHRASE[index]`. Clear incorrect fields only. After five failed submissions, lock for 30 seconds and then clear all fields. Success calls `completeOnboarding({recoveryMethod:'phrase'})`.

- [x] **Step 6: Run the security scan assertions**

Assert fixture words are absent from all `.scr[inert]`, values, history, storage, console, and toasts after exit. It is acceptable and expected that the immutable fixture exists in JavaScript source; the check targets runtime leakage, not public prototype source.

- [x] **Step 7: Build and run focused plus regression tests**

Run: `python3 build.py && python3 _tmp/verify_account.py && python3 _tmp/verify_split.py`

Expected: all checks pass.

- [x] **Step 8: Record checkpoint**

Record: `Task 6 — recovery flow + teardown PASS`.

---

### Task 7: Implement wallet import modes and watch-only restrictions

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `src/screens/wallet-import.html`
- Modify: `src/screens/home.html`
- Modify: `src/screens/token.html`
- Modify: `src/screens/group.html`
- Modify: `src/screens/swap.html`
- Modify: `src/screens/dapp.html`
- Modify: `src/screens/wallet.html`
- Modify: `src/shell-close.html`
- Modify: `src/app.js`
- Modify: `src/style.css`

- [x] **Step 1: Add failing validation and watch-only tests**

Test mode switching clears the prior input; phrase errors distinguish 11 words, unknown word, and checksum-style fixture; private key distinguishes wrong length and non-hex; watch-only accepts one EVM and one centralized Solana fixture; malformed fixtures fail; successful secret import clears DOM before Home; watch-only sets the approved flag and disables every `[data-requires-signing]` action with a visible explanation. Capture all requests and assert zero request contains or is triggered by recovery/private-key submission. Scan mutable state, DOM text/values/ARIA, history, storage, console, and toast after every specified exit. Spy on clipboard methods and assert no sensitive clipboard write.

- [x] **Step 2: Run focused tests and verify failure**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: import and watch-only checks fail.

- [x] **Step 3: Build accessible mode switching and validation**

Use a radio/tablist with `phrase | private | watch`. Render one labeled textarea/input and one error region. Use the exact `DEMO_BAD_CHECKSUM`, `DEMO_PRIVATE_KEY`, `DEMO_EVM_ADDRESS`, and `DEMO_SOLANA_ADDRESS` values from the shared contract. Exact validation order:

```javascript
function validateImport(mode, value){
  const v=value.trim();
  if(mode==='phrase'){
    const words=v.toLowerCase().split(/\s+/).filter(Boolean);
    if(words.length!==12) return 'Enter exactly 12 recovery words.';
    if(words.some(w=>!DEMO_IMPORT_WORDS.has(w))) return 'One or more words are not recognized.';
    if(v===DEMO_BAD_CHECKSUM) return 'The recovery phrase checksum is invalid.';
    return '';
  }
  if(mode==='private'){
    if(!/^0x[0-9a-fA-F]{64}$/.test(v)) return 'Enter 0x followed by 64 hexadecimal characters.';
    return '';
  }
  if(!isDemoEvmAddress(v) && !isDemoSolanaAddress(v)) return 'Enter a supported EVM or Solana address.';
  return '';
}
```

The accepted fixture values must be labeled test data adjacent to the form; do not make users invent plausible secrets.

- [x] **Step 4: Complete with safe teardown**

For phrase/private modes, clear the field and mutable state before `completeOnboarding()`. For watch-only, clear first, then call `completeOnboarding({watchOnly:true})`. Importing an existing wallet does not set an embedded-wallet recovery method.

- [x] **Step 5: Apply signing restrictions to every existing signing entry point**

Inventory and mark every signing-capable control with `data-requires-signing`: Home Pay (`home.html`); Token Buy (`token.html`); group Token Buy and Copy trade (`group.html`); Wallet Send/Swap/Bridge/DApps and DApp rows (`wallet.html`); Swap submit (`swap.html`); DApp Approve (`dapp.html`); approval-limit, unlimited-approval, and post-swap signing/result actions where applicable (`shell-close.html`). Browsing, Chart, Watch, Alert, View analysis, voice, and tab navigation remain available. `renderOnboardingFlags()` sets real `disabled` where possible and a capturing document handler blocks any remaining inline handler as defense in depth. Test every listed route/control in watch-only mode and require one consistent explanation.

- [x] **Step 6: Build and run focused plus regression tests**

Run: `python3 build.py && python3 _tmp/verify_account.py && python3 _tmp/verify_split.py`

Expected: all checks pass.

- [x] **Step 7: Record checkpoint**

Record: `Task 7 — import + watch-only PASS`.

---

### Task 8: Finish accessibility, mobile layout, shared regression coverage, and docs

**Files:**
- Modify: `_tmp/verify_account.py`
- Modify: `_tmp/verify_split.py:10-11,150-155`
- Modify: `src/app.js`
- Modify: `src/screens/splash.html`
- Modify: `src/screens/auth.html`
- Modify: `src/screens/auth-otp.html`
- Modify: `src/screens/auth-wallet.html`
- Modify: `src/screens/wallet-create.html`
- Modify: `src/screens/wallet-backup.html`
- Modify: `src/screens/seed-show.html`
- Modify: `src/screens/seed-verify.html`
- Modify: `src/screens/wallet-import.html`
- Modify: `src/style.css:440-472`
- Modify: `README.md`
- Regenerate: `app.html`

- [x] **Step 1: Add failing accessibility and mobile assertions**

For every account hash assert one active screen, inactive screens inert/aria-hidden, labeled fields, error association, focus on heading/first field, no hidden tabbables, and no horizontal overflow. Use a 375×667 page for iPhone SE-class layout; focus each input and assert the primary action can be scrolled into the viewport.

Re-run the complete approved transition table and unified security matrix here using isolated contexts and `fresh_incomplete`/`fresh_completed`: every feature Push/Replace, branch-specific in-app Back, incomplete browser Back/Forward, completion stale-history guard, every exact secret fixture on all required exit paths, and phrase-only visibility cleanup.

- [x] **Step 2: Add reduced-motion coverage**

Create a page with `reduced_motion='reduce'`; assert account progress/transition animation duration is zero or effectively disabled.

- [x] **Step 3: Run focused tests and verify any remaining failures**

Run: `python3 build.py && python3 _tmp/verify_account.py`

Expected: layout/focus/reduced-motion failures expose the remaining CSS/DOM work.

- [x] **Step 4: Finish responsive, focus, and reduced-motion CSS**

Add mobile safe-area padding, `scroll-margin-bottom` for fields/actions, visible 2 px focus ring, minimum 44 px touch targets, and:

```css
@media (prefers-reduced-motion: reduce){
  .account-screen *, .account-screen{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
```

Do not hide labels to gain space.

Implement `focusActiveScreen()` in `src/app.js`: after each render, use `requestAnimationFrame` to focus `[data-route-focus]`, otherwise the screen heading with `tabindex="-1"`, otherwise the first enabled field. Every account fragment must mark exactly one heading or initial field with `data-route-focus`; focus must not reveal or populate sensitive content.

- [x] **Step 5: Expand shared route regression inventory**

Add the nine account hashes to `_tmp/verify_split.py`'s `HASHES`. Keep account-specific behavior in `_tmp/verify_account.py`; shared suite checks only routing, console errors, prohibited wording, and inactive-screen isolation.

- [x] **Step 6: Update README development commands and current count**

Add `python3 _tmp/verify_account.py` after the existing verifier. State that the generated prototype now has 20 routed screen fragments (11 existing + nine account screens). Keep the 47/48 inventory reconciliation explicitly out of this slice.

- [x] **Step 7: Run the full authoritative verification set**

Run:

```bash
python3 build.py
python3 _tmp/verify_account.py
python3 _tmp/verify_split.py
python3 build_docs.py
python3 _tmp/verify_docs.py
```

Expected:

- `app.html built: … bytes · 20 screens`
- account verifier reports all sections passed;
- existing prototype verifier reports all sections passed;
- docs builder reports five docs;
- docs verifier reports all sections passed.

- [x] **Step 8: Inspect generated-artifact discipline**

Run:

```bash
python3 build.py
shasum app.html > /tmp/loop-app-first.sha
python3 build.py
shasum app.html > /tmp/loop-app-second.sha
cmp /tmp/loop-app-first.sha /tmp/loop-app-second.sha
```

Expected: `cmp` exits 0, proving two clean source builds are byte-for-byte deterministic.

Then inspect `rg -n "TODO|FIXME|AI Guard|Risk Score|[0-9]+/100" src app.html` and confirm there are no new prohibited phrases, placeholder TODOs, or numeric risk scores. Existing intentionally documented Phase references are allowed.

- [x] **Step 9: Perform the mandatory human copy gate**

The project owner reviews every word on A6–A10. Record pass/fail and exact requested copy changes. This is the only acceptance item that cannot be replaced by automation.

- [x] **Step 10: Record final checkpoint (Git unavailable)**

Check this plan's completed task boxes with `apply_patch` and preserve the final command output for the handoff message. Record in the plan: `Task 8 — full suite PASS; owner copy review <PASS/PENDING>`. Do not create an undefined external task log, and do not claim the slice complete while copy review is pending.

Recorded 2026-08-22: `Task 8 — full suite PASS; owner copy review PASS`.

---

## Completion evidence checklist

- [x] All nine in-scope fragments exist and build into `app.html`.
- [x] Every approved transition and deterministic error state is covered by `_tmp/verify_account.py`.
- [x] Sensitive values are absent from runtime DOM, form values, mutable state, history, storage, console, and toasts after every exit path.
- [x] Completion guard survives stale Back/Forward/refresh/direct hashes and Restart clears the entire namespace.
- [x] Backup-incomplete and watch-only restrictions render and reset correctly.
- [x] All account screens meet keyboard, inert, labeling, focus, reduced-motion, and 375×667 layout checks.
- [x] Existing route, Chat→Swap, voice, approval, wording, and docs regressions remain green.
- [x] A6–A10 copy receives recorded owner approval.
