# LOOP Account Onboarding Prototype Design

**Date:** 2026-08-21  
**Status:** Approved in conversation  
**Scope:** Nine account screens identified as A1 and A3–A10

## 1. Context and decision

LOOP is currently an 11-screen static HTML/CSS/JavaScript prototype. The product inventory's module totals and the older README headline are stale or internally inconsistent. This design does not attempt to repair the global count; its scope is authoritative by explicit screen ID. The project has already decided to finalize the HTML prototype before translating it to Flutter.

The first implementation slice will complete the mandatory account and wallet-onboarding path. This is the best first slice because every new user passes through it, it establishes the three-level routing and sensitive-state rules required by later flows, and it gives downstream Flutter work an approved reference for Privy and wallet onboarding.

Alternative approaches considered:

1. **Vertical business slices (selected):** account, discovery/trading, Chat, Perp, then system states. Each batch is independently demonstrable and testable.
2. **Screen-number batches:** faster initial UI production, but navigation and end-to-end behavior would only converge late.
3. **Immediate Flutter migration:** avoids later translation work, but violates the existing HTML-first product decision and freezes screens before review.

## 2. Scope

This slice adds the following **nine** A-tier account screens: A1 plus A3 through A10.

| ID | Screen | Hash | Purpose |
|---|---|---|---|
| A1 | Splash | `#splash` | Session and version-check simulation |
| A3 | Authentication choice | `#auth` | Email, Google, Apple, passkey, or external wallet entry |
| A4 | OTP verification | `#auth-otp` | Six-digit verification and resend lifecycle |
| A5 | External wallet connection | `#auth-wallet` | Wallet discovery and connection/signature simulation |
| A6 | Embedded wallet creation | `#wallet-create` | Privy wallet-creation simulation and custody explanation |
| A7 | Backup and recovery choice | `#wallet-backup` | Cloud, recovery phrase, or social recovery selection |
| A8 | Recovery phrase display | `#seed-show` | Reveal and recorded-acknowledgement flow using prototype-only data |
| A9 | Recovery phrase verification | `#seed-verify` | Verify three randomly selected word positions |
| A10 | Existing wallet import | `#wallet-import` | Recovery phrase, private key, or watch-only address validation |

A2, A11, and A12 are B-tier and remain outside this slice. Successful completion routes to the existing `#home` screen. The existing 11 screens remain in scope for regression protection. The canonical inventory must be reconciled separately before claiming a final A-tier total; this slice is accepted against the nine IDs above.

## 3. Architecture

The prototype remains dependency-free static HTML/CSS/JavaScript. `app.html` remains generated output and must never be edited directly.

- Each new screen lives in `src/screens/<name>.html`.
- `src/screens-order.txt` remains the sole screen-order manifest.
- Shared styles stay in `src/style.css`.
- Navigation, state transitions, validation, and simulation logic stay in `src/app.js`.
- `python3 build.py` assembles the source files into `app.html`.

The current implicit route handling will become a small declarative route registry. Each route describes its screen ID, hash, root tab (if any), parent route, and whether it is sensitive. The navigation stack remains the single source of truth; the URL hash and browser history remain projections of it.

The hierarchy for this slice is:

```text
splash
└── auth
    ├── auth-otp
    │   └── wallet-create
    │       └── wallet-backup
    │           └── seed-show
    │               └── seed-verify
    ├── auth-wallet
    └── wallet-import
```

Onboarding screens do not display the six-tab navigation. Normal onboarding transitions use browser history so Back and Forward remain realistic during an incomplete flow. Completion stores the non-sensitive boolean guard `loop.proto.onboarding.complete` in `sessionStorage` and replaces the current entry with `home`. Any later Back, Forward, refresh, or direct hash that lands on an onboarding route while the guard is set is immediately replaced with `home`. This does not claim to delete arbitrary browser-history entries, which the History API cannot do.

