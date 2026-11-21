# Mac版（裏方あり）のテスト：server.py を起動して、フォルダ選択→解析→文字起こし→書き出し
import os, sys, time, json, subprocess, tempfile, signal
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'dist/セリフテイク.app/Contents/Resources')
sup = tempfile.mkdtemp()
env = dict(os.environ, ST_PORT='8795', ST_HEADLESS='1', ST_NO_UPDATE='1', ST_SUPPORT=sup,
           ST_WHISPER=os.path.join(ROOT, 'tests/fake_whisper.py'), ST_MODEL='/dev/null',
           ST_FAKE_PICK=os.path.join(ROOT, 'tests/media'), ST_FAKE_SAVE=os.path.join(ROOT, 'tests/out_mac.fcpxml'))
srv = subprocess.Popen([sys.executable, 'server.py'], cwd=RES, env=env)
time.sleep(1.5)
SCRIPT = "# Scene 1\nA「ふざけんなよ、あいつのこと忘れんなよ。」\nB「そうだけど。（笑う）」\n"
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'))
        pg = b.new_page(viewport={'width': 1500, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
        pg.on('console', lambda m: logs.append(m.type + ' ' + m.text) if m.type == 'error' else None)
        pg.goto('http://127.0.0.1:8795/')
        pg.wait_for_function('window.__st', timeout=20000); time.sleep(1.5)
        pg.click('#bScript'); pg.fill('#sText', SCRIPT); pg.click('#sApply'); time.sleep(1)
        pg.click('#bAdd')
        for i in range(90):
            st = pg.inner_text('#status')
            if '整理済み' in st or 'エラー' in st: break
            time.sleep(0.5)
        print('STATUS', st)
        r = pg.evaluate("""() => { const P = window.__st.P, D = window.__st.D;
          return { roots: P.roots, abs: Object.values(P.media).map(m => !!m.abs).every(Boolean),
            tr: Object.entries(P.transcripts).map(([k, v]) => P.media[k].name + ':' + v.map(s => s.text).join('/')),
            ph: [...D.phrases.values()].map(e => e.phrase.text + ' ' + e.takes.length + ' ' + e.takes.map(t => t.cams.length).join(',')) } }""")
        print(json.dumps(r, ensure_ascii=False, indent=1))
        pg.click('.ph[data-ph] >> text=忘れんなよ'); time.sleep(1.5)
        pg.screenshot(path=os.path.join(ROOT, 'tests/mac1.png'))
        # 再読み込みしても素材がつながったまま
        pg.reload(); pg.wait_for_function('window.__st', timeout=20000); time.sleep(3)
        print('after reload: missing banner =', pg.query_selector('.banner') is not None, 'files', pg.evaluate('window.__st.files.size'))
        pg.click('#bExport'); time.sleep(0.3)
        print('basePath field:', pg.query_selector('#basePath') is not None)
        pg.click('#exGo'); time.sleep(1.5)
        print('toast:', pg.inner_text('#toast'))
        print('\n'.join(logs[-10:]))
        b.close()
finally:
    srv.send_signal(signal.SIGTERM)
