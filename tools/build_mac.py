#!/usr/bin/env python3
"""Mac版の組み立て：dist/セリフテイク.app を作り、mac/manifest.json（自動更新用）を更新する。"""
import hashlib, json, shutil, stat
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
WEB_FILES = ["index.html", "style.css", "manifest.webmanifest", "version.json", "sw.js"]
WEB_DIRS = ["js", "icons", "vendor/kuromoji"]

def web_list():
    out = [ROOT / f for f in WEB_FILES]
    for d in WEB_DIRS:
        out += sorted(p for p in (ROOT / d).rglob("*") if p.is_file() and not p.name.startswith("."))
    return out

def main():
    version = json.loads((ROOT / "version.json").read_text())["version"]
    man = {"version": version, "files": {}}
    for p in web_list():
        man["files"]["web/" + str(p.relative_to(ROOT))] = hashlib.sha1(p.read_bytes()).hexdigest()
    for n in ["server.py", "AppIcon.icns"]:
        man["files"][n] = hashlib.sha1((ROOT / "mac" / n).read_bytes()).hexdigest()
    (ROOT / "mac/manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=1))
    app = ROOT / "dist/セリフテイク.app"
    shutil.rmtree(app, ignore_errors=True)
    res = app / "Contents/Resources"
    (app / "Contents/MacOS").mkdir(parents=True)
    res.mkdir(parents=True)
    shutil.copy(ROOT / "mac/AppIcon.icns", res / "AppIcon.icns")
    res = res / "app"   # 初回に ~/Library/Application Support/SerifuTake/app へ写す本体
    res.mkdir()
    shutil.copy(ROOT / "mac/app/Info.plist", app / "Contents/Info.plist")
    exe = app / "Contents/MacOS/SerifuTake"
    shutil.copy(ROOT / "mac/app/SerifuTake", exe)
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    for n in ["server.py", "AppIcon.icns"]:
        shutil.copy(ROOT / "mac" / n, res / n)
    for p in web_list():
        d = res / "web" / p.relative_to(ROOT)
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(p, d)
    print("built", app, "version", version, "files", len(man["files"]))

if __name__ == "__main__":
    main()