The prototype owns the non-sensitive `sessionStorage` namespace `loop.proto.onboarding.*`:

- `complete`: stale onboarding routes must redirect to Home;
- `backupIncomplete`: Home and Profile show a backup warning;
- `watchOnly`: Home and Wallet disable every signing action and explain why;
- `recoveryMethod`: one of `phrase`, `cloud-simulated`, `social-simulated`, or `skipped`.

Tests clear the complete namespace before exercising an onboarding deep link. The prototype exposes a visible “Restart onboarding demo” action from Profile that clears every `loop.proto.onboarding.*` key, clears all ephemeral account state, and starts at Splash.

## 4. State and data boundaries

Account flow state is separated into three categories:

1. **Route state:** current route stack and non-sensitive navigation metadata. This may be persisted for refresh/deep-link behavior.
2. **Flow state:** selected authentication method, OTP lifecycle, wallet-connection status, and backup choice. Only non-sensitive values may be persisted.
3. **Sensitive ephemeral state:** OTP digits, recovery phrase, private-key input, and phrase-verification answers. This exists in memory and relevant form controls only, and is synchronously cleared whenever the route is left, the flow succeeds, or the page unloads.

The prototype never creates or imports a real wallet. Recovery words are a fixed clearly labeled demonstration fixture, not generated entropy. The phrase is inserted into the DOM only after explicit reveal and is removed rather than merely hidden on every exit. Private-key and recovery-phrase fields validate shape only; they do not derive addresses or perform cryptographic operations.

Sensitive values must never appear in:

- URL hashes or history state;
- `localStorage` or `sessionStorage`;
- console output, analytics, toasts, or error messages;
- accessibility labels or hidden inactive-screen markup after leaving the screen.

All navigation exits run a central sensitive teardown before mutating the stack. The same teardown runs for in-app navigation, browser `popstate`, external `hashchange`, successful completion, and `pagehide`. It clears input values, verification answers, in-memory secret fields, and secret-bearing text nodes. Tests inspect active and inactive DOM, form values, memory state, history state, storage, console output, and toast text.

## 5. Interaction design

### 5.1 Splash and authentication

Splash displays a short deterministic session-check sequence and then routes to authentication. A prototype control can expose force-update and maintenance variants without changing production semantics.

Authentication choice offers the documented Privy methods plus an explicit “Import existing wallet” action. Email and phone lead to OTP, external wallet leads to wallet connection, import leads to wallet import, and social/passkey actions simulate authentication before wallet creation. Every unavailable method shows a disabled explanation rather than silently failing.

| Method | Prototype availability | Destination |
|---|---|---|
| Email | Enabled, simulated | OTP |
| Phone | Enabled, simulated | OTP |
| Google | Enabled, simulated | Wallet creation |
| Apple | Enabled, simulated | Wallet creation |
| Passkey | Enabled when WebAuthn is present; otherwise visibly disabled | Wallet creation after simulation |
| External wallet | Enabled, simulated | External-wallet connection |
| Import existing wallet | Enabled, simulated | Wallet import |

### 5.2 OTP

OTP uses six single-character inputs with forward focus, backspace navigation, paste support, and numeric-only validation. The interaction includes invalid code, expired code, resend countdown, resend success, and too-many-attempts lockout. A successful code advances to wallet creation.

### 5.3 External wallet

The screen shows detected-wallet choices and a WalletConnect QR placeholder. It supports no-wallet-installed, waiting, signature-requested, rejected, timed-out, and connected states. Connected users proceed directly to Home because the external wallet already exists.

### 5.4 Create, back up, and verify

Wallet creation exposes idle/loading/failure/success states and clearly states that this is a simulation. Success proceeds to the recovery choice.

The recovery screen offers cloud backup, recovery phrase, and 2-of-3 social recovery. Recovery phrase is the fully demonstrated branch. Cloud and social recovery each open a clearly labeled “Designed for Privy · simulated in this prototype” confirmation state; Continue marks the simulated recovery method configured and completes to Home. Social recovery does not pretend that three guardians were configured; full guardian setup remains H8/B-tier.

