#!/usr/bin/env python3
"""把 文档/*.md 包进 docs.html（复用 index.html 的渲染骨架与样式）。

markdown 原文放进 <script type="text/markdown"> 而不是 <textarea>：
textarea 会把内容当 HTML 解析一次，md 里的 <b>、<!-- --> 会被吃掉；
script 标签的内容是 raw text，只需防 </script> 序列。

侧栏在多份文档间切换，正文由 marked.js 渲染，与方案页一致。
"""
import html
import hashlib
import json
import pathlib
import re
import stat
import sys

root = pathlib.Path(__file__).parent
docs_dir = root / '文档'

EXPECTED_MARKED_VENDOR = {
    'name': 'marked',
    'version': '18.0.10',
    'license': 'MIT',
    'npm_integrity':
        'sha512-FJeH4bRpYoXiggcgriCGItKCSv3xkngJc4QCZ/rkQCogU3VYaLxYJoZl8Nw/'
        'b4+x7iij/pd+09mZ6A1dXzpL0A==',
    'source': 'https://registry.npmjs.org/marked/-/marked-18.0.10.tgz',
    'file': 'docs_vendor/marked-18.0.10.umd.js',
    'sha256': 'eaccee2fb9fb3b2c09e873a5504da82507850d9e677bd720122ac49e2a03982a',
    'license_file': 'docs_vendor/marked.LICENSE.md',
    'license_sha256':
        '8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c',
}


def confined_vendor_file(relative, label):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        sys.exit(f'Marked vendor lock {label} must be a normalized relative path')
    candidate = pathlib.PurePosixPath(relative)
    if candidate.is_absolute() or '..' in candidate.parts or str(candidate) != relative:
        sys.exit(f'Marked vendor lock {label} must be a normalized relative path')
    path = root / candidate
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root.resolve())
    except (FileNotFoundError, RuntimeError, ValueError):
        sys.exit(f'Marked vendor lock {label} escapes project root or is missing')
    try:
        mode = path.lstat().st_mode
    except OSError:
        sys.exit(f'Marked vendor lock {label} must be a confined regular file')
    if path.is_symlink() or not stat.S_ISREG(mode) or not resolved.is_file():
        sys.exit(f'Marked vendor lock {label} must be a confined regular file')
    return resolved


def strict_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'duplicate key: {key}')
        value[key] = item
    return value


def confined_lock_file(path):
    """Validate the fixed lock itself before reading any bytes or values."""
    try:
        mode = path.lstat().st_mode
        resolved = path.resolve(strict=True)
        resolved.relative_to(root.resolve())
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        sys.exit('Marked vendor lock file must be a project-confined regular file')
    if path.is_symlink() or not stat.S_ISREG(mode) or not resolved.is_file():
        sys.exit('Marked vendor lock file must be a project-confined regular file')
    return resolved


vendor_lock_path = root / 'docs_vendor' / 'vendor-lock.json'
vendor_lock_path = confined_lock_file(vendor_lock_path)
try:
    marked_vendor = json.loads(
        vendor_lock_path.read_text(), object_pairs_hook=strict_json_object)
except (OSError, ValueError) as error:
    sys.exit(f'cannot read Marked vendor lock: {error}')
if marked_vendor != EXPECTED_MARKED_VENDOR:
    sys.exit('Marked vendor lock must match the exact pinned schema and values')
marked_path = confined_vendor_file(marked_vendor['file'], 'file')
marked_license_path = confined_vendor_file(
    marked_vendor['license_file'], 'license_file')
if hashlib.sha256(marked_path.read_bytes()).hexdigest() != marked_vendor['sha256']:
    sys.exit('Marked vendor SHA-256 mismatch')
if hashlib.sha256(marked_license_path.read_bytes()).hexdigest() != \
        marked_vendor['license_sha256']:
    sys.exit('Marked vendor license SHA-256 mismatch')

# 顺序即侧栏顺序；(文件名, 标签, 一句话说明)
DOCS = [
    ('页面清单.md', '页面清单', '全量 103 屏 · 本次画 A 档 47 屏'),
    ('账号清单-对齐开发方.md', '账号清单（对齐开发）', '与开发方 9 项清单合并后的执行版'),
    ('账号注册清单.md', '账号清单（完整背景）', '36 项 + 定价依据 + 风险提示'),
    ('开发进度安排.md', '开发进度安排', '30 工作日 · AI 开发 + 人工审核'),
    ('测试用例.md', '测试用例', '151 条 · 89 条 P0'),
]

missing = [n for n, _, _ in DOCS if not (docs_dir / n).exists()]
if missing:
    sys.exit(f'missing docs: {", ".join(missing)}')

# --- 复用 index.html 的 <style> 块，保证视觉一致 ---
index = (root / 'index.html').read_text()
m = re.search(r'<style>(.*?)</style>', index, re.S)
if not m:
    sys.exit('cannot extract <style> from index.html')
style = m.group(1)

