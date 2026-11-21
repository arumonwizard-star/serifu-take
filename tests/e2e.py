import json, time
from playwright.sync_api import sync_playwright
SCRIPT = "# Scene 1\nA「ふざけんなよ、あいつのこと忘れんなよ。」\nB「そうだけど。」\n"
FILES = ['A/A001C001.mov','B/B001C001.mp4','音声/T001.wav','A/A001C002.mov','B/B001C002.mp4','音声/T002.wav']
import os, sys
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width':1500,'height':900}, accept_downloads=True)
    pg = ctx.new_page()
    logs=[]
    pg.on('console', lambda m: logs.append(m.type+': '+m.text) if m.type in('error','warning') else None)
    pg.on('pageerror', lambda e: logs.append('PAGEERROR: '+str(e)))
    pg.on('response', lambda r: logs.append('HTTP %d %s'%(r.status,r.url)) if r.status>=400 else None)
    pg.add_init_script("""
      window.__stMockAsr = async (rep) => {
        const s = await (await fetch('/tests/media/sched.json')).json();
        const md = window.__st.P.media[rep];
        return s[md.name].map(x => ({...x, start: x.start - (md.audioOffset||0), end: x.end - (md.audioOffset||0)}));
      };""")
    pg.goto('http://localhost:8765/')
    pg.wait_for_function('window.__st', timeout=20000)
    # 前回の保存が残っていれば素材だけ再登録
    time.sleep(2)
    pg.evaluate("s => window.__st.applyScript(s)", SCRIPT)
    pg.evaluate("""async (files) => {
      const out = []; let lm = 1700000000000;
      for (const f of files) { const b = await (await fetch('/tests/media/' + f)).blob(); out.push({ file: new File([b], f.split('/').pop(), { lastModified: lm += 1000 }), rel: 'shoot/' + f }); }
      await window.__st.registerFiles(out);
    }""", FILES)
    for i in range(60):
        if '整理済み' in pg.inner_text('#status'): break
        time.sleep(0.5)
    pg.click('.ph[data-ph] >> text=あいつのこと')
    time.sleep(2.5)
    pg.screenshot(path='tests/s2.png')
    # Bカメ take1 を○に
    cards = pg.query_selector_all('.card')
    print('cards', len(cards))
    pg.click('.camRow:has(.camName:text("Bカメ")) .card >> nth=0 >> [data-st=ok]')
    pg.click('.ph[data-ph] >> text=ふざけんなよ')
    time.sleep(1)
    pg.keyboard.press('ArrowRight'); time.sleep(0.3); pg.keyboard.press('1')
    # 区切り編集
    pg.hover('.lineBox[data-line="S1L1"]')
    pg.click('[data-act=cut][data-line="S1L1"]')
    time.sleep(0.3)
    pg.screenshot(path='tests/s3.png')
    pg.click('[data-act=cutdone]')
    # アドリブ選択
    pg.click('[data-ad]')
    time.sleep(1)
    pg.click('.card >> nth=0 >> [data-st=ok]')
    # 書き出し
    pg.click('#bExport')
    pg.fill('#basePath', '/Users/yuito/Movies/撮影')
    with pg.expect_download() as d:
        pg.click('#exGo')
    d.value.save_as('tests/out.fcpxml')
    time.sleep(0.5)
    pg.screenshot(path='tests/s4.png')
    print('\n'.join(logs[-20:]))
    b.close()
