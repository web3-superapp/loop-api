#!/usr/bin/env python3
"""验证 src/ 拆分后 app.html 的路由与关键交互没坏。"""
import pathlib
import sys
from playwright.sync_api import sync_playwright
from platform_policy_test_app import production_policy_test_app

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / 'app.html'
URL = APP.as_uri()
PRODUCTION_SCRIPTS = [
    'vendor/qrcode-generator-1.4.4.js', 'wallet-provider.js',
    'wallet-review.js', 'wallet-transfer.js', 'stream-chat-provider.js',
    'platform-provider.js', 'platform-offline-fixture.js',
    'perp-read-provider.js', 'perp-offline-fixture.js',
    'perp-account-provider.js', 'perp-account-offline-fixture.js',
    'app.js',
]

HASHES = ['splash', 'auth', 'auth-otp', 'auth-wallet', 'wallet-create',
          'wallet-backup', 'seed-show', 'seed-verify', 'wallet-import',
          'home', 'pay', 'market', 'token', 'launchpad', 'chat',
          'group', 'voiceroom', 'dm', 'wallet', 'asset', 'send', 'send-to',
          'send-confirm', 'receive', 'tx-result', 'swap', 'dapp', 'profile']

fails = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


def fresh(pg, h):
    """硬加载到某个 hash —— 同文档 hash 跳转不会重置定时器，测试需要干净起点。"""
    pg.goto('about:blank')
    pg.goto(f'{URL}#{h}')
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(260)


manifest = (ROOT / 'src/scripts-order.txt').read_text().splitlines()
generated = APP.read_text()
check(manifest == PRODUCTION_SCRIPTS,
      f'生产脚本为精确十二项顺序: {manifest}')
check(generated.count(
    '/* ============ SCRIPT: stream-chat-provider.js ============ */') == 1,
      '生成物恰好包含一次 Stream 生产适配器')
check('StreamChatOfflineFixture' not in generated and
      'Offline fixture — Stream credentials not connected' not in generated,
      '测试专用 Stream 离线 fixture 未进入生产生成物')

