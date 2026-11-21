#!/usr/bin/env python3
"""セリフテイク（Mac版）の裏方。

- アプリ内の画面（web/）を 127.0.0.1 で配信し、専用ウインドウ（pywebview）で開く
- 素材フォルダの選択（Finder のダイアログ）、素材ファイルの部分読み出し（Range 対応）
- 文字起こし（whisper.cpp の whisper-cli、端末内で処理）
- FCPXML の保存と Final Cut Pro での読み込み
- GitHub から新しい版を取り込む（自動更新）
標準ライブラリだけで動く（専用ウインドウの pywebview は入っていれば使う）。
"""
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent            # .app/Contents/Resources
WEB = HERE / "web"
SUPPORT = Path(os.environ.get("ST_SUPPORT", Path.home() / "Library/Application Support/SerifuTake"))
SUPPORT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("ST_PORT", "8790"))
REPO_RAW = "https://raw.githubusercontent.com/arumonwizard-star/serifu-take/main/"
os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "")
MODEL_CANDIDATES = [
    Path.home() / ".local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin",
    Path.home() / ".local/share/whisper-cpp/ggml-large-v3-turbo.bin",
    Path.home() / ".local/share/whisper-cpp/ggml-large-v3.bin",
]
MEDIA_EXT = {".mov", ".mp4", ".m4v", ".wav", ".bwf", ".txt", ".md", ".fountain"}
JOBS = {}
LOCK = threading.Lock()
WIN = []  # 専用ウインドウ（あれば、その中でフォルダ選択・保存の画面を出す）


def dialog_folder():
    if WIN:
        import webview
        r = WIN[0].create_file_dialog(webview.FOLDER_DIALOG)
        if not r:
            return None
        return r[0] if isinstance(r, (list, tuple)) else r
    return osascript('tell me to activate\nPOSIX path of (choose folder with prompt "素材フォルダを選択")')


def dialog_save(name, where):
    if WIN:
        import webview
        r = WIN[0].create_file_dialog(webview.SAVE_DIALOG, directory=where, save_filename=name + ".fcpxml")
        if not r:
            return None
        return r[0] if isinstance(r, (list, tuple)) else r
    return osascript('tell me to activate\nPOSIX path of (choose file name with prompt "FCPXMLの保存先" default name "%s.fcpxml" default location (POSIX file "%s"))' % (name, where.replace('"', "")))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_whisper():
    if os.environ.get("ST_WHISPER"):
        return os.environ["ST_WHISPER"]
    for name in ("whisper-cli", "whisper-cpp"):
        p = shutil.which(name)
        if p:
            return p
    return None


def find_model():
    if os.environ.get("ST_MODEL"):
        return os.environ["ST_MODEL"]
    for p in MODEL_CANDIDATES:
        if p.exists():
            return str(p)
    d = Path.home() / ".local/share/whisper-cpp"
    if d.exists():
        bins = sorted(d.glob("ggml-*.bin"), key=lambda x: x.stat().st_size, reverse=True)
        if bins:
            return str(bins[0])
    return None


def web_version():
    try:
        return json.loads((WEB / "version.json").read_text())["version"]
    except Exception:
        return "?"