EXTRA_CSS = """
/* docs page: sidebar switches between documents instead of listing one doc's headings */
.doc-nav{margin-bottom:18px}
.doc-nav a{display:block;padding:10px 11px;margin:3px 0;border:1px solid var(--l);border-radius:11px;color:#a6a6b0;font-size:12.5px}
.doc-nav a b{display:block;color:var(--t);font-weight:500;margin-bottom:2px}
.doc-nav a span{font-size:11px;color:var(--m2)}
.doc-nav a:hover{border-color:var(--al);background:var(--as)}
.doc-nav a.on{border-color:var(--al);background:var(--as)}
.doc-nav a.on b{color:var(--a)}
#content>h1:first-child{display:block;margin:0 0 6px;font-size:34px;font-weight:500;letter-spacing:-.04em}
#content>blockquote:first-of-type{display:block}
.docmeta{color:var(--m2);font-size:12px;margin-bottom:26px}
"""


SCRIPT_END = re.compile(r'</script(?=[\t\n\f\r />])', re.I)


def md_payload(text):
    """Case-insensitively break every HTML raw-text script end-tag opener."""
    return SCRIPT_END.sub(r'<\\/script', text)


marked_payload = md_payload(marked_path.read_text())


nav = '\n'.join(
    f'<a href="#{i}" data-i="{i}"><b>{html.escape(label)}</b><span>{html.escape(desc)}</span></a>'
    for i, (_, label, desc) in enumerate(DOCS)
)

payloads = '\n'.join(
    f'<script type="text/markdown" id="md{i}">\n{md_payload((docs_dir / name).read_text())}\n</script>'
    for i, (name, _, _) in enumerate(DOCS)
)

labels_js = ','.join(f'"{label}"' for _, label, _ in DOCS)

page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>LOOP 交付文档</title>
<script id="marked-vendor">{marked_payload}</script>
<style>{style}{EXTRA_CSS}</style></head><body>
<header class="top">
  <a class="brand" href="./index.html">L⊙⊙P</a>
  <div class="actions">
    <a class="btn" href="./index.html">产品方案</a>
    <a class="btn" href="./app.html">交互原型</a>
    <button class="btn primary" id="printBtn">打印 / 导出 PDF</button>
  </div>
</header>
<div class="shell">
  <aside>
    <div class="toc-title">交付文档</div>
    <nav class="doc-nav" id="docNav">{nav}</nav>
    <div class="toc-title">本篇目录</div>
    <nav class="toc" id="toc"></nav>
  </aside>
  <main><div class="doc">
    <div class="mobile-nav"><select id="docSelect"></select></div>
    <article id="content"></article>
    <div class="foot">
      <span>LOOP 交付文档 · 2026-08-21</span>
      <span>本文监管相关表述不构成法律意见；第三方定价以厂商正式报价为准</span>
    </div>
  </div></main>
</div>
{payloads}
<script>
(function(){{
var LABELS=[{labels_js}];
var content=document.getElementById('content'), toc=document.getElementById('toc');
var navLinks=[].slice.call(document.querySelectorAll('#docNav a'));
var sel=document.getElementById('docSelect');
LABELS.forEach(function(l,i){{var o=document.createElement('option');o.value=i;o.textContent=l;sel.appendChild(o)}});

function render(i){{
  var src=document.getElementById('md'+i).textContent;
  function showRaw(){{
    var pre=document.createElement('pre');pre.textContent=src;
    content.replaceChildren(pre);toc.replaceChildren();
  }}
  try{{
    if(!globalThis.marked || typeof globalThis.marked.setOptions!=='function' ||
       typeof globalThis.marked.parse!=='function') throw new Error('Marked API unavailable');
    globalThis.marked.setOptions({{gfm:true,breaks:false}});
    var rendered=globalThis.marked.parse(src);
    if(typeof rendered!=='string') throw new Error('Marked parse did not return HTML');
    content.innerHTML=rendered;
  }}catch(_error){{
    showRaw();
  }}
  content.querySelectorAll('table').forEach(function(t){{
    var w=document.createElement('div');w.className='table-wrap';
    t.parentNode.insertBefore(w,t);w.appendChild(t);
  }});
  toc.innerHTML='';
  var hs=[].slice.call(content.querySelectorAll('h2,h3'));
  hs.forEach(function(h,n){{
    h.id='s'+n;
    var a=document.createElement('a');a.href='#'+h.id;a.textContent=h.textContent;
    a.className='depth-'+h.tagName.slice(1);
    a.addEventListener('click',function(e){{e.preventDefault();h.scrollIntoView({{behavior:'smooth'}})}});
    toc.appendChild(a);
  }});
  navLinks.forEach(function(a,n){{a.classList.toggle('on',n===i)}});
  sel.value=i;
  window.scrollTo(0,0);
}}

navLinks.forEach(function(a,i){{
  a.addEventListener('click',function(e){{e.preventDefault();location.hash=i;render(i)}});
}});
sel.addEventListener('change',function(e){{location.hash=e.target.value;render(+e.target.value)}});
window.addEventListener('hashchange',function(){{
  var i=parseInt(location.hash.slice(1),10);
  if(!isNaN(i)&&i>=0&&i<LABELS.length) render(i);
}});
document.getElementById('printBtn').addEventListener('click',function(){{window.print()}});

var start=parseInt(location.hash.slice(1),10);
render(!isNaN(start)&&start>=0&&start<LABELS.length?start:0);
}})();
</script></body></html>
"""

out = root / 'docs.html'
out.write_text(page)
print(f'docs.html built: {out.stat().st_size:,} bytes · {len(DOCS)} docs')