URL = production_policy_test_app(ROOT).as_uri()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))

    print('== 深链路由 ==')
    for h in HASHES:
        fresh(pg, h)
        # 激活屏以 .active 类 + 无 inert 为准。
        # 不要用 computed opacity 判断：弹层过渡期间底层屏的 opacity 是中间值，会误判。
        active = pg.evaluate("""() => [...document.querySelectorAll('.scr')]
          .filter(s => s.classList.contains('active') && !s.hasAttribute('inert'))
          .map(s => s.id)""")
        check(len(active) == 1, f'#{h} → 恰好一屏激活，得到 {active}')
        inactive_bad = pg.evaluate("""() => [...document.querySelectorAll('.scr:not(.active)')]
          .filter(s => !s.hasAttribute('inert') || s.getAttribute('aria-hidden') !== 'true')
          .map(s => s.id)""")
        check(not inactive_bad,
              f'#{h} → 非活动屏均 inert + aria-hidden，例外 {inactive_bad}')

    print('\n== 无 JS 错误 ==')
    check(not errs, f'console/page 错误: {errs[:4]}')

    print('\n== Tab 切换 ==')
    fresh(pg, 'home')
    for tab in ['market', 'launchpad', 'chat', 'wallet', 'profile', 'home']:
        pg.click(f'.tab[data-tab="{tab}"]')
        pg.wait_for_timeout(200)
        hs = pg.evaluate('location.hash')
        on = pg.evaluate("() => document.querySelector('.tab.on')?.dataset.tab")
        check(hs == f'#{tab}' and on == tab,
              f'点 {tab} tab → hash={hs} 高亮={on}')

    print('\n== 闭环：群聊 Token 卡 → Buy → Swap review → provider pending ==')
    fresh(pg, 'group')
    check(pg.locator('.tok-card').count() >= 1, '群聊里有 Token 识别卡')
    check(pg.locator('.risk-strip').count() >= 1, '群聊里有高风险拦截条')
    pg.click('.tc-buy')
    pg.wait_for_timeout(300)
    check(pg.evaluate('location.hash') == '#swap', 'Token 卡 Buy → Swap')
    pg.click('.swap-cta')
    pg.wait_for_timeout(80)
    review = pg.evaluate("""() => ({
      open:document.getElementById('review-dialog').classList.contains('open'),
      id:history.state?.review_id||'',state:
        document.getElementById('review-dialog').dataset.state,
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''
    })""")
    check(review == {'open': True, 'id': 'review-swap-fresh',
                     'state': 'ready', 'glyph': ''},
          f'Swap 先进入统一 F11 且 holdings 不变：{review}')
    pg.click('#review-continue')
    pg.wait_for_timeout(160)
    pending = pg.evaluate("""() => ({
      open:document.getElementById('review-dialog').classList.contains('open'),
      banner:document.getElementById('review-provider-banner').textContent,
      state:document.getElementById('review-provider-banner').dataset.state,
      successNode:Boolean(document.getElementById('success')),
      glyph:document.querySelector('[data-asset="GLYPH"]')?.textContent||''
    })""")
    check(pending == {'open': False, 'banner': 'Simulated Privy handoff pending',
                      'state': 'provider_pending', 'successNode': False, 'glyph': ''},
          f'Swap 仅停在 provider pending 且 holdings 不变：{pending}')

    print('\n== Stream Video 离线投影与写入门禁 ==')
    fresh(pg, 'voiceroom')
    pg.wait_for_timeout(200)
    check(pg.locator('#voiceRoomCard').is_visible(), '语音房卡片可见（群聊内嵌）')
    voice_gate = pg.evaluate("""() => {
      const join=document.getElementById('vrJoinBtn');
      const before=JSON.stringify(history.state);
      const result=streamMutationPending('join_audio_room');
      return {disabled:join.disabled,aria:join.getAttribute('aria-disabled'),before,
        after:JSON.stringify(history.state),hasVoice:typeof voice!=='undefined',
        stored:sessionStorage.getItem('loop.proto.state'),result,inCall:inCall()};
    }""")
    check(voice_gate == {'disabled': True, 'aria': 'true',
          'before': '{"stack":["scr-chat","scr-group"]}',
          'after': '{"stack":["scr-chat","scr-group"]}', 'hasVoice': False,
          'stored': '{"stack":["scr-chat","scr-group"]}',
          'result': {'ok': False, 'error': {'code': 'STREAM_CHAT_PROVIDER_MUTATION_PENDING'}},
          'inCall': False}, f'语音写入 fail closed 且不创建本地 RTC 状态：{voice_gate}')
    pg.click('#vrToggleBtn')
    pg.wait_for_timeout(120)
    check(pg.locator('#callbar').is_visible() and
          pg.locator('#cbStatus').inner_text() == 'Unavailable · Stream Video not connected',
          '最小化条仅显示明确离线投影，不声称已入房')
    pg.evaluate("goTab('market')")
    pg.wait_for_timeout(120)
    check(pg.locator('#callbar').is_visible(), '切页后明确离线预览条可返回语音投影')
    check(not pg.locator('.tab[data-tab="chat"] .live-dot').is_visible(),
          '未连接时 Chat tab 不伪造 live 指示')
    check(pg.locator('.cb-leave').is_disabled(), '离线预览 Leave 写入保持 PENDING')

    print('\n== 授权拦截弹层 ==')
    fresh(pg, 'dapp')
    pg.wait_for_timeout(1100)
    ok = pg.evaluate("""() => {
      const s = document.getElementById('sheet-approve');
      return s && !s.hasAttribute('inert');
    }""")
    check(ok, '#dapp 深链自动弹出授权拦截')

    print('\n== 回归：#dapp 延迟弹层不应飘到其他页 ==')
    fresh(pg, 'dapp')
    pg.evaluate("goTab('market')")          # 900ms 到期前离开
    pg.wait_for_timeout(1400)
    leaked = pg.evaluate("""() => {
      const s = document.getElementById('sheet-approve');
      return !!s && !s.hasAttribute('inert');
    }""")
    check(not leaked, '离开 #dapp 后授权弹层不再弹出')

    print('\n== TC-C10 决策 8：无 AI 措辞与风险分 ==')
    import re as _re
    txt = pg.evaluate("() => document.body.innerText")
    banned = ['AI Guard', 'AI Risk', 'AI score', 'AI pre-flight',
              'AI screener', 'AI-suggested', 'AI layer', 'Risk Score']
    hit = [b for b in banned if b.lower() in txt.lower()]
    check(not hit, f'无 AI 品牌措辞，命中: {hit}')
    # 风险分形如 72/100、23/100
    scores = _re.findall(r'\b\d{1,3}\s*/\s*100\b', txt)
    check(not scores, f'无 0-100 风险分，命中: {scores}')
    # 遍历各屏再查一次（innerText 只覆盖当前屏）
    all_hits = []
    for h in HASHES:
        fresh(pg, h)
        t = pg.evaluate("() => document.body.innerText")
        all_hits += [f'#{h}:{b}' for b in banned if b.lower() in t.lower()]
        all_hits += [f'#{h}:{s}' for s in _re.findall(r'\b\d{1,3}\s*/\s*100\b', t)]
    check(not all_hits, f'全部屏无残留，命中: {all_hits[:6]}')

    print('\n== 安全能力仍在（决策 8 只去包装不去能力）==')
    fresh(pg, 'dapp')
    pg.wait_for_timeout(1100)
    sheet = pg.evaluate("""() => {
      const s = document.getElementById('sheet-approve');
      return s ? s.innerText : '';
    }""")
    check('UNLIMITED' in sheet.upper(), '授权拦截仍指出 unlimited 请求')
    check('1,000' in sheet, '仍给出限额建议数值')
    check('Review 1,000 limit' in sheet and 'Review unlimited request' in sheet and
          'No token approval has occurred. Your choice will be reviewed before any wallet request.'
          in sheet, 'F16 仅提供进入统一 F11 的两种 review 选择')
    pg.click('#approval-limit')
    approval_review = pg.evaluate("""() => ({
      open:document.getElementById('review-dialog').classList.contains('open'),
      id:history.state?.review_id||'',kind:
        document.getElementById('review-kind').textContent
    })""")
    check(approval_review == {'open': True, 'id': 'review-approve-limited',
                              'kind': 'Approval'},
          f'F16 limited 选择复用统一 F11：{approval_review}')
    pg.click('#review-cancel')
    pg.wait_for_timeout(80)
    fresh(pg, 'swap')
    swap = pg.evaluate("() => document.querySelector('.ai-ok')?.innerText || ''")
    check('imulat' in swap, f'Swap 仍显示模拟结果: {swap[:60]!r}')
    fresh(pg, 'group')
    strip = pg.evaluate("() => document.querySelector('.risk-strip')?.innerText || ''")
    check('mint' in strip.lower(), f'高风险条改为事实陈述: {strip[:70]!r}')
    check(pg.evaluate("""() => {
        const s = document.querySelector('.risk-strip');
        return s ? !s.parentElement.querySelector('.tc-buy') : false;
    }"""), '高风险条不提供购买入口')

    print('\n== 无障碍：非活动页 inert ==')
    fresh(pg, 'market')
    bad = pg.evaluate("""() => [...document.querySelectorAll('.scr')]
       .filter(s => s.id !== 'scr-market' && !s.hasAttribute('inert'))
       .map(s => s.id)""")
    check(not bad, f'非活动屏都带 inert，例外: {bad}')

    fresh(pg, 'home')
    pg.screenshot(path='/tmp/loop-split-home.png')
    fresh(pg, 'group')
    pg.screenshot(path='/tmp/loop-split-group.png')
    b.close()

print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败:'))
for f in fails:
    print(' -', f)
sys.exit(1 if fails else 0)