def osascript(script):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def list_folder(root):
    root = Path(root)
    out = []
    top = root.name
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and not d.endswith(".fcpbundle"))
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            p = Path(dirpath) / fn
            if p.suffix.lower() not in MEDIA_EXT:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            rel = top + "/" + str(p.relative_to(root)).replace(os.sep, "/")
            out.append({"abs": str(p), "rel": rel, "name": fn, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
    return out


def write_wav16(path, pcm_f32_bytes):
    n = len(pcm_f32_bytes) // 4
    samples = struct.unpack("<%df" % n, pcm_f32_bytes[: n * 4])
    data = bytearray(n * 2)
    for i, v in enumerate(samples):
        v = 32767 if v >= 1 else -32768 if v <= -1 else int(v * 32767)
        struct.pack_into("<h", data, i * 2, v)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


def run_whisper(job_id, pcm_bytes):
    job = JOBS[job_id]
    try:
        whisper, model = find_whisper(), find_model()
        if not whisper or not model:
            raise RuntimeError("文字起こしの部品が見つかりません")
        tmp = Path(tempfile.mkdtemp(prefix="serifutake-"))
        wav = tmp / "a.wav"
        write_wav16(wav, pcm_bytes)
        out = tmp / "out"
        cmd = [whisper, "-m", model, "-l", "ja", "-oj", "-of", str(out), "-pp",
               "-t", str(max(2, min(8, (os.cpu_count() or 4)))), "-f", str(wav)]
        log("whisper:", " ".join(cmd))
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        tail = []
        for line in p.stdout:
            tail = (tail + [line.rstrip()])[-20:]
            if "progress" in line:
                try:
                    job["progress"] = int(line.split("=")[-1].strip().rstrip("%")) / 100
                except Exception:
                    pass
        p.wait()
        jf = Path(str(out) + ".json")
        if p.returncode != 0 or not jf.exists():
            raise RuntimeError("文字起こしに失敗：" + " / ".join(tail[-3:]))
        data = json.loads(jf.read_text(encoding="utf-8", errors="replace"))
        segs = []
        for s in data.get("transcription", []):
            text = (s.get("text") or "").strip()
            off = s.get("offsets", {})
            if text:
                segs.append({"start": off.get("from", 0) / 1000.0, "end": off.get("to", 0) / 1000.0, "text": text})
        job.update(done=True, segments=segs, progress=1)
        shutil.rmtree(tmp, ignore_errors=True)
    except Exception as e:
        log("whisper error", traceback.format_exc())
        job.update(done=True, error=str(e))


# ------------------------------------------------------------ 自動更新
def check_update():
    """GitHub の manifest と比べて、変わったファイルだけ取り込む。"""
    try:
        with urllib.request.urlopen(REPO_RAW + "mac/manifest.json?t=%d" % time.time(), timeout=20) as r:
            man = json.loads(r.read())
        if man.get("version") == web_version() and all((HERE / k).exists() for k in man["files"]):
            return False
        changed = 0
        for rel, sha in man["files"].items():
            dst = HERE / rel
            if dst.exists() and hashlib.sha1(dst.read_bytes()).hexdigest() == sha:
                continue
            src = rel[4:] if rel.startswith("web/") else "mac/" + rel
            with urllib.request.urlopen(REPO_RAW + urllib.parse.quote(src), timeout=60) as r:
                body = r.read()
            if hashlib.sha1(body).hexdigest() != sha:
                raise RuntimeError("内容が一致しません: " + rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            tmp = dst.with_name(dst.name + ".new")
            tmp.write_bytes(body)
            os.replace(tmp, dst)
            changed += 1
        log("update: %d files -> %s" % (changed, man.get("version")))
        return changed > 0
    except Exception as e:
        log("update check failed:", e)
        return False


def updater():
    time.sleep(5)
    while True:
        check_update()
        time.sleep(30 * 60)


# ------------------------------------------------------------ HTTP
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        try:
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/api/ping":
                return self.send_json({"ok": True, "version": web_version(), "whisper": bool(find_whisper()), "model": bool(find_model())})
            if u.path == "/api/list":
                p = q.get("p", [""])[0]
                if not p or not Path(p).is_dir():
                    return self.send_json({"files": [], "missing": True})
                return self.send_json({"path": p, "files": list_folder(p)})
            if u.path == "/api/job":
                j = JOBS.get(q.get("id", [""])[0])
                if not j:
                    return self.send_json({"error": "no job"}, 404)
                out = {k: v for k, v in j.items() if k != "thread"}
                if j.get("done"):
                    JOBS.pop(q["id"][0], None)
                return self.send_json(out)
            if u.path == "/api/project":
                f = SUPPORT / "project.json"
                b = f.read_bytes() if f.exists() else b"null"
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b)
                return
            if u.path == "/media":
                return self.send_file(Path(q.get("p", [""])[0]), media=True)
            # 画面のファイル
            rel = urllib.parse.unquote(u.path).lstrip("/") or "index.html"
            f = (WEB / rel).resolve()
            if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
            return self.send_file(f)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log(traceback.format_exc())
            try:
                self.send_json({"error": "server"}, 500)
            except Exception:
                pass

    def send_file(self, f, media=False):
        if not f.is_file():
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        size = f.stat().st_size
        ext = f.suffix.lower()
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript",
                 ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
                 ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".mov": "video/quicktime",
                 ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".wav": "audio/wav", ".gz": "application/octet-stream",
                 ".txt": "text/plain; charset=utf-8"}.get(ext, "application/octet-stream")
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            if a:
                start = int(a)
                end = int(b) if b else size - 1
            else:
                start = max(0, size - int(b))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416); self.send_header("Content-Range", "bytes */%d" % size); self.send_header("Content-Length", "0"); self.end_headers(); return
            code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store" if not media else "private, max-age=0")
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(f, "rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                chunk = fh.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_HEAD(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/media":
            q = urllib.parse.parse_qs(u.query)
            return self.send_file(Path(q.get("p", [""])[0]), media=True)
        self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()

    def do_POST(self):
        try:
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/api/pick-folder":
                p = os.environ.get("ST_FAKE_PICK") or dialog_folder()
                if not p:
                    return self.send_json({"cancel": True})
                p = p.rstrip("/")
                return self.send_json({"path": p, "files": list_folder(p)})
            if u.path == "/api/transcribe":
                data = self.body()
                jid = uuid.uuid4().hex
                JOBS[jid] = {"progress": 0, "done": False}
                threading.Thread(target=run_whisper, args=(jid, data), daemon=True).start()
                return self.send_json({"id": jid})
            if u.path == "/api/project":
                data = self.body()
                tmp = SUPPORT / "project.json.new"
                tmp.write_bytes(data)
                os.replace(tmp, SUPPORT / "project.json")
                return self.send_json({"ok": True})
            if u.path == "/api/save-fcpxml":
                req = json.loads(self.body() or b"{}")
                name = (req.get("name") or "セリフテイク").replace('"', "")
                where = req.get("dir") or str(Path.home() / "Movies")
                if os.environ.get("ST_FAKE_SAVE"):
                    path = os.environ["ST_FAKE_SAVE"]
                else:
                    path = dialog_save(name, where)
                if not path:
                    return self.send_json({"cancel": True})
                if not path.lower().endswith(".fcpxml"):
                    path += ".fcpxml"
                Path(path).write_text(req.get("xml", ""), encoding="utf-8")
                opened = False
                if req.get("open") and not os.environ.get("ST_FAKE_SAVE"):
                    opened = subprocess.run(["open", "-a", "Final Cut Pro", path]).returncode == 0
                return self.send_json({"path": path, "opened": opened})
            if u.path == "/api/reveal":
                req = json.loads(self.body() or b"{}")
                subprocess.run(["open", "-R", req.get("path", "")])
                return self.send_json({"ok": True})
            self.send_json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log(traceback.format_exc())
            try:
                self.send_json({"error": "server"}, 500)
            except Exception:
                pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def set_app_name():
    # メニューバーの表示を「Python」ではなく「セリフテイク」に
    try:
        from Foundation import NSBundle
        info = NSBundle.mainBundle().localizedInfoDictionary() or NSBundle.mainBundle().infoDictionary()
        if info is not None:
            info["CFBundleName"] = "セリフテイク"
            info["CFBundleDisplayName"] = "セリフテイク"
    except Exception:
        pass


def set_dock_icon():
    try:
        from AppKit import NSApplication, NSImage
        icns = HERE / "AppIcon.icns"
        if icns.exists():
            NSApplication.sharedApplication().setApplicationIconImage_(NSImage.alloc().initWithContentsOfFile_(str(icns)))
    except Exception:
        pass


def main():
    log("=== セリフテイク 起動", web_version(), "port", PORT)
    try:
        serve()
    except OSError:
        # 既に動いている（前回の残り）→ 少し待って再挑戦
        time.sleep(2)
        serve()
    if os.environ.get("ST_NO_UPDATE") != "1":
        threading.Thread(target=updater, daemon=True).start()
    url = "http://127.0.0.1:%d/" % PORT
    if os.environ.get("ST_HEADLESS") == "1":
        while True:
            time.sleep(3600)
    try:
        import webview
        set_app_name()
        win = webview.create_window("セリフテイク", url, width=1500, height=950, min_size=(1000, 650), background_color="#121418")
        WIN.append(win)
        storage = SUPPORT / "webview"
        storage.mkdir(exist_ok=True)
        webview.start(set_dock_icon, private_mode=False, storage_path=str(storage))
    except Exception:
        log("専用ウインドウを使えないため、ブラウザで開きます", traceback.format_exc())
        subprocess.run(["open", url])
        while True:
            time.sleep(3600)
    os._exit(0)


if __name__ == "__main__":
    main()