A separate “Not now” action opens a strong confirmation dialog explaining that loss of access may permanently lose assets. The first confirmation never exits; the destructive secondary confirmation completes to Home with a persistent “Backup incomplete” prototype flag. Home and Profile surface that warning until the onboarding demo is reset.

The phrase screen starts obscured and requires an explicit reveal acknowledgement. It explains that native iOS/Android builds must block screenshots; HTML cannot enforce OS screenshot blocking and therefore renders a persistent warning and hides the phrase on `visibilitychange`. Copy is deliberately disabled in the HTML prototype, so no recovery words enter the clipboard. The user must confirm that the words were recorded before continuing. The verification screen asks for three deterministic word positions so automated tests are stable. Incorrect answers remain on the screen and clear only the incorrect fields; correct answers clear all sensitive state and complete to Home through the route guard.

### 5.5 Import

Import supports recovery phrase, private key, and watch-only address modes. Each mode has its own label, warning, and format validation. Submission simulates a loading state, then either displays an inline validation error or completes to Home. Switching modes clears the previous mode's input.

### 5.6 Transition contract

| Source | Action/result | Destination | History | Sensitive cleanup |
|---|---|---|---|---|
| Splash | Session check completes | Auth | Replace | Yes |
| Auth | Email or phone | OTP | Push | Yes |
| Auth | Google, Apple, or passkey succeeds | Wallet creation | Push | Yes |
| Auth | External wallet | Wallet connection | Push | Yes |
| Auth | Import existing wallet | Wallet import | Push | Yes |
| OTP | Correct code | Wallet creation | Push | Clear OTP |
| Wallet connection | Connected | Home | Complete/replace + guard | Clear connection request |
| Wallet creation | Created | Backup choice | Push | Clear service response |
| Backup choice | Recovery phrase | Phrase display | Push | Yes |
| Backup choice | Cloud/social simulated confirmation | Home | Complete/replace + guard | Yes |
| Backup choice | Skip second confirmation | Home | Complete/replace + guard | Yes |
| Phrase display | Recorded | Phrase verification | Push | Remove displayed phrase and all per-screen phrase state; verification compares answers to the immutable prototype fixture definition |
| Phrase verification | Correct | Home | Complete/replace + guard | Clear all phrase state |
| Wallet import | Valid simulated input | Home | Complete/replace + guard | Clear all imported input |

Every Back action uses the declared parent while incomplete. Every browser-history replay runs the completion guard before rendering.

### 5.7 Deterministic prototype fixtures

| Behavior | Fixture/trigger | Expected result |
|---|---|---|
| OTP success | `246810` | Advance to wallet creation |
| OTP expired | `000000` | “Code expired” inline error |
| OTP service unavailable | `999998` | Retryable service error |
| OTP invalid | Any other six digits | Increment failed attempts |
| OTP resend | Button enabled after 60 seconds | New 60-second timer and success announcement |
| OTP lockout | Five invalid attempts | Inputs locked for 30 seconds with countdown |
| Wallet connected | Choose Demo Wallet, then Connect | Complete to Home |
| Wallet rejected | Choose Demo Wallet, then Reject | Return to selectable state with inline error |
| Wallet timeout | Choose Timeout Wallet | Timeout state after 10 seconds; test hook may advance timer |
| No wallet installed | Open `?demo=wallet-none#auth-wallet` | Empty detected-wallet state with WalletConnect alternative |
| Wallet waiting/signature | Choose Demo Wallet, then Connect | Waiting state followed by explicit signature-requested state |
| Wallet connection failure | Choose Failure Wallet | Retryable generic connection error |
| Wallet creation failure | Select visible “Simulate service failure” demo link | Retry state; Retry succeeds |
| Valid recovery phrase import | The same labeled 12-word prototype fixture | Simulated import succeeds |
| Recovery phrase errors | 11 words; one non-fixture word; 12-word checksum-error fixture | Distinct length, word, and checksum-style errors |
| Valid private key shape | `0x` plus 64 hexadecimal characters from the labeled test fixture | Simulated import succeeds |
| Invalid private key | Wrong length or non-hex character | Specific inline error |
| Valid watch-only address | 40-hex EVM address or supported Solana base58 test address | Home with all signing CTAs disabled |
| Invalid watch-only address | Malformed EVM/Solana fixture | Specific inline error |
| Splash force update | Open `?demo=splash-force-update#splash` | Blocking force-update variant; no auth transition |
| Splash maintenance | Open `?demo=splash-maintenance#splash` | Maintenance variant with retry; no auth transition until reset |
| Phrase verification failure | Submit one or more wrong fixture words | Incorrect fields clear; remaining attempts decrement |
| Phrase verification lock | Five failed submissions | Inputs lock for 30 seconds, then reset with all answer fields empty |

