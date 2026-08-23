#!/usr/bin/env python3
"""验证账号引导路由、安全状态边界与非敏感完成标记。"""
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright
from platform_policy_test_app import production_policy_test_app


APP = pathlib.Path(__file__).resolve().parent.parent / 'app.html'
APP_JS = APP.parent / 'src' / 'app.js'
URL = APP.as_uri()

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

EXPECTED_ACCOUNT_DEFAULTS = {
    'otp': '', 'otpFailures': 0, 'otpLockedUntil': 0, 'otpExpiresAt': 0,
    'selectedWallet': '', 'walletState': 'idle', 'createState': 'idle',
    'seedRevealed': False, 'verifyFailures': 0, 'verifyLockedUntil': 0,
    'importMode': 'phrase', 'importValue': '', 'authMethod': '', 'timers': [],
}

TASK7_PHRASE = 'orbit velvet cactus harbor lunar maple echo raven silver tunnel pixel anchor'
TASK7_BAD_CHECKSUM = 'orbit velvet cactus harbor lunar maple echo raven silver tunnel pixel pixel'
TASK7_PRIVATE_KEY = '0x' + '1' * 64
TASK7_EVM_ADDRESS = '0x' + '1' * 40
TASK7_SOLANA_ADDRESS = '1' * 32

# Authoritative Task 8 account interaction inventory. Keep this exact: the verifier
# separately rejects missing IDs, duplicate IDs, and id-less account controls.
ACCOUNT_INTERACTIVE_IDS = (
    'auth-apple', 'auth-email', 'auth-google', 'auth-import', 'auth-passkey',
    'auth-phone', 'auth-wallet', 'backup-cloud', 'backup-confirm-cancel',
    'backup-confirm-continue', 'backup-not-now', 'backup-recovery-phrase',
    'backup-skip-confirm', 'backup-social', 'otp-digit-1', 'otp-digit-2',
    'otp-digit-3', 'otp-digit-4', 'otp-digit-5', 'otp-digit-6', 'otp-resend',
    'otp-verify', 'seed-show-ack', 'seed-show-continue', 'seed-show-recorded',
    'seed-show-reveal', 'seed-verify-11', 'seed-verify-3', 'seed-verify-7',
    'seed-verify-submit', 'splash-reset', 'splash-retry', 'splash-update',
    'wallet-connect', 'wallet-connect-retry', 'wallet-create-fail-demo',
    'wallet-create-retry', 'wallet-create-start', 'wallet-import-mode-phrase',
    'wallet-import-mode-private', 'wallet-import-mode-watch',
    'wallet-import-submit', 'wallet-import-value', 'wallet-option-demo',
    'wallet-option-failure', 'wallet-option-timeout', 'wallet-sign-approve',
    'wallet-sign-reject',
)

fails = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


def clear_onboarding_namespace(pg):
    pg.evaluate("""() => {
      for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('loop.proto.onboarding.')) sessionStorage.removeItem(key);
      }
      if (typeof onboardingMemory !== 'undefined') {
        Object.keys(ONBOARDING_KEYS).forEach(name => { onboardingMemory[name] = ''; });
      }
    }""")


def wait_for_settled_screen(pg, route):
    expected_id = ACCOUNT.get(route, f'scr-{route}')
    pg.wait_for_function("""expectedId => {
      const screen = document.getElementById(expectedId);
      if (!screen || !screen.classList.contains('active') || screen.hasAttribute('inert')) return false;
      const style = getComputedStyle(screen);
      return style.opacity === '1' && style.transform === 'none';
    }""", arg=expected_id)


def fresh_incomplete(pg, route, query=''):
    """从已加载的 #home 清空引导命名空间，再硬加载目标深链。"""
    pg.goto(f'{URL}#home')
    pg.wait_for_load_state('networkidle')
    clear_onboarding_namespace(pg)
    pg.goto(f'{URL}{query}#{route}')
    pg.wait_for_load_state('networkidle')
    wait_for_settled_screen(pg, route)


def fresh_completed(pg, route):
    """以已完成引导的会话状态硬加载；账号深链必须收敛到 Home。"""
    pg.goto(f'{URL}#home')
    pg.wait_for_load_state('networkidle')
    clear_onboarding_namespace(pg)
    pg.evaluate("setOnboardingFlag('complete', true)")
    pg.goto(f'{URL}#{route}')
    pg.wait_for_load_state('networkidle')
    wait_for_settled_screen(pg, 'home' if route in ACCOUNT else route)


def attach_errors(pg, errors, all_console=None):
    def capture_console(msg):
        if all_console is not None:
            all_console.append(f'{msg.type}: {msg.text}')
        if msg.type == 'error':
            errors.append(msg.text)

    pg.on('console', capture_console)
    pg.on('pageerror', lambda err: errors.append(f'pageerror: {err}'))


def seed_sensitive_state(pg, otp_secret, import_secret):
    return pg.evaluate("""([otpSecret, importSecret]) => {
      if (typeof account === 'undefined') return {ready:false, sensitiveCount:0};
      account.otp = otpSecret;
      account.importValue = importSecret;
      const sensitive = [...document.querySelectorAll('[data-sensitive]')];
      sensitive.forEach((el, index) => {
        const value = index % 2 ? importSecret : otpSecret;
        if ('value' in el) el.value = value;
        else el.textContent = value;
      });
      account.timers.push(setTimeout(() => {
        console.log(otpSecret);
        toast(importSecret);
      }, 80));
      return {ready:true, sensitiveCount:sensitive.length};
    }""", [otp_secret, import_secret])


def sensitive_scan(pg, secrets, all_console):
    scan = pg.evaluate("""() => ({
      account: typeof account === 'undefined' ? '<missing>' : JSON.stringify(account),
      controls: [...document.querySelectorAll('input, textarea')]
        .flatMap(el => [el.value, el.getAttribute('value')]).filter(Boolean).join('|'),
      text: document.body.textContent,
      aria: [...document.querySelectorAll('*')].flatMap(el =>
        [...el.attributes].filter(attr => attr.name.startsWith('aria-')).map(attr => attr.value)
      ).filter(Boolean).join('|'),
      history: JSON.stringify(history.state),
      local: [...Array(localStorage.length)].flatMap((_, i) => {
        const key = localStorage.key(i); return [key, localStorage.getItem(key)];
      }).join('|'),
      session: [...Array(sessionStorage.length)].flatMap((_, i) => {
        const key = sessionStorage.key(i); return [key, sessionStorage.getItem(key)];
      }).join('|'),
      toast: document.getElementById('toast').textContent,
      sensitive: [...document.querySelectorAll('[data-sensitive]')].map(el =>
        'value' in el ? el.value : el.textContent).join('|'),
    })""")
    scan['allConsole'] = '|'.join(all_console)
    locations = {name: value for name, value in scan.items()
                 if any(secret in value for secret in secrets)}
    return scan, locations


def wallet_forbidden_scan(pg, sentinel, all_console):
    """扫描钱包动作的全部可变/可观察数据面，但允许描述性的 signature request 文案。"""
    scan = pg.evaluate(r"""() => ({
      account:typeof account === 'undefined' ? '<missing>' : JSON.stringify(account),
      domText:document.body.textContent,
      controls:[...document.querySelectorAll('input, textarea')]
        .flatMap(el => [el.value, el.getAttribute('value')]).filter(Boolean).join('|'),
      aria:[...document.querySelectorAll('*')].flatMap(el => {
        const direct=[el.getAttribute('aria-label'),el.getAttribute('aria-description')];
        const resolved=(el.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean)
          .flatMap(id => {
            const target=document.getElementById(id);
            return [id,target ? target.textContent : ''];
          });
        return direct.concat(resolved);
      }).filter(Boolean).join('|'),
      history:JSON.stringify(history.state),
      local:[...Array(localStorage.length)].flatMap((_,i) => {
        const key=localStorage.key(i); return [key,localStorage.getItem(key)];
      }).filter(Boolean).join('|'),
      session:[...Array(sessionStorage.length)].flatMap((_,i) => {
        const key=sessionStorage.key(i); return [key,sessionStorage.getItem(key)];
      }).filter(Boolean).join('|'),
      toast:document.getElementById('toast').textContent,
    })""")
    scan['console'] = '|'.join(all_console)
    material = re.compile(
        r'0x[a-f0-9]{64,}|(?:private[ _-]?key|seed[ _-]?phrase|mnemonic|'
        r'raw[ _-]?signature|signature[ _-]?(?:value|bytes|material))'
        r'\s*[:=]\s*["\']?[a-z0-9+/=_-]{12,}', re.I)
    return scan, {name: value for name, value in scan.items()
                  if sentinel in value or material.search(value)}


def otp_paste(pg, selector, text):
    pg.locator(selector).focus()
    pg.evaluate("""([selector, text]) => {
      const event = new Event('paste', {bubbles:true, cancelable:true});
      Object.defineProperty(event, 'clipboardData', {
        value:{getData:type => type === 'text' ? text : ''},
      });
      document.querySelector(selector).dispatchEvent(event);
    }""", [selector, text])


def otp_enter(pg, value):
    otp_paste(pg, '#otp-digit-1', value)
    pg.locator('#otp-verify').click()


def otp_fill(pg, value):
    for index, digit in enumerate(value, 1):
        pg.locator(f'#otp-digit-{index}').fill(digit)


def exact_otp_scan(pg, secret, all_console):
    """扫描运行时数据面；故意不读取 script/style 源码中的确定性 fixture。"""
    scan = pg.evaluate(r"""() => ({
      accountOtp:typeof account === 'undefined' ? '<missing>' : account.otp,
      controls:[...document.querySelectorAll('input, textarea')].flatMap(el =>
        [el.value, el.getAttribute('value')]).filter(Boolean).join('|'),
      controlJoined:[...document.querySelectorAll('#scr-auth-otp .otp-inputs input')]
        .map(el => el.value).join(''),
      screenText:[...document.querySelectorAll('.scr')].map(el => el.textContent).join('|'),
      aria:[...document.querySelectorAll('*')].flatMap(el => {
        const direct=[el.getAttribute('aria-label'), el.getAttribute('aria-description')];
        const described=(el.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean)
          .flatMap(id => {
            const target=document.getElementById(id);
            return [id, target ? target.textContent : ''];
          });
        return direct.concat(described);
      }).filter(Boolean).join('|'),
      history:JSON.stringify(history.state),
      local:[...Array(localStorage.length)].map((_,i) =>
        localStorage.getItem(localStorage.key(i))).filter(Boolean).join('|'),
      session:[...Array(sessionStorage.length)].map((_,i) =>
        sessionStorage.getItem(sessionStorage.key(i))).filter(Boolean).join('|'),
      toast:document.getElementById('toast').textContent,
    })""")
    scan['allConsole'] = '|'.join(all_console)
    return scan, {name: value for name, value in scan.items() if secret in value}


def active_state(pg):
    return pg.evaluate("""() => ({
      active: [...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      hash: location.hash,
    })""")


def install_storage_denial(context, operation):
    context.add_init_script(f"""(() => {{
      const denied = () => {{ throw new Error('storage-{operation}-denied'); }};
      if ('{operation}' === 'length') {{
        Object.defineProperty(Storage.prototype, 'length', {{
          configurable:true,
          get:denied,
        }});
      }} else {{
        Object.defineProperty(Storage.prototype, '{operation}', {{
          configurable:true,
          writable:true,
          value:denied,
        }});
      }}
    }})()""")


def install_storage_denials(context, operations):
    for operation in operations:
        install_storage_denial(context, operation)


def install_task7_security_spies(context, clipboard_calls, api_calls):
    """Install persistent cross-navigation spies; each document reports through bindings."""
    context.expose_binding('__task7ClipboardReport',
                           lambda _source, event: clipboard_calls.append(event))
    context.expose_binding('__task7ApiReport',
                           lambda _source, event: api_calls.append(event))
    context.add_init_script(r"""(() => {
      window.__task7ClipboardSpyInstalled=false;
      window.__task7ClipboardSpyError='';
      window.__task7ExecCommandSpyInstalled=false;
      window.__task7ExecCommandSpyError='';
      window.__task7NetworkSpyInstalled=false;
      window.__task7NetworkSpyError='';
      const reportClipboard=event=>globalThis.__task7ClipboardReport(event);
      const reportApi=event=>globalThis.__task7ApiReport(event);
      try{
        const clipboard={};
        for(const name of ['read','write','writeText','readText']){
          Object.defineProperty(clipboard,name,{configurable:true,get(){
            reportClipboard(`get:${name}`);
            return (...args)=>{
              reportClipboard(`call:${name}:${args.map(String).join('|')}`);
              return Promise.resolve(name==='readText' ? '' : []);
            };
          }});
        }
        Object.defineProperty(navigator,'clipboard',{configurable:true,get(){
          reportClipboard('get:clipboard'); return clipboard;
        }});
        const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
        window.__task7ClipboardSpyInstalled=Boolean(descriptor&&descriptor.get);
      }catch(error){window.__task7ClipboardSpyError=String(error)}
      try{
        const originalExecCommand=Document.prototype.execCommand;
        Object.defineProperty(Document.prototype,'execCommand',{
          configurable:true,writable:true,value:function(command){
            const normalized=String(command||'').toLowerCase();
            if(normalized==='copy'||normalized==='cut'){
              reportClipboard(`call:execCommand:${normalized}`);
              return false;
            }
            return typeof originalExecCommand==='function'
              ? originalExecCommand.apply(this,arguments) : false;
          }
        });
        window.__task7ExecCommandSpyInstalled=
          typeof Document.prototype.execCommand==='function';
      }catch(error){window.__task7ExecCommandSpyError=String(error)}
      try{
        const originalFetch=globalThis.fetch;
        if(typeof originalFetch==='function') globalThis.fetch=function(input,init={}){
          reportApi({kind:'fetch',url:String(input&&input.url||input),
            method:String(init.method||input?.method||'GET'),body:String(init.body||'')});
          return originalFetch.apply(this,arguments);
        };
        const originalOpen=XMLHttpRequest.prototype.open;
        const originalSend=XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open=function(method,url){
          this.__task7Request={kind:'xhr',url:String(url),method:String(method||'GET')};
          return originalOpen.apply(this,arguments);
        };
        XMLHttpRequest.prototype.send=function(body){
          reportApi({...this.__task7Request,body:String(body||'')});
          return originalSend.apply(this,arguments);
        };
        window.__task7NetworkSpyInstalled=true;
      }catch(error){window.__task7NetworkSpyError=String(error)}
    })()""")


def task7_spy_state(pg):
    return pg.evaluate("""() => ({
      clipboard:window.__task7ClipboardSpyInstalled,
      clipboardError:window.__task7ClipboardSpyError,
      execCommand:window.__task7ExecCommandSpyInstalled,
      execCommandError:window.__task7ExecCommandSpyError,
      network:window.__task7NetworkSpyInstalled,
      networkError:window.__task7NetworkSpyError,
    })""")


def request_record(request):
    return {'url': request.url, 'method': request.method, 'body': request.post_data or ''}


def account_target_sizes(pg, control_ids):
    """Measure the actual clickable target; radios/checkboxes use their associated label."""
    return pg.evaluate("""ids => ids.map(id => {
      const control=document.getElementById(id);
      let target=control;
      if(control?.matches('input[type="radio"],input[type="checkbox"]')&&control.labels?.[0]){
        target=control.labels[0];
      }
      const rect=target?.getBoundingClientRect();
      return {id,exists:Boolean(control),visible:Boolean(rect&&target.getClientRects().length),
        disabled:'disabled' in (control||{}) ? control.disabled : null,
        width:rect?.width||0,height:rect?.height||0};
    })""", control_ids)


