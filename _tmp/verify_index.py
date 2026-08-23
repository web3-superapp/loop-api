#!/usr/bin/env python3
"""验证方案页更新后仍正常渲染，且新内容与链接就位。"""
import pathlib
import sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
URL = (root / 'index.html').as_uri()
fails = []


def check(c, m):
    print(('  ok   ' if c else '  FAIL ') + m)
    if not c:
        fails.append(m)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={'width': 1440, 'height': 960})
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))

    pg.goto(URL)
    pg.wait_for_load_state('networkidle')
    pg.wait_for_timeout(700)

    check(not errs, f'无 JS 错误: {errs[:3]}')
    txt = pg.evaluate("() => document.getElementById('content').innerText")
    check(len(txt) > 8000, f'正文已渲染（{len(txt)} 字符）')

    print('\n== 新增第九章 ==')
    for needle in ['技术选型与交付计划', 'Privy', 'Stream', 'deriv_chart',
                   'iOS 上不了永续合约', '内部 user id', 'Go/No-Go', '19%']:
        check(needle in txt, f'含「{needle}」')

    print('\n== 章节编号 ==')
    h2s = pg.evaluate("() => [...document.querySelectorAll('#content h2')].map(h=>h.textContent)")
    check(any('九、技术选型' in h for h in h2s), '第九章为技术选型')
    check(any('十、已拍板' in h for h in h2s), '原第九章已改为第十章')
    check(len(h2s) == len(set(h2s)), f'无重复章节标题（{len(h2s)} 章）')

    print('\n== 过期内容已清除 ==')
    check('AI 风险分 | 72/100' not in txt, '4.1 表格无风险分')
    check('11 屏' not in pg.evaluate("() => document.querySelector('.hero-meta').innerText"),
          'hero 不再写 11 屏')

    print('\n== 文档页链接 ==')
    hrefs = pg.evaluate("() => [...document.querySelectorAll('a')].map(a=>a.getAttribute('href'))")
    check('./docs.html' in hrefs, '顶部导航有交付文档入口')
    check((root / 'docs.html').exists(), 'docs.html 存在')

    print('\n== 目录与移动端 ==')
    check(pg.locator('#toc a').count() > 10, f'侧栏目录 {pg.locator("#toc a").count()} 项')
    pg.set_viewport_size({'width': 390, 'height': 844})
    pg.wait_for_timeout(300)
    ow = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(ow <= 1, f'窄屏无横向溢出（{ow}px）')
    check(pg.locator('#mobileNav').is_visible(), '窄屏显示章节选择器')

    pg.set_viewport_size({'width': 1440, 'height': 960})
    pg.goto(URL + '#protos')
    pg.wait_for_timeout(500)
    pg.screenshot(path='/tmp/index-updated.png')
    b.close()

print('\n' + ('全部通过' if not fails else f'{len(fails)} 项失败:'))
for f in fails:
    print(' -', f)
sys.exit(1 if fails else 0)