Fixture values are centralized in `src/app.js`, labeled as prototype data in the UI, and never logged or persisted. Timing code accepts a test clock through the Playwright page context; production behavior uses the durations above.

## 6. Error handling

Recoverable form and connection errors remain inline on the current screen so users do not lose context. Errors describe the next action rather than exposing implementation details.

- OTP: invalid, expired, rate-limited, or temporarily unavailable.
- External wallet: none detected, user rejected, timeout, or connection failure.
- Embedded wallet: creation failure with retry and safe exit.
- Recovery verification: incorrect positions with remaining-attempt feedback.
- Import: wrong length, invalid characters, checksum-style failure simulation, or malformed watch address.

The existing global system-state patterns remain reserved for whole-app failures. A local account error must not activate a global 5xx or offline screen unless the simulated failure affects the entire app.

## 7. Accessibility and responsive behavior

- Exactly one `.scr` is active at a time.
- Every inactive screen has `inert` and `aria-hidden="true"`.
- Initial focus moves to the screen heading or first meaningful field after navigation.
- Form controls have visible labels, programmatic descriptions, and announced inline errors.
- Sensitive reveal controls expose pressed/expanded state without putting secret content in their accessible names.
- All interactions work with a keyboard.
- On iPhone SE-sized viewports, content scrolls without horizontal overflow; the primary action remains reachable when the virtual keyboard is open.
- Reduced-motion preferences disable nonessential transitions and progress animation.

## 8. Testing and acceptance

The existing Playwright regression suite remains mandatory. A new account-flow suite will provide authoritative evidence for this slice.

### Routing and flow

- All nine new hashes deep-link to exactly one active screen.
- The happy path reaches Home from Splash through authentication, OTP, wallet creation, backup, phrase display, and verification.
- The external-wallet and import paths also reach Home.
- Browser Back replays real history while the in-app Back control moves one parent level.
- Completing onboarding guards stale onboarding history so Back cannot reopen secret screens.

### State and failures

- OTP invalid, expired, resend, and lockout states are reachable and recoverable.
- Wallet rejection, timeout, creation failure, and import-validation states are reachable and recoverable.
- Splash force-update and maintenance, no-wallet, waiting, signature-requested, generic wallet failure, and phrase-verification lock states are deterministically reachable.
- Refresh restores route location but never restores OTP, phrase, private-key, or verification input.
- Switching import modes clears the previous value.
- Restart onboarding clears the full `loop.proto.onboarding.*` namespace, including backup and watch-only restrictions.

### Security-oriented checks

- Leaving A8 or A10 removes sensitive values from active inputs and in-memory flow state.
- No demonstration phrase, OTP, or private key appears in storage, URL state, console messages, or toast text.
- The demonstration phrase is labeled as non-wallet prototype data.
- Repeated browser Back and Forward, refresh, and direct stale onboarding hashes redirect to Home after completion.
- Phrase text is inserted only on reveal and is absent from the entire DOM after every exit path.