URL = production_policy_test_app(APP.parent).as_uri()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    attach_errors(page, errors)

    print('== Task 1：账号引导深链 ==')
    for route, expected_id in ACCOUNT.items():
        fresh_incomplete(page, route)
        active = page.evaluate("""() => [...document.querySelectorAll('.scr.active:not([inert])')]
          .map(screen => screen.id)""")
        tabbar = page.evaluate("""() => {
          const el = document.querySelector('.tabbar');
          return {hidden:el.hidden, inert:el.hasAttribute('inert'), display:getComputedStyle(el).display};
        }""")
        ok = (active == [expected_id] and tabbar['hidden'] and
              tabbar['inert'] and tabbar['display'] == 'none')
        check(ok, f'#{route} → {expected_id} 唯一激活，Tab 栏隐藏且 inert'
              f'（active={active}, tabbar={tabbar}）')

    print('\n== Task 1：seed-show 安全边界 ==')
    fresh_incomplete(page, 'seed-show')
    copy_affordances = page.evaluate("""() =>
      [...document.querySelectorAll(`#scr-seed-show button, #scr-seed-show [role="button"],
                                     #scr-seed-show [aria-label], #scr-seed-show [title]`)]
        .filter(el => /copy|clipboard/i.test([
          el.id, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')
        ].filter(Boolean).join(' ')))
        .map(el => el.id || el.textContent.trim())""")
    check(not copy_affordances,
          f'#seed-show 无 Copy/剪贴板操作入口，命中 {copy_affordances}')

    print('\n== Task 1：助手函数隔离契约 ==')
    incomplete_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    incomplete_page = incomplete_context.new_page()
    attach_errors(incomplete_page, errors)
    incomplete_page.goto(f'{URL}#home')
    incomplete_page.evaluate("""() => {
      sessionStorage.setItem('loop.proto.onboarding.draft', 'stale');
      sessionStorage.setItem('loop.proto.onboarding.completed', 'stale');
      sessionStorage.setItem('unrelated.sentinel', 'keep');
    }""")
    fresh_incomplete(incomplete_page, 'auth', '?demo=x')
    incomplete = incomplete_page.evaluate("""() => ({
      onboarding: [...Array(sessionStorage.length)].map((_,i) => sessionStorage.key(i))
        .filter(key => key.startsWith('loop.proto.onboarding.')).sort(),
      sentinel: sessionStorage.getItem('unrelated.sentinel'), search:location.search, hash:location.hash,
    })""")
    check(incomplete == {
        'onboarding': [], 'sentinel': 'keep', 'search': '?demo=x', 'hash': '#auth',
    }, f'fresh_incomplete 只清理 onboarding 命名空间并保持 URL，得到 {incomplete}')
    incomplete_context.close()

    completed_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    completed_page = completed_context.new_page()
    attach_errors(completed_page, errors)
    completed_page.goto(f'{URL}#home')
    completed_page.evaluate("""() => {
      sessionStorage.setItem('loop.proto.onboarding.draft', 'stale');
      sessionStorage.setItem('loop.proto.onboarding.completed', 'stale');
      sessionStorage.setItem('unrelated.sentinel', 'keep');
    }""")
    fresh_completed(completed_page, 'home')
    completed = completed_page.evaluate("""() => ({
      onboarding: [...Array(sessionStorage.length)].map((_,i) => sessionStorage.key(i))
        .filter(key => key.startsWith('loop.proto.onboarding.')).sort()
        .map(key => [key, sessionStorage.getItem(key)]),
      sentinel: sessionStorage.getItem('unrelated.sentinel'), search:location.search, hash:location.hash,
    })""")
    check(completed == {
        'onboarding': [['loop.proto.onboarding.complete', 'true']],
        'sentinel': 'keep', 'search': '', 'hash': '#home',
    }, f'fresh_completed 清理陈旧键、仅设置 complete 并保留无关状态，得到 {completed}')
    completed_context.close()

    slow_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    slow_page = slow_context.new_page()
    slow_page.add_init_script("""
      addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '.scr { transition-duration: 1s !important; }';
        document.head.append(style);
      });
    """)
    fresh_incomplete(slow_page, 'auth')
    settled = slow_page.evaluate("""() => {
      const style = getComputedStyle(document.getElementById('scr-auth'));
      return style.opacity === '1' && style.transform === 'none';
    }""")
    check(settled, 'fresh_incomplete 等待激活屏过渡明确完成')
    slow_context.close()

    print('\n== Task 2：账号状态契约与敏感 DOM 标记 ==')
    fresh_incomplete(page, 'auth-otp')
    state_contract = page.evaluate("""() => ({
      hasDefaults: typeof ACCOUNT_DEFAULTS !== 'undefined',
      hasAccount: typeof account !== 'undefined',
      defaultsFrozen: typeof ACCOUNT_DEFAULTS !== 'undefined' &&
        Object.isFrozen(ACCOUNT_DEFAULTS) && Object.isFrozen(ACCOUNT_DEFAULTS.timers),
      keys: typeof account === 'undefined' ? [] : Object.keys(account).sort(),
      sensitiveIds: [...document.querySelectorAll('[data-sensitive]')].map(el => el.id).sort(),
    })""")
    expected_keys = sorted(EXPECTED_ACCOUNT_DEFAULTS)
    check(state_contract == {
        'hasDefaults': True, 'hasAccount': True, 'defaultsFrozen': True,
        'keys': expected_keys,
        'sensitiveIds': sorted([
            'otp-digit-1', 'otp-digit-2', 'otp-digit-3', 'otp-digit-4',
            'otp-digit-5', 'otp-digit-6', 'seed-words', 'seed-verify-3',
            'seed-verify-7', 'seed-verify-11',
            'wallet-import-value']),
    }, f'账号默认状态不可变且敏感 DOM 边界精确，得到 {state_contract}')

    print('\n== Task 2：集中敏感状态清理入口 ==')
    teardown_actions = {
        'navigate': "navigate(['scr-home'], {replace:true})",
        'popstate replay': "dispatchEvent(new PopStateEvent('popstate', {state:{stack:['scr-market']}}))",
        'external hashchange': "location.hash = 'market'",
        'completeOnboarding': "completeOnboarding()",
        'pagehide': "dispatchEvent(new PageTransitionEvent('pagehide'))",
    }
    for index, (name, action) in enumerate(teardown_actions.items()):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        local_errors = []
        all_console = []
        attach_errors(pg, local_errors, all_console)
        fresh_incomplete(pg, 'auth-otp')
        secrets = (f'OTP_SECRET_{index}_739151', f'IMPORT_SECRET_{index}_copper_lake')
        seeded = seed_sensitive_state(pg, *secrets)
        check(seeded == {'ready': True, 'sensitiveCount': 11},
              f'{name}: 已注入账号与 11 个敏感 DOM fixture（{seeded}）')
        pg.evaluate(f"() => {{ {action} }}")
        pg.wait_for_timeout(180)
        _, leaked = sensitive_scan(pg, secrets, all_console)
        check(not leaked and not local_errors,
              f'{name}: account/DOM/a11y/history/storage/toast 无 fixture，泄漏={leaked}，错误={local_errors}')
        context.close()

    print('\n== Task 2：Storage 拒绝访问时安全降级 ==')
    for operation in ('getItem', 'setItem', 'removeItem', 'key', 'length'):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        install_storage_denial(context, operation)
        pg = context.new_page()
        storage_errors = []
        storage_console = []
        attach_errors(pg, storage_errors, storage_console)
        pg.goto(URL if operation == 'getItem' else f'{URL}#profile', wait_until='networkidle')
        pg.wait_for_timeout(120)
        probe = pg.evaluate("""operation => {
          const result = {operation};
          try { result.read = onboardingFlag('complete'); }
          catch (error) { result.readThrew = error.message; }
          try { setOnboardingFlag('backupIncomplete', true); result.writeReturned = true; }
          catch (error) { result.writeThrew = error.message; }
          if (operation !== 'getItem') {
            try {
              const button = document.getElementById('restart-onboarding');
              result.restartCallable = Boolean(button && typeof restartOnboarding === 'function');
              if (button) button.click();
            } catch (error) { result.restartThrew = error.message; }
          }
          return result;
        }""", operation)
        pg.wait_for_timeout(120)
        state = active_state(pg)
        canonical = state == {'active': ['scr-splash'], 'hash': '#splash'}
        expected_read = probe.get('read') == '' if operation == 'getItem' else 'readThrew' not in probe
        restart_ok = operation == 'getItem' or (
            probe.get('restartCallable') is True and 'restartThrew' not in probe)
        check(expected_read and 'writeThrew' not in probe and restart_ok and canonical and
              not storage_errors,
              f'{operation} 拒绝时读写不抛错、重启仍 canonical 到 Splash，'
              f'probe={probe} state={state} errors={storage_errors} console={storage_console}')
        context.close()

    print('\n== Task 2：外部/持久化 stack 校验 ==')
    stack_contract = page.evaluate("""() => ({
      helper:typeof isValidStack === 'function',
      valid:typeof isValidStack === 'function' && isValidStack(['scr-auth','scr-auth-otp']),
      empty:typeof isValidStack === 'function' && isValidStack([]),
      removed:typeof isValidStack === 'function' && isValidStack(['scr-removed']),
      nullItem:typeof isValidStack === 'function' && isValidStack([null]),
    })""")
    check(stack_contract == {
        'helper': True, 'valid': True, 'empty': False, 'removed': False, 'nullItem': False,
    }, f'isValidStack 接受已知非空屏栈并拒绝损坏值，得到 {stack_contract}')

    invalid_stacks = ([], ['scr-removed'], [None])
    for invalid in invalid_stacks:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        restore_errors = []
        attach_errors(pg, restore_errors)
        pg.goto(f'{URL}#home', wait_until='networkidle')
        pg.evaluate("""invalid => sessionStorage.setItem('loop.proto.state',
          JSON.stringify({stack:invalid,voice:{state:'idle'}}))""", invalid)
        pg.reload(wait_until='networkidle')
        pg.wait_for_timeout(120)
        restored = pg.evaluate("""() => ({
          ...({active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
               hash:location.hash}),
          persisted:JSON.parse(sessionStorage.getItem('loop.proto.state')).stack,
          history:history.state && history.state.stack,
        })""")
        check(restored == {
            'active': ['scr-home'], 'hash': '#home',
            'persisted': ['scr-home'], 'history': ['scr-home'],
        } and not restore_errors,
              f'损坏持久化 stack {invalid} 被 route canonicalize，得到 {restored}，错误={restore_errors}')
        context.close()

    for index, invalid in enumerate(invalid_stacks):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        pop_errors = []
        pop_console = []
        attach_errors(pg, pop_errors, pop_console)
        fresh_incomplete(pg, 'market')
        secrets = (f'POP_OTP_SECRET_{index}_2851', f'POP_IMPORT_SECRET_{index}_fjord')
        seed_sensitive_state(pg, *secrets)
        pg.evaluate("""invalid => {
          history.replaceState({stack:invalid}, '', '#market');
          dispatchEvent(new PopStateEvent('popstate', {state:{stack:invalid}}));
        }""", invalid)
        pg.wait_for_timeout(180)
        _, leaked = sensitive_scan(pg, secrets, pop_console)
        popped = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
          hash:location.hash,
          persisted:JSON.parse(sessionStorage.getItem('loop.proto.state')).stack,
          history:history.state && history.state.stack,
        })""")
        check(popped == {
            'active': ['scr-market'], 'hash': '#market',
            'persisted': ['scr-market'], 'history': ['scr-market'],
        } and not leaked and not pop_errors,
              f'损坏 popstate stack {invalid} 清敏并从 URL canonicalize，'
              f'得到 {popped}，泄漏={leaked}，错误={pop_errors}')
        context.close()

    print('\n== Task 2：未完成态通用历史与直接 restore ==')
    history_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    history_page = history_context.new_page()
    history_errors = []
    attach_errors(history_page, history_errors)
    history_page.goto(URL, wait_until='networkidle')
    wait_for_settled_screen(history_page, 'splash')
    base_length = history_page.evaluate('history.length')
    history_page.evaluate("navigate(ROUTES.auth.stack.slice())")
    pushed = history_page.evaluate("""() => ({...history.state,length:history.length,hash:location.hash})""")
    history_page.evaluate("navigate(ROUTES['auth-wallet'].stack.slice(), {replace:true})")
    replaced = history_page.evaluate("""() => ({...history.state,length:history.length,hash:location.hash})""")
    history_page.evaluate('back()')
    wait_for_settled_screen(history_page, 'auth')
    in_app_back = active_state(history_page)
    history_page.evaluate("navigate(ROUTES['auth-otp'].stack.slice())")
    wait_for_settled_screen(history_page, 'auth-otp')
    history_page.evaluate('history.back()')
    history_page.wait_for_timeout(160)
    browser_back = active_state(history_page)
    history_page.evaluate('history.forward()')
    history_page.wait_for_timeout(160)
    browser_forward = active_state(history_page)
    check(pushed['stack'] == ['scr-auth'] and pushed['hash'] == '#auth' and
          pushed['length'] == base_length + 1 and
          replaced['stack'] == ['scr-auth', 'scr-auth-wallet'] and
          replaced['hash'] == '#auth-wallet' and replaced['length'] == pushed['length'] and
          in_app_back == {'active': ['scr-auth'], 'hash': '#auth'} and
          browser_back == {'active': ['scr-auth'], 'hash': '#auth'} and
          browser_forward == {'active': ['scr-auth-otp'], 'hash': '#auth-otp'} and
          not history_errors,
          f'未完成态 Push/Replace/in-app Back/browser Back-Forward 正常：'
          f'pushed={pushed} replaced={replaced} inApp={in_app_back} '
          f'back={browser_back} forward={browser_forward} errors={history_errors}')
    history_context.close()

    valid_restore_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    valid_restore_page = valid_restore_context.new_page()
    valid_restore_errors = []
    attach_errors(valid_restore_page, valid_restore_errors)
    valid_restore_page.goto(f'{URL}#auth-otp', wait_until='networkidle')
    valid_restore_page.evaluate("""() => sessionStorage.setItem('loop.proto.state', JSON.stringify({
      stack:['scr-auth','scr-auth-otp'],voice:{state:'idle',open:false,minimized:false,muted:true}
    }))""")
    valid_restore_page.reload(wait_until='networkidle')
    wait_for_settled_screen(valid_restore_page, 'auth-otp')
    valid_restored = active_state(valid_restore_page)
    check(valid_restored == {'active': ['scr-auth-otp'], 'hash': '#auth-otp'} and
          not valid_restore_errors,
          f'未完成态有效账号 stack 直接 restore，得到 {valid_restored}，错误={valid_restore_errors}')
    valid_restore_context.close()

    stale_restore_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    stale_restore_page = stale_restore_context.new_page()
    stale_restore_errors = []
    attach_errors(stale_restore_page, stale_restore_errors)
    stale_restore_page.goto(f'{URL}#auth-otp', wait_until='networkidle')
    stale_restore_page.evaluate("""() => {
      sessionStorage.setItem('loop.proto.onboarding.complete','true');
      sessionStorage.setItem('loop.proto.state', JSON.stringify({
        stack:['scr-auth','scr-auth-otp'],voice:{state:'idle',open:false,minimized:false,muted:true}
      }));
    }""")
    stale_restore_page.reload(wait_until='networkidle')
    wait_for_settled_screen(stale_restore_page, 'home')
    stale_restored = stale_restore_page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      hash:location.hash,
      persisted:JSON.parse(sessionStorage.getItem('loop.proto.state')).stack,
    })""")
    check(stale_restored == {
        'active': ['scr-home'], 'hash': '#home', 'persisted': ['scr-home'],
    } and not stale_restore_errors,
          f'完成态陈旧持久化账号 stack 守卫到 Home，得到 {stale_restored}，错误={stale_restore_errors}')
    stale_restore_context.close()

    print('\n== Task 2：完成态账号路由守卫 ==')
    for route in ACCOUNT:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        attach_errors(pg, errors)
        fresh_completed(pg, route)
        settled_state = active_state(pg)
        check(settled_state == {'active': ['scr-home'], 'hash': '#home'},
              f'完成态 #{route} 精确替换为 #home，得到 {settled_state}')
        context.close()

    stale_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    stale_page = stale_context.new_page()
    stale_errors = []
    attach_errors(stale_page, stale_errors)
    fresh_incomplete(stale_page, 'splash')
    stale_page.evaluate("navigate(ROUTES.auth.stack.slice())")
    stale_page.evaluate("navigate(ROUTES['auth-otp'].stack.slice())")
    stale_page.evaluate("completeOnboarding({recoveryMethod:'phrase'})")
    wait_for_settled_screen(stale_page, 'home')
    traversal = []
    for command in ('history.back()', 'history.back()', 'history.forward()', 'history.forward()'):
        stale_page.evaluate(command)
        stale_page.wait_for_timeout(160)
        traversal.append(active_state(stale_page))
    check(all(item == {'active': ['scr-home'], 'hash': '#home'} for item in traversal),
          f'完成后重复 Back/Forward 不重现账号 UI，得到 {traversal}')
    stale_page.evaluate("location.hash = 'wallet-import'")
    stale_page.wait_for_timeout(160)
    direct = active_state(stale_page)
    check(direct == {'active': ['scr-home'], 'hash': '#home'},
          f'完成后外部陈旧账号 hash 收敛到 Home，得到 {direct}')
    stale_page.reload(wait_until='networkidle')
    wait_for_settled_screen(stale_page, 'home')
    refreshed = active_state(stale_page)
    check(refreshed == {'active': ['scr-home'], 'hash': '#home'} and not stale_errors,
          f'完成后刷新仍为 Home 且无错误，得到 {refreshed}，错误={stale_errors}')
    stale_context.close()

    print('\n== Task 2：无 hash 默认路由与显式产品深链 ==')
    default_incomplete_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    default_incomplete = default_incomplete_context.new_page()
    attach_errors(default_incomplete, errors)
    default_incomplete.goto(URL, wait_until='networkidle')
    wait_for_settled_screen(default_incomplete, 'splash')
    check(active_state(default_incomplete) == {'active': ['scr-splash'], 'hash': '#splash'},
          f'未完成且无 hash 默认 Splash，得到 {active_state(default_incomplete)}')
    default_incomplete_context.close()

    default_complete_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    default_complete = default_complete_context.new_page()
    attach_errors(default_complete, errors)
    default_complete.goto(f'{URL}#home', wait_until='networkidle')
    default_complete.evaluate("sessionStorage.setItem('loop.proto.onboarding.complete', 'true')")
    default_complete.goto(URL, wait_until='networkidle')
    wait_for_settled_screen(default_complete, 'home')
    check(active_state(default_complete) == {'active': ['scr-home'], 'hash': '#home'},
          f'已完成且无 hash 默认 Home，得到 {active_state(default_complete)}')
    default_complete_context.close()

    deep_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    deep_page = deep_context.new_page()
    attach_errors(deep_page, errors)
    deep_page.goto(f'{URL}#home', wait_until='networkidle')
    deep_page.evaluate("sessionStorage.setItem('loop.proto.onboarding.complete', 'false')")
    deep_page.goto(f'{URL}#market', wait_until='networkidle')
    wait_for_settled_screen(deep_page, 'market')
    check(active_state(deep_page) == {'active': ['scr-market'], 'hash': '#market'},
          f'显式产品深链不受未完成状态影响，得到 {active_state(deep_page)}')
    deep_context.close()

    print('\n== Task 2：完成标记与恢复方式白名单 ==')
    flag_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    flag_page = flag_context.new_page()
    attach_errors(flag_page, errors)
    fresh_incomplete(flag_page, 'auth')
    allowed_methods = ['phrase', 'cloud-simulated', 'social-simulated', 'skipped']
    for method in allowed_methods:
        flags = flag_page.evaluate("""method => {
          completeOnboarding({recoveryMethod:method, backupIncomplete:true, watchOnly:true});
          return Object.fromEntries(Object.entries(ONBOARDING_KEYS)
            .map(([name,key]) => [name, sessionStorage.getItem(key)]));
        }""", method)
        check(flags == {
            'complete': 'true', 'backupIncomplete': 'true', 'watchOnly': 'true',
            'recoveryMethod': method,
        }, f'恢复方式 {method} 与布尔标记精确保存，得到 {flags}')
    for method in ('', 'external', 'PHRASE', 'invalid'):
        flags = flag_page.evaluate("""method => {
          sessionStorage.setItem(ONBOARDING_KEYS.recoveryMethod, 'stale');
          completeOnboarding({recoveryMethod:method, backupIncomplete:false, watchOnly:false});
          return Object.fromEntries(Object.entries(ONBOARDING_KEYS)
            .map(([name,key]) => [name, sessionStorage.getItem(key)]));
        }""", method)
        check(flags == {
            'complete': 'true', 'backupIncomplete': 'false', 'watchOnly': 'false',
            'recoveryMethod': None,
        }, f'空/非法恢复方式 {method!r} 删除 recoveryMethod，得到 {flags}')
    flag_context.close()

    print('\n== Task 2：非敏感标记 UI ==')
    ui_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    ui_page = ui_context.new_page()
    attach_errors(ui_page, errors)
    fresh_completed(ui_page, 'home')
    backup_states = []
    for value in (True, False):
        backup_states.append(ui_page.evaluate("""value => {
          setOnboardingFlag('backupIncomplete', value);
          navigate(['scr-home'], {replace:true});
          const el = document.getElementById('backup-warning');
          return {hidden:el.hidden, text:el.textContent.trim()};
        }""", value))
    check(backup_states[0]['hidden'] is False and backup_states[1]['hidden'] is True and
          'backup' in backup_states[0]['text'].lower(),
          f'Home 备份提醒随标记切换，得到 {backup_states}')

    watch_states = []
    for value in (True, False):
        watch_states.append(ui_page.evaluate("""value => {
          setOnboardingFlag('watchOnly', value);
          navigate(['scr-wallet'], {replace:true});
          const el = document.getElementById('watch-only-notice');
          return {hidden:el.hidden, text:el.textContent.trim()};
        }""", value))
    check(watch_states[0]['hidden'] is False and watch_states[1]['hidden'] is True and
          'watch' in watch_states[0]['text'].lower(),
          f'Wallet 只读提醒随标记切换，得到 {watch_states}')

    expected_recovery = {
        'phrase': 'Recovery phrase backed up',
        'cloud-simulated': 'Cloud backup simulated',
        'social-simulated': 'Social recovery simulated',
        'skipped': 'Recovery setup skipped',
    }
    for method, expected_text in expected_recovery.items():
        recovery = ui_page.evaluate("""method => {
          setOnboardingFlag('backupIncomplete', false);
          setOnboardingFlag('recoveryMethod', method);
          navigate(['scr-profile'], {replace:true});
          return {
            detail:document.getElementById('profile-recovery-detail').textContent.trim(),
            status:document.getElementById('profile-recovery-status').textContent.trim(),
          };
        }""", method)
        check(recovery['detail'] == expected_text,
              f'Profile 显示 {method} 恢复状态，得到 {recovery}')
    backup_profile = ui_page.evaluate("""() => {
      setOnboardingFlag('backupIncomplete', true);
      navigate(['scr-profile'], {replace:true});
      return {
        detail:document.getElementById('profile-recovery-detail').textContent.trim(),
        status:document.getElementById('profile-recovery-status').textContent.trim(),
      };
    }""")
    check(backup_profile == {'detail': 'Backup incomplete', 'status': 'action needed'},
          f'Profile 备份未完成优先显示警告，得到 {backup_profile}')

    print('\n== Task 2：重新开始 demo ==')
    restart_secret = 'RESTART_SECRET_44192'
    restart_seeded = ui_page.evaluate("""secret => {
      Object.assign(account, {
        otp:secret, otpFailures:3, otpLockedUntil:42, otpExpiresAt:84,
        selectedWallet:'external', walletState:'connected', createState:'revealed',
        seedRevealed:true, verifyFailures:2, verifyLockedUntil:99,
        importMode:'private-key', importValue:secret,
      });
      account.timers.push(setTimeout(() => toast(secret), 80));
      sessionStorage.setItem('loop.proto.onboarding.complete', 'true');
      sessionStorage.setItem('loop.proto.onboarding.backupIncomplete', 'true');
      sessionStorage.setItem('loop.proto.onboarding.watchOnly', 'true');
      sessionStorage.setItem('loop.proto.onboarding.recoveryMethod', 'phrase');
      sessionStorage.setItem('loop.proto.onboarding.extra', 'remove-me');
      sessionStorage.setItem('unrelated.sentinel', 'keep');
      return Object.keys(account).sort();
    }""", restart_secret)
    check(restart_seeded == expected_keys, f'重启前已覆盖每个账号字段，得到 {restart_seeded}')
    ui_page.locator('#restart-onboarding').click()
    wait_for_settled_screen(ui_page, 'splash')
    ui_page.wait_for_timeout(180)
    restart = ui_page.evaluate("""() => ({
      onboarding:[...Array(sessionStorage.length)].map((_,i) => sessionStorage.key(i))
        .filter(key => key.startsWith('loop.proto.onboarding.')).sort(),
      sentinel:sessionStorage.getItem('unrelated.sentinel'),
      account:Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(account)))
        .filter(([key]) => key !== 'timers')),
      timerCount:account.timers.length,
      freshTimers:account.timers !== ACCOUNT_DEFAULTS.timers,
      defaultsFrozen:Object.isFrozen(ACCOUNT_DEFAULTS) && Object.isFrozen(ACCOUNT_DEFAULTS.timers),
      hash:location.hash,
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      banners:{backup:document.getElementById('backup-warning').hidden,
               watch:document.getElementById('watch-only-notice').hidden},
      toast:document.getElementById('toast').textContent,
    })""")
    check(restart == {
        'onboarding': [], 'sentinel': 'keep',
        'account': {key: value for key, value in EXPECTED_ACCOUNT_DEFAULTS.items() if key != 'timers'},
        'timerCount': 1,
        'freshTimers': True, 'defaultsFrozen': True, 'hash': '#splash',
        'active': ['scr-splash'], 'banners': {'backup': True, 'watch': True}, 'toast': '',
    }, f'重启清除整个命名空间、重置状态与 UI、保留无关键，得到 {restart}')
    ui_context.close()

    print('\n== Task 3：Splash 精确时序与阻断变体 ==')
    timing_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    timing_page = timing_context.new_page()
    timing_errors = []
    attach_errors(timing_page, timing_errors)
    timing_page.clock.install(time=1_000)
    timing_page.clock.pause_at(1_000)
    timing_page.goto(f'{URL}#splash', wait_until='networkidle')
    splash_start = timing_page.evaluate("""() => ({
      state:history.state, length:history.length, hash:location.hash,
      timing:typeof ACCOUNT_TIMING === 'undefined' ? null : ACCOUNT_TIMING.splash,
      timers:typeof account === 'undefined' ? -1 : account.timers.length,
      copy:document.getElementById('scr-splash').innerText,
    })""")
    timing_page.clock.run_for(799)
    before_boundary = active_state(timing_page)
    timing_page.clock.run_for(1)
    at_boundary = timing_page.evaluate("""() => ({
      ...({active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
           hash:location.hash}), state:history.state, length:history.length, timers:account.timers.length,
    })""")
    timing_page.evaluate('history.back()')
    timing_page.clock.run_for(50)
    after_back = active_state(timing_page)
    check(splash_start['timing'] == 800 and splash_start['timers'] == 1 and
          'checking' in splash_start['copy'].lower() and
          before_boundary == {'active': ['scr-splash'], 'hash': '#splash'} and
          at_boundary['active'] == ['scr-auth'] and at_boundary['hash'] == '#auth' and
          at_boundary['state']['stack'] == ['scr-auth'] and
          at_boundary['length'] == splash_start['length'] and at_boundary['timers'] == 0 and
          after_back != {'active': ['scr-splash'], 'hash': '#splash'} and not timing_errors,
          f'Splash 799ms 仍停留、800ms replace 到 Auth 且 Back 不重开，'
          f'start={splash_start} before={before_boundary} at={at_boundary} back={after_back} errors={timing_errors}')
    timing_context.close()

    click_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    click_page = click_context.new_page()
    click_page.clock.install(time=1_500)
    click_page.clock.pause_at(1_500)
    click_page.goto(f'{URL}#splash', wait_until='networkidle')
    click_base_length = click_page.evaluate('history.length')
    accelerator_count = click_page.locator('#splash-continue').count()
    click_page.clock.run_for(799)
    click_799 = active_state(click_page)
    click_page.clock.run_for(1)
    click_800 = click_page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      hash:location.hash, stack:history.state.stack, length:history.length,
      method:account.authMethod, timers:account.timers.length,
      accelerator:document.querySelectorAll('#splash-continue').length,
    })""")
    click_page.clock.run_for(500)
    click_after_social_window = click_page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      hash:location.hash, stack:history.state.stack, length:history.length,
      method:account.authMethod, timers:account.timers.length,
    })""")
    check(click_799 == {'active': ['scr-splash'], 'hash': '#splash'} and
          accelerator_count == 0 and
          click_800 == {'active': ['scr-auth'], 'hash': '#auth', 'stack': ['scr-auth'],
                        'length': click_base_length, 'method': '', 'timers': 0, 'accelerator': 0} and
          click_after_social_window == {'active': ['scr-auth'], 'hash': '#auth',
                                        'stack': ['scr-auth'], 'length': click_base_length,
                                        'method': '', 'timers': 0},
          f'Splash 无加速控件，无用户操作时仅在 800ms replace 到 Auth，'
          f'799={click_799} 800={click_800} later={click_after_social_window}')
    click_context.close()

    unknown_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    unknown_page = unknown_context.new_page()
    unknown_page.clock.install(time=1_800)
    unknown_page.clock.pause_at(1_800)
    unknown_page.goto(f'{URL}?demo=unknown#splash', wait_until='networkidle')
    unknown_page.clock.run_for(799)
    unknown_799 = active_state(unknown_page)
    unknown_page.clock.run_for(1)
    unknown_800 = unknown_page.evaluate("""() => ({
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
      hash:location.hash, search:location.search, stack:history.state.stack,
    })""")
    check(unknown_799 == {'active': ['scr-splash'], 'hash': '#splash'} and
          unknown_800 == {'active': ['scr-auth'], 'hash': '#auth',
                          'search': '?demo=unknown', 'stack': ['scr-auth']},
          f'未知 demo 值不阻断普通 Splash，799/800ms={unknown_799}/{unknown_800}')
    unknown_context.close()

    print('\n== Task 3：BFCache 恢复时器 ==')
    bfcache_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    bfcache_page = bfcache_context.new_page()
    bfcache_page.clock.install(time=1_900)
    bfcache_page.clock.pause_at(1_900)
    bfcache_page.goto(f'{URL}#splash', wait_until='networkidle')
    bfcache_page.clock.run_for(200)
    before_nonpersisted = bfcache_page.evaluate('account.timers.slice()')
    bfcache_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:false}))")
    after_nonpersisted = bfcache_page.evaluate('account.timers.slice()')
    bfcache_page.clock.run_for(100)
    bfcache_page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")
    hidden_timer_count = bfcache_page.evaluate('account.timers.length')
    bfcache_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
    first_restore = bfcache_page.evaluate('account.timers.slice()')
    bfcache_page.clock.run_for(400)
    bfcache_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
    repeated_restore = bfcache_page.evaluate('account.timers.slice()')
    bfcache_page.clock.run_for(799)
    restored_799 = active_state(bfcache_page)
    bfcache_page.clock.run_for(1)
    restored_800 = active_state(bfcache_page)
    check(len(before_nonpersisted) == 1 and after_nonpersisted == before_nonpersisted and
          hidden_timer_count == 0 and len(first_restore) == 1 and
          len(repeated_restore) == 1 and repeated_restore != first_restore and
          restored_799 == {'active': ['scr-splash'], 'hash': '#splash'} and
          restored_800 == {'active': ['scr-auth'], 'hash': '#auth'},
          f'BFCache 恢复幂等重启 Splash 800ms，非 persisted 不扰动，'
          f'timers={before_nonpersisted}/{after_nonpersisted}/{hidden_timer_count}/'
          f'{first_restore}/{repeated_restore} states={restored_799}/{restored_800}')
    bfcache_context.close()

    for demo in ('splash-force-update', 'splash-maintenance'):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        pg.clock.install(time=1_950)
        pg.clock.pause_at(1_950)
        pg.goto(f'{URL}?demo={demo}#splash', wait_until='networkidle')
        pg.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")
        pg.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
        pg.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
        pg.clock.run_for(1_600)
        variant_restore = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el => el.id),
          hash:location.hash, timers:account.timers.length,
        })""")
        check(variant_restore == {'active': ['scr-splash'], 'hash': '#splash', 'timers': 0},
              f'{demo} BFCache 恢复后仍阻断，得到 {variant_restore}')
        context.close()

    for demo, expected_copy in (('splash-force-update', 'update required'),
                                ('splash-maintenance', 'maintenance')):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        demo_errors = []
        attach_errors(pg, demo_errors)
        pg.clock.install(time=2_000)
        pg.clock.pause_at(2_000)
        pg.goto(f'{URL}?demo={demo}#splash', wait_until='networkidle')
        pg.clock.run_for(1_600)
        blocked = pg.evaluate("""() => ({
          state:history.state, hash:location.hash, timers:account.timers.length,
          copy:document.getElementById('scr-splash').innerText.toLowerCase(),
        })""")
        check(blocked['hash'] == '#splash' and blocked['state']['stack'] == ['scr-splash'] and
              expected_copy in blocked['copy'] and not demo_errors,
              f'{demo} >800ms 仍阻断且有明确状态文案，得到 {blocked} errors={demo_errors}')
        if demo == 'splash-maintenance':
            pg.locator('#splash-retry').click()
            pg.clock.run_for(1_600)
            retried = active_state(pg)
            pg.locator('#splash-reset').click()
            reset_immediate = pg.evaluate("""() => ({search:location.search, hash:location.hash,
              active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
              timers:account.timers.length})""")
            pg.clock.run_for(799)
            reset_799 = active_state(pg)
            pg.clock.run_for(1)
            reset_800 = active_state(pg)
            check(retried == {'active': ['scr-splash'], 'hash': '#splash'} and
                  reset_immediate == {'search': '', 'hash': '#splash',
                                      'active': ['scr-splash'], 'timers': 1} and
                  reset_799 == {'active': ['scr-splash'], 'hash': '#splash'} and
                  reset_800 == {'active': ['scr-auth'], 'hash': '#auth'},
                  f'Maintenance Retry 仍停留；Reset 移除 query 并重跑 800ms，'
                  f'retried={retried} reset={reset_immediate}/{reset_799}/{reset_800}')
        context.close()

    leak_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    leak_page = leak_context.new_page()
    leak_page.clock.install(time=3_000)
    leak_page.clock.pause_at(3_000)
    leak_page.goto(f'{URL}#splash', wait_until='networkidle')
    leak_page.clock.run_for(300)
    leak_page.evaluate("navigate(['scr-home'])")
    left_splash = leak_page.evaluate("""() => ({state:history.state, timers:account.timers.length})""")
    leak_page.clock.run_for(1_000)
    stayed_signed_in = active_state(leak_page)
    check(left_splash == {'state': {'stack': ['scr-home']}, 'timers': 0} and
          stayed_signed_in == {'active': ['scr-home'], 'hash': '#home'},
          f'离开 Splash 后清理延迟结果，得到 {left_splash} -> {stayed_signed_in}')
    leak_context.close()

    print('\n== Task 3：Auth 方式选择器、进度与历史 ==')
    focus_contract = page.evaluate("""() => [...document.querySelectorAll('.account-screen')].map(screen => {
      const labelId=screen.getAttribute('aria-labelledby');
      const heading=labelId && document.getElementById(labelId);
      return {screen:screen.id, labelId,
              headingId:heading&&heading.id, headingTag:heading&&heading.tagName,
              tabindex:heading&&heading.getAttribute('tabindex'),
              routeFocus:Boolean(heading&&heading.hasAttribute('data-route-focus'))};
    })""")
    check(len(focus_contract) == 9 and len({item['labelId'] for item in focus_contract}) == 9 and
          all(item['labelId'] and item['headingId'] == item['labelId'] and
              item['headingTag'] == 'H1' and item['tabindex'] == '-1' and item['routeFocus']
              for item in focus_contract),
          f'9 个 account section 各由唯一可编程聚焦 h1 命名，得到 {focus_contract}')

    focus_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    focus_page = focus_context.new_page()
    focus_page.clock.install(time=3_500)
    focus_page.clock.pause_at(3_500)
    focus_page.goto(f'{URL}#splash', wait_until='networkidle')
    focus_page.clock.run_for(16)
    splash_focus = focus_page.evaluate("document.activeElement.id")
    focus_page.clock.run_for(784)
    focus_page.clock.run_for(16)
    auth_focus = focus_page.evaluate("document.activeElement.id")
    focus_page.locator('#auth-email').click()
    focus_page.clock.run_for(16)
    destination_focus = focus_page.evaluate("""() => ({active:document.activeElement.id,
      hidden:Boolean(document.activeElement.closest('.scr:not(.active)'))})""")
    focus_page.evaluate('history.back()')
    focus_page.clock.run_for(16)
    history_focus = focus_page.evaluate("""() => ({active:document.activeElement.id,
      hidden:Boolean(document.activeElement.closest('.scr:not(.active)')), hash:location.hash})""")
    check(splash_focus == 'splash-title' and auth_focus == 'auth-title' and
          destination_focus == {'active': 'auth-otp-title', 'hidden': False} and
          history_focus == {'active': 'auth-title', 'hidden': False, 'hash': '#auth'},
          f'account 路由自动/方法/browser history 后只聚焦活动标题，'
          f'{splash_focus}/{auth_focus}/{destination_focus}/{history_focus}')
    focus_context.close()

    auth_methods = {
        'auth-email': ('email', ['scr-auth', 'scr-auth-otp']),
        'auth-phone': ('phone', ['scr-auth', 'scr-auth-otp']),
        'auth-wallet': ('wallet', ['scr-auth', 'scr-auth-wallet']),
        'auth-import': ('import', ['scr-auth', 'scr-wallet-import']),
    }
    for button_id, (method, expected_stack) in auth_methods.items():
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        requests = []
        pg.on('request', lambda request, bucket=requests:
              bucket.append(request.url) if request.url.startswith(('http://', 'https://')) else None)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        before_length = pg.evaluate('history.length')
        pg.locator(f'#{button_id}').click()
        outcome = pg.evaluate("""() => ({stack:history.state.stack, hash:location.hash,
          length:history.length, method:account.authMethod})""")
        check(outcome == {'stack': expected_stack, 'hash': '#' + {
                  'auth-email': 'auth-otp', 'auth-phone': 'auth-otp',
                  'auth-wallet': 'auth-wallet', 'auth-import': 'wallet-import'}[button_id],
                  'length': before_length + 1, 'method': method} and not requests,
              f'{button_id} push 精确分支且无网络请求，得到 {outcome} requests={requests}')
        context.close()

    for button_id, method in (('auth-google', 'google'), ('auth-apple', 'apple'),
                              ('auth-passkey', 'passkey')):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        context.add_init_script("Object.defineProperty(window, 'PublicKeyCredential', {configurable:true, value:function PublicKeyCredential(){}})")
        pg = context.new_page()
        social_errors = []
        requests = []
        attach_errors(pg, social_errors)
        pg.on('request', lambda request, bucket=requests:
              bucket.append(request.url) if request.url.startswith(('http://', 'https://')) else None)
        pg.clock.install(time=4_000)
        pg.clock.pause_at(4_000)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        before_length = pg.evaluate('history.length')
        pg.locator(f'#{button_id}').dblclick(delay=20)
        pending = pg.evaluate("""id => {
          const button=document.getElementById(id);
          return {text:button.innerText, disabled:button.disabled, busy:button.getAttribute('aria-busy'),
                  stack:history.state.stack, method:account.authMethod,
                  timing:ACCOUNT_TIMING.socialAuth, timers:account.timers.length,
                  described:button.getAttribute('aria-describedby')};
        }""", button_id)
        pg.clock.run_for(449)
        at_449 = active_state(pg)
        pg.clock.run_for(1)
        social_done = pg.evaluate("""() => ({stack:history.state.stack, hash:location.hash,
          length:history.length, timers:account.timers.length})""")
        check(method.title() in pending['text'] and 'Signing in' in pending['text'] and
              pending['disabled'] and pending['busy'] == 'true' and pending['stack'] == ['scr-auth'] and
              pending['method'] == method and pending['timing'] == 450 and pending['timers'] == 1 and
              pending['described'] is None and
              at_449 == {'active': ['scr-auth'], 'hash': '#auth'} and
              social_done == {'stack': ['scr-auth', 'scr-wallet-create'],
                              'hash': '#wallet-create', 'length': before_length + 1, 'timers': 0} and
              not requests and not social_errors,
              f'{button_id} 保留标签的 450ms 进度、双击仅 push 一次，'
              f'pending={pending} 449={at_449} done={social_done} requests={requests} errors={social_errors}')
        context.close()

    absent_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    absent_context.add_init_script("delete window.PublicKeyCredential")
    absent_page = absent_context.new_page()
    absent_page.goto(f'{URL}#auth', wait_until='networkidle')
    passkey_absent = absent_page.evaluate("""() => {
      const button=document.getElementById('auth-passkey');
      return {disabled:button.disabled, aria:button.getAttribute('aria-disabled'),
              described:button.getAttribute('aria-describedby'),
              explanation:document.getElementById('auth-passkey-note').innerText,
              disclosure:document.getElementById('scr-auth').innerText};
    }""")
    check(passkey_absent['disabled'] and passkey_absent['aria'] == 'true' and
          passkey_absent['described'] == 'auth-passkey-note' and
          'not available' in passkey_absent['explanation'].lower() and
          'designed for privy' in passkey_absent['disclosure'].lower() and
          'simulated' in passkey_absent['disclosure'].lower(),
          f'WebAuthn 缺失时 Passkey 真禁用且明示原因/原型披露，得到 {passkey_absent}')
    absent_context.close()

    print('\n== Task 4：OTP 可访问结构、输入与键盘 ==')
    otp_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    otp_page = otp_context.new_page()
    otp_errors = []
    attach_errors(otp_page, otp_errors)
    otp_page.goto(f'{URL}#auth', wait_until='networkidle')
    otp_page.locator('#auth-email').click()
    otp_page.wait_for_function("document.activeElement?.id === 'auth-otp-title'")
    structure = otp_page.evaluate("""() => {
      const inputs=[...document.querySelectorAll('#scr-auth-otp input')];
      const group=document.querySelector('#scr-auth-otp fieldset');
      return {
        ids:inputs.map(el=>el.id),
        labels:inputs.map(el=>Boolean(document.querySelector(`label[for="${el.id}"]`))),
        numeric:inputs.map(el=>el.inputMode), max:inputs.map(el=>el.maxLength),
        autocomplete:inputs.map(el=>el.autocomplete),
        sensitive:inputs.map(el=>el.hasAttribute('data-sensitive')),
        groupLabel:Boolean(group && group.querySelector('legend')),
        context:document.getElementById('otp-auth-context')?.innerText || '',
        statusLive:document.getElementById('otp-status')?.getAttribute('aria-live') || null,
        statusDisplay:document.getElementById('otp-status')
          ? getComputedStyle(document.getElementById('otp-status')).display : null,
        lockCountdownLive:document.getElementById('otp-lock-countdown')
          ?.getAttribute('aria-live') || null,
        verifyDisabled:document.getElementById('otp-verify')?.disabled ?? null,
        resendDisabled:document.getElementById('otp-resend')?.disabled ?? null,
        focused:document.activeElement.id,
      };
    }""")
    check(structure['ids'] == [f'otp-digit-{i}' for i in range(1, 7)] and
          all(structure['labels']) and all(x == 'numeric' for x in structure['numeric']) and
          all(x == 1 for x in structure['max']) and all(structure['sensitive']) and
          structure['autocomplete'][0] == 'one-time-code' and
          all(x != 'one-time-code' for x in structure['autocomplete'][1:]) and
          structure['groupLabel'] and 'email' in structure['context'].lower() and
          structure['statusLive'] == 'polite' and structure['statusDisplay'] != 'none' and
          structure['lockCountdownLive'] == 'off' and structure['verifyDisabled'] and
          structure['resendDisabled'] and structure['focused'] == 'auth-otp-title',
          f'6 个独立 OTP 输入有标签/数字/敏感标记，路由聚焦标题，得到 {structure}')
    if structure['ids'] != [f'otp-digit-{i}' for i in range(1, 7)]:
        otp_context.close()
        browser.close()
        print('\n' + f'{len(fails)} 项失败:')
        for failure in fails:
            print(' -', failure)
        sys.exit(1)

    first = otp_page.locator('#otp-digit-1')
    first.press_sequentially('a1')
    after_filter = otp_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      account:account.otp, focused:document.activeElement.id,
      verify:document.getElementById('otp-verify').disabled,
    })""")
    otp_page.locator('#otp-digit-2').press('Backspace')
    after_backspace = otp_page.evaluate('document.activeElement.id')
    otp_page.locator('#otp-digit-1').press('ArrowRight')
    after_right = otp_page.evaluate('document.activeElement.id')
    otp_page.locator('#otp-digit-2').press('ArrowLeft')
    after_left = otp_page.evaluate('document.activeElement.id')
    otp_paste(otp_page, '#otp-digit-1', '2x4-6 8a10')
    after_paste = otp_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      account:account.otp, focused:document.activeElement.id,
      verify:document.getElementById('otp-verify').disabled,
    })""")
    otp_paste(otp_page, '#otp-digit-1', 'x7 y8')
    invalid_paste = otp_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      account:account.otp, verify:document.getElementById('otp-verify').disabled,
    })""")
    check(after_filter == {'values': ['1', '', '', '', '', ''], 'account': '1',
                           'focused': 'otp-digit-2', 'verify': True} and
          after_backspace == 'otp-digit-1' and after_right == 'otp-digit-2' and
          after_left == 'otp-digit-1' and
          after_paste == {'values': ['2', '4', '6', '8', '1', '0'], 'account': '246810',
                          'focused': 'otp-digit-6', 'verify': False} and
          invalid_paste == {'values': ['7', '8', '', '', '', ''], 'account': '78',
                            'verify': True} and not otp_errors,
          f'过滤/前进/空退格/方向键/粘贴/启用状态正确，filter={after_filter} '
          f'paste={after_paste} invalid={invalid_paste} errors={otp_errors}')
    otp_context.close()

    autofill_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    autofill_page = autofill_context.new_page()
    autofill_page.goto(f'{URL}#auth', wait_until='networkidle')
    autofill_page.locator('#auth-email').click()
    autofill_page.wait_for_function("document.activeElement?.id === 'auth-otp-title'")
    autofill_page.evaluate("""() => {
      const input=document.getElementById('otp-digit-1');
      input.value='246810';
      input.dispatchEvent(new InputEvent('input', {
        bubbles:true, inputType:'insertReplacementText', data:'246810',
      }));
    }""")
    autofill = autofill_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      account:account.otp, focused:document.activeElement.id,
      verify:document.getElementById('otp-verify').disabled,
    })""")
    check(autofill == {'values': ['2', '4', '6', '8', '1', '0'], 'account': '246810',
                       'focused': 'otp-digit-6', 'verify': False},
          f'insertReplacementText 六位 autofill 分发到独立输入，得到 {autofill}')
    autofill_context.close()

    composition_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    composition_page = composition_context.new_page()
    composition_page.goto(f'{URL}#auth', wait_until='networkidle')
    composition_page.locator('#auth-email').click()
    composition_page.wait_for_function("document.activeElement?.id === 'auth-otp-title'")
    composition_page.locator('#otp-digit-1').focus()
    composition_page.evaluate("""() => {
      const input=document.getElementById('otp-digit-1');
      input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}));
      input.value='246810';
      input.dispatchEvent(new InputEvent('input', {
        bubbles:true, inputType:'insertCompositionText', data:'246810', isComposing:true,
      }));
    }""")
    composing = composition_page.evaluate("""() => ({
      account:account.otp, value:document.getElementById('otp-digit-1').value,
      focused:document.activeElement.id,
    })""")
    composition_page.evaluate("""() => {
      const input=document.getElementById('otp-digit-1');
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles:true, data:'246810',
      }));
    }""")
    composed = composition_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      account:account.otp, focused:document.activeElement.id,
      verify:document.getElementById('otp-verify').disabled,
    })""")
    check(composing == {'account': '', 'value': '246810', 'focused': 'otp-digit-1'} and
          composed == {'values': ['2', '4', '6', '8', '1', '0'], 'account': '246810',
                       'focused': 'otp-digit-6', 'verify': False},
          f'IME composition 期间不更新，compositionend 仅分发一次，mid={composing} done={composed}')
    composition_context.close()

    phone_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    phone_page = phone_context.new_page()
    phone_page.goto(f'{URL}#auth', wait_until='networkidle')
    phone_page.locator('#auth-phone').click()
    phone_copy = phone_page.locator('#otp-auth-context').inner_text().lower()
    check('phone' in phone_copy and 'email' not in phone_copy,
          f'phone 分支显示非敏感上下文，得到 {phone_copy!r}')
    phone_context.close()

    print('\n== Task 4：OTP 确定性验证结果与返回栈 ==')
    fixture_expectations = {
        '000000': ('Code expired', 0),
        '999998': ('Service unavailable', 0),
        '135790': ('Invalid code', 1),
    }
    for fixture, (copy, failures) in fixture_expectations.items():
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        fixture_console = []
        fixture_errors = []
        attach_errors(pg, fixture_errors, fixture_console)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        pg.locator('#auth-email').click()
        otp_enter(pg, fixture)
        outcome = pg.evaluate("""() => ({
          stack:history.state.stack, hash:location.hash, failures:account.otpFailures,
          status:document.getElementById('otp-status').innerText,
          toast:document.getElementById('toast').innerText,
        })""")
        leaked_copy = fixture in outcome['status'] or fixture in outcome['toast'] or any(
            fixture in line for line in fixture_console)
        check(outcome['stack'] == ['scr-auth', 'scr-auth-otp'] and
              outcome['hash'] == '#auth-otp' and copy.lower() in outcome['status'].lower() and
              outcome['failures'] == failures and not leaked_copy and not fixture_errors,
              f'{fixture} 留在 OTP 且给出非泄密结果，得到 {outcome} errors={fixture_errors}')
        context.close()

    success_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    success_page = success_context.new_page()
    success_console = []
    attach_errors(success_page, [], success_console)
    success_page.goto(f'{URL}#auth', wait_until='networkidle')
    success_page.locator('#auth-email').click()
    success_length = success_page.evaluate('history.length')
    otp_enter(success_page, '246810')
    success = success_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length, otp:account.otp,
      accountPushed:history.state.accountPushed === true,
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
    })""")
    success_page.evaluate("""() => {
      window.__accountBackPopped=false;
      addEventListener('popstate', () => { window.__accountBackPopped=true }, {once:true});
      back();
    }""")
    success_page.wait_for_function("""() => location.hash === '#auth-otp' &&
      document.activeElement?.id === 'auth-otp-title'""")
    returned = success_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, otp:account.otp,
      length:history.length, accountPushed:history.state.accountPushed === true,
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      focused:document.activeElement.id,
    })""")
    success_page.evaluate("""() => {
      window.__parentBackPopped=false;
      addEventListener('popstate', () => { window.__parentBackPopped=true }, {once:true});
      history.back();
    }""")
    success_page.wait_for_function('window.__parentBackPopped === true')
    after_parent_back = success_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length,
      accountPushed:history.state.accountPushed === true,
    })""")
    check(success == {'stack': ['scr-auth', 'scr-auth-otp', 'scr-wallet-create'],
                      'hash': '#wallet-create', 'length': success_length + 1, 'otp': '',
                      'accountPushed': True,
                      'values': ['', '', '', '', '', '']} and
          returned == {'stack': ['scr-auth', 'scr-auth-otp'], 'hash': '#auth-otp', 'otp': '',
                       'length': success_length + 1, 'accountPushed': True,
                       'values': ['', '', '', '', '', ''], 'focused': 'auth-otp-title'} and
          after_parent_back == {'stack': ['scr-auth'], 'hash': '#auth',
                                'length': success_length + 1, 'accountPushed': False} and
          not any('246810' in line for line in success_console),
          f'成功 push、in-app Back 回 OTP、再 browser Back 回 Auth 且无重复历史，'
          f'success={success} returned={returned} parent={after_parent_back}')
    success_context.close()

    reload_back_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    reload_back_page = reload_back_context.new_page()
    reload_back_page.goto(f'{URL}#auth', wait_until='networkidle')
    reload_back_page.locator('#auth-email').click()
    otp_enter(reload_back_page, '246810')
    before_reload = reload_back_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length,
      accountPushed:history.state.accountPushed === true,
      entryId:history.state.accountEntryId ?? null,
      helper:typeof hasValidAccountHistoryProvenance === 'function'
        ? hasValidAccountHistoryProvenance() : null,
    })""")
    reload_back_page.reload(wait_until='networkidle')
    wait_for_settled_screen(reload_back_page, 'wallet-create')
    after_reload = reload_back_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length,
      accountPushed:history.state.accountPushed === true,
      entryId:history.state.accountEntryId ?? null,
      helper:typeof hasValidAccountHistoryProvenance === 'function'
        ? hasValidAccountHistoryProvenance() : null,
    })""")
    reload_back_page.evaluate("""() => {
      window.__reloadProofPopped=false;
      addEventListener('popstate',()=>{window.__reloadProofPopped=true},{once:true});
      back();
    }""")
    reload_back_page.wait_for_function("""() =>
      location.hash === '#auth' || window.__reloadProofPopped === true""")
    after_reload_back = reload_back_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length,
      accountPushed:history.state.accountPushed === true,
      entryId:history.state.accountEntryId ?? null,
      popped:window.__reloadProofPopped,
    })""")
    check(before_reload['accountPushed'] is True and before_reload['helper'] is True and
          isinstance(before_reload['entryId'], str) and before_reload['entryId'] and
          after_reload == {
              'stack': ['scr-auth', 'scr-auth-otp', 'scr-wallet-create'],
              'hash': '#wallet-create', 'length': before_reload['length'],
              'accountPushed': False, 'entryId': None, 'helper': False,
          } and
          after_reload_back == {
              'stack': ['scr-auth'], 'hash': '#auth',
              'length': before_reload['length'], 'accountPushed': False, 'entryId': None,
              'popped': False,
          },
          f'成功页 reload 不信任未知运行时 proof，Back 按 defaultParent 安全 fallback，'
          f'before={before_reload} reload={after_reload} back={after_reload_back}')
    reload_back_context.close()

    direct_back_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    direct_back_page = direct_back_context.new_page()
    direct_back_page.goto(f'{URL}#wallet-create', wait_until='networkidle')
    direct_back_page.reload(wait_until='networkidle')
    wait_for_settled_screen(direct_back_page, 'wallet-create')
    direct_length = direct_back_page.evaluate('history.length')
    direct_before = direct_back_page.evaluate("""() => ({stack:history.state.stack,
      accountPushed:history.state.accountPushed === true})""")
    direct_back_page.evaluate('back()')
    direct_back_page.wait_for_function("location.hash === '#auth'")
    direct_after = direct_back_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash, length:history.length,
      accountPushed:history.state.accountPushed === true,
      active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
    })""")
    check(direct_before == {'stack': ['scr-auth', 'scr-wallet-create'],
                            'accountPushed': False} and
          direct_after == {'stack': ['scr-auth'], 'hash': '#auth', 'length': direct_length,
                           'accountPushed': False, 'active': ['scr-auth']},
          f'直接 #wallet-create 的 in-app Back replace 到 Auth 且不离开应用，'
          f'before={direct_before} after={direct_after}')
    direct_back_context.close()

    invalid_marker_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    invalid_marker_page = invalid_marker_context.new_page()
    invalid_marker_page.goto(f'{URL}#wallet-create', wait_until='networkidle')
    invalid_marker_page.evaluate("""() => history.replaceState({
      stack:['scr-not-a-screen'], accountPushed:true,
    }, '', '#wallet-create')""")
    invalid_marker_page.reload(wait_until='networkidle')
    wait_for_settled_screen(invalid_marker_page, 'wallet-create')
    invalid_marker_restore = invalid_marker_page.evaluate("""() => ({
      stack:history.state.stack, hash:location.hash,
      accountPushed:history.state.accountPushed === true,
    })""")
    check(invalid_marker_restore == {
        'stack': ['scr-auth', 'scr-wallet-create'], 'hash': '#wallet-create',
        'accountPushed': False,
    }, f'非法 history stack 不能伪造 accountPushed，得到 {invalid_marker_restore}')
    invalid_marker_context.close()

    print('\n== Task 4：OTP 重发与五次失败锁定时钟边界 ==')
    resend_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    resend_page = resend_context.new_page()
    resend_page.clock.install(time=10_000)
    resend_page.clock.pause_at(10_000)
    resend_page.goto(f'{URL}#auth', wait_until='networkidle')
    resend_page.locator('#auth-email').click()
    resend_start = resend_page.evaluate("""() => ({
      resend:document.getElementById('otp-resend').disabled,
      copy:document.getElementById('otp-resend-countdown').innerText,
      timing:ACCOUNT_TIMING.otpResend, now:Date.now(), expires:account.otpExpiresAt,
      timers:account.timers.length,
    })""")
    resend_page.clock.run_for(59_999)
    resend_59999 = resend_page.evaluate("""() => ({
      disabled:document.getElementById('otp-resend').disabled,
      copy:document.getElementById('otp-resend-countdown').innerText,
    })""")
    resend_page.clock.run_for(1)
    resend_60000 = resend_page.evaluate("""() => ({
      disabled:document.getElementById('otp-resend').disabled,
      copy:document.getElementById('otp-resend-countdown').innerText,
    })""")
    otp_fill(resend_page, '135790')
    resend_page.locator('#otp-verify').click()
    resend_error = resend_page.evaluate("""() => ({
      status:document.getElementById('otp-status').innerText,
      error:document.getElementById('otp-status').classList.contains('is-error'),
      failures:account.otpFailures,
    })""")
    resend_page.locator('#otp-resend').click()
    resend_restart = resend_page.evaluate("""() => ({
      disabled:document.getElementById('otp-resend').disabled,
      copy:document.getElementById('otp-resend-countdown').innerText,
      status:document.getElementById('otp-status').innerText,
      error:document.getElementById('otp-status').classList.contains('is-error'),
      live:document.getElementById('otp-status').getAttribute('aria-live'),
      otp:account.otp, values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      now:Date.now(), expires:account.otpExpiresAt, timers:account.timers.length,
    })""")
    check(resend_start['resend'] and resend_start['timing'] == 60_000 and
          resend_start['expires'] - resend_start['now'] == 60_000 and resend_start['timers'] > 0 and
          resend_59999['disabled'] and not resend_60000['disabled'] and
          resend_error['error'] and resend_error['failures'] == 1 and
          'invalid code' in resend_error['status'].lower() and
          resend_restart['disabled'] and 'new code sent' in resend_restart['status'].lower() and
          not resend_restart['error'] and resend_restart['live'] == 'polite' and
          resend_restart['otp'] == '' and resend_restart['values'] == [''] * 6 and
          resend_restart['expires'] - resend_restart['now'] == 60_000 and resend_restart['timers'] > 0,
          f'重发 59999/60000 边界及重启正确，start={resend_start} '
          f'boundary={resend_59999}/{resend_60000} error={resend_error} restart={resend_restart}')
    resend_context.close()

    combined_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    combined_page = combined_context.new_page()
    combined_page.clock.install(time=15_000)
    combined_page.clock.pause_at(15_000)
    combined_page.goto(f'{URL}#auth', wait_until='networkidle')
    combined_page.locator('#auth-email').click()
    combined_page.clock.run_for(60_000)
    resend_before_lock = combined_page.evaluate("""() => ({
      disabled:document.getElementById('otp-resend').disabled,
      expires:account.otpExpiresAt, now:Date.now(), timers:account.timers.length,
    })""")
    for _ in range(5):
        otp_enter(combined_page, '135790')
    combined_locked = combined_page.evaluate("""() => ({
      resend:document.getElementById('otp-resend').disabled,
      locked:account.otpLockedUntil, now:Date.now(), timers:account.timers.length,
      failures:account.otpFailures,
    })""")
    combined_page.evaluate("document.getElementById('otp-resend').click()")
    after_locked_resend = combined_page.evaluate("""() => ({
      resend:document.getElementById('otp-resend').disabled,
      locked:account.otpLockedUntil, timers:account.timers.length,
      failures:account.otpFailures, otp:account.otp,
    })""")
    combined_page.clock.run_for(30_000)
    combined_unlocked = combined_page.evaluate("""() => ({
      resend:document.getElementById('otp-resend').disabled,
      locked:account.otpLockedUntil, failures:account.otpFailures,
      otp:account.otp, timers:account.timers.length,
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
    })""")
    check(resend_before_lock['disabled'] is False and
          resend_before_lock['expires'] <= resend_before_lock['now'] and
          combined_locked['resend'] and combined_locked['failures'] == 5 and
          combined_locked['locked'] - combined_locked['now'] == 30_000 and
          after_locked_resend == {
              'resend': True, 'locked': combined_locked['locked'],
              'timers': combined_locked['timers'], 'failures': 5, 'otp': '135790'} and
          combined_unlocked == {'resend': False, 'locked': 0, 'failures': 0, 'otp': '',
                                'timers': 0, 'values': [''] * 6},
          f'已到期 Resend 在 lock 中禁用且不可取消 unlock，解锁后按原 deadline 恢复，'
          f'before={resend_before_lock} locked={combined_locked} '
          f'clicked={after_locked_resend} unlocked={combined_unlocked}')
    combined_context.close()

    lock_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    lock_page = lock_context.new_page()
    lock_page.clock.install(time=20_000)
    lock_page.clock.pause_at(20_000)
    lock_page.goto(f'{URL}#auth', wait_until='networkidle')
    lock_page.locator('#auth-email').click()
    attempts = []
    for attempt in range(1, 6):
        if attempt == 5:
            lock_page.evaluate("""() => {
              window.__otpAnnouncements=[];
              const status=document.getElementById('otp-status');
              new MutationObserver(() => window.__otpAnnouncements.push(status.textContent))
                .observe(status, {childList:true, subtree:true, characterData:true});
            }""")
        otp_enter(lock_page, '135790')
        attempts.append(lock_page.evaluate("""() => ({
          failures:account.otpFailures, now:Date.now(), locked:account.otpLockedUntil,
          inputs:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.disabled),
          verify:document.getElementById('otp-verify').disabled,
          status:document.getElementById('otp-status').innerText,
          visual:document.getElementById('otp-lock-countdown')?.innerText || '',
        })"""))
    lock_page.clock.run_for(1_000)
    locked_1000 = lock_page.evaluate("""() => ({
      status:document.getElementById('otp-status').innerText,
      visual:document.getElementById('otp-lock-countdown')?.innerText || '',
      visualLive:document.getElementById('otp-lock-countdown')?.getAttribute('aria-live') || null,
      inputs:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.disabled),
      verify:document.getElementById('otp-verify').disabled,
    })""")
    lock_page.clock.run_for(28_999)
    locked_29999 = lock_page.evaluate("""() => ({
      failures:account.otpFailures, locked:account.otpLockedUntil,
      inputs:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.disabled),
      verify:document.getElementById('otp-verify').disabled,
    })""")
    lock_page.clock.run_for(1)
    unlocked_30000 = lock_page.evaluate("""() => ({
      failures:account.otpFailures, locked:account.otpLockedUntil, otp:account.otp,
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
      inputs:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.disabled),
      verify:document.getElementById('otp-verify').disabled,
      visual:document.getElementById('otp-lock-countdown')?.innerText || '',
      announcements:window.__otpAnnouncements,
    })""")
    check(all(item['failures'] == i and not any(item['inputs']) and not item['verify']
              for i, item in enumerate(attempts[:4], 1)) and
          attempts[4]['failures'] == 5 and
          attempts[4]['locked'] - attempts[4]['now'] == 30_000 and
          all(attempts[4]['inputs']) and attempts[4]['verify'] and
          '30' in attempts[4]['visual'] and
          '29' in locked_1000['visual'] and locked_1000['status'] == attempts[4]['status'] and
          locked_1000['visualLive'] == 'off' and
          all(locked_1000['inputs']) and locked_1000['verify'] and
          locked_29999['failures'] == 5 and all(locked_29999['inputs']) and
          unlocked_30000['failures'] == 0 and unlocked_30000['locked'] == 0 and
          unlocked_30000['otp'] == '' and unlocked_30000['values'] == [''] * 6 and
          unlocked_30000['inputs'] == [False] * 6 and unlocked_30000['verify'] and
          unlocked_30000['visual'] == '' and
          unlocked_30000['announcements'] == [attempts[4]['status'], 'You can try again.'],
          f'前四次可重试、第五次锁 30s 并在边界清空解锁，attempts={attempts} '
          f'countdown={locked_1000} boundary={locked_29999}/{unlocked_30000}')
    lock_context.close()

    print('\n== Task 4：UI 输入 OTP 的精确 forbidden-sink 扫描 ==')
    exit_cases = (
        ('success + in-app Back', '246810', '#auth-otp'),
        ('browser Back + Forward', '864209', '#auth-otp'),
        ('external hashchange', '753190', '#market'),
        ('completeOnboarding', '681357', '#home'),
    )
    for exit_name, entered_otp, expected_hash in exit_cases:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        exit_errors = []
        exit_console = []
        attach_errors(pg, exit_errors, exit_console)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        pg.locator('#auth-email').click()
        otp_fill(pg, entered_otp)
        _, before_hits = exact_otp_scan(pg, entered_otp, exit_console)
        check(before_hits == {'accountOtp': entered_otp, 'controlJoined': entered_otp},
              f'{exit_name}: scan 在退出前只于许可的内存/输入面捕获精确 OTP，命中={before_hits}')

        if exit_name == 'success + in-app Back':
            pg.locator('#otp-verify').click()
            pg.wait_for_function("location.hash === '#wallet-create'")
            pg.evaluate('back()')
            pg.wait_for_function("location.hash === '#auth-otp'")
        elif exit_name == 'browser Back + Forward':
            pg.evaluate('history.back()')
            pg.wait_for_function("location.hash === '#auth'")
            pg.evaluate('history.forward()')
            pg.wait_for_function("location.hash === '#auth-otp'")
        elif exit_name == 'external hashchange':
            pg.evaluate("location.hash = 'market'")
            pg.wait_for_function("location.hash === '#market'")
        else:
            pg.evaluate('completeOnboarding()')
            pg.wait_for_function("location.hash === '#home'")

        _, after_hits = exact_otp_scan(pg, entered_otp, exit_console)
        state = pg.evaluate("""() => ({hash:location.hash, otp:account.otp,
          values:[...document.querySelectorAll('input, textarea')].map(el=>el.value)
            .filter(Boolean)})""")
        check(state['hash'] == expected_hash and state['otp'] == '' and
              not after_hits and not exit_errors,
              f'{exit_name}: account/controls/screens/a11y/history/storage/console/toast 无精确 OTP，'
              f'state={state} hits={after_hits} errors={exit_errors}')
        context.close()

    print('\n== Task 4：OTP 离开清理、定时器隔离与 BFCache 幂等 ==')
    for action_name, action in (
            ('route exit', "navigate(['scr-home'])"),
            ('pagehide', "dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        secret_console = []
        secret_errors = []
        attach_errors(pg, secret_errors, secret_console)
        pg.clock.install(time=30_000)
        pg.clock.pause_at(30_000)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        pg.locator('#auth-email').click()
        otp_paste(pg, '#otp-digit-1', '864209')
        pg.evaluate(action)
        immediate = pg.evaluate("""() => ({
          hash:location.hash, otp:account.otp, failures:account.otpFailures,
          timers:account.timers.length,
          values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value),
        })""")
        pg.clock.run_for(90_000)
        later = pg.evaluate("""() => ({hash:location.hash, otp:account.otp,
          timers:account.timers.length})""")
        _, leaked = sensitive_scan(pg, ('864209',), secret_console)
        expected_hash = '#home' if action_name == 'route exit' else '#auth-otp'
        check(immediate == {'hash': expected_hash, 'otp': '', 'failures': 0, 'timers': 0,
                            'values': [''] * 6} and
              later == {'hash': expected_hash, 'otp': '', 'timers': 0} and
              not leaked and not secret_errors,
              f'{action_name} 清除秘密/定时器且挂起回调不能变更路由，'
              f'immediate={immediate} later={later} leaks={leaked} errors={secret_errors}')
        context.close()

    idempotent_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    idempotent_page = idempotent_context.new_page()
    idempotent_page.clock.install(time=40_000)
    idempotent_page.clock.pause_at(40_000)
    idempotent_page.goto(f'{URL}#auth', wait_until='networkidle')
    idempotent_page.locator('#auth-email').click()
    first_timers = idempotent_page.evaluate('account.timers.length')
    idempotent_page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")
    idempotent_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
    restored_timers = idempotent_page.evaluate('account.timers.length')
    idempotent_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
    repeated_timers = idempotent_page.evaluate('account.timers.length')
    otp_paste(idempotent_page, '#otp-digit-1', '12')
    idempotent_values = idempotent_page.evaluate("""() => ({otp:account.otp,
      values:[...document.querySelectorAll('#scr-auth-otp input')].map(el=>el.value)})""")
    check(first_timers > 0 and restored_timers == first_timers and
          repeated_timers == first_timers and
          idempotent_values == {'otp': '12', 'values': ['1', '2', '', '', '', '']},
          f'BFCache setup 幂等，无重复 timer/listener，timers='
          f'{first_timers}/{restored_timers}/{repeated_timers} values={idempotent_values}')
    idempotent_context.close()

    listener_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    listener_context.add_init_script("""(() => {
      window.__otpListenerRegistrations=[];
      const original=EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener=function(type, listener, options){
        const id=this && this.id;
        if(id && (id.startsWith('otp-digit-') || id === 'otp-form' || id === 'otp-resend')){
          window.__otpListenerRegistrations.push(`${id}:${type}`);
        }
        return original.call(this,type,listener,options);
      };
    })()""")
    listener_page = listener_context.new_page()
    listener_page.goto(f'{URL}#auth', wait_until='networkidle')
    listener_page.locator('#auth-email').click()
    registrations_before = listener_page.evaluate('window.__otpListenerRegistrations.slice()')
    for _ in range(3):
        listener_page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}))")
        listener_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))")
    registrations_after = listener_page.evaluate('window.__otpListenerRegistrations.slice()')
    expected_registrations = sorted(
        ['otp-form:submit', 'otp-resend:click'] +
        [f'otp-digit-{index}:{event}' for index in range(1, 7)
         for event in ('input', 'keydown', 'paste', 'compositionend')])
    check(sorted(registrations_before) == expected_registrations and
          registrations_after == registrations_before,
          f'重复 BFCache pagehide/pageshow 不新增 OTP listeners，'
          f'before={registrations_before} after={registrations_after}')
    listener_context.close()

    print('\n== Task 5：外部钱包结构、空态与纯模拟边界 ==')
    wallet_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    wallet_page = wallet_context.new_page()
    wallet_errors = []
    wallet_requests = []
    attach_errors(wallet_page, wallet_errors)
    wallet_page.on('request', lambda request: wallet_requests.append(request.url))
    fresh_incomplete(wallet_page, 'auth-wallet')
    wallet_requests.clear()
    wallet_structure = wallet_page.evaluate(r"""() => ({
      timing:typeof ACCOUNT_TIMING === 'undefined' ? null : {
        signature:ACCOUNT_TIMING.walletSignature,
        timeout:ACCOUNT_TIMING.walletTimeout,
        create:ACCOUNT_TIMING.walletCreate,
      },
      options:[...document.querySelectorAll('#wallet-detected-list input[type="radio"]')]
        .map(el => ({value:el.value, name:el.name, checked:el.checked})),
      labels:[...document.querySelectorAll('#wallet-detected-list label')]
        .map(el => el.textContent.replace(/\s+/g,' ').trim()),
      connect:document.getElementById('wallet-connect')?.disabled,
      status:{
        role:document.getElementById('wallet-connect-state')?.getAttribute('role'),
        live:document.getElementById('wallet-connect-state')?.getAttribute('aria-live'),
        display:getComputedStyle(document.getElementById('wallet-connect-state')).display,
        visibility:getComputedStyle(document.getElementById('wallet-connect-state')).visibility,
        hidden:document.getElementById('wallet-connect-state')?.hidden,
      },
      signatureButtons:['wallet-sign-approve','wallet-sign-reject'].map(id => ({
        id, hidden:document.getElementById(id)?.hidden,
      })),
      retryHidden:document.getElementById('wallet-connect-retry')?.hidden,
      qr:document.getElementById('walletconnect-placeholder')?.textContent.replace(/\s+/g,' ').trim(),
    })""")
    check(wallet_structure == {
        'timing': {'signature': 500, 'timeout': 10000, 'create': 700},
        'options': [
            {'value': 'demo', 'name': 'detected-wallet', 'checked': False},
            {'value': 'timeout', 'name': 'detected-wallet', 'checked': False},
            {'value': 'failure', 'name': 'detected-wallet', 'checked': False},
        ],
        'labels': ['Demo Wallet Success · signature request',
                   'Timeout Wallet Simulated timeout',
                   'Failure Wallet Simulated connection error'],
        'connect': True,
        'status': {'role': 'status', 'live': 'polite', 'display': 'block',
                   'visibility': 'visible', 'hidden': False},
        'signatureButtons': [
            {'id': 'wallet-sign-approve', 'hidden': True},
            {'id': 'wallet-sign-reject', 'hidden': True},
        ],
        'retryHidden': True,
        'qr': 'WalletConnect QR placeholder — nonfunctional and simulated.',
    }, f'钱包选择器语义、状态出口与精确时序常量完整，得到 {wallet_structure}')

    fresh_incomplete(wallet_page, 'auth-wallet', '?demo=wallet-none')
    no_wallet = wallet_page.evaluate(r"""() => ({
      empty:document.getElementById('wallet-empty-state')?.hidden,
      emptyText:document.getElementById('wallet-empty-state')?.textContent.replace(/\s+/g,' ').trim(),
      listHidden:document.getElementById('wallet-detected')?.hidden,
      connectHidden:document.getElementById('wallet-connect')?.hidden,
      qr:document.getElementById('walletconnect-placeholder')?.textContent.replace(/\s+/g,' ').trim(),
      state:account.walletState, selected:account.selectedWallet,
    })""")
    check(no_wallet == {
        'empty': False, 'emptyText': 'No detected wallets. You can use the simulated WalletConnect alternative below.',
        'listHidden': True, 'connectHidden': True,
        'qr': 'WalletConnect QR placeholder — nonfunctional and simulated.',
        'state': 'idle', 'selected': '',
    } and not wallet_errors,
          f'?demo=wallet-none 显示无钱包空态与非功能 WalletConnect，不报错，得到 {no_wallet}')
    wallet_context.close()

    print('\n== Task 5：Demo 钱包签名、拒绝/重试与完成守卫 ==')
    for outcome in ('approve', 'reject'):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        flow_errors = []
        flow_console = []
        flow_requests = []
        attach_errors(pg, flow_errors, flow_console)
        pg.on('request', lambda request, sink=flow_requests: sink.append(request.url))
        pg.clock.install(time=100_000)
        pg.clock.pause_at(100_000)
        pg.goto(f'{URL}#auth-wallet', wait_until='networkidle')
        flow_requests.clear()
        pg.evaluate("document.getElementById('wallet-option-demo')?.click()")
        selected = pg.evaluate("""() => ({selected:account.selectedWallet,
          state:account.walletState, connect:document.getElementById('wallet-connect')?.disabled,
          checked:document.getElementById('wallet-option-demo')?.checked})""")
        pg.evaluate("document.getElementById('wallet-connect')?.click()")
        waiting = pg.evaluate("""() => ({state:account.walletState,
          status:document.getElementById('wallet-connect-state')?.textContent,
          timers:account.timers.length, connect:document.getElementById('wallet-connect')?.disabled})""")
        pg.clock.run_for(499)
        at_499 = pg.evaluate("""() => ({state:account.walletState,
          approve:document.getElementById('wallet-sign-approve')?.hidden})""")
        pg.clock.run_for(1)
        at_500 = pg.evaluate("""() => ({state:account.walletState,
          status:document.getElementById('wallet-connect-state')?.textContent,
          approve:document.getElementById('wallet-sign-approve')?.hidden,
          reject:document.getElementById('wallet-sign-reject')?.hidden,
          timers:account.timers.length})""")
        signature_sentinel = f'WALLET_SIGNATURE_SENTINEL_{outcome}_8f31'
        _, signature_leaks = wallet_forbidden_scan(pg, signature_sentinel, flow_console)
        pg.evaluate(f"document.getElementById('wallet-sign-{outcome}')?.click()")
        final = pg.evaluate("""() => ({state:account.walletState, hash:location.hash,
          status:document.getElementById('wallet-connect-state')?.textContent,
          retry:document.getElementById('wallet-connect-retry')?.hidden,
          flags:Object.fromEntries(Object.entries(ONBOARDING_KEYS)
            .map(([name,key]) => [name,sessionStorage.getItem(key)])),
          stack:history.state?.stack,
        })""")
        _, final_leaks = wallet_forbidden_scan(pg, signature_sentinel, flow_console)
        common = (selected == {'selected': 'demo', 'state': 'idle', 'connect': False, 'checked': True} and
                  waiting == {'state': 'waiting', 'status': 'Connecting to Demo Wallet…',
                              'timers': 1, 'connect': True} and
                  at_499 == {'state': 'waiting', 'approve': True} and
                  at_500 == {'state': 'signature',
                             'status': 'Approve the signature request in this prototype. No real signature is created.',
                             'approve': False, 'reject': False, 'timers': 0})
        if outcome == 'approve':
            expected = {
                'state': 'connected', 'hash': '#home', 'status': '', 'retry': True,
                'flags': {'complete': 'true', 'backupIncomplete': 'false',
                          'watchOnly': 'false', 'recoveryMethod': None},
                'stack': ['scr-home'],
            }
            pg.evaluate('history.back()')
            pg.clock.run_for(200)
            guarded = active_state(pg)
            guarded_account = pg.evaluate("""() => [...document.querySelectorAll('.scr.active:not([inert])')]
              .some(el => ACCOUNT_SCREENS.has(el.id))""")
            outcome_ok = final == expected and not guarded_account
        else:
            expected = {
                'state': 'rejected', 'hash': '#auth-wallet',
                'status': 'Connection request rejected. No account was connected.',
                'retry': False,
                'flags': {'complete': None, 'backupIncomplete': None,
                          'watchOnly': None, 'recoveryMethod': None},
                'stack': ['scr-auth', 'scr-auth-wallet'],
            }
            pg.evaluate("document.getElementById('wallet-connect-retry')?.click()")
            retry = pg.evaluate("""() => ({state:account.walletState, selected:account.selectedWallet,
              connect:document.getElementById('wallet-connect')?.disabled,
              status:document.getElementById('wallet-connect-state')?.textContent,
              retry:document.getElementById('wallet-connect-retry')?.hidden})""")
            outcome_ok = final == expected and retry == {
                'state': 'idle', 'selected': 'demo', 'connect': False, 'status': '', 'retry': True,
            }
        leaked = any(fragment in '|'.join(flow_console).lower()
                     for fragment in ('signature:', '0x', 'private key', 'seed phrase'))
        check(common and outcome_ok and not flow_requests and not leaked and
              not signature_leaks and not final_leaks and not flow_errors,
              f'Demo {outcome}：499/500 边界、显式决策、标记/重试/历史与零网络正确，'
              f'selected={selected} waiting={waiting} 499={at_499} 500={at_500} '
              f'final={final} signatureLeaks={signature_leaks} finalLeaks={final_leaks} '
              f'errors={flow_errors} requests={flow_requests}')
        context.close()

    print('\n== Task 5：超时、失败与重复提交 ==')
    terminal_cases = {
        'timeout': (9999, 1, 'waiting', 'timeout', 'Connection timed out. Try again.'),
        'failure': (499, 1, 'waiting', 'error', 'Could not connect to this wallet. Try again.'),
    }
    for wallet, (before_ms, boundary_ms, before_state, final_state, message) in terminal_cases.items():
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        terminal_errors = []
        terminal_requests = []
        attach_errors(pg, terminal_errors)
        pg.on('request', lambda request, sink=terminal_requests: sink.append(request.url))
        pg.clock.install(time=200_000)
        pg.clock.pause_at(200_000)
        pg.goto(f'{URL}#auth-wallet', wait_until='networkidle')
        terminal_requests.clear()
        pg.evaluate(f"document.getElementById('wallet-option-{wallet}')?.click()")
        pg.evaluate("document.getElementById('wallet-connect')?.click(); document.getElementById('wallet-connect')?.click()")
        submitted = pg.evaluate("() => ({state:account.walletState,timers:account.timers.length})")
        pg.clock.run_for(before_ms)
        before = pg.evaluate("account.walletState")
        pg.clock.run_for(boundary_ms)
        terminal = pg.evaluate("""() => ({state:account.walletState,
          status:document.getElementById('wallet-connect-state')?.textContent,
          retry:document.getElementById('wallet-connect-retry')?.hidden,
          timers:account.timers.length})""")
        pg.evaluate("document.getElementById('wallet-connect-retry')?.click()")
        retry = pg.evaluate("""() => ({state:account.walletState,
          selected:account.selectedWallet, disabled:document.getElementById('wallet-connect')?.disabled,
          timers:account.timers.length})""")
        check(submitted == {'state': 'waiting', 'timers': 1} and before == before_state and
              terminal == {'state': final_state, 'status': message, 'retry': False, 'timers': 0} and
              retry == {'state': 'idle', 'selected': wallet, 'disabled': False, 'timers': 0} and
              not terminal_requests and not terminal_errors,
              f'{wallet} 精确边界、单 timer 与可恢复终态正确，submitted={submitted} '
              f'before={before} terminal={terminal} retry={retry} '
              f'requests={terminal_requests} errors={terminal_errors}')
        context.close()

    print('\n== Task 5：创建钱包结构、700ms 状态机与来源栈 ==')
    create_sources = ('direct', 'social', 'otp')
    for source in create_sources:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        create_errors = []
        create_requests = []
        attach_errors(pg, create_errors)
        pg.on('request', lambda request, sink=create_requests: sink.append(request.url))
        pg.clock.install(time=300_000)
        pg.clock.pause_at(300_000)
        pg.goto(f'{URL}#{"wallet-create" if source == "direct" else "auth"}', wait_until='networkidle')
        create_requests.clear()
        if source == 'social':
            pg.locator('#auth-google').click()
            pg.clock.run_for(450)
        elif source == 'otp':
            pg.locator('#auth-email').click()
            otp_enter(pg, '246810')
        structure = pg.evaluate(r"""() => ({
          disclosure:document.getElementById('wallet-create-disclosure')?.textContent.trim(),
          custody:document.getElementById('wallet-create-custody')?.textContent.replace(/\s+/g,' ').trim(),
          statusRole:document.getElementById('wallet-create-status')?.getAttribute('role'),
          statusLive:document.getElementById('wallet-create-status')?.getAttribute('aria-live'),
          statusDisplay:getComputedStyle(document.getElementById('wallet-create-status')).display,
          statusVisibility:getComputedStyle(document.getElementById('wallet-create-status')).visibility,
          statusHidden:document.getElementById('wallet-create-status')?.hidden,
          failText:document.getElementById('wallet-create-fail-demo')?.textContent.trim(),
          state:account.createState,
        })""")
        pg.evaluate("document.getElementById('wallet-create-start')?.click(); document.getElementById('wallet-create-start')?.click()")
        started = pg.evaluate("""() => ({state:account.createState,timers:account.timers.length,
          start:document.getElementById('wallet-create-start')?.disabled,
          fail:document.getElementById('wallet-create-fail-demo')?.disabled})""")
        pg.clock.run_for(699)
        at_699 = pg.evaluate("() => ({state:account.createState,hash:location.hash})")
        pg.clock.run_for(1)
        at_700 = pg.evaluate("() => ({state:account.createState,hash:location.hash,stack:history.state?.stack})")
        expected_stack = {
            'direct': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup'],
            'social': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup'],
            'otp': ['scr-auth', 'scr-auth-otp', 'scr-wallet-create', 'scr-wallet-backup'],
        }[source]
        pg.evaluate('back()')
        in_app_back = active_state(pg)
        pg.evaluate('history.back()')
        pg.clock.run_for(160)
        browser_back = active_state(pg)
        expected_browser_back = {
            'direct': {'active': [], 'hash': ''},
            'social': {'active': ['scr-auth'], 'hash': '#auth'},
            'otp': {'active': ['scr-auth-otp'], 'hash': '#auth-otp'},
        }[source]
        check(structure == {
            'disclosure': 'Designed for Privy · simulated in this prototype.',
            'custody': 'This prototype simulates an embedded self-custody wallet. No key, seed, or recovery material is created or stored.',
            'statusRole': 'status', 'statusLive': 'polite', 'statusDisplay': 'block',
            'statusVisibility': 'visible', 'statusHidden': False,
            'failText': 'Demo creation failure', 'state': 'idle',
        } and started == {'state': 'creating', 'timers': 1, 'start': True, 'fail': True} and
              at_699 == {'state': 'creating', 'hash': '#wallet-create'} and
              at_700 == {'state': 'created', 'hash': '#wallet-backup', 'stack': expected_stack} and
              in_app_back == {'active': ['scr-wallet-create'], 'hash': '#wallet-create'} and
              browser_back == expected_browser_back and
              not create_requests and not create_errors,
              f'{source} 创建 699/700 边界、双击防护、live stack 与两类 Back 正确，'
              f'structure={structure} started={started} 699={at_699} 700={at_700} '
              f'inApp={in_app_back} browser={browser_back} errors={create_errors}')
        context.close()

    print('\n== Task 5：创建失败/重试与离页、pagehide、BFCache 清理 ==')
    create_failure_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    create_failure = create_failure_context.new_page()
    create_failure_requests = []
    create_failure.on('request', lambda request: create_failure_requests.append(request.url))
    create_failure.clock.install(time=400_000)
    create_failure.clock.pause_at(400_000)
    create_failure.goto(f'{URL}#wallet-create', wait_until='networkidle')
    create_failure_requests.clear()
    create_failure.evaluate("document.getElementById('wallet-create-fail-demo')?.click()")
    create_failure.clock.run_for(699)
    fail_699 = create_failure.evaluate("account.createState")
    create_failure.clock.run_for(1)
    fail_700 = create_failure.evaluate("""() => ({state:account.createState,
      status:document.getElementById('wallet-create-status')?.textContent,
      startDisabled:document.getElementById('wallet-create-start')?.disabled,
      failDisabled:document.getElementById('wallet-create-fail-demo')?.disabled,
      retryHidden:document.getElementById('wallet-create-retry')?.hidden,
      retryDisabled:document.getElementById('wallet-create-retry')?.disabled,
      timers:account.timers.length})""")
    create_failure.evaluate("""() => {
      document.getElementById('wallet-create-start')?.click();
      document.getElementById('wallet-create-fail-demo')?.click();
      beginWalletCreation(false);
      beginWalletCreation(true);
    }""")
    illegal_error_actions = create_failure.evaluate("""() => ({
      state:account.createState,timers:account.timers.length,
      status:document.getElementById('wallet-create-status')?.textContent,
      startDisabled:document.getElementById('wallet-create-start')?.disabled,
      failDisabled:document.getElementById('wallet-create-fail-demo')?.disabled,
      retryHidden:document.getElementById('wallet-create-retry')?.hidden,
    })""")
    create_failure.evaluate("document.getElementById('wallet-create-retry')?.click()")
    retried = create_failure.evaluate("() => ({state:account.createState,timers:account.timers.length})")
    create_failure.clock.run_for(700)
    retry_done = create_failure.evaluate("() => ({state:account.createState,hash:location.hash,stack:history.state?.stack})")
    check(fail_699 == 'creating' and fail_700 == {
        'state': 'error', 'status': 'Wallet creation demo failed. Try again.',
        'startDisabled': True, 'failDisabled': True, 'retryHidden': False,
        'retryDisabled': False, 'timers': 0,
    } and illegal_error_actions == {
        'state': 'error', 'timers': 0, 'status': 'Wallet creation demo failed. Try again.',
        'startDisabled': True, 'failDisabled': True, 'retryHidden': False,
    } and retried == {'state': 'creating', 'timers': 1} and retry_done == {
        'state': 'created', 'hash': '#wallet-backup',
        'stack': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup'],
    } and not create_failure_requests,
          f'创建失败 699/700、error 非法动作隔离与 Retry→成功正确，'
          f'699={fail_699} 700={fail_700} illegal={illegal_error_actions} '
          f'retried={retried} done={retry_done} requests={create_failure_requests}')
    create_failure_context.close()

    cleanup_cases = (
        ('wallet route exit', 'auth-wallet', "document.getElementById('wallet-option-timeout')?.click(); document.getElementById('wallet-connect')?.click(); navigate(['scr-auth'],{replace:true})"),
        ('wallet pagehide', 'auth-wallet', "document.getElementById('wallet-option-failure')?.click(); document.getElementById('wallet-connect')?.click(); dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))"),
        ('create route exit', 'wallet-create', "document.getElementById('wallet-create-start')?.click(); navigate(['scr-auth'],{replace:true})"),
        ('create pagehide', 'wallet-create', "document.getElementById('wallet-create-start')?.click(); dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))"),
    )
    for name, route, action in cleanup_cases:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        cleanup_errors = []
        attach_errors(pg, cleanup_errors)
        pg.clock.install(time=500_000)
        pg.clock.pause_at(500_000)
        pg.goto(f'{URL}#{route}', wait_until='networkidle')
        pg.evaluate(f"() => {{ {action} }}")
        immediate = pg.evaluate("() => ({hash:location.hash,wallet:account.walletState,create:account.createState,timers:account.timers.length})")
        pg.clock.run_for(20_000)
        later = pg.evaluate("() => ({hash:location.hash,wallet:account.walletState,create:account.createState,timers:account.timers.length})")
        check(immediate == later and immediate['timers'] == 0 and
              immediate['hash'] != '#wallet-backup' and not cleanup_errors,
              f'{name} 取消 timer，推进时钟无陈旧导航/状态变更，immediate={immediate} later={later}')
        context.close()

    print('\n== Task 5：A5/A6 BFCache pending 重置与恢复后单次动作 ==')
    for flow in ('external', 'create'):
        bfcache_context = browser.new_context(viewport={'width': 1440, 'height': 900})
        bfcache_context.add_init_script("""(() => {
          window.__task5BfcacheListeners=[];
          const original=EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener=function(type,listener,options){
            if(this?.id?.startsWith('wallet-')) window.__task5BfcacheListeners.push(`${this.id}:${type}`);
            return original.call(this,type,listener,options);
          };
        })()""")
        pg = bfcache_context.new_page()
        bfcache_errors = []
        attach_errors(pg, bfcache_errors)
        pg.clock.install(time=600_000)
        pg.clock.pause_at(600_000)
        route = 'auth-wallet' if flow == 'external' else 'wallet-create'
        pg.goto(f'{URL}#{route}', wait_until='networkidle')
        listeners_before = pg.evaluate('window.__task5BfcacheListeners.slice()')
        if flow == 'external':
            pg.evaluate("""() => {
              document.getElementById('wallet-option-timeout').click();
              document.getElementById('wallet-connect').click();
            }""")
        else:
            pg.evaluate("document.getElementById('wallet-create-start').click()")
        canonical_before = pg.evaluate("""() => ({
          hash:location.hash,stack:history.state?.stack,length:history.length,
        })""")
        pending = pg.evaluate("""() => ({wallet:account.walletState,
          create:account.createState,timers:account.timers.length})""")
        for _ in range(3):
            pg.evaluate("""() => {
              dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
              dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
            }""")
        restored = pg.evaluate("""() => ({
          wallet:account.walletState,create:account.createState,selected:account.selectedWallet,
          timers:account.timers.length,hash:location.hash,stack:history.state?.stack,
          length:history.length,listeners:window.__task5BfcacheListeners.slice(),
        })""")
        if flow == 'external':
            pg.evaluate("""() => {
              document.getElementById('wallet-option-demo').click();
              document.getElementById('wallet-connect').click();
            }""")
            post_start = pg.evaluate("() => ({state:account.walletState,timers:account.timers.length})")
            pg.clock.run_for(499)
            post_before = pg.evaluate("account.walletState")
            pg.clock.run_for(1)
            post_boundary = pg.evaluate("() => ({state:account.walletState,timers:account.timers.length,hash:location.hash})")
            pending_expected = {'wallet': 'waiting', 'create': 'idle', 'timers': 1}
            boundary_expected = {'state': 'signature', 'timers': 0, 'hash': '#auth-wallet'}
        else:
            pg.evaluate("document.getElementById('wallet-create-start').click()")
            post_start = pg.evaluate("() => ({state:account.createState,timers:account.timers.length})")
            pg.clock.run_for(699)
            post_before = pg.evaluate("account.createState")
            pg.clock.run_for(1)
            post_boundary = pg.evaluate("() => ({state:account.createState,timers:account.timers.length,hash:location.hash})")
            pending_expected = {'wallet': 'idle', 'create': 'creating', 'timers': 1}
            boundary_expected = {'state': 'created', 'timers': 0, 'hash': '#wallet-backup'}
        canonical_after = {key: restored[key] for key in ('hash', 'stack', 'length')}
        check(pending == pending_expected and
              canonical_after == canonical_before and
              restored['wallet'] == 'idle' and restored['create'] == 'idle' and
              restored['selected'] == '' and restored['timers'] == 0 and
              restored['listeners'] == listeners_before and
              post_start == {'state': 'waiting' if flow == 'external' else 'creating', 'timers': 1} and
              post_before == ('waiting' if flow == 'external' else 'creating') and
              post_boundary == boundary_expected and not bfcache_errors,
              f'{flow} pending BFCache 恢复为空闲且 canonical/listeners 不变；恢复后仅一 timer/边界迁移，'
              f'pending={pending} canonical={canonical_before}/{canonical_after} restored={restored} '
              f'post={post_start}/{post_before}/{post_boundary} errors={bfcache_errors}')
        bfcache_context.close()

    wallet_listener_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    wallet_listener_context.add_init_script("""(() => {
      window.__task5Listeners=[];
      const original=EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener=function(type,listener,options){
        if(this?.id?.startsWith('wallet-')) window.__task5Listeners.push(`${this.id}:${type}`);
        return original.call(this,type,listener,options);
      };
    })()""")
    listener_pg = wallet_listener_context.new_page()
    listener_pg.goto(f'{URL}#auth-wallet', wait_until='networkidle')
    listener_before = listener_pg.evaluate('window.__task5Listeners.slice()')
    for _ in range(3):
        listener_pg.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
    listener_after = listener_pg.evaluate('window.__task5Listeners.slice()')
    check(listener_before and listener_after == listener_before,
          f'Task 5 事件仅绑定一次，BFCache setup 不重复，before={listener_before} after={listener_after}')
    wallet_listener_context.close()

    print('\n== Task 5：Storage 拒绝下的内存 onboarding overlay、完成守卫与重启 ==')
    overlay_cases = {
        'working storage': (),
        'setItem denied': ('setItem',),
        'getItem denied': ('getItem',),
        'setItem + getItem denied': ('setItem', 'getItem'),
        'removeItem denied': ('removeItem',),
    }
    overlay_names = ['backupIncomplete', 'complete', 'recoveryMethod', 'watchOnly']
    for case_name, denied_operations in overlay_cases.items():
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        install_storage_denials(context, denied_operations)
        pg = context.new_page()
        overlay_errors = []
        overlay_console = []
        attach_errors(pg, overlay_errors, overlay_console)
        pg.clock.install(time=700_000)
        pg.clock.pause_at(700_000)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        pg.locator('#auth-wallet').click()
        pg.locator('#wallet-option-demo').click()
        pg.locator('#wallet-connect').click()
        pg.clock.run_for(500)
        pg.locator('#wallet-sign-approve').click()
        completed = pg.evaluate("""() => {
          const safeStored=name => {
            try{return sessionStorage.getItem(ONBOARDING_KEYS[name])}
            catch(error){return '<denied>'}
          };
          const memory=typeof onboardingMemory === 'undefined' ? null
            : Object.fromEntries(Object.keys(onboardingMemory).sort()
              .map(name => [name,onboardingMemory[name]]));
          return {
            active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
            hash:location.hash,flags:Object.fromEntries(Object.keys(ONBOARDING_KEYS)
              .map(name => [name,onboardingFlag(name)])),
            memory,stored:Object.fromEntries(Object.keys(ONBOARDING_KEYS)
              .map(name => [name,safeStored(name)])),
            backupHidden:document.getElementById('backup-warning').hidden,
          };
        }""")

        rendered = pg.evaluate("""() => {
          setOnboardingFlag('backupIncomplete',true);
          navigate(['scr-home'],{replace:true});
          const backupVisible=!document.getElementById('backup-warning').hidden;
          setOnboardingFlag('backupIncomplete',false);
          setOnboardingFlag('watchOnly',true);
          navigate(['scr-wallet'],{replace:true});
          const watchVisible=!document.getElementById('watch-only-notice').hidden;
          setOnboardingFlag('watchOnly',false);
          navigate(['scr-home'],{replace:true});
          return {backupVisible,watchVisible,
            backupCleared:document.getElementById('backup-warning').hidden,
            memory:typeof onboardingMemory === 'undefined' ? null
              : Object.fromEntries(Object.keys(onboardingMemory).sort()
                .map(name => [name,onboardingMemory[name]]))};
        }""")

        traversal = []
        for command in ('history.back()', 'history.forward()', 'history.back()', 'history.forward()'):
            pg.evaluate(command)
            pg.clock.run_for(180)
            traversal.append(pg.evaluate("""() => ({
              active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
              account:[...document.querySelectorAll('.scr.active:not([inert])')]
                .some(el=>ACCOUNT_SCREENS.has(el.id)),hash:location.hash,
            })"""))
        pg.evaluate("location.hash='auth-wallet'")
        pg.clock.run_for(180)
        direct_guard = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
          hash:location.hash,complete:onboardingFlag('complete'),
        })""")

        pg.evaluate('restartOnboarding()')
        restarted = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
          hash:location.hash,complete:onboardingFlag('complete'),timers:account.timers.length,
          memory:typeof onboardingMemory === 'undefined' ? null
            : Object.fromEntries(Object.keys(onboardingMemory).sort()
              .map(name => [name,onboardingMemory[name]])),
        })""")
        pg.evaluate("location.hash='auth'")
        pg.clock.run_for(180)
        post_restart_route = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
          hash:location.hash,complete:onboardingFlag('complete'),
        })""")

        expected_memory = {
            'backupIncomplete': 'false', 'complete': 'true',
            'recoveryMethod': '', 'watchOnly': 'false',
        }
        expected_tombstones = {name: '' for name in overlay_names}
        working_storage_ok = denied_operations or completed['stored'] == {
            'complete': 'true', 'backupIncomplete': 'false',
            'watchOnly': 'false', 'recoveryMethod': None,
        }
        check(completed['active'] == ['scr-home'] and completed['hash'] == '#home' and
              completed['flags'] == {
                  'complete': True, 'backupIncomplete': False,
                  'watchOnly': False, 'recoveryMethod': '',
              } and completed['memory'] == expected_memory and completed['backupHidden'] and
              rendered == {
                  'backupVisible': True, 'watchVisible': True, 'backupCleared': True,
                  'memory': expected_memory,
              } and working_storage_ok and
              all(not state['account'] for state in traversal) and
              direct_guard == {'active': ['scr-home'], 'hash': '#home', 'complete': True} and
              restarted['active'] == ['scr-splash'] and restarted['hash'] == '#splash' and
              restarted['complete'] is False and restarted['memory'] == expected_tombstones and
              post_restart_route == {
                  'active': ['scr-auth'], 'hash': '#auth', 'complete': False,
              } and not overlay_errors,
              f'{case_name}: 完成由非敏感内存 overlay 守卫/渲染，Back/Forward/直链不重开账号；'
              f'重启 tombstone 后 Splash 且账号守卫清除，completed={completed} rendered={rendered} '
              f'traversal={traversal} direct={direct_guard} restarted={restarted} '
              f'postRestart={post_restart_route} errors={overlay_errors} console={overlay_console}')
        context.close()

    print('\n== Task 6：A7 备份方式、确认边界与完成标记 ==')
    backup_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    backup_page = backup_context.new_page()
    backup_errors = []
    backup_requests = []
    attach_errors(backup_page, backup_errors)
    backup_page.on('request', lambda request: backup_requests.append(request.url))
    fresh_incomplete(backup_page, 'wallet-backup')
    backup_requests.clear()
    if backup_page.locator('#backup-choice-view').count() == 0:
        check(False, 'A7 缺少四选项 backup-choice-view（Task 6 尚未实现）')
        browser.close()
        print('\n' + f'{len(fails)} 项失败:')
        for failure in fails:
            print(' -', failure)
        sys.exit(1)
    backup_structure = backup_page.evaluate("""() => ({
      choices:[...document.querySelectorAll('#scr-wallet-backup [data-backup-choice]')]
        .map(el=>el.querySelector('strong')?.textContent.trim() || el.textContent.trim()),
      importControls:[...document.querySelectorAll('#scr-wallet-backup input, #scr-wallet-backup textarea')]
        .map(el=>el.id),
      active:document.getElementById('backup-choice-view').hidden ? 'confirm' : 'choices',
      panel:history.state?.backupPanel ?? null,
      validator:typeof isValidBackupPanel === 'function',
      confirmHeadingTabindex:document.getElementById('backup-confirm-title').getAttribute('tabindex'),
    })""")
    check(backup_structure == {
        'choices': ['Recovery phrase', 'Cloud backup', 'Social recovery 2-of-3', 'Not now'],
        'importControls': [], 'active': 'choices', 'panel': None, 'validator': True,
        'confirmHeadingTabindex': '-1',
    }, f'A7 提供四个可访问选择且无 import/watch-only 控件，得到 {backup_structure}')

    backup_page.locator('#backup-recovery-phrase').click()
    phrase_route = backup_page.evaluate("""() => ({hash:location.hash,
      stack:history.state.stack, length:history.length})""")
    check(phrase_route['hash'] == '#seed-show' and
          phrase_route['stack'][-2:] == ['scr-wallet-backup', 'scr-seed-show'],
          f'Recovery phrase push 到 seed-show 并记录历史，得到 {phrase_route}')
    backup_page.evaluate('back()')
    backup_page.wait_for_function("location.hash === '#wallet-backup'")

    for choice_id, method, description in (
            ('backup-cloud', 'cloud-simulated', 'Cloud backup'),
            ('backup-social', 'social-simulated', 'Social recovery 2-of-3'),
            ('backup-not-now', 'skipped', 'Not now')):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        history_errors = []
        history_requests = []
        attach_errors(pg, history_errors)
        pg.on('request', lambda request, sink=history_requests: sink.append(request.url))
        fresh_incomplete(pg, 'wallet-backup')
        history_requests.clear()
        base = pg.evaluate("""() => ({length:history.length, state:history.state,
          hash:location.hash})""")
        if method == 'social-simulated':
            pg.locator(f'#{choice_id}').focus()
            pg.locator(f'#{choice_id}').press('Enter')
        else:
            pg.locator(f'#{choice_id}').click()
        opened = pg.evaluate("""() => ({
          length:history.length, hash:location.hash, panel:history.state?.backupPanel,
          entryId:history.state?.accountEntryId ?? null,
          proof:typeof hasValidBackupPanelHistoryProvenance === 'function'
            ? hasValidBackupPanelHistoryProvenance() : null,
          confirm:!document.getElementById('backup-confirmation').hidden,
          text:document.getElementById('backup-confirmation').innerText,
          focused:document.activeElement?.id,
        })""")
        pg.evaluate('history.back()')
        pg.wait_for_function("""method =>
          !history.state?.backupPanel &&
          !document.getElementById('backup-choice-view').hidden""", arg=method)
        browser_back = pg.evaluate("""() => ({
          length:history.length, hash:location.hash, panel:history.state?.backupPanel ?? null,
          choices:!document.getElementById('backup-choice-view').hidden,
          confirm:document.getElementById('backup-confirmation').hidden,
          focused:document.activeElement?.id,
        })""")
        pg.evaluate('history.forward()')
        pg.wait_for_function("""method =>
          history.state?.backupPanel === method &&
          !document.getElementById('backup-confirmation').hidden""", arg=method)
        browser_forward = pg.evaluate("""() => ({
          length:history.length, hash:location.hash, panel:history.state?.backupPanel,
          entryId:history.state?.accountEntryId ?? null,
          proof:typeof hasValidBackupPanelHistoryProvenance === 'function'
            ? hasValidBackupPanelHistoryProvenance() : null,
          confirm:!document.getElementById('backup-confirmation').hidden,
          text:document.getElementById('backup-confirmation').innerText,
          focused:document.activeElement?.id,
        })""")
        pg.evaluate('back()')
        pg.wait_for_function("""method =>
          !history.state?.backupPanel &&
          !document.getElementById('backup-choice-view').hidden""", arg=method)
        in_app_back = pg.evaluate("""() => ({
          length:history.length, hash:location.hash, panel:history.state?.backupPanel ?? null,
          choices:!document.getElementById('backup-choice-view').hidden,
          confirm:document.getElementById('backup-confirmation').hidden,
          focused:document.activeElement?.id,
        })""")
        expected_heading = 'Back up later?' if method == 'skipped' else description
        exact_copy = (expected_heading in opened['text'] and
                      ('permanent' in opened['text'].lower() if method == 'skipped'
                       else 'Designed for Privy · simulated in this prototype' in opened['text']))
        check(base['hash'] == '#wallet-backup' and base['state'].get('backupPanel') is None and
              opened['length'] == base['length'] + 1 and opened['hash'] == '#wallet-backup' and
              opened['panel'] == method and isinstance(opened['entryId'], str) and
              opened['entryId'] and opened['proof'] is True and opened['confirm'] and exact_copy and
              opened['focused'] == 'backup-confirm-title' and
              browser_back == {'length': opened['length'], 'hash': '#wallet-backup',
                               'panel': None, 'choices': True, 'confirm': True,
                               'focused': choice_id} and
              browser_forward['length'] == opened['length'] and
              browser_forward['hash'] == '#wallet-backup' and browser_forward['panel'] == method and
              browser_forward['entryId'] == opened['entryId'] and
              browser_forward['proof'] is True and
              browser_forward['confirm'] and browser_forward['text'] == opened['text'] and
              browser_forward['focused'] == 'backup-confirm-title' and
              in_app_back == {'length': opened['length'], 'hash': '#wallet-backup',
                              'panel': None, 'choices': True, 'confirm': True,
                              'focused': choice_id} and
              (method != 'skipped' or opened['focused'] != 'backup-skip-confirm') and
              not history_requests and not history_errors,
              f'{description} confirmation 用 validated same-hash history；browser Back/Forward '
              f'与 in-app Back 精确恢复且不重复 entry，base={base} opened={opened} '
              f'back={browser_back} forward={browser_forward} inApp={in_app_back} '
              f'requests={history_requests} errors={history_errors}')
        context.close()

    invalid_panel_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    invalid_panel_page = invalid_panel_context.new_page()
    fresh_incomplete(invalid_panel_page, 'wallet-backup')
    invalid_panel = invalid_panel_page.evaluate("""() => {
      history.replaceState({...history.state, backupPanel:'echo'},'',location.href);
      dispatchEvent(new PopStateEvent('popstate',{state:history.state}));
      return {
        helper:typeof isValidBackupPanel === 'function',
        accepted:typeof isValidBackupPanel === 'function' && isValidBackupPanel('echo'),
        panel:history.state?.backupPanel ?? null,
        choices:!document.getElementById('backup-choice-view').hidden,
        hash:location.hash,
      };
    }""")
    check(invalid_panel == {'helper': True, 'accepted': False, 'panel': None,
                            'choices': True, 'hash': '#wallet-backup'},
          f'非法 backupPanel metadata 被验证、丢弃并渲染默认 choices，得到 {invalid_panel}')
    invalid_panel_context.close()

    forged_panel_context = browser.new_context(viewport={'width': 375, 'height': 667})
    forged_panel_page = forged_panel_context.new_page()
    fresh_incomplete(forged_panel_page, 'wallet-backup')
    forged_panel = forged_panel_page.evaluate("""() => {
      history.replaceState({...history.state,backupPanel:'cloud-simulated'},'',location.href);
      setupWalletBackup();
      return {
        helper:typeof hasValidBackupPanelHistoryProvenance === 'function'
          ? hasValidBackupPanelHistoryProvenance() : null,
        panel:history.state?.backupPanel ?? null,
        entryId:history.state?.accountEntryId ?? null,
        choices:!document.getElementById('backup-choice-view').hidden,
        confirm:!document.getElementById('backup-confirmation').hidden,
      };
    }""")
    check(forged_panel == {
        'helper': False, 'panel': None, 'entryId': None, 'choices': True, 'confirm': False,
    }, f'合法 panel 名称但无 app-issued proof 时被清理，得到 {forged_panel}')
    forged_panel_context.close()

    replay_panel_context = browser.new_context(viewport={'width': 375, 'height': 667})
    replay_panel_page = replay_panel_context.new_page()
    fresh_incomplete(replay_panel_page, 'wallet-backup')
    replay_panel_page.locator('#backup-cloud').click()
    replay_panel = replay_panel_page.evaluate("""() => {
      const entryId=history.state.accountEntryId;
      history.replaceState({...history.state,backupPanel:'skipped'},'',location.href);
      const helper=typeof hasValidBackupPanelHistoryProvenance === 'function'
        ? hasValidBackupPanelHistoryProvenance() : null;
      setupWalletBackup();
      return {
        helper,originalId:entryId,panel:history.state?.backupPanel ?? null,
        entryId:history.state?.accountEntryId ?? null,
        choices:!document.getElementById('backup-choice-view').hidden,
      };
    }""")
    check(isinstance(replay_panel['originalId'], str) and replay_panel['originalId'] and
          replay_panel['helper'] is False and replay_panel['panel'] is None and
          replay_panel['entryId'] is None and replay_panel['choices'] is True,
          f'backupPanel proof 不能重放到不同 confirmation，得到 {replay_panel}')
    replay_panel_context.close()

    reload_panel_context = browser.new_context(viewport={'width': 375, 'height': 667})
    reload_panel_page = reload_panel_context.new_page()
    fresh_incomplete(reload_panel_page, 'wallet-backup')
    reload_panel_page.locator('#backup-not-now').click()
    before_panel_reload = reload_panel_page.evaluate("""() => ({
      proof:typeof hasValidBackupPanelHistoryProvenance === 'function'
        ? hasValidBackupPanelHistoryProvenance() : null,
      entryId:history.state.accountEntryId ?? null,panel:history.state.backupPanel,
      length:history.length,
    })""")
    reload_panel_page.reload(wait_until='networkidle')
    wait_for_settled_screen(reload_panel_page, 'wallet-backup')
    after_panel_reload = reload_panel_page.evaluate("""() => ({
      proof:typeof hasValidBackupPanelHistoryProvenance === 'function'
        ? hasValidBackupPanelHistoryProvenance() : null,
      entryId:history.state.accountEntryId ?? null,
      panel:history.state.backupPanel ?? null,
      choices:!document.getElementById('backup-choice-view').hidden,
      length:history.length,
    })""")
    reload_panel_page.evaluate("""() => {
      window.__panelReloadPopped=false;
      addEventListener('popstate',()=>{window.__panelReloadPopped=true},{once:true});
      back();
    }""")
    reload_panel_page.wait_for_function("""() =>
      location.hash === '#wallet-create' || window.__panelReloadPopped === true""")
    after_panel_reload_back = reload_panel_page.evaluate(
        """() => ({hash:location.hash,stack:history.state.stack,length:history.length,
          popped:window.__panelReloadPopped})""")
    check(before_panel_reload['proof'] is True and
          isinstance(before_panel_reload['entryId'], str) and
          before_panel_reload['panel'] == 'skipped' and
          after_panel_reload == {
              'proof': False, 'entryId': None, 'panel': None, 'choices': True,
              'length': before_panel_reload['length'],
          } and after_panel_reload_back == {
              'hash': '#wallet-create', 'stack': ['scr-auth', 'scr-wallet-create'],
              'length': before_panel_reload['length'], 'popped': False,
          }, f'backupPanel reload 丢弃未知 proof 且 Back 不陷入同 hash entry，'
             f'before={before_panel_reload} reload={after_panel_reload} '
             f'back={after_panel_reload_back}')
    reload_panel_context.close()

    for choice_id, method, description in (
            ('backup-cloud', 'cloud-simulated', 'Cloud backup'),
            ('backup-social', 'social-simulated', 'Social recovery 2-of-3')):
        backup_page.locator(f'#{choice_id}').click()
        confirmation = backup_page.evaluate("""() => ({
          choiceHidden:document.getElementById('backup-choice-view').hidden,
          confirmHidden:document.getElementById('backup-confirmation').hidden,
          text:document.getElementById('backup-confirmation').innerText,
          canContinue:!document.getElementById('backup-confirm-continue').disabled,
          hash:location.hash,
        })""")
        expected_simulated = 'Designed for Privy · simulated in this prototype'
        social_clear = method != 'social-simulated' or 'no guardians are configured' in confirmation['text'].lower()
        check(confirmation['choiceHidden'] and not confirmation['confirmHidden'] and
              expected_simulated in confirmation['text'] and description in confirmation['text'] and
              confirmation['canContinue'] and confirmation['hash'] == '#wallet-backup' and social_clear,
              f'{description} 只显示明确模拟确认（Social 明示无 guardian），得到 {confirmation}')
        if method == 'cloud-simulated':
            backup_page.evaluate('back()')
            backup_page.wait_for_function("!document.getElementById('backup-choice-view').hidden")
            backed = backup_page.evaluate("""() => ({
              choices:!document.getElementById('backup-choice-view').hidden,
              confirm:document.getElementById('backup-confirmation').hidden,
              complete:onboardingFlag('complete'), hash:location.hash,
            })""")
            check(backed == {'choices': True, 'confirm': True, 'complete': False,
                             'hash': '#wallet-backup'},
                  f'confirmation Back 返回选择且不完成，得到 {backed}')
            if backed['hash'] != '#wallet-backup' or not backed['choices']:
                fresh_incomplete(backup_page, 'wallet-backup')
            backup_page.locator(f'#{choice_id}').click()
        backup_page.locator('#backup-confirm-cancel').click()
        backup_page.wait_for_function("!document.getElementById('backup-choice-view').hidden")
        cancelled = backup_page.evaluate("""() => ({
          choices:!document.getElementById('backup-choice-view').hidden,
          confirm:document.getElementById('backup-confirmation').hidden,
          complete:onboardingFlag('complete'), method:onboardingFlag('recoveryMethod'),
        })""")
        check(cancelled == {'choices': True, 'confirm': True, 'complete': False, 'method': ''},
              f'{description} Cancel 返回选择且不完成，得到 {cancelled}')
        backup_page.locator(f'#{choice_id}').click()
        backup_page.locator('#backup-confirm-continue').click()
        backup_page.wait_for_function("location.hash === '#home'")
        completion_requests = backup_requests.copy()
        completed = backup_page.evaluate("""method => ({
          hash:location.hash, stack:history.state.stack,
          complete:onboardingFlag('complete'), method:onboardingFlag('recoveryMethod'),
          incomplete:onboardingFlag('backupIncomplete'),
          bannerHidden:document.getElementById('backup-warning').hidden,
        })""", method)
        backup_page.evaluate("goTab('profile')")
        profile = backup_page.evaluate("""() => ({
          detail:document.getElementById('profile-recovery-detail').innerText,
          status:document.getElementById('profile-recovery-status').innerText,
        })""")
        check(completed == {'hash': '#home', 'stack': ['scr-home'], 'complete': True,
                            'method': method, 'incomplete': False, 'bannerHidden': True} and
              profile['status'] == 'simulated' and method.split('-')[0] in profile['detail'].lower(),
              f'{description} 完成仅写非敏感 enum 并在 Home/Profile 准确呈现，'
              f'completed={completed} profile={profile}')
        check(not completion_requests,
              f'{description} completion 独立零网络，requests={completion_requests}')
        fresh_incomplete(backup_page, 'wallet-backup')
        backup_requests.clear()

    backup_page.locator('#backup-not-now').click()
    skip_first = backup_page.evaluate("""() => ({
      warning:document.getElementById('backup-confirmation').innerText,
      secondHidden:document.getElementById('backup-skip-confirm').hidden,
      complete:onboardingFlag('complete'), hash:location.hash,
    })""")
    check('permanent' in skip_first['warning'].lower() and
          'loss' in skip_first['warning'].lower() and not skip_first['secondHidden'] and
          not skip_first['complete'] and skip_first['hash'] == '#wallet-backup',
          f'Not now 第一阶段只揭示永久损失警告、不能完成，得到 {skip_first}')
    backup_page.locator('#backup-confirm-cancel').click()
    backup_page.wait_for_function("!document.getElementById('backup-choice-view').hidden")
    check(backup_page.locator('#backup-choice-view').is_visible() and
          not backup_page.evaluate("onboardingFlag('complete')"),
          'Not now Cancel 返回四选项且不完成')
    backup_page.locator('#backup-not-now').click()
    backup_page.locator('#backup-skip-confirm').click()
    backup_page.wait_for_function("location.hash === '#home'")
    skip_completion_requests = backup_requests.copy()
    skipped = backup_page.evaluate("""() => ({
      hash:location.hash, stack:history.state.stack, complete:onboardingFlag('complete'),
      method:onboardingFlag('recoveryMethod'), incomplete:onboardingFlag('backupIncomplete'),
      bannerHidden:document.getElementById('backup-warning').hidden,
      banner:document.getElementById('backup-warning').innerText,
    })""")
    backup_page.evaluate("goTab('profile')")
    skipped_profile = backup_page.evaluate("""() => ({
      detail:document.getElementById('profile-recovery-detail').innerText,
      status:document.getElementById('profile-recovery-status').innerText,
    })""")
    check(skipped['hash'] == '#home' and skipped['stack'] == ['scr-home'] and
          skipped['complete'] and skipped['method'] == 'skipped' and skipped['incomplete'] and
          not skipped['bannerHidden'] and 'incomplete' in skipped['banner'].lower() and
          skipped_profile == {'detail': 'Backup incomplete', 'status': 'action needed'} and
          not skip_completion_requests and not backup_errors,
          f'Not now 第二个独立 destructive 确认完成并准确标记，'
          f'home={skipped} profile={skipped_profile} requests={skip_completion_requests} errors={backup_errors}')
    backup_context.close()

    print('\n== Task 6：A8 即时揭示、录制门控与秘密清理 ==')
    seed_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    seed_page = seed_context.new_page()
    seed_errors = []
    seed_console = []
    seed_requests = []
    attach_errors(seed_page, seed_errors, seed_console)
    seed_page.on('request', lambda request: seed_requests.append(request.url))
    seed_page.add_init_script("""(() => {
      window.__clipboardAccess=[];
      Object.defineProperty(Navigator.prototype, 'clipboard', {configurable:true, get(){
        window.__clipboardAccess.push('get');
        return {
          writeText:value => {window.__clipboardAccess.push(['writeText',value]); return Promise.resolve();},
          write:items => {window.__clipboardAccess.push(['write',items]); return Promise.resolve();},
          readText:() => {window.__clipboardAccess.push('readText'); return Promise.resolve('');},
          read:() => {window.__clipboardAccess.push('read'); return Promise.resolve([]);},
        };
      }});
      const originalExecCommand=Document.prototype.execCommand;
      Object.defineProperty(Document.prototype,'execCommand',{
        configurable:true,writable:true,value:function(command){
          const normalized=String(command||'').toLowerCase();
          if(normalized==='copy'||normalized==='cut'){
            window.__clipboardAccess.push(`execCommand:${normalized}`);
            return false;
          }
          return typeof originalExecCommand==='function'
            ? originalExecCommand.apply(this,arguments) : false;
        }
      });
      window.__execCommandSpyInstalled=typeof Document.prototype.execCommand==='function';
    })()""")
    fresh_incomplete(seed_page, 'seed-show')
    seed_requests.clear()
    seed_initial = seed_page.evaluate("""() => ({
      fixture:typeof PROTOTYPE_SEED_WORDS !== 'undefined' && Object.isFrozen(PROTOTYPE_SEED_WORDS)
        ? [...PROTOTYPE_SEED_WORDS] : null,
      words:[...document.querySelectorAll('#seed-words li')].map(el=>el.textContent),
      dom:document.getElementById('scr-seed-show').innerText,
      revealDisabled:document.getElementById('seed-show-reveal').disabled,
      revealControls:document.getElementById('seed-show-reveal').getAttribute('aria-controls'),
      revealExpanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded'),
      panelRole:document.getElementById('seed-phrase-panel').getAttribute('role'),
      panelLabel:document.getElementById('seed-phrase-panel').getAttribute('aria-label'),
      continueDisabled:document.getElementById('seed-show-continue').disabled,
      copyButtons:[...document.querySelectorAll('#scr-seed-show button,[role="button"]')]
        .filter(el=>/copy|clipboard/i.test(el.textContent+' '+(el.getAttribute('aria-label')||''))).length,
      seedRevealed:account.seedRevealed,
    })""")
    fixture = ['orbit', 'velvet', 'cactus', 'harbor', 'lunar', 'maple',
               'echo', 'raven', 'silver', 'tunnel', 'pixel', 'anchor']
    check(seed_initial['fixture'] == fixture and seed_initial['words'] == [] and
          not any(word in seed_initial['dom'] for word in fixture) and
          seed_initial['revealDisabled'] and seed_initial['continueDisabled'] and
          seed_initial['revealControls'] == 'seed-phrase-panel' and
          seed_initial['revealExpanded'] == 'false' and seed_initial['panelRole'] == 'region' and
          seed_initial['panelLabel'] == 'Revealed recovery words' and
          seed_initial['copyButtons'] == 0 and not seed_initial['seedRevealed'] and
          'HTML' in seed_initial['dom'] and 'OS screenshots' in seed_initial['dom'] and
          'native builds' in seed_initial['dom'].lower() and 'visibility' in seed_initial['dom'].lower() and
          'These are public prototype-only words. Never use them for a real wallet.' in seed_initial['dom'],
          f'初始 DOM 无 phrase，fixture 冻结，确认前禁 Reveal/Continue 且警告准确，得到 {seed_initial}')
    seed_page.locator('#seed-show-ack').check()
    check(not seed_page.locator('#seed-show-reveal').is_disabled(), '显式 acknowledgement 后才可 Reveal')
    seed_page.locator('#seed-show-reveal').click()
    revealed = seed_page.evaluate("""() => ({
      words:[...document.querySelectorAll('#seed-words li')].map(el=>el.textContent),
      count:document.querySelectorAll('#seed-words > li').length,
      revealed:account.seedRevealed, recordedDisabled:document.getElementById('seed-show-recorded').disabled,
      continueDisabled:document.getElementById('seed-show-continue').disabled,
      expanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded'),
      mutable:JSON.stringify(account), clipboard:window.__clipboardAccess,
      execCommandSpy:window.__execCommandSpyInstalled,
    })""")
    check(revealed['words'] == fixture and revealed['count'] == 12 and revealed['revealed'] and
          not revealed['recordedDisabled'] and revealed['continueDisabled'] and
          revealed['expanded'] == 'true' and revealed['execCommandSpy'] is True and
          ' '.join(fixture) not in revealed['mutable'] and not revealed['clipboard'],
          f'Reveal 通过 12 个有序 li 即时建立，account 不持有 phrase 且 recorded 继续门控，得到 {revealed}')
    seed_page.evaluate("""() => {
      const panel=document.getElementById('seed-phrase-panel');
      for(const type of ['copy','cut','contextmenu']){
        const event=new Event(type,{bubbles:true,cancelable:true});
        window['__'+type+'Prevented']=!panel.dispatchEvent(event);
      }
    }""")
    blocked = seed_page.evaluate("""() => ({
      copy:window.__copyPrevented, cut:window.__cutPrevented,
      context:window.__contextmenuPrevented, clipboard:window.__clipboardAccess,
    })""")
    check(blocked == {'copy': True, 'cut': True, 'context': True, 'clipboard': []},
          f'phrase panel 阻断 copy/cut/contextmenu 且不调用 clipboard，得到 {blocked}')
    seed_page.locator('#seed-show-recorded').check()
    check(not seed_page.locator('#seed-show-continue').is_disabled(), '独立 recorded checkbox 后才可 Continue')
    seed_page.locator('#seed-show-continue').click()
    seed_page.wait_for_function("location.hash === '#seed-verify'")
    continued = seed_page.evaluate("""() => ({
      hash:location.hash, words:document.querySelectorAll('#seed-words li').length,
      text:document.getElementById('seed-words').textContent, revealed:account.seedRevealed,
      expanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded'),
      stack:history.state.stack,
    })""")
    check(continued['hash'] == '#seed-verify' and continued['words'] == 0 and
          continued['text'] == '' and not continued['revealed'] and continued['expanded'] == 'false' and
          continued['stack'][-2:] == ['scr-seed-show', 'scr-seed-verify'],
          f'Continue 同步清 phrase 后 push seed-verify，得到 {continued}')
    check(seed_page.evaluate('window.__clipboardAccess') == [],
          'A8 reveal/events/Continue 均未读取 navigator.clipboard getter 或调用任何方法')

    for exit_name, exit_action, expected_hash in (
            ('in-app Back', 'back()', '#wallet-backup'),
            ('browser Back', 'history.back()', '#wallet-backup'),
            ('hashchange', "location.hash='market'", '#market'),
            ('pagehide', "dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))", '#seed-show')):
        fresh_incomplete(seed_page, 'wallet-backup' if exit_name == 'browser Back' else 'seed-show')
        if exit_name == 'browser Back':
            seed_page.locator('#backup-recovery-phrase').click()
            seed_page.wait_for_function("location.hash === '#seed-show'")
        seed_page.locator('#seed-show-ack').check()
        seed_page.locator('#seed-show-reveal').click()
        seed_page.evaluate(exit_action)
        if exit_name != 'pagehide':
            seed_page.wait_for_function("expected => location.hash === expected", arg=expected_hash)
        exit_state = seed_page.evaluate("""() => ({hash:location.hash,
          words:document.querySelectorAll('#seed-words li').length,
          revealed:account.seedRevealed, timers:account.timers.length,
          expanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded')})""")
        check(exit_state == {'hash': expected_hash, 'words': 0, 'revealed': False,
                             'timers': 0, 'expanded': 'false'},
              f'{exit_name} 清除 phrase/state/timers，得到 {exit_state}')

    fresh_incomplete(seed_page, 'seed-show')
    seed_page.locator('#seed-show-ack').check()
    seed_page.locator('#seed-show-reveal').click()
    seed_page.evaluate("""() => {
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    visibility_state = seed_page.evaluate("""() => ({
      words:document.querySelectorAll('#seed-words li').length, revealed:account.seedRevealed,
      ack:document.getElementById('seed-show-ack').checked,
      recorded:document.getElementById('seed-show-recorded').checked,
      revealDisabled:document.getElementById('seed-show-reveal').disabled,
      continueDisabled:document.getElementById('seed-show-continue').disabled,
      expanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded'),
    })""")
    check(visibility_state == {'words': 0, 'revealed': False, 'ack': False, 'recorded': False,
                               'revealDisabled': True, 'continueDisabled': True,
                               'expanded': 'false'},
          f'实际 visibilitychange-hidden 只对 A8 完整重置，得到 {visibility_state}')

    fresh_incomplete(seed_page, 'seed-show')
    seed_page.locator('#seed-show-ack').check()
    seed_page.locator('#seed-show-reveal').click()
    seed_page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))")
    seed_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
    seed_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
    bfcache_seed = seed_page.evaluate("""() => ({
      words:document.querySelectorAll('#seed-words li').length, revealed:account.seedRevealed,
      ack:document.getElementById('seed-show-ack').checked,
      revealDisabled:document.getElementById('seed-show-reveal').disabled,
      expanded:document.getElementById('seed-show-reveal').getAttribute('aria-expanded'),
      timers:account.timers.length,
    })""")
    check(bfcache_seed == {'words': 0, 'revealed': False, 'ack': False,
                           'revealDisabled': True, 'expanded': 'false', 'timers': 0} and
          not seed_page.evaluate('window.__clipboardAccess') and
          not seed_requests and not seed_errors,
          f'A8 BFCache 重复 setup 幂等且返回必须重新 reveal；state={bfcache_seed} '
          f'requests={seed_requests} errors={seed_errors}')
    seed_context.close()

    print('\n== Task 6：A9 三位置验证、错误保留与 30 秒锁 ==')
    verify_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    verify_page = verify_context.new_page()
    verify_page.clock.install(time=80_000)
    verify_page.clock.pause_at(80_000)
    verify_errors = []
    verify_console = []
    verify_requests = []
    attach_errors(verify_page, verify_errors, verify_console)
    verify_page.on('request', lambda request: verify_requests.append(request.url))
    fresh_incomplete(verify_page, 'seed-verify')
    verify_requests.clear()
    verify_structure = verify_page.evaluate("""() => ({
      timing:ACCOUNT_TIMING.seedVerifyLock,
      inputs:[...document.querySelectorAll('#seed-verify-form input[data-sensitive]')].map(el=>({
        id:el.id, label:document.querySelector(`label[for="${el.id}"]`)?.innerText,
        aria:el.getAttribute('aria-label'), described:el.getAttribute('aria-describedby'),
        invalid:el.getAttribute('aria-invalid'), autocomplete:el.autocomplete,
      })),
      submit:document.getElementById('seed-verify-submit').disabled,
      live:document.getElementById('seed-verify-status').getAttribute('aria-live'),
      visualLive:document.getElementById('seed-verify-countdown').getAttribute('aria-live'),
    })""")
    check(verify_structure == {
        'timing': 30_000,
        'inputs': [
            {'id': 'seed-verify-3', 'label': 'Word 3', 'aria': None,
             'described': 'seed-verify-help', 'invalid': None, 'autocomplete': 'off'},
            {'id': 'seed-verify-7', 'label': 'Word 7', 'aria': None,
             'described': 'seed-verify-help', 'invalid': None, 'autocomplete': 'off'},
            {'id': 'seed-verify-11', 'label': 'Word 11', 'aria': None,
             'described': 'seed-verify-help', 'invalid': None, 'autocomplete': 'off'},
        ],
        'submit': True, 'live': 'polite', 'visualLive': 'off',
    }, f'A9 精确 3/7/11 标签且 label/ARIA 不含 secret，得到 {verify_structure}')
    for selector, value in (('#seed-verify-3', 'cactus'), ('#seed-verify-7', 'wrong-seven')):
        verify_page.locator(selector).fill(value)
        check(verify_page.locator('#seed-verify-submit').is_disabled(),
              f'{selector} 部分填写时 Verify 保持 disabled')
    verify_page.locator('#seed-verify-11').fill('wrong-eleven')
    check(not verify_page.locator('#seed-verify-submit').is_disabled(), '三项填写后 Verify 可用')
    verify_page.locator('#seed-verify-submit').click()
    partial_wrong = verify_page.evaluate("""() => ({
      values:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.value),
      failures:account.verifyFailures, status:document.getElementById('seed-verify-status').innerText,
      attempts:document.getElementById('seed-verify-attempts').innerText,
      submit:document.getElementById('seed-verify-submit').disabled,
      semantics:[...document.querySelectorAll('#seed-verify-form input')].map(el=>({
        invalid:el.getAttribute('aria-invalid'), described:el.getAttribute('aria-describedby')})),
      fieldError:{hidden:document.getElementById('seed-verify-field-error')?.hidden,
        text:document.getElementById('seed-verify-field-error')?.innerText},
    })""")
    check(partial_wrong['values'] == ['cactus', '', ''] and partial_wrong['failures'] == 1 and
          'incorrect' in partial_wrong['status'].lower() and '4' in partial_wrong['attempts'] and
          partial_wrong['submit'] and
          partial_wrong['semantics'] == [
              {'invalid': None, 'described': 'seed-verify-help'},
              {'invalid': 'true', 'described': 'seed-verify-help seed-verify-field-error'},
              {'invalid': 'true', 'described': 'seed-verify-help seed-verify-field-error'},
          ] and partial_wrong['fieldError'] == {
              'hidden': False, 'text': 'Check the marked word and try again.'},
          f'错误提交只清错误字段、保留正确字段且显示剩余次数，不泄露答案，得到 {partial_wrong}')
    wrong_answer_surfaces = verify_page.evaluate("""() => ({
      status:document.getElementById('seed-verify-status').innerText,
      attempts:document.getElementById('seed-verify-attempts').innerText,
      live:[...document.querySelectorAll('#scr-seed-verify [aria-live]')]
        .map(el=>el.textContent).join('|'),
      aria:[...document.querySelectorAll('#scr-seed-verify *')].flatMap(el=>{
        const direct=[el.getAttribute('aria-label'),el.getAttribute('aria-description')];
        const resolved=(el.getAttribute('aria-describedby')||'').split(/\\s+/).filter(Boolean)
          .map(id=>document.getElementById(id)?.textContent||'');
        return direct.concat(resolved);
      }).filter(Boolean).join('|'),
    })""")
    answer_leaks = {name: value for name, value in wrong_answer_surfaces.items()
                    if any(re.search(rf'(?<![A-Za-z]){word}(?![A-Za-z])', value, re.I)
                           for word in ('cactus', 'echo', 'pixel'))}
    check(not answer_leaks,
          f'错误结果 status/attempts/live/non-live/ARIA/描述不揭示 3/7/11 答案，hits={answer_leaks}')
    verify_page.locator('#seed-verify-7').fill('retry-seven')
    edited_semantics = verify_page.evaluate("""() => ({
      seven:{invalid:document.getElementById('seed-verify-7').getAttribute('aria-invalid'),
        described:document.getElementById('seed-verify-7').getAttribute('aria-describedby')},
      elevenInvalid:document.getElementById('seed-verify-11').getAttribute('aria-invalid'),
      errorHidden:document.getElementById('seed-verify-field-error')?.hidden ?? null,
    })""")
    check(edited_semantics == {
        'seven': {'invalid': None, 'described': 'seed-verify-help'},
        'elevenInvalid': 'true', 'errorHidden': False,
    }, f'编辑错误字段只清该字段 invalid/error association，得到 {edited_semantics}')

    verify_page.evaluate("""() => {
      window.__verifyAnnouncements=[];
      const status=document.getElementById('seed-verify-status');
      new MutationObserver(()=>{
        const value=status.textContent;
        if(value && window.__verifyAnnouncements.at(-1)!==value) window.__verifyAnnouncements.push(value);
      }).observe(status,{childList:true,subtree:true,characterData:true});
    }""")
    for _ in range(4):
        verify_page.locator('#seed-verify-7').fill('wrong-seven')
        verify_page.locator('#seed-verify-11').fill('wrong-eleven')
        verify_page.locator('#seed-verify-submit').click()
    locked = verify_page.evaluate("""() => ({
      failures:account.verifyFailures, until:account.verifyLockedUntil, now:Date.now(),
      values:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.value),
      disabled:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.disabled),
      submit:document.getElementById('seed-verify-submit').disabled,
      status:document.getElementById('seed-verify-status').innerText,
      countdown:document.getElementById('seed-verify-countdown').innerText,
    })""")
    verify_page.clock.run_for(1_000)
    locked_1000 = verify_page.evaluate("document.getElementById('seed-verify-countdown').innerText")
    verify_page.clock.run_for(28_999)
    locked_29999 = verify_page.evaluate("""() => ({
      failures:account.verifyFailures,
      disabled:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.disabled),
      submit:document.getElementById('seed-verify-submit').disabled,
      countdown:document.getElementById('seed-verify-countdown').innerText,
    })""")
    verify_page.clock.run_for(1)
    unlocked_30000 = verify_page.evaluate("""() => ({
      failures:account.verifyFailures, until:account.verifyLockedUntil,
      values:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.value),
      disabled:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.disabled),
      submit:document.getElementById('seed-verify-submit').disabled,
      countdown:document.getElementById('seed-verify-countdown').innerText,
      announcements:window.__verifyAnnouncements,
      invalid:[...document.querySelectorAll('#seed-verify-form input')]
        .map(el=>el.getAttribute('aria-invalid')),
      described:[...document.querySelectorAll('#seed-verify-form input')]
        .map(el=>el.getAttribute('aria-describedby')),
      fieldErrorHidden:document.getElementById('seed-verify-field-error')?.hidden ?? null,
    })""")
    check(locked['failures'] == 5 and locked['until'] - locked['now'] == 30_000 and
          locked['values'] == ['cactus', '', ''] and all(locked['disabled']) and locked['submit'] and
          'locked' in locked['status'].lower() and '30' in locked['countdown'] and
          '29' in locked_1000 and
          locked_29999['failures'] == 5 and all(locked_29999['disabled']) and
          locked_29999['submit'] and '1' in locked_29999['countdown'] and
          unlocked_30000['failures'] == 0 and unlocked_30000['until'] == 0 and
          unlocked_30000['values'] == ['', '', ''] and
          unlocked_30000['disabled'] == [False, False, False] and unlocked_30000['submit'] and
          unlocked_30000['countdown'] == '' and
          unlocked_30000['invalid'] == [None, None, None] and
          unlocked_30000['described'] == ['seed-verify-help'] * 3 and
          unlocked_30000['fieldErrorHidden'] and
          len([msg for msg in unlocked_30000['announcements'] if 'locked' in msg.lower()]) == 1 and
          unlocked_30000['announcements'].count('You can try again.') == 1,
          f'第五次精确锁 30s，visual countdown 非 live，29999 锁/30000 清空解锁且各播报一次，'
          f'locked={locked} +1s={locked_1000} boundary={locked_29999}/{unlocked_30000}')

    for selector, value in (('#seed-verify-3', 'cactus'), ('#seed-verify-7', 'echo'),
                            ('#seed-verify-11', 'pixel')):
        verify_page.locator(selector).fill(value)
    verify_page.locator('#seed-verify-submit').click()
    verify_page.wait_for_function("location.hash === '#home'")
    verified = verify_page.evaluate("""() => ({
      hash:location.hash, stack:history.state.stack, complete:onboardingFlag('complete'),
      method:onboardingFlag('recoveryMethod'), incomplete:onboardingFlag('backupIncomplete'),
      values:[...document.querySelectorAll('#seed-verify-form input')].map(el=>el.value),
      failures:account.verifyFailures, until:account.verifyLockedUntil,
      bannerHidden:document.getElementById('backup-warning').hidden,
      invalid:[...document.querySelectorAll('#seed-verify-form input')]
        .map(el=>el.getAttribute('aria-invalid')),
      described:[...document.querySelectorAll('#seed-verify-form input')]
        .map(el=>el.getAttribute('aria-describedby')),
      fieldErrorHidden:document.getElementById('seed-verify-field-error')?.hidden ?? null,
    })""")
    verify_page.evaluate("""() => {
      window.__verifyCompletionPops=0;
      addEventListener('popstate',()=>{window.__verifyCompletionPops+=1});
    }""")
    traversal = []
    for pop_count, command in enumerate(('history.back()', 'history.forward()'), 1):
        verify_page.evaluate(command)
        verify_page.wait_for_function("""count =>
          window.__verifyCompletionPops >= count && location.hash === '#home' &&
          document.getElementById('scr-home').classList.contains('active') &&
          !document.getElementById('scr-home').hasAttribute('inert')""", arg=pop_count)
        traversal.append(active_state(verify_page))
    check(verified == {'hash': '#home', 'stack': ['scr-home'], 'complete': True,
                       'method': 'phrase', 'incomplete': False, 'values': ['', '', ''],
                       'failures': 0, 'until': 0, 'bannerHidden': True,
                       'invalid': [None, None, None],
                       'described': ['seed-verify-help'] * 3, 'fieldErrorHidden': True} and
          all(item == {'active': ['scr-home'], 'hash': '#home'} for item in traversal) and
          not verify_requests and not verify_errors,
          f'正确三词同步清值/状态、phrase 完成到 Home 且 stale Back 守卫，'
          f'verified={verified} traversal={traversal} requests={verify_requests} errors={verify_errors}')
    verify_context.close()

    print('\n== Task 6：phrase forbidden-sink、退出清理与监听器幂等 ==')
    phrase_secret = ' '.join(fixture)
    for exit_name, exit_action in (
            ('Continue', "document.getElementById('seed-show-recorded').click(); document.getElementById('seed-show-continue').click()"),
            ('in-app Back', 'back()'),
            ('browser Back', 'history.back()'),
            ('hashchange', "location.hash='market'"),
            ('pagehide', "dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))"),
            ('BFCache', "dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")):
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        pg = context.new_page()
        all_console = []
        local_errors = []
        attach_errors(pg, local_errors, all_console)
        fresh_incomplete(pg, 'seed-show')
        pg.locator('#seed-show-ack').check()
        pg.locator('#seed-show-reveal').click()
        pg.evaluate(exit_action)
        pg.wait_for_function("""() =>
          document.querySelectorAll('#seed-words li').length === 0 && !account.seedRevealed""")
        scan = pg.evaluate("""() => ({
          account:JSON.stringify(account),
          controls:[...document.querySelectorAll('input,textarea')].flatMap(el=>[el.value,el.getAttribute('value')]).filter(Boolean).join('|'),
          screenText:[...document.querySelectorAll('.scr')].map(el=>el.textContent).join('|'),
          aria:[...document.querySelectorAll('*')].flatMap(el=>{
            const direct=[el.getAttribute('aria-label'),el.getAttribute('aria-description')];
            const resolved=(el.getAttribute('aria-describedby')||'').split(/\\s+/).filter(Boolean)
              .map(id=>document.getElementById(id)?.textContent||'');
            return direct.concat(resolved);
          }).filter(Boolean).join('|'),
          history:JSON.stringify(history.state),
          local:[...Array(localStorage.length)].flatMap((_,i)=>[localStorage.key(i),localStorage.getItem(localStorage.key(i))]).filter(Boolean).join('|'),
          session:[...Array(sessionStorage.length)].flatMap((_,i)=>[sessionStorage.key(i),sessionStorage.getItem(sessionStorage.key(i))]).filter(Boolean).join('|'),
          toast:document.getElementById('toast').textContent,
        })""")
        scan['console'] = '|'.join(all_console)
        hits = {name: value for name, value in scan.items()
                if phrase_secret in value or any(re.search(rf'(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])', value)
                                                 for word in fixture)}
        check(not hits and not local_errors,
              f'{exit_name} 后 mutable state/controls/screens/ARIA/history/storage/console/toast '
              f'无完整 phrase 或精确词，hits={hits} errors={local_errors}')
        context.close()

    listener_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    listener_context.add_init_script("""(() => {
      window.__seedListeners=[];
      const original=EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener=function(type,listener,options){
        const id=this && this.id;
        if((id && (id.startsWith('seed-show-') || id.startsWith('seed-verify-'))) ||
           (this===document && type==='visibilitychange')) window.__seedListeners.push(`${id||'document'}:${type}`);
        return original.call(this,type,listener,options);
      };
    })()""")
    listener_page = listener_context.new_page()
    listener_page.goto(f'{URL}#seed-show', wait_until='networkidle')
    before_listeners = listener_page.evaluate('window.__seedListeners.slice()')
    for _ in range(3):
        listener_page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))")
        listener_page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
    after_listeners = listener_page.evaluate('window.__seedListeners.slice()')
    check(before_listeners == after_listeners and len(before_listeners) == len(set(before_listeners)),
          f'A8/A9 BFCache 不重复注册 listeners，before={before_listeners} after={after_listeners}')
    listener_context.close()

    print('\n== Task 7：钱包导入模式、精确校验与切换清理 ==')
    import_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    import_clipboard = []
    import_api = []
    install_task7_security_spies(import_context, import_clipboard, import_api)
    import_page = import_context.new_page()
    import_errors = []
    import_console = []
    import_requests = []
    attach_errors(import_page, import_errors, import_console)
    import_page.on('request', lambda req: import_requests.append(request_record(req)))
    fresh_incomplete(import_page, 'wallet-import')
    import_page.clock.install()
    import_page.clock.pause_at(2_000_000_000_000)
    fixture = import_page.evaluate("""fallback => ({
      available:typeof DEMO_PHRASE !== 'undefined' && typeof DEMO_BAD_CHECKSUM !== 'undefined' &&
        typeof DEMO_PRIVATE_KEY !== 'undefined' && typeof DEMO_EVM_ADDRESS !== 'undefined' &&
        typeof DEMO_SOLANA_ADDRESS !== 'undefined' && typeof DEMO_IMPORT_WORDS !== 'undefined',
      phrase:typeof DEMO_PHRASE === 'undefined' ? fallback.phrase : DEMO_PHRASE.join(' '),
      badChecksum:typeof DEMO_BAD_CHECKSUM === 'undefined' ? fallback.badChecksum : DEMO_BAD_CHECKSUM,
      privateKey:typeof DEMO_PRIVATE_KEY === 'undefined' ? fallback.privateKey : DEMO_PRIVATE_KEY,
      evm:typeof DEMO_EVM_ADDRESS === 'undefined' ? fallback.evm : DEMO_EVM_ADDRESS,
      solana:typeof DEMO_SOLANA_ADDRESS === 'undefined' ? fallback.solana : DEMO_SOLANA_ADDRESS,
      words:typeof DEMO_IMPORT_WORDS === 'undefined' ? [] : [...DEMO_IMPORT_WORDS],
      constants:typeof DEMO_PHRASE === 'undefined' ? [] : [
        Object.isFrozen(DEMO_PHRASE), DEMO_PRIVATE_KEY.length,
        DEMO_EVM_ADDRESS.length, DEMO_SOLANA_ADDRESS.length,
      ],
    })""", {'phrase': TASK7_PHRASE, 'badChecksum': TASK7_BAD_CHECKSUM,
              'privateKey': TASK7_PRIVATE_KEY, 'evm': TASK7_EVM_ADDRESS,
              'solana': TASK7_SOLANA_ADDRESS})
    check(fixture['available'] and fixture['constants'] == [True, 66, 42, 32] and
          fixture['phrase'].split()[-1] == 'anchor' and 'pixel' in fixture['words'],
          f'Task 7 精确 fixtures 集中且完整，得到 {fixture}')
    structure = import_page.evaluate("""() => ({
      modes:[...document.querySelectorAll('[name="wallet-import-mode"]')].map(el=>el.value),
      field:document.getElementById('wallet-import-value')?.tagName,
      described:document.getElementById('wallet-import-value')?.getAttribute('aria-describedby'),
      statusRole:document.getElementById('wallet-import-status')?.getAttribute('role'),
    })""")
    expected_import_structure = {'modes': ['phrase', 'private', 'watch'], 'field': 'TEXTAREA',
                                 'described': 'wallet-import-help wallet-import-status',
                                 'statusRole': 'alert'}
    check(structure == expected_import_structure,
          f'A10 有三种可访问模式及关联错误，得到 {structure}')
    if structure != expected_import_structure:
        import_context.close()
        browser.close()
        print('\n' + f'{len(fails)} 项失败:')
        for failure in fails:
            print(' -', failure)
        sys.exit(1)

    import_requests.clear(); import_clipboard.clear(); import_api.clear()
    import_page.locator('#wallet-import-value').fill('SECRET_MODE_SWITCH_731')
    import_page.locator('#wallet-import-value').dispatch_event('change')
    import_page.locator('#wallet-import-submit').click()
    import_page.clock.run_for(500)
    import_page.locator('#wallet-import-mode-private').check()
    switched = import_page.evaluate("""() => ({
      mode:account.importMode, value:account.importValue,
      field:document.getElementById('wallet-import-value').value,
      status:document.getElementById('wallet-import-status').textContent,
      invalid:document.getElementById('wallet-import-value').getAttribute('aria-invalid'),
      type:document.getElementById('wallet-import-value').getAttribute('type'),
    })""")
    check(switched == {'mode': 'private', 'value': '', 'field': '', 'status': '',
                       'invalid': None, 'type': 'password'},
          f'切换模式清空旧输入/错误/敏感可变状态，得到 {switched}')

    validation_cases = [
        ('phrase', ' '.join(fixture['phrase'].split()[:11]), 'Enter exactly 12 recovery words.'),
        ('phrase', fixture['phrase'].replace('anchor', 'unknownword'),
         'One or more words are not recognized.'),
        ('phrase', fixture['badChecksum'], 'The recovery phrase checksum is invalid.'),
        ('private', '0x' + '1' * 63, 'Enter 0x followed by 64 hexadecimal characters.'),
        ('private', '0x' + '1' * 63 + 'z', 'Enter 0x followed by 64 hexadecimal characters.'),
        ('private', '1' * 64, 'Enter 0x followed by 64 hexadecimal characters.'),
        ('watch', '0x' + '1' * 39, 'Enter a supported EVM or Solana address.'),
        ('watch', '0OIl' * 8, 'Enter a supported EVM or Solana address.'),
    ]
    validation_results = []
    for mode, value, expected in validation_cases:
        import_page.locator(f'#wallet-import-mode-{mode}').check()
        import_requests.clear(); import_clipboard.clear(); import_api.clear()
        import_page.locator('#wallet-import-value').fill(value)
        import_page.locator('#wallet-import-value').dispatch_event('change')
        import_page.locator('#wallet-import-submit').click()
        pending = import_page.evaluate("""secret => ({
          busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          status:document.getElementById('wallet-import-status').textContent,
          submit:document.getElementById('wallet-import-submit').disabled,
          modes:[...document.querySelectorAll('[name="wallet-import-mode"]')].map(el=>el.disabled),
          timerCount:account.timers.length, accountValue:account.importValue,
          field:document.getElementById('wallet-import-value').value,
          fixture:document.getElementById('wallet-import-fixture').textContent,
          secretInAccount:JSON.stringify(account).includes(secret),
        })""", value)
        import_page.clock.run_for(499)
        before_boundary = import_page.evaluate("""() => ({
          busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          status:document.getElementById('wallet-import-status').textContent,
          timerCount:account.timers.length,
        })""")
        import_page.clock.run_for(1)
        revealed = import_page.evaluate("""secret => ({
          busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          status:document.getElementById('wallet-import-status').textContent,
          invalid:document.getElementById('wallet-import-value').getAttribute('aria-invalid'),
          submit:document.getElementById('wallet-import-submit').disabled,
          modes:[...document.querySelectorAll('[name="wallet-import-mode"]')].map(el=>el.disabled),
          timerCount:account.timers.length, accountValue:account.importValue,
          field:document.getElementById('wallet-import-value').value,
          fixture:document.getElementById('wallet-import-fixture').textContent,
          secretRetained:JSON.stringify(account).includes(secret)||
            [...document.querySelectorAll('input,textarea')].some(el=>el.value.includes(secret))||
            document.getElementById('wallet-import-fixture').textContent.includes(secret),
        })""", value)
        validation_results.append({
            'mode': mode, 'pending': pending, 'before': before_boundary,
            'revealed': revealed, 'requests': list(import_requests),
            'api': list(import_api), 'clipboard': list(import_clipboard),
        })
    expected_pending = {'busy': 'true', 'status': '', 'submit': True,
                        'modes': [True, True, True], 'timerCount': 1,
                        'accountValue': '', 'field': '', 'fixture': '',
                        'secretInAccount': False}
    expected_before = {'busy': 'true', 'status': '', 'timerCount': 1}
    check(all(item['pending'] == expected_pending and item['before'] == expected_before and
              item['revealed'] == {
                  'busy': 'false', 'status': case[2], 'invalid': 'true',
                  'submit': False, 'modes': [False, False, False], 'timerCount': 0,
                  'accountValue': '', 'field': '', 'fixture': '', 'secretRetained': False,
              } and not item['requests'] and not item['api'] and not item['clipboard']
              for item, case in zip(validation_results, validation_cases)),
          f'phrase/private/watch 错误使用 500ms loading、精确揭示且不保留秘密，得到 {validation_results}')
    mixed_bad = '  OrBiT   VELVET cactus  HARBOR lunar MAPLE echo RAVEN silver TUNNEL pixel   PIXEL  '
    mixed_valid = '  ORBIT   velvet CACTUS harbor   lunar MAPLE echo raven SILVER tunnel pixel ANCHOR  '
    normalized_validation = import_page.evaluate("""([bad,valid]) => ({
      bad:validateImport('phrase',bad), valid:validateImport('phrase',valid),
    })""", [mixed_bad, mixed_valid])
    check(normalized_validation == {
        'bad': 'The recovery phrase checksum is invalid.', 'valid': ''},
        f'phrase 只规范化一次并以 lowercase/collapsed words 比较 checksum，得到 {normalized_validation}')
    import_context.close()

    print('\n== Task 7：成功导入 loading/teardown、零网络与零敏感 clipboard ==')
    success_cases = [
        ('phrase', fixture['phrase'], False),
        ('private', fixture['privateKey'], False),
        ('watch', fixture['evm'], True),
        ('watch', fixture['solana'], True),
    ]
    for mode, secret, watch_only in success_cases:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        clipboard_calls = []
        api_calls = []
        install_task7_security_spies(context, clipboard_calls, api_calls)
        pg = context.new_page()
        local_errors = []
        all_console = []
        requests = []
        attach_errors(pg, local_errors, all_console)
        pg.on('request', lambda req: requests.append(request_record(req)))
        fresh_incomplete(pg, 'wallet-import')
        pg.clock.install()
        pg.clock.pause_at(2_000_000_000_000)
        spy_install = task7_spy_state(pg)
        spy_probe = pg.evaluate("""() => ({
          copy:document.execCommand('copy'),cut:document.execCommand('cut')
        })""")
        check(spy_probe == {'copy': False, 'cut': False} and
              clipboard_calls == ['call:execCommand:copy', 'call:execCommand:cut'],
              f'{mode} execCommand copy/cut spy 安装且可观测，'
              f'probe={spy_probe} calls={clipboard_calls}')
        pg.locator(f'#wallet-import-mode-{mode}').check()
        requests.clear()
        clipboard_calls.clear()
        api_calls.clear()
        pg.locator('#wallet-import-value').fill(secret)
        pg.locator('#wallet-import-value').dispatch_event('change')
        pg.locator('#wallet-import-submit').click()
        pending = pg.evaluate("""secret => ({
          hash:location.hash,busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          submit:document.getElementById('wallet-import-submit').disabled,
          modes:[...document.querySelectorAll('[name="wallet-import-mode"]')].map(el=>el.disabled),
          timerCount:account.timers.length,accountValue:account.importValue,
          field:document.getElementById('wallet-import-value')?.value||'',
          fixture:document.getElementById('wallet-import-fixture').textContent,
          secretInAccount:JSON.stringify(account).includes(secret),
        })""", secret)
        pg.clock.run_for(499)
        before_boundary = active_state(pg)
        pg.clock.run_for(1)
        wait_for_settled_screen(pg, 'home')
        runtime = pg.evaluate("""() => ({
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id),
          hash:location.hash, importMode:account.importMode, importValue:account.importValue,
          complete:onboardingFlag('complete'), watchOnly:onboardingFlag('watchOnly'),
          recoveryMethod:onboardingFlag('recoveryMethod'),
          controls:[...document.querySelectorAll('input,textarea')].flatMap(el=>[el.value,el.getAttribute('value')]).filter(Boolean).join('|'),
          text:[...document.querySelectorAll('.scr')].map(el=>el.textContent).join('|'),
          aria:[...document.querySelectorAll('*')].flatMap(el=>[el.getAttribute('aria-label'),el.getAttribute('aria-description')]).filter(Boolean).join('|'),
          history:JSON.stringify(history.state),
          local:JSON.stringify({...localStorage}), session:JSON.stringify({...sessionStorage}),
          toast:document.getElementById('toast').textContent,
          focused:document.activeElement?.id||'',
        })""")
        runtime['console'] = '|'.join(all_console)
        leaked = {name: value for name, value in runtime.items()
                  if isinstance(value, str) and secret in value}
        expected_focus = 'home-title'
        check(pending == {'hash': '#wallet-import', 'busy': 'true', 'submit': True,
                          'modes': [True, True, True], 'timerCount': 1,
                          'accountValue': '', 'field': '', 'fixture': '',
                          'secretInAccount': False} and
              before_boundary == {'active': ['scr-wallet-import'], 'hash': '#wallet-import'} and
              runtime['active'] == ['scr-home'] and runtime['hash'] == '#home' and
              runtime['importMode'] == 'phrase' and runtime['importValue'] == '' and
              runtime['complete'] is True and runtime['watchOnly'] is watch_only and
              runtime['recoveryMethod'] == '' and runtime['focused'] == expected_focus and
              spy_install == {'clipboard': True, 'clipboardError': '',
                              'execCommand': True, 'execCommandError': '',
                              'network': True, 'networkError': ''} and
              not leaked and not requests and not api_calls and not clipboard_calls and not local_errors,
              f'{mode} 500ms loading 同步清秘密、聚焦 Home、无 recoveryMethod/网络/clipboard，'
              f'pending={pending} boundary={before_boundary} runtime={runtime} leaked={leaked} '
              f'requests={requests} api={api_calls} clipboard={clipboard_calls} spies={spy_install} errors={local_errors}')
        context.close()

    cancel_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    cancel_clipboard = []
    cancel_api = []
    install_task7_security_spies(cancel_context, cancel_clipboard, cancel_api)
    cancel_page = cancel_context.new_page()
    cancel_requests = []
    cancel_page.on('request', lambda req: cancel_requests.append(request_record(req)))
    fresh_incomplete(cancel_page, 'wallet-import')
    cancel_page.clock.install()
    cancel_page.clock.pause_at(2_000_000_000_000)
    cancel_page.locator('#wallet-import-mode-private').check()
    cancel_requests.clear(); cancel_clipboard.clear(); cancel_api.clear()
    cancel_page.locator('#wallet-import-value').fill(fixture['privateKey'])
    cancel_page.locator('#wallet-import-value').dispatch_event('change')
    cancel_page.locator('#wallet-import-submit').click()
    cancel_page.evaluate("location.hash='market'")
    cancel_page.wait_for_function("location.hash==='#market'")
    cancel_page.clock.run_for(1000)
    cancelled = cancel_page.evaluate("""secret => ({
      state:{hash:location.hash,complete:onboardingFlag('complete'),timers:account.timers.length,
        value:account.importValue,busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy')},
      leaked:JSON.stringify(account).includes(secret)||document.body.textContent.includes(secret)||
        [...document.querySelectorAll('input,textarea')].some(el=>el.value.includes(secret)),
    })""", fixture['privateKey'])
    check(cancelled == {'state': {'hash': '#market', 'complete': False, 'timers': 0,
                                  'value': '', 'busy': 'false'}, 'leaked': False} and
          not cancel_requests and not cancel_api and not cancel_clipboard,
          f'import loading 可由中央 teardown 取消且 timer 不留秘密/不晚完成，state={cancelled} '
          f'requests={cancel_requests} api={cancel_api} clipboard={cancel_clipboard}')
    cancel_context.close()

    print('\n== Task 7：invalid loading 退出取消与 clipboard/network 矩阵 ==')
    invalid_actions = [
        ('invalid submit', 'invalid', 'phrase',
         fixture['phrase'].replace('anchor', 'unknownword'),
         'One or more words are not recognized.'),
        ('mode switch', 'switch', 'private', '0x' + '1' * 63,
         'Enter 0x followed by 64 hexadecimal characters.'),
        ('in-app Back', 'back', 'watch', '0x' + '1' * 39,
         'Enter a supported EVM or Solana address.'),
        ('hash exit', 'hash', 'phrase', fixture['badChecksum'],
         'The recovery phrase checksum is invalid.'),
        ('reload', 'reload', 'private', '1' * 64,
         'Enter 0x followed by 64 hexadecimal characters.'),
        ('BFCache', 'bfcache', 'watch', '0OIl' * 8,
         'Enter a supported EVM or Solana address.'),
        ('restart', 'restart', 'phrase', ' '.join(fixture['phrase'].split()[:11]),
         'Enter exactly 12 recovery words.'),
    ]
    expected_active = {
        'invalid': 'scr-wallet-import', 'switch': 'scr-wallet-import',
        'back': 'scr-auth', 'hash': 'scr-market',
        'reload': 'scr-wallet-import', 'bfcache': 'scr-wallet-import',
        'restart': 'scr-auth',
    }
    for exit_name, action, mode, secret, expected_error in invalid_actions:
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        clipboard_calls = []
        api_calls = []
        install_task7_security_spies(context, clipboard_calls, api_calls)
        pg = context.new_page()
        requests = []
        local_errors = []
        all_console = []
        attach_errors(pg, local_errors, all_console)
        pg.on('request', lambda req: requests.append(request_record(req)))
        fresh_incomplete(pg, 'wallet-import')
        pg.clock.install()
        pg.clock.pause_at(2_000_000_000_000)
        installed_before = task7_spy_state(pg)
        pg.locator(f'#wallet-import-mode-{mode}').check()
        requests.clear(); clipboard_calls.clear(); api_calls.clear()
        pg.locator('#wallet-import-value').fill(secret)
        pg.locator('#wallet-import-value').dispatch_event('change')
        pg.locator('#wallet-import-submit').click()
        pending = pg.evaluate("""secret => ({
          busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          status:document.getElementById('wallet-import-status').textContent,
          timers:account.timers.length, value:account.importValue,
          control:document.getElementById('wallet-import-value').value,
          secretRetained:JSON.stringify(account).includes(secret)||
            [...document.querySelectorAll('input,textarea')].some(el=>el.value.includes(secret)),
        })""", secret)
        if action == 'invalid':
            pg.clock.run_for(500)
        elif action == 'switch':
            pg.evaluate("""() => {
              const target=document.getElementById('wallet-import-mode-watch');
              target.disabled=false;
              target.click();
            }""")
        elif action == 'back':
            pg.evaluate('back()')
        elif action == 'hash':
            pg.evaluate("location.hash='market'")
            pg.wait_for_function("location.hash==='#market'")
        elif action == 'reload':
            pg.reload(wait_until='networkidle')
        elif action == 'bfcache':
            pg.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        else:
            pg.evaluate('restartOnboarding()')
        if action != 'invalid' and action != 'reload':
            pg.clock.run_for(1000)
        pg.wait_for_timeout(0)
        installed_after = task7_spy_state(pg)
        state = pg.evaluate("""secret => ({
          active:activeScr(), hash:location.hash, complete:onboardingFlag('complete'),
          timers:account.timers.length,
          busy:document.getElementById('scr-wallet-import').getAttribute('aria-busy'),
          status:document.getElementById('wallet-import-status').textContent,
          mode:account.importMode,value:account.importValue,
          control:document.getElementById('wallet-import-value')?.value||'',
          submit:document.getElementById('wallet-import-submit').disabled,
          modes:[...document.querySelectorAll('[name="wallet-import-mode"]')].map(el=>el.disabled),
          leaked:JSON.stringify(account).includes(secret)||
            [...document.querySelectorAll('.scr')].some(el=>el.textContent.includes(secret))||
            [...document.querySelectorAll('input,textarea')].some(el=>el.value.includes(secret))||
            [...document.querySelectorAll('*')].some(el=>
              [el.getAttribute('aria-label'),el.getAttribute('aria-description')].filter(Boolean)
                .some(value=>value.includes(secret)))||
            JSON.stringify(history.state).includes(secret)||
            JSON.stringify({...localStorage}).includes(secret)||
            JSON.stringify({...sessionStorage}).includes(secret)||
            document.getElementById('toast').textContent.includes(secret),
        })""", secret)
        reload_requests = requests if action == 'reload' else []
        safe_reload = action != 'reload' or all(
            record['method'] == 'GET' and not record['body'] and secret not in record['url']
            for record in reload_requests)
        expected_status = expected_error if action == 'invalid' else ''
        expected_mode = 'watch' if action == 'switch' else 'phrase'
        check(pending == {'busy': 'true', 'status': '', 'timers': 1,
                          'value': '', 'control': '', 'secretRetained': False} and
              state == {'active': expected_active[action],
                        'hash': '#' + expected_active[action].removeprefix('scr-'),
                        'complete': False, 'timers': 0, 'busy': 'false',
                        'status': expected_status, 'mode': expected_mode,
                        'value': '', 'control': '', 'submit': False,
                        'modes': [False, False, False], 'leaked': False} and
              installed_before == {'clipboard': True, 'clipboardError': '',
                                   'execCommand': True, 'execCommandError': '',
                                   'network': True, 'networkError': ''} and
              installed_after == installed_before and not clipboard_calls and not api_calls and
              safe_reload and (action == 'reload' or not requests) and not local_errors and
              not any(secret in entry for entry in all_console),
              f'{exit_name}: invalid timer 可取消、秘密同步清理且 clipboard/network 零访问，pending={pending} '
              f'installed={installed_before}/{installed_after} calls={clipboard_calls} api={api_calls} '
              f'requests={requests} state={state} errors={local_errors} console={all_console}')
        context.close()

    print('\n== Task 7：watch-only 全签名入口阻断与非签名能力保留 ==')
    watch_context = browser.new_context(viewport={'width': 1440, 'height': 900})
    watch_page = watch_context.new_page()
    watch_errors = []
    attach_errors(watch_page, watch_errors)
    watch_page.goto(f'{URL}#home', wait_until='networkidle')
    clear_onboarding_namespace(watch_page)
    watch_page.evaluate("""() => {
      setOnboardingFlag('complete',true); setOnboardingFlag('watchOnly',true);
      navigate(ROUTES.home.stack.slice(),{replace:true});
    }""")
    expected_signing = {
        'home': ['home-pay'],
        'token': ['token-buy'],
        'group': ['group-token-buy', 'group-copy-trade'],
        'wallet': ['wallet-send', 'wallet-swap', 'wallet-bridge', 'wallet-dapps'],
        'swap': ['swap-submit'],
        'dapp': ['dapp-approve'],
    }
    expected_shell_ids = ['approval-limit', 'approval-unlimited']
    expected_signing_ids = sorted(
        [control_id for ids in expected_signing.values() for control_id in ids] +
        expected_shell_ids)
    actual_signing_ids = watch_page.evaluate("""() =>
      [...document.querySelectorAll('[data-requires-signing]')].map(el=>el.id).sort()""")
    check(actual_signing_ids == expected_signing_ids and len(actual_signing_ids) == 12,
          f'签名控制 authoritative inventory 精确 12 个，actual={actual_signing_ids} expected={expected_signing_ids}')
    restricted = {}
    for route_name, ids in expected_signing.items():
        watch_page.evaluate("routeName => navigate(ROUTES[routeName].stack.slice(),{replace:true})",
                            route_name)
        restricted[route_name] = watch_page.evaluate("""ids => ids.map(id => {
          const el=document.getElementById(id);
          const before={hash:location.hash,toast:document.getElementById('toast').textContent,
            veil:document.getElementById('veil').classList.contains('open')};
          el?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
          return {id,exists:Boolean(el),marker:el?.hasAttribute('data-requires-signing'),
            disabled:'disabled' in (el||{}) ? el.disabled : null,
            ariaDisabled:el?.getAttribute('aria-disabled'),
            described:el?.getAttribute('aria-describedby'),
            title:el?.getAttribute('title'), before,
            after:{hash:location.hash,toast:document.getElementById('toast').textContent,
              veil:document.getElementById('veil').classList.contains('open')}};
        })""", ids)
    watch_page.evaluate("openSheet('sheet-approve')")
    shell_restricted = watch_page.evaluate("""() => [...document.querySelectorAll(
      '#sheet-approve [data-requires-signing]')].map(el=>({
        id:el.id,disabled:el.disabled,ariaDisabled:el.getAttribute('aria-disabled'),
        described:el.getAttribute('aria-describedby'),title:el.getAttribute('title'),
      }))""")
    flat_restricted = [item for rows in restricted.values() for item in rows]
    check(all(item['exists'] and item['marker'] and item['disabled'] is True and
              item['ariaDisabled'] == 'true' and item['described'] == 'watch-only-explanation' and
              item['title'] == 'Watch-only wallets cannot sign transactions.' and
              item['before'] == item['after'] for item in flat_restricted) and
          len(shell_restricted) == 2 and all(item['disabled'] is True and
              item['ariaDisabled'] == 'true' and item['described'] == 'watch-only-explanation' and
              item['title'] == 'Watch-only wallets cannot sign transactions.'
              for item in shell_restricted),
          f'所有签名入口 real-disabled + capturing defense + 同一解释，routes={restricted} shell={shell_restricted}')

    interaction_results = []
    if actual_signing_ids == expected_signing_ids:
        route_for_id = {control_id: route_name
                        for route_name, ids in expected_signing.items()
                        for control_id in ids}
        route_for_id.update({'approval-limit': 'dapp', 'approval-unlimited': 'dapp'})
        for control_id in expected_signing_ids:
            route_name = route_for_id[control_id]
            watch_page.evaluate("""([routeName,id]) => {
              closeSheets();
              navigate(ROUTES[routeName].stack.slice(),{replace:true});
              if(id==='approval-limit'||id==='approval-unlimited') openSheet('sheet-approve');
            }""", [route_name, control_id])
            for method in ('user-click', 'keyboard', 'nested-target', 'native-click', 'synthetic-click'):
                baseline = watch_page.evaluate("""id => {
                  const toastEl=document.getElementById('toast'); toastEl.textContent=''; toastEl.classList.remove('show');
                  const explanation=document.getElementById('watch-only-explanation'); explanation.hidden=true;
                  const el=document.getElementById(id); el.disabled=false; el.removeAttribute('aria-disabled');
                  return {hash:location.hash,stack:JSON.stringify(stack),toast:toastEl.textContent,
                    veil:document.getElementById('veil').classList.contains('open'),
                    sheets:[...document.querySelectorAll('.sheet.open')].map(node=>node.id),
                    timers:account.timers.length,account:JSON.stringify(account)};
                }""", control_id)
                locator = watch_page.locator(f'#{control_id}')
                if method == 'user-click':
                    locator.click()
                elif method == 'keyboard':
                    locator.focus()
                    locator.press('Enter')
                elif method == 'nested-target':
                    watch_page.evaluate("""id => {
                      const el=document.getElementById(id);
                      let target=el.querySelector('svg,span');
                      if(!target){target=document.createElement('span');target.dataset.task7Probe='';el.append(target)}
                      target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
                    }""", control_id)
                elif method == 'native-click':
                    watch_page.evaluate("id => document.getElementById(id).click()", control_id)
                else:
                    watch_page.evaluate("""id => document.getElementById(id).dispatchEvent(
                      new MouseEvent('click',{bubbles:true,cancelable:true}))""", control_id)
                result = watch_page.evaluate("""([id,before]) => {
                  const after={hash:location.hash,stack:JSON.stringify(stack),
                    toast:document.getElementById('toast').textContent,
                    veil:document.getElementById('veil').classList.contains('open'),
                    sheets:[...document.querySelectorAll('.sheet.open')].map(node=>node.id),
                    timers:account.timers.length,account:JSON.stringify(account)};
                  renderOnboardingFlags();
                  document.querySelectorAll('[data-task7-probe]').forEach(node=>node.remove());
                  return {same:JSON.stringify(before)===JSON.stringify(after),disabled:document.getElementById(id).disabled,
                    explanation:document.getElementById('watch-only-explanation').hidden};
                }""", [control_id, baseline])
                interaction_results.append({'id': control_id, 'method': method, **result})
    check(len(interaction_results) == 60 and
          all(item['same'] and item['disabled'] and not item['explanation']
              for item in interaction_results),
          f'12 个签名入口 × user/keyboard/nested/native/synthetic 全由 capture defense 阻断且恢复 disabled，'
          f'failures={[item for item in interaction_results if not item.get("same") or not item.get("disabled") or item.get("explanation")]} count={len(interaction_results)}')

    completed_before = watch_page.evaluate("""() => {
      closeSheets(); navigate(ROUTES.swap.stack.slice(),{replace:true});
      const control=document.getElementById('completed-provider-fixture');
      const priorAdapter=ensureWalletAdapter().adapter;
      const before=JSON.stringify(priorAdapter.getBalanceSnapshot({}));
      return {before,
        exists:Boolean(control), label:control.textContent.trim(),
        signing:control.hasAttribute('data-requires-signing'), disabled:control.disabled,
        beforeGlyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||'',
        priorUnchanged:before===JSON.stringify(priorAdapter.getBalanceSnapshot({}))};
    }""")
    watch_page.click('#completed-provider-fixture')
    completed_after = watch_page.evaluate("""before => ({
        same:before===JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({})),
        demo:new URLSearchParams(location.search).get('demo')||'',
        hash:location.hash, dialog:document.getElementById('review-dialog').classList.contains('open'),
        reviewMarker:Boolean(history.state?.loop_review),
        banner:document.getElementById('review-provider-banner').textContent,
        providerState:document.getElementById('review-provider-banner').dataset.state,
        glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''
      })""", completed_before['before'])
    completed_fixture = {key: value for key, value in completed_before.items() if key != 'before'}
    completed_fixture.update(completed_after)
    check(completed_fixture == {
              'exists': True, 'label': 'Show completed provider fixture',
              'signing': False, 'disabled': False, 'beforeGlyph': '',
              'priorUnchanged': True, 'same': True, 'demo': '',
              'hash': '#swap', 'dialog': False, 'reviewMarker': False,
              'banner': 'Completed provider fixture is unavailable for watch-only wallets.',
              'providerState': 'provider_blocked', 'glyph': ''},
          f'completed-provider control 是 watch-only 可查看的非签名入口且不触发 handoff/余额变更: {completed_fixture}')
    usable = watch_page.evaluate("""() => {
      navigate(ROUTES.token.stack.slice(),{replace:true});
      const token=['tk-watch'];
      navigate(ROUTES.group.stack.slice(),{replace:true});
      const group=['group-chart','group-watch','group-analysis','vrJoinBtn'];
      return [...token,...group].map(id=>{const el=document.getElementById(id);return [id,Boolean(el),el?.disabled||false]});
    }""")
    tabs = watch_page.evaluate("""() => [...document.querySelectorAll('.tab')]
      .map(el=>[el.dataset.tab,el.disabled])""")
    watch_page.evaluate("""() => {
      const clean=new URL(location.href); clean.searchParams.delete('demo');
      history.replaceState(history.state,'',clean); ensureWalletAdapter();
      setOnboardingFlag('watchOnly',false); navigate(ROUTES.home.stack.slice(),{replace:true});
    }""")
    reset_restrictions = watch_page.evaluate("""() => ({
      restricted:[...document.querySelectorAll('[data-requires-signing]')].filter(el=>el.disabled).length,
      explanationHidden:document.getElementById('watch-only-explanation').hidden,
    })""")
    approval_plan = watch_page.evaluate("""() => {
      navigate(ROUTES.profile.stack.slice(),{replace:true});
      const control=document.getElementById('profile-approvals-review');
      const before=JSON.stringify(ensureWalletAdapter().adapter.getBalanceSnapshot({}));
      const banner=document.getElementById('review-provider-banner');
      banner.textContent=''; banner.hidden=true; document.getElementById('toast').textContent='';
      control.click();
      return {label:control.textContent.trim(),signing:control.hasAttribute('data-requires-signing'),
        disabled:control.disabled,same:before===JSON.stringify(
          ensureWalletAdapter().adapter.getBalanceSnapshot({})),
        review:document.getElementById('review-dialog').classList.contains('open'),
        marker:Boolean(history.state?.loop_review),banner:banner.textContent,
        toast:document.getElementById('toast').textContent};
    }""")
    expected_usable = {
      'tk-watch': (True, False), 'group-chart': (True, False),
      'group-watch': (True, False), 'group-analysis': (True, False),
      'vrJoinBtn': (True, True),
    }
    check(all(expected_usable.get(item_id) == (exists, disabled)
              for item_id, exists, disabled in usable) and
          all(not disabled for _, disabled in tabs) and
          reset_restrictions == {'restricted': 0, 'explanationHidden': True} and
          approval_plan == {'label': 'View plan', 'signing': False, 'disabled': False,
            'same': True, 'review': False, 'marker': False, 'banner': '',
            'toast': 'Approval management is planned for F17. No approval has changed.'} and
          not watch_errors,
          f'浏览/非执行approval plan/tabs可用且重启解除限制，usable={usable} tabs={tabs} '
          f'reset={reset_restrictions} plan={approval_plan} errors={watch_errors}')
    watch_context.close()

    print('\n== Task 8：九屏无障碍、焦点与 375×667 布局矩阵 ==')
    mobile_context = browser.new_context(viewport={'width': 375, 'height': 667})
    mobile_page = mobile_context.new_page()
    mobile_errors = []
    attach_errors(mobile_page, mobile_errors)
    primary_actions = {
        'auth-otp': '#otp-verify',
        'auth-wallet': '#wallet-connect',
        'seed-show': '#seed-show-continue',
        'seed-verify': '#seed-verify-submit',
        'wallet-import': '#wallet-import-submit',
    }
    route_layout = {}
    for route, expected_id in ACCOUNT.items():
        fresh_incomplete(mobile_page, route)
        mobile_page.wait_for_function(
            "expected => document.activeElement?.id === "
            "document.querySelector(`#${expected} [data-route-focus]`)?.id",
            arg=expected_id)
        snapshot = mobile_page.evaluate(r"""expectedId => {
          const active=[...document.querySelectorAll('.scr.active:not([inert])')];
          const inactive=[...document.querySelectorAll('.scr')].filter(screen=>screen.id!==expectedId);
          const screen=document.getElementById(expectedId);
          const focus=screen.querySelectorAll('[data-route-focus]');
          const fields=[...screen.querySelectorAll('input,textarea,select')];
          const unlabeled=fields.filter(field=>field.labels?.length===0&&
            !field.getAttribute('aria-label')&&!field.getAttribute('aria-labelledby')).map(field=>field.id);
          const potentiallyFocusable=[...document.querySelectorAll(
            'a[href],button,input,textarea,select,[tabindex]')].filter(el=>
              el.getAttribute('tabindex')!=='-1'&&getComputedStyle(el).display!=='none'&&
              getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0);
          const hiddenTabbables=potentiallyFocusable.filter(el=>{
            const owner=el.closest('.scr');
            return owner&&owner.id!==expectedId&&!owner.hasAttribute('inert');
          }).map(el=>el.id||el.tagName);
          const targetRects=potentiallyFocusable.filter(el=>screen.contains(el)).map(el=>{
            let target=el;
            if(el.matches('input[type="radio"],input[type="checkbox"]')&&el.labels?.[0]) target=el.labels[0];
            const rect=target.getBoundingClientRect();
            return {id:el.id||el.tagName,width:rect.width,height:rect.height};
          });
          return {
            active:active.map(node=>node.id),
            inactiveBad:inactive.filter(node=>!node.hasAttribute('inert')||
              node.getAttribute('aria-hidden')!=='true').map(node=>node.id),
            routeFocus:focus.length,
            routeFocusSensitive:focus[0]?.matches('[data-sensitive]')||false,
            focused:document.activeElement?.id||'',
            expectedFocus:focus[0]?.id||'',
            unlabeled,hiddenTabbables,targetRects,
            screenOverflow:screen.scrollWidth-screen.clientWidth,
            documentOverflow:document.documentElement.scrollWidth-innerWidth,
          };
        }""", expected_id)
        undersized = [item for item in snapshot['targetRects']
                      if item['width'] < 43.5 or item['height'] < 43.5]
        check(snapshot['active'] == [expected_id] and not snapshot['inactiveBad'],
              f'#{route} 唯一激活，其他屏 inert + aria-hidden，得到 {snapshot}')
        check(snapshot['routeFocus'] == 1 and not snapshot['routeFocusSensitive'] and
              snapshot['focused'] == snapshot['expectedFocus'],
              f'#{route} 仅一个非敏感 data-route-focus 且确定聚焦，得到 {snapshot}')
        check(not snapshot['unlabeled'] and not snapshot['hiddenTabbables'],
              f'#{route} 字段均有标签且隐藏屏无 tabbable 泄漏，得到 {snapshot}')
        check(snapshot['screenOverflow'] <= 1 and snapshot['documentOverflow'] <= 1,
              f'#{route} 在 375×667 无横向溢出，得到 {snapshot}')
        check(not undersized, f'#{route} 可见交互目标至少 44×44，过小={undersized}')
        route_layout[route] = snapshot

        primary = primary_actions.get(route)
        if primary:
            input_results = []
            if route == 'seed-show':
                mobile_page.locator('#seed-show-ack').check()
                mobile_page.locator('#seed-show-reveal').click()
            visible_inputs = mobile_page.locator(
                f'#{expected_id} input:not([type="hidden"]), #{expected_id} textarea, #{expected_id} select')
            for index in range(visible_inputs.count()):
                field = visible_inputs.nth(index)
                if not field.is_visible() or field.is_disabled():
                    continue
                mobile_page.set_viewport_size({'width': 375, 'height': 420})
                field.focus()
                before = mobile_page.locator(primary).evaluate("""element => {
                  const rect=element.getBoundingClientRect();
                  const visualBottom=Math.min(innerHeight,visualViewport?.height||innerHeight);
                  return {top:rect.top,bottom:rect.bottom,visualBottom,
                    naturallyVisible:rect.top>=0&&rect.bottom<=visualBottom};
                }""")
                mobile_page.locator(primary).evaluate("""element => {
                  const screen=element.closest('.scr');
                  const rect=element.getBoundingClientRect();
                  const visualBottom=Math.min(innerHeight,visualViewport?.height||innerHeight);
                  if(rect.bottom>visualBottom){
                    screen.scrollTop=Math.min(screen.scrollHeight-screen.clientHeight,
                      screen.scrollTop+rect.bottom-visualBottom+16);
                  }
                }""")
                mobile_page.wait_for_function("""selector => {
                  const element=document.querySelector(selector);
                  const rect=element.getBoundingClientRect();
                  const visualBottom=Math.min(innerHeight,visualViewport?.height||innerHeight);
                  return rect.top>=-1&&rect.bottom<=visualBottom+1;
                }""", arg=primary)
                result = mobile_page.locator(primary).evaluate("""element => {
                  const rect=element.getBoundingClientRect();
                  const screen=element.closest('.scr');
                  const screenRect=screen.getBoundingClientRect();
                  const visualBottom=Math.min(innerHeight,visualViewport?.height||innerHeight);
                  return {id:element.id,top:rect.top,bottom:rect.bottom,
                    screenTop:screenRect.top,screenBottom:screenRect.bottom,
                    visualBottom,naturallyVisible:false,
                    scrollTop:screen.scrollTop,maxScroll:screen.scrollHeight-screen.clientHeight,
                    overflow:screen.scrollWidth-screen.clientWidth};
                }""")
                result['naturallyVisible'] = before['naturallyVisible']
                input_results.append(result)
                mobile_page.set_viewport_size({'width': 375, 'height': 667})
            check(input_results and all(item['top'] >= -1 and
                  item['bottom'] <= item['visualBottom']+1 and item['overflow'] <= 1 and
                  (item['naturallyVisible'] or item['scrollTop'] > 0)
                  for item in input_results),
                  f'#{route} 每个输入聚焦后主操作可在 375×420 键盘视口自然可见'
                  f'或由 screen scrollTop 明确滚入，得到 {input_results}')
    check(not mobile_errors, f'375×667 逐路由无 console/page 错误，得到 {mobile_errors}')

    print('\n== Task 8：所有 account 分支控件 44×44 目标清单 ==')
    measured_targets = []

    def record_targets(pg, state_name, control_ids):
        sizes = account_target_sizes(pg, control_ids)
        measured_targets.extend(item['id'] for item in sizes)
        check(all(item['exists'] and item['visible'] and
                  item['width'] >= 43.5 and item['height'] >= 43.5 for item in sizes),
              f'{state_name} 全部目标至少 44×44，得到 {sizes}')

    fresh_incomplete(mobile_page, 'auth')
    record_targets(mobile_page, 'Auth methods', [
        'auth-email', 'auth-phone', 'auth-google', 'auth-apple', 'auth-passkey',
        'auth-wallet', 'auth-import'])

    auth_target_context = browser.new_context(viewport={'width': 375, 'height': 667})
    auth_target_page = auth_target_context.new_page()
    auth_target_page.clock.install(time=115_000_000)
    auth_target_page.clock.pause_at(115_000_000)
    auth_target_page.goto(f'{URL}#auth', wait_until='networkidle')
    auth_target_page.locator('#auth-google').click()
    record_targets(auth_target_page, 'Auth simulated sign-in pending disabled methods', [
        'auth-email', 'auth-phone', 'auth-google', 'auth-apple', 'auth-passkey',
        'auth-wallet', 'auth-import'])
    auth_target_context.close()

    force_context = browser.new_context(viewport={'width': 375, 'height': 667})
    force_page = force_context.new_page()
    fresh_incomplete(force_page, 'splash', '?demo=splash-force-update')
    record_targets(force_page, 'Splash force-update', ['splash-update'])
    force_context.close()

    maintenance_context = browser.new_context(viewport={'width': 375, 'height': 667})
    maintenance_page = maintenance_context.new_page()
    fresh_incomplete(maintenance_page, 'splash', '?demo=splash-maintenance')
    record_targets(maintenance_page, 'Splash maintenance', ['splash-retry', 'splash-reset'])
    maintenance_context.close()

    otp_target_context = browser.new_context(viewport={'width': 375, 'height': 667})
    otp_target_page = otp_target_context.new_page()
    otp_target_page.clock.install(time=120_000_000)
    otp_target_page.clock.pause_at(120_000_000)
    otp_target_page.goto(f'{URL}#auth-otp', wait_until='networkidle')
    record_targets(otp_target_page, 'OTP initial disabled actions', [
        'otp-digit-1', 'otp-digit-2', 'otp-digit-3', 'otp-digit-4',
        'otp-digit-5', 'otp-digit-6', 'otp-verify', 'otp-resend'])
    otp_fill(otp_target_page, '246810')
    otp_target_page.clock.run_for(60_000)
    record_targets(otp_target_page, 'OTP enabled actions', ['otp-verify', 'otp-resend'])
    otp_fill(otp_target_page, '135790')
    for _ in range(5):
        otp_target_page.locator('#otp-verify').click()
    record_targets(otp_target_page, 'OTP locked disabled fields/actions', [
        'otp-digit-1', 'otp-digit-2', 'otp-digit-3', 'otp-digit-4',
        'otp-digit-5', 'otp-digit-6', 'otp-verify', 'otp-resend'])
    otp_target_context.close()

    wallet_target_context = browser.new_context(viewport={'width': 375, 'height': 667})
    wallet_target_page = wallet_target_context.new_page()
    wallet_target_page.clock.install(time=130_000_000)
    wallet_target_page.clock.pause_at(130_000_000)
    wallet_target_page.goto(f'{URL}#auth-wallet', wait_until='networkidle')
    record_targets(wallet_target_page, 'Wallet choices', [
        'wallet-option-demo', 'wallet-option-timeout', 'wallet-option-failure',
        'wallet-connect'])
    wallet_target_page.locator('#wallet-option-demo').check()
    record_targets(wallet_target_page, 'Wallet selected', ['wallet-connect'])
    wallet_target_page.locator('#wallet-connect').click()
    record_targets(wallet_target_page, 'Wallet waiting disabled choices/actions', [
        'wallet-option-demo', 'wallet-option-timeout', 'wallet-option-failure',
        'wallet-connect'])
    wallet_target_page.clock.run_for(500)
    record_targets(wallet_target_page, 'Wallet signature decision', [
        'wallet-sign-approve', 'wallet-sign-reject'])
    wallet_target_page.locator('#wallet-sign-reject').click()
    record_targets(wallet_target_page, 'Wallet rejected retry', ['wallet-connect-retry'])
    wallet_target_context.close()

    create_target_context = browser.new_context(viewport={'width': 375, 'height': 667})
    create_target_page = create_target_context.new_page()
    create_target_page.clock.install(time=140_000_000)
    create_target_page.clock.pause_at(140_000_000)
    create_target_page.goto(f'{URL}#wallet-create', wait_until='networkidle')
    record_targets(create_target_page, 'Wallet create idle', [
        'wallet-create-start', 'wallet-create-fail-demo'])
    create_target_page.locator('#wallet-create-fail-demo').click()
    record_targets(create_target_page, 'Wallet create pending disabled actions', [
        'wallet-create-start', 'wallet-create-fail-demo'])
    create_target_page.clock.run_for(700)
    record_targets(create_target_page, 'Wallet create retry', ['wallet-create-retry'])
    create_target_context.close()

    fresh_incomplete(mobile_page, 'wallet-backup')
    record_targets(mobile_page, 'Backup choices', [
        'backup-recovery-phrase', 'backup-cloud', 'backup-social', 'backup-not-now'])
    mobile_page.locator('#backup-cloud').click()
    record_targets(mobile_page, 'Backup simulated confirmation', [
        'backup-confirm-continue', 'backup-confirm-cancel'])
    mobile_page.locator('#backup-confirm-cancel').click()
    mobile_page.locator('#backup-social').click()
    record_targets(mobile_page, 'Backup social confirmation', [
        'backup-confirm-continue', 'backup-confirm-cancel'])
    mobile_page.locator('#backup-confirm-cancel').click()
    mobile_page.locator('#backup-not-now').click()
    record_targets(mobile_page, 'Backup destructive confirmation', [
        'backup-skip-confirm', 'backup-confirm-cancel'])

    fresh_incomplete(mobile_page, 'seed-show')
    record_targets(mobile_page, 'Phrase reveal initial', ['seed-show-ack', 'seed-show-reveal'])
    mobile_page.locator('#seed-show-ack').check()
    record_targets(mobile_page, 'Phrase reveal acknowledged', ['seed-show-ack', 'seed-show-reveal'])
    mobile_page.locator('#seed-show-reveal').click()
    record_targets(mobile_page, 'Phrase reveal recorded gate', [
        'seed-show-recorded', 'seed-show-continue'])
    mobile_page.locator('#seed-show-recorded').check()
    record_targets(mobile_page, 'Phrase reveal continue enabled', [
        'seed-show-recorded', 'seed-show-continue'])

    fresh_incomplete(mobile_page, 'seed-verify')
    record_targets(mobile_page, 'Phrase verification initial disabled submit', [
        'seed-verify-3', 'seed-verify-7', 'seed-verify-11', 'seed-verify-submit'])
    for field_id in ('seed-verify-3', 'seed-verify-7', 'seed-verify-11'):
        mobile_page.locator(f'#{field_id}').fill('wrong')
    record_targets(mobile_page, 'Phrase verification enabled submit', [
        'seed-verify-3', 'seed-verify-7', 'seed-verify-11', 'seed-verify-submit'])
    for attempt in range(5):
        mobile_page.locator('#seed-verify-submit').click()
        if attempt < 4:
            for field_id in ('seed-verify-3', 'seed-verify-7', 'seed-verify-11'):
                mobile_page.locator(f'#{field_id}').fill('wrong')
    record_targets(mobile_page, 'Phrase verification locked disabled controls', [
        'seed-verify-3', 'seed-verify-7', 'seed-verify-11', 'seed-verify-submit'])

    import_target_context = browser.new_context(viewport={'width': 375, 'height': 667})
    import_target_page = import_target_context.new_page()
    import_target_page.clock.install(time=145_000_000)
    import_target_page.clock.pause_at(145_000_000)
    import_target_page.goto(f'{URL}#wallet-import', wait_until='networkidle')
    import_fixtures = {
        'phrase': TASK7_PHRASE, 'private': TASK7_PRIVATE_KEY, 'watch': TASK7_EVM_ADDRESS,
    }
    for mode, secret in import_fixtures.items():
        import_target_page.locator(f'#wallet-import-mode-{mode}').check()
        record_targets(import_target_page, f'Wallet import {mode} ready', [
            'wallet-import-mode-phrase', 'wallet-import-mode-private',
            'wallet-import-mode-watch', 'wallet-import-value', 'wallet-import-submit'])
        import_target_page.locator('#wallet-import-value').fill(secret)
        import_target_page.locator('#wallet-import-submit').click()
        record_targets(import_target_page, f'Wallet import {mode} loading disabled', [
            'wallet-import-mode-phrase', 'wallet-import-mode-private',
            'wallet-import-mode-watch', 'wallet-import-value', 'wallet-import-submit'])
        import_target_page.evaluate('clearSensitiveAccountState()')
        import_target_page.evaluate("setupWalletImport()")
    import_target_context.close()

    inventory_probe = mobile_page.evaluate("""() => {
      const selector='.account-screen a[href],.account-screen button,'+
        '.account-screen input,.account-screen textarea,.account-screen select,'+
        '.account-screen [role="button"]';
      const controls=[...document.querySelectorAll(selector)];
      const ids=controls.map(control=>control.id);
      const counts=ids.reduce((result,id)=>{
        if(id) result[id]=(result[id]||0)+1;
        return result;
      },{});
      return {ids:ids.filter(Boolean).sort(),idless:controls.filter(control=>!control.id)
        .map(control=>control.outerHTML.slice(0,160)),
        duplicates:Object.entries(counts).filter(([,count])=>count!==1)};
    }""")
    check(len(ACCOUNT_INTERACTIVE_IDS) == 48 and
          len(set(ACCOUNT_INTERACTIVE_IDS)) == 48,
          f'权威 account interactive ID 清单精确 48 且无重复，'
          f'count={len(ACCOUNT_INTERACTIVE_IDS)}')
    check(not inventory_probe['idless'] and not inventory_probe['duplicates'] and
          inventory_probe['ids'] == sorted(ACCOUNT_INTERACTIVE_IDS),
          f'DOM account interactive controls 无缺失/重复/id-less，得到 {inventory_probe}')
    check(set(measured_targets) == set(ACCOUNT_INTERACTIVE_IDS),
          f'44px 状态清单覆盖权威 48 个 account controls，'
          f'measured={sorted(set(measured_targets))}')

    print('\n== Task 8：精确 ROUTES parent metadata 与 Back fallback ==')
    fresh_incomplete(mobile_page, 'auth')
    route_metadata = mobile_page.evaluate("""() => Object.fromEntries(
      Object.entries(ROUTES).filter(([,route])=>route.account).map(([name,route])=>[name,{
        screen:route.screen,stack:route.stack,parent:route.parent ?? null,
        hasParent:Object.prototype.hasOwnProperty.call(route,'parent'),
        defaultParent:route.defaultParent ?? null,
        hasDefaultParent:Object.prototype.hasOwnProperty.call(route,'defaultParent'),
        account:route.account===true,sensitive:route.sensitive===true,
      }]))""")
    expected_route_metadata = {
        'splash': {'screen': 'scr-splash', 'stack': ['scr-splash'], 'parent': None,
                   'hasParent': True, 'defaultParent': None, 'hasDefaultParent': False,
                   'account': True, 'sensitive': False},
        'auth': {'screen': 'scr-auth', 'stack': ['scr-auth'], 'parent': 'splash',
                 'hasParent': True, 'defaultParent': None, 'hasDefaultParent': False,
                 'account': True, 'sensitive': False},
        'auth-otp': {'screen': 'scr-auth-otp', 'stack': ['scr-auth', 'scr-auth-otp'],
                     'parent': None, 'hasParent': False, 'defaultParent': 'auth',
                     'hasDefaultParent': True, 'account': True, 'sensitive': True},
        'auth-wallet': {'screen': 'scr-auth-wallet', 'stack': ['scr-auth', 'scr-auth-wallet'],
                        'parent': 'auth', 'hasParent': True, 'defaultParent': None,
                        'hasDefaultParent': False, 'account': True, 'sensitive': False},
        'wallet-create': {'screen': 'scr-wallet-create', 'stack': ['scr-auth', 'scr-wallet-create'],
                          'parent': None, 'hasParent': False, 'defaultParent': 'auth',
                          'hasDefaultParent': True, 'account': True, 'sensitive': False},
        'wallet-backup': {'screen': 'scr-wallet-backup',
                          'stack': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup'],
                          'parent': 'wallet-create', 'hasParent': True, 'defaultParent': None,
                          'hasDefaultParent': False, 'account': True, 'sensitive': False},
        'seed-show': {'screen': 'scr-seed-show',
                      'stack': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup', 'scr-seed-show'],
                      'parent': 'wallet-backup', 'hasParent': True, 'defaultParent': None,
                      'hasDefaultParent': False, 'account': True, 'sensitive': True},
        'seed-verify': {'screen': 'scr-seed-verify',
                        'stack': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup',
                                  'scr-seed-show', 'scr-seed-verify'],
                        'parent': 'seed-show', 'hasParent': True, 'defaultParent': None,
                        'hasDefaultParent': False, 'account': True, 'sensitive': True},
        'wallet-import': {'screen': 'scr-wallet-import', 'stack': ['scr-auth', 'scr-wallet-import'],
                          'parent': 'auth', 'hasParent': True, 'defaultParent': None,
                          'hasDefaultParent': False, 'account': True, 'sensitive': True},
    }
    check(route_metadata == expected_route_metadata,
          f'九条 account ROUTES metadata 与计划逐字段一致，得到 {route_metadata}')

    print('\n== Task 8：Navigation API 不可用时 proof fail-closed ==')
    no_nav_context = browser.new_context(viewport={'width': 375, 'height': 667})
    no_nav_context.add_init_script("""(() => {
      try{Object.defineProperty(globalThis,'navigation',{
        configurable:true,writable:true,value:undefined});}catch(error){}
      window.__task8NoNavigation=globalThis.navigation===undefined;
    })()""")
    no_nav_page = no_nav_context.new_page()
    fresh_incomplete(no_nav_page, 'auth')
    no_nav_page.locator('#auth-import').click()
    unsupported_push = no_nav_page.evaluate("""() => {
      const first={supported:!window.__task8NoNavigation,
        helper:hasValidAccountHistoryProvenance(),
        entryId:history.state?.accountEntryId??null};
      const copied=history.state?.accountEntryId||'copied-opaque-entry-id';
      history.pushState({...history.state,accountPushed:true,accountEntryId:copied},'',location.href);
      const replay={helper:hasValidAccountHistoryProvenance(),entryId:history.state.accountEntryId};
      window.__unsupportedPopped=false;
      addEventListener('popstate',()=>{window.__unsupportedPopped=true},{once:true});
      back();
      return {first,replay,after:{hash:location.hash,stack:history.state?.stack,
        popped:window.__unsupportedPopped}};
    }""")
    check(unsupported_push == {
        'first': {'supported': False, 'helper': False, 'entryId': None},
        'replay': {'helper': False, 'entryId': 'copied-opaque-entry-id'},
        'after': {'hash': '#auth', 'stack': ['scr-auth'], 'popped': False},
    }, f'Navigation key 缺失时 legitimate push 与 copied-token replay 均 fail-closed，'
       f'in-app Back 使用 parent replace，得到 {unsupported_push}')

    no_nav_parents = {
        'splash': 'splash', 'auth': 'splash', 'auth-otp': 'auth',
        'auth-wallet': 'auth', 'wallet-create': 'auth',
        'wallet-backup': 'wallet-create', 'seed-show': 'wallet-backup',
        'seed-verify': 'seed-show', 'wallet-import': 'auth',
    }
    no_nav_fallbacks = {}
    for route, parent in no_nav_parents.items():
        fresh_incomplete(no_nav_page, route)
        no_nav_fallbacks[route] = no_nav_page.evaluate("""() => {
          history.replaceState({...history.state,accountPushed:true,
            accountEntryId:'forged-canonical-proof'},'',location.href);
          const helper=hasValidAccountHistoryProvenance();
          window.__noNavRoutePopped=false;
          addEventListener('popstate',()=>{window.__noNavRoutePopped=true},{once:true});
          back();
          return {helper,hash:location.hash,popped:window.__noNavRoutePopped};
        }""")
    check(all(value == {'helper': False, 'hash': f'#{no_nav_parents[route]}', 'popped': False}
              for route, value in no_nav_fallbacks.items()),
          f'九条 account route 在 Navigation API 缺失时均按声明 parent '
          f'fail-safe 且不 pop，得到 {no_nav_fallbacks}')

    no_nav_panels = {}
    for name, selector in (('cloud', '#backup-cloud'), ('social', '#backup-social'),
                           ('skip', '#backup-not-now')):
        fresh_incomplete(no_nav_page, 'wallet-backup')
        no_nav_page.locator(selector).click()
        no_nav_panels[name] = no_nav_page.evaluate("""() => {
          const before={helper:hasValidBackupPanelHistoryProvenance(),
            panel:history.state?.backupPanel??null,
            entryId:history.state?.accountEntryId??null,
            confirmation:!document.getElementById('backup-confirmation').hidden};
          window.__noNavPanelPopped=false;
          addEventListener('popstate',()=>{window.__noNavPanelPopped=true},{once:true});
          back();
          return {before,after:{hash:location.hash,
            choices:!document.getElementById('backup-choice-view').hidden,
            confirmation:!document.getElementById('backup-confirmation').hidden,
            popped:window.__noNavPanelPopped}};
        }""")
    check(all(value == {
        'before': {'helper': False, 'panel': None, 'entryId': None, 'confirmation': True},
        'after': {'hash': '#wallet-backup', 'choices': True,
                  'confirmation': False, 'popped': False},
    } for value in no_nav_panels.values()),
          f'cloud/social/skip same-hash panel 无 stable key 时不造历史陷阱，'
          f'Back 回 choices，得到 {no_nav_panels}')
    no_nav_context.close()

    print('\n== Task 8：proof 有界、裁剪与 lifecycle invalidation ==')
    proof_source = APP_JS.read_text(encoding='utf-8')
    check('const MAX_ACCOUNT_HISTORY_PROOFS=32;' in proof_source,
          'proof hard cap 精确为 32，且不超过可访问 history budget')
    cap_context = browser.new_context(viewport={'width': 375, 'height': 667})
    cap_page = cap_context.new_page()
    fresh_incomplete(cap_page, 'auth')
    cap_setup = cap_page.evaluate("""() => {
      push('scr-wallet-import');
      const oldest={...history.state};
      for(let index=0;index<40;index+=1){
        push(index%2===0 ? 'scr-wallet-create' : 'scr-wallet-import');
      }
      navigate(ROUTES.auth.stack.slice(),{replace:false});
      push('scr-wallet-import');
      return {oldestId:oldest.accountEntryId,recent:hasValidAccountHistoryProvenance(),
        recentId:history.state.accountEntryId,delta:42};
    }""")
    cap_page.evaluate("delta => history.go(-delta)", cap_setup['delta'])
    cap_page.wait_for_function("oldest => history.state?.accountEntryId===oldest",
                               arg=cap_setup['oldestId'])
    oldest_after_cap = cap_page.evaluate("hasValidAccountHistoryProvenance()")
    cap_page.evaluate("""() => {
      window.__prunedProofPopped=false;
      addEventListener('popstate',()=>{window.__prunedProofPopped=true},{once:true});
      back();
    }""")
    pruned_fallback = cap_page.evaluate("""() => ({
      hash:location.hash,stack:history.state?.stack,popped:window.__prunedProofPopped,
    })""")
    check(cap_setup['recent'] is True and isinstance(cap_setup['recentId'], str) and
          oldest_after_cap is False and pruned_fallback == {
              'hash': '#auth', 'stack': ['scr-auth'], 'popped': False},
          f'>32 proofs 后最新可用、最早已裁剪（仅通过行为观察），'
          f'裁剪后 Back 安全 fallback，setup={cap_setup} '
          f'oldestValid={oldest_after_cap} fallback={pruned_fallback}')
    cap_context.close()

    for lifecycle in ('complete', 'restart', 'pagehide', 'unload'):
        context = browser.new_context(viewport={'width': 375, 'height': 667})
        pg = context.new_page()
        fresh_incomplete(pg, 'auth')
        pg.locator('#auth-import').click()
        lifecycle_result = pg.evaluate("""lifecycle => {
          const issued={...history.state};
          const before=hasValidAccountHistoryProvenance();
          if(lifecycle==='complete') completeOnboarding();
          else if(lifecycle==='restart') restartOnboarding();
          else if(lifecycle==='pagehide') dispatchEvent(
            new PageTransitionEvent('pagehide',{persisted:false}));
          else dispatchEvent(new Event('unload'));
          if(lifecycle==='complete'||lifecycle==='restart'){
            setOnboardingFlag('complete',false);
            navigate(ROUTES['wallet-import'].stack.slice(),{replace:true});
            history.replaceState({...history.state,accountPushed:true,
              accountEntryId:issued.accountEntryId},'','#wallet-import');
          }
          return {before,after:hasValidAccountHistoryProvenance()};
        }""", lifecycle)
        check(lifecycle_result == {'before': True, 'after': False},
              f'{lifecycle} 清空 closure proof，旧 token 在同 entry/route 也不可重放，'
              f'得到 {lifecycle_result}')
        context.close()

    fallback_context = browser.new_context(viewport={'width': 375, 'height': 667})
    fallback_page = fallback_context.new_page()
    fresh_incomplete(fallback_page, 'wallet-import')
    malformed_provenance = fallback_page.evaluate("""() => {
      navigate(['scr-home','scr-wallet-import'],{replace:true});
      history.replaceState({...history.state,accountPushed:true},'',location.href);
      const helper=typeof hasValidAccountHistoryProvenance==='function'
        ? hasValidAccountHistoryProvenance() : null;
      back();
      return {helper,hash:location.hash,stack:history.state?.stack,
        active:[...document.querySelectorAll('.scr.active:not([inert])')].map(el=>el.id)};
    }""")
    check(malformed_provenance == {'helper': False, 'hash': '#auth', 'stack': ['scr-auth'],
                                   'active': ['scr-auth']},
          f'伪造 accountPushed + malformed live stack 被拒绝并按 parent metadata fallback，'
          f'得到 {malformed_provenance}')
    fallback_context.close()

    canonical_context = browser.new_context(viewport={'width': 375, 'height': 667})
    canonical_page = canonical_context.new_page()
    fresh_incomplete(canonical_page, 'wallet-import')
    canonical_before = canonical_page.evaluate("""() => {
      history.replaceState({...history.state,accountPushed:true},'',location.href);
      return {
        helper:typeof hasValidAccountHistoryProvenance==='function'
          ? hasValidAccountHistoryProvenance() : null,
        stack:history.state.stack,entryId:history.state.accountEntryId ?? null,
      };
    }""")
    canonical_page.evaluate("""() => {
      window.__canonicalForgePopped=false;
      addEventListener('popstate',()=>{window.__canonicalForgePopped=true},{once:true});
      back();
    }""")
    canonical_page.wait_for_function("""() =>
      location.hash === '#auth' || window.__canonicalForgePopped === true""")
    canonical_after = canonical_page.evaluate("""() => ({
      hash:location.hash,stack:history.state?.stack,popped:window.__canonicalForgePopped,
    })""")
    check(canonical_before == {
        'helper': False, 'stack': ['scr-auth', 'scr-wallet-import'], 'entryId': None,
    } and canonical_after == {
        'hash': '#auth', 'stack': ['scr-auth'], 'popped': False,
    }, f'canonical stack + accountPushed 无 app-issued proof 时被拒绝并 fallback，'
       f'before={canonical_before} after={canonical_after}')
    canonical_context.close()

    mismatch_context = browser.new_context(viewport={'width': 375, 'height': 667})
    mismatch_page = mismatch_context.new_page()
    fresh_incomplete(mismatch_page, 'auth')
    mismatch_page.locator('#auth-import').click()
    mismatch_before = mismatch_page.evaluate("""() => ({
      helper:hasValidAccountHistoryProvenance(),
      entryId:history.state.accountEntryId ?? null,
      inSession:sessionStorage.getItem('loop.proto.state')?.includes(
        history.state.accountEntryId ?? '__missing__') ?? false,
      inLocal:[...Array(localStorage.length)].some((_,index)=>
        (localStorage.getItem(localStorage.key(index))||'').includes(
          history.state.accountEntryId ?? '__missing__')),
      exposed:Object.prototype.hasOwnProperty.call(window,'accountHistoryProof'),
    })""")
    mismatch_state = mismatch_page.evaluate("""() => {
      const entryId=history.state.accountEntryId;
      navigate(ROUTES['seed-show'].stack.slice(),{replace:true});
      history.replaceState({...history.state,accountPushed:true,accountEntryId:entryId},
        '','#seed-show');
      return {helper:hasValidAccountHistoryProvenance(),entryId};
    }""")
    mismatch_page.evaluate("""() => {
      window.__routeReplayPopped=false;
      addEventListener('popstate',()=>{window.__routeReplayPopped=true},{once:true});
      back();
    }""")
    mismatch_page.wait_for_function("""() =>
      location.hash !== '#seed-show' || window.__routeReplayPopped === true""")
    mismatch_after = mismatch_page.evaluate("""() => ({
      hash:location.hash,stack:history.state?.stack,popped:window.__routeReplayPopped,
    })""")
    check(mismatch_before['helper'] is True and
          isinstance(mismatch_before['entryId'], str) and mismatch_before['entryId'] and
          not mismatch_before['inSession'] and not mismatch_before['inLocal'] and
          mismatch_before['exposed'] is False and
          mismatch_state['entryId'] == mismatch_before['entryId'] and
          mismatch_state['helper'] is False and mismatch_after == {
              'hash': '#wallet-backup',
              'stack': ['scr-auth', 'scr-wallet-create', 'scr-wallet-backup'],
              'popped': False,
          }, f'issued proof 不能重放到不同 route/stack 且不进入 storage/global，'
             f'before={mismatch_before} replay={mismatch_state} after={mismatch_after}')
    mismatch_context.close()

    entry_replay_context = browser.new_context(viewport={'width': 375, 'height': 667})
    entry_replay_page = entry_replay_context.new_page()
    fresh_incomplete(entry_replay_page, 'auth')
    entry_replay_page.locator('#auth-import').click()
    entry_replay = entry_replay_page.evaluate("""() => {
      const originalKey=globalThis.navigation?.currentEntry?.key ?? '';
      const originalId=history.state.accountEntryId ?? null;
      history.pushState({...history.state},'',location.href);
      return {
        supported:Boolean(originalKey&&globalThis.navigation?.currentEntry?.key),
        keyChanged:originalKey !== (globalThis.navigation?.currentEntry?.key ?? ''),
        idReplayed:history.state.accountEntryId === originalId,
        helper:hasValidAccountHistoryProvenance(),entryId:originalId,
      };
    }""")
    entry_replay_page.evaluate("""() => {
      window.__entryReplayPopped=false;
      addEventListener('popstate',()=>{window.__entryReplayPopped=true},{once:true});
      back();
    }""")
    entry_replay_page.wait_for_function("""() =>
      location.hash === '#auth' || window.__entryReplayPopped === true""")
    entry_replay_after = entry_replay_page.evaluate("""() => ({
      hash:location.hash,stack:history.state?.stack,popped:window.__entryReplayPopped,
    })""")
    check(entry_replay['supported'] and entry_replay['keyChanged'] and
          entry_replay['idReplayed'] and isinstance(entry_replay['entryId'], str) and
          entry_replay['helper'] is False and entry_replay_after == {
              'hash': '#auth', 'stack': ['scr-auth'], 'popped': False,
          }, f'issued proof 不能重放到不同 browser entry，'
             f'replay={entry_replay} after={entry_replay_after}')
    entry_replay_context.close()

    for branch, trigger, expected_parent in (
            ('OTP', "document.getElementById('auth-email').click()", 'auth-otp'),
            ('social', "document.getElementById('auth-google').click()", 'auth')):
        context = browser.new_context(viewport={'width': 375, 'height': 667})
        pg = context.new_page()
        pg.clock.install(time=150_000_000)
        pg.clock.pause_at(150_000_000)
        pg.goto(f'{URL}#auth', wait_until='networkidle')
        pg.evaluate(trigger)
        if branch == 'OTP':
            otp_fill(pg, '246810')
            pg.locator('#otp-verify').click()
        else:
            pg.clock.run_for(450)
        valid_before = pg.evaluate("""() => ({
          helper:typeof hasValidAccountHistoryProvenance==='function'
            ? hasValidAccountHistoryProvenance() : null,
          hash:location.hash,stack:history.state?.stack})""")
        pg.evaluate('back()')
        pg.wait_for_function("parent => location.hash === `#${parent}`", arg=expected_parent)
        after = pg.evaluate("() => ({hash:location.hash,stack:history.state?.stack})")
        check(valid_before['helper'] is True and after['hash'] == f'#{expected_parent}',
              f'{branch} branch 使用有效 browser-history provenance 返回 {expected_parent}，'
              f'before={valid_before} after={after}')
        context.close()

    for branch, start_route, trigger, child_route, parent_route in (
            ('seed', 'wallet-backup', '#backup-recovery-phrase', 'seed-show', 'wallet-backup'),
            ('import', 'auth', '#auth-import', 'wallet-import', 'auth')):
        context = browser.new_context(viewport={'width': 375, 'height': 667})
        pg = context.new_page()
        fresh_incomplete(pg, start_route)
        pg.locator(trigger).click()
        issued = pg.evaluate("""() => ({
          helper:hasValidAccountHistoryProvenance(),
          entryId:history.state.accountEntryId ?? null,
        })""")
        pg.evaluate('history.back()')
        pg.wait_for_function("parent => location.hash === `#${parent}`", arg=parent_route)
        pg.evaluate('history.forward()')
        pg.wait_for_function("child => location.hash === `#${child}`", arg=child_route)
        forward = pg.evaluate("""() => ({
          helper:hasValidAccountHistoryProvenance(),
          entryId:history.state.accountEntryId ?? null,
        })""")
        pg.evaluate('back()')
        pg.wait_for_function("parent => location.hash === `#${parent}`", arg=parent_route)
        final = pg.evaluate("() => ({hash:location.hash,stack:history.state?.stack})")
        check(issued['helper'] is True and isinstance(issued['entryId'], str) and
              forward == issued and final['hash'] == f'#{parent_route}',
              f'{branch} branch proof 支持 browser Back/Forward 与 in-app Back，'
              f'issued={issued} forward={forward} final={final}')
        context.close()

    bfcache_proof_context = browser.new_context(viewport={'width': 375, 'height': 667})
    bfcache_proof_page = bfcache_proof_context.new_page()
    fresh_incomplete(bfcache_proof_page, 'auth')
    bfcache_proof_page.locator('#auth-email').click()
    otp_fill(bfcache_proof_page, '246810')
    bfcache_proof_page.locator('#otp-verify').click()
    bfcache_proof = bfcache_proof_page.evaluate("""() => {
      const before={helper:hasValidAccountHistoryProvenance(),
        entryId:history.state.accountEntryId ?? null};
      dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
      dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
      return {before,after:{helper:hasValidAccountHistoryProvenance(),
        entryId:history.state.accountEntryId ?? null}};
    }""")
    bfcache_proof_page.evaluate('back()')
    bfcache_proof_page.wait_for_function("location.hash === '#auth-otp'")
    bfcache_after = bfcache_proof_page.evaluate("() => ({hash:location.hash,stack:history.state.stack})")
    check(bfcache_proof['before']['helper'] is True and
          isinstance(bfcache_proof['before']['entryId'], str) and
          bfcache_proof['after'] == bfcache_proof['before'] and
          bfcache_after['hash'] == '#auth-otp',
          f'BFCache 保留 closure-issued proof 并正常 Back，proof={bfcache_proof} '
          f'after={bfcache_after}')
    bfcache_proof_context.close()

    print('\n== Task 8：错误字段编程关联 ==')
    fresh_incomplete(mobile_page, 'auth-otp')
    otp_enter(mobile_page, '111111')
    otp_error_links = mobile_page.evaluate(r"""() => ({
      text:document.getElementById('otp-status').textContent,
      fields:[...document.querySelectorAll('.otp-inputs input')].map(input=>({
        invalid:input.getAttribute('aria-invalid'),
        described:(input.getAttribute('aria-describedby')||'').split(/\s+/),
      })),
    })""")
    check('Invalid code' in otp_error_links['text'] and
          all(item['invalid'] == 'true' and 'otp-status' in item['described']
              for item in otp_error_links['fields']),
          f'OTP inline error 与六个字段关联，得到 {otp_error_links}')

    fresh_incomplete(mobile_page, 'seed-verify')
    for field_id in ('seed-verify-3', 'seed-verify-7', 'seed-verify-11'):
        mobile_page.locator(f'#{field_id}').fill('wrong')
    mobile_page.locator('#seed-verify-submit').click()
    seed_error_links = mobile_page.evaluate(r"""() => [...document.querySelectorAll(
      '#scr-seed-verify input[aria-invalid="true"]')].map(input=>({
        id:input.id,described:(input.getAttribute('aria-describedby')||'').split(/\s+/)}))""")
    check(len(seed_error_links) == 3 and
          all('seed-verify-field-error' in item['described'] for item in seed_error_links),
          f'phrase verification inline error 与错误字段关联，得到 {seed_error_links}')

    fresh_incomplete(mobile_page, 'wallet-import')
    mobile_page.locator('#wallet-import-value').fill('too short')
    mobile_page.locator('#wallet-import-submit').click()
    mobile_page.wait_for_function("""() => {
      const field=document.getElementById('wallet-import-value');
      const status=document.getElementById('wallet-import-status');
      return field?.getAttribute('aria-invalid')==='true'&&
        status?.textContent.includes('exactly 12');
    }""")
    import_error_link = mobile_page.evaluate(r"""() => ({
      invalid:document.getElementById('wallet-import-value').getAttribute('aria-invalid'),
      described:(document.getElementById('wallet-import-value').getAttribute('aria-describedby')||'').split(/\s+/),
      text:document.getElementById('wallet-import-status').textContent,
    })""")
    check(import_error_link['invalid'] == 'true' and
          'wallet-import-status' in import_error_link['described'] and
          'exactly 12' in import_error_link['text'],
          f'import inline error 与当前字段关联，得到 {import_error_link}')
    mobile_context.close()

    print('\n== Task 8：reduced-motion 与 CSS 可用性契约 ==')
    reduced_context = browser.new_context(
        viewport={'width': 375, 'height': 667}, reduced_motion='reduce')
    reduced_page = reduced_context.new_page()
    reduced_errors = []
    attach_errors(reduced_page, reduced_errors)
    fresh_incomplete(reduced_page, 'splash')
    reduced = reduced_page.evaluate("""() => {
      const screen=document.getElementById('scr-splash');
      const spinner=document.querySelector('#scr-splash .account-progress > span:first-child');
      const screenStyle=getComputedStyle(screen);
      const spinnerStyle=getComputedStyle(spinner);
      return {screenAnimation:screenStyle.animationDuration,
        screenTransition:screenStyle.transitionDuration,
        spinnerAnimation:spinnerStyle.animationDuration,
        spinnerTransition:spinnerStyle.transitionDuration,
        scrollBehavior:screenStyle.scrollBehavior};
    }""")
    zero_times = {'0s', '0ms'}
    check(all(part.strip() in zero_times
              for value in (reduced['screenAnimation'], reduced['screenTransition'],
                            reduced['spinnerAnimation'], reduced['spinnerTransition'])
              for part in value.split(',')) and reduced['scrollBehavior'] == 'auto' and
          not reduced_errors,
          f'prefers-reduced-motion 下 account 动画/过渡为零，得到 {reduced} errors={reduced_errors}')
    reduced_context.close()

    css_source = (APP.parent / 'src' / 'style.css').read_text(encoding='utf-8')
    css_compact = re.sub(r'\s+', '', css_source)
    exact_reduced_rule = ('@media(prefers-reduced-motion:reduce){.account-screen*,'
                          '.account-screen{animation:none!important;transition:none!important;'
                          'scroll-behavior:auto!important}}')
    check(exact_reduced_rule in css_compact,
          'CSS 包含计划指定的 exact reduced-motion rule')
    check('env(safe-area-inset-top)' in css_source and
          'env(safe-area-inset-bottom)' in css_source and
          re.search(r'account-(?:screen|shell)[^{]*\{[^}]*env\(safe-area-inset-',
                    css_source, re.S),
          'account mobile 布局显式使用顶部/底部 safe-area padding')
    check('scroll-margin-bottom' in css_source,
          '账号字段与操作具备 scroll-margin-bottom 键盘避让')

    print('\n== 无 JS 错误 ==')
    check(not errors, f'console/page 错误: {errors[:8]}')
    browser.close()

print('\n' + ('账号边界全部通过' if not fails else f'{len(fails)} 项失败:'))
for failure in fails:
    print(' -', failure)
sys.exit(1 if fails else 0)