### Accessibility and layout

- Inactive screens remain inert and hidden from the accessibility tree.
- Keyboard traversal never enters hidden screens.
- Error messages are associated with their fields.
- iPhone SE viewport checks show no horizontal overflow, clipped actions, or overlapping chrome.

### Regression

The following existing behaviors must remain green:

- all current deep links and six-tab navigation;
- Chat token card to Swap success;
- voice-room lifecycle and global call bar;
- DApp approval interception;
- no prohibited AI-security or numeric risk-score wording;
- documentation-site build and verification.

Required commands:

```bash
python3 build.py
python3 _tmp/verify_split.py
python3 _tmp/verify_account.py
python3 build_docs.py
python3 _tmp/verify_docs.py
```

### Canonical test-case applicability for this HTML slice

The master test document targets the later real Flutter build. This prototype does not claim those native/integration checks are passing. The slice records their disposition explicitly:

| Canonical case | HTML-slice disposition | Replacement evidence |
|---|---|---|
| TC-A01 random BIP-39 generation | Deferred to Flutter/Privy; no real wallet generation here | Fixed fixture is labeled, ephemeral, and never treated as entropy |
| TC-A02 native screenshot blocking | Deferred to Flutter | Persistent warning, hide on visibility loss, copy disabled |
| TC-A03 reject wrong phrase verification | Adapted | Deterministic wrong-position browser test |
| TC-A04 / TC-S03 secret not logged | Adapted | DOM/storage/history/console/toast scan |
| TC-A05 invalid phrase import | Adapted | Length, unknown-word, and checksum-style fixture tests |
| TC-A06 watch-only import | Adapted | Signing CTAs disabled after simulated watch-only completion |
| TC-A08 private key boundary | Adapted, no network exists | Assert no request, storage, history, console, or hidden-DOM exposure |
| TC-A10 full first-run flow including A2 | Partially adapted | A2 is B-tier and intentionally deferred; Splash-to-Home path covers all in-scope IDs |
| TC-A11 real login channels | UI-contract only; integration deferred | Method availability and destination matrix tests |
| TC-A12 / A13 OTP lifecycle | Adapted | 60-second resend, expiry, five-attempt lock, and recovery tests |
| TC-A14 wallet rejection | Adapted | Deterministic Reject path |
| TC-A15 wallet creation retry | Adapted | Deterministic failure then retry |
| TC-A16 skip-backup warning | Adapted | Two-step warning and persistent incomplete-backup flag |
| TC-A17 guardian configuration | Deferred to H8/B-tier | A7 social branch states that no guardians are configured |
| TC-A18–A20 MFA/biometrics/profile | Deferred to A11/A12 B-tier | No substitute claim in this slice |
| TC-S06 clipboard lifecycle | Not applicable because copy is disabled in HTML | Assert clipboard write is never requested |

Before implementation acceptance, the project owner must perform the inventory-mandated human copy review for A6–A10. The review is a recorded gate, not replaced by screenshots or automated tests.

## 9. Deliverables

1. Nine new screen fragments and the updated screen-order manifest.
2. Declarative three-level route metadata and account-flow state machine.
3. Shared form, progress, error, and sensitive-data-clearing behavior.
4. Responsive and accessible account-screen styling.
5. `_tmp/verify_account.py` covering happy paths, failure states, sensitive-data cleanup, routing, and layout.
6. Rebuilt `app.html` with all existing regressions passing.

## 10. Explicit non-goals

- Real Privy, WalletConnect, passkey, social login, cloud-backup, or social-recovery integration.
- Real wallet generation, key derivation, signature, import, or custody.
- Flutter or BFF implementation in this slice.
- B-tier onboarding screens A2, A11, and A12.
- Any changes to the product's six-tab information architecture.
