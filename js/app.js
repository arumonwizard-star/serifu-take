import * as store from './store.js';
import { probe, audio16k, isMovieName, isAudioName } from './media.js';
import { envelope, detectSpeech, syncFeature, HOP } from './analysis.js';
import { initTokenizer, parseScript, autoCuts, phrasesOf, boundaryCandidates, displayClean, hasTokenizer } from './text.js';
import { buildGroups, asrBlocks, buildRuns, derive, autoCameras, cameraOf, matchesQuery, clearReadingCache, lineReading } from './organize.js';
import { buildFcpxml } from './fcpxml.js';

export const VERSION = '1.2.3';
const BASE = new URL('../', import.meta.url).href;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const zen2han = (s) => String(s).replace(/[０-９．－]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[。]/g, '.');

// ===== Mac版（裏方あり）か =====
let LOCAL = null;
class RemoteFile {
  constructor(f) { this.name = f.name; this.size = f.size; this.lastModified = f.mtime; this.abs = f.abs; }
  slice(a, b) {
    const abs = this.abs, size = this.size;
    const end = Math.min(b == null ? size : b, size);
    return {
      arrayBuffer: async () => {
        if (end <= a) return new ArrayBuffer(0);
        const r = await fetch('/media?p=' + encodeURIComponent(abs), { headers: { Range: `bytes=${a}-${end - 1}` } });
        if (!r.ok) throw new Error('素材を読めません');
        return r.arrayBuffer();
      },
    };
  }
  async text() { const r = await fetch('/media?p=' + encodeURIComponent(this.abs)); return r.text(); }
  async arrayBuffer() { return this.slice(0, this.size).arrayBuffer(); }
}

// ===== 読み込み中表示 =====
let busyN = 0, busyT = null;
function busy(on) {
  busyN += on ? 1 : -1;
  if (busyN < 0) busyN = 0;
  if (busyN > 0 && !busyT && !$('#loadbar').classList.contains('on')) {
    busyT = setTimeout(() => { busyT = null; if (busyN > 0) { $('#loadbar').classList.add('on'); $('#loading').classList.add('on'); } }, 150);
  }
  if (busyN === 0) {
    clearTimeout(busyT); busyT = null;
    $('#loadbar').classList.remove('on'); $('#loading').classList.remove('on');
  }
}
async function withBusy(fn) { busy(true); try { return await fn(); } finally { busy(false); } }

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

// ===== プロジェクト =====
const DEFAULT_SETTINGS = { qv: 2, padPre: 0.5, padPost: 0.5, quality: 'std', basePath: '', joinTakes: true, unselected: 'auto', extAudio: true, keywords: true };
function newProject() {
  return {
    v: 1, name: '新規プロジェクト', scriptText: '', scenes: [], cutsByText: {},
    media: {}, groups: [], transcripts: {}, transcriptModel: {}, runs: [], freeAdlibs: [],
    user: { status: {}, overrides: {}, adjust: {}, cameraNames: {} },
    settings: { ...DEFAULT_SETTINGS },
  };
}
let P = newProject();
const files = new Map(); // key -> File
const urls = new Map();
let D = null; // derive 結果
let sel = { kind: null, key: null, item: null, cam: null };
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    store.put('kv', 'project', P).catch(e => console.warn(e));
    if (LOCAL) fetch('/api/project', { method: 'POST', body: JSON.stringify(P) }).catch(() => { });
  }, 400);
}
const speechOf = (key) => P.media[key] && P.media[key].speech;

// ===== 素材の取り込み =====
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
function isScriptName(n) { return /\.(txt|md|fountain)$/i.test(n); }

async function registerFiles(list) {
  let added = 0, script = null;
  for (const { file, rel } of list) {
    const n = file.name;
    if (n.startsWith('._') || n.startsWith('.')) continue;
    if (isScriptName(n)) { script = script || file; continue; }
    if (!isMovieName(n) && !isAudioName(n)) continue;
    const k = fileKey(file);
    files.set(k, file);
    if (!P.media[k]) { P.media[k] = { key: k, name: n, rel: rel || n, size: file.size }; added++; }
    else if (rel && P.media[k].rel !== rel) P.media[k].rel = rel;
    if (file.abs) P.media[k].abs = file.abs;
  }
  if (script) {
    const text = await script.text();
    if (text.trim() && text !== P.scriptText) { await applyScript(text); toast('台本を読み込みました：' + script.name); }
  }
  save();
  render();
  if (added || needsAnalysis()) runPipeline();
  return added;
}

async function walkEntry(entry, path, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file: f, rel: path + f.name });
  } else if (entry.isDirectory) {
    const r = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => r.readEntries(res, rej));
      for (const e of batch) await walkEntry(e, path + entry.name + '/', out);
    } while (batch.length);
  }
}

async function walkHandle(h, path, out) {
  if (h.kind === 'file') { const f = await h.getFile(); out.push({ file: f, rel: path + f.name }); return; }
  for await (const e of h.values()) {
    if (e.name.startsWith('.')) continue;
    await walkHandle(e, path + h.name + '/', out);
  }
}

async function saveHandles(hs) {
  if (!hs.length) return;
  const cur = (await store.get('handles', 'list')) || [];
  for (const h of hs) {
    let dup = false;
    for (const c of cur) { try { if (await c.isSameEntry(h)) dup = true; } catch (e) { } }
    if (!dup) cur.push(h);
  }
  await store.put('handles', 'list', cur);
}

function setupDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('#drop').classList.add('on'); e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#drop').classList.remove('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; $('#drop').classList.remove('on');
    if (LOCAL) {
      // 台本ファイルだけはそのまま読む。素材はフォルダ選択で場所を取得する
      const fl = [...e.dataTransfer.files];
      const sc = fl.find(f => isScriptName(f.name));
      if (sc && fl.length === 1) { await withBusy(async () => { await applyScript(await sc.text()); render(); }); toast('台本を読み込みました：' + sc.name); return; }
      pickFolder();
      return;
    }
    const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
    const handleProms = items.map(i => i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null);
    const entries = items.map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null);
    const plain = [...e.dataTransfer.files];
    await withBusy(async () => {
      const out = [];
      const hs = (await Promise.all(handleProms)).filter(h => h && h.kind === 'directory');
      if (entries.some(Boolean)) { for (const en of entries) if (en) await walkEntry(en, '', out); }
      else for (const f of plain) out.push({ file: f, rel: f.name });
      saveHandles(hs).catch(() => { });
      await registerFiles(out);
    });
  });
}
function hasFiles(e) { return e.dataTransfer && [...e.dataTransfer.types].includes('Files'); }

// 裏方の処理（ダイアログなど）が終わるまで待つ
async function awaitJob(start) {
  const s = await start;
  if (!s || !s.id) return s;
  for (;;) {
    await sleep(400);
    const j = await fetch('/api/job?id=' + s.id).then(r => r.json()).catch(() => null);
    if (j && j.done) return j;
    if (j && j.error && !j.done) return j;
  }
}

// 画面内のフォルダ選択
function browseFolder() {
  return new Promise((resolve) => {
    let cur = localStorage.getItem('st-lastdir') || '';
    const draw = async (p) => {
      const d = await withBusy(() => fetch('/api/dirs?p=' + encodeURIComponent(p || '')).then(r => r.json()));
      cur = d.path;
      openSheet(`<h2>素材フォルダ選択<span class="sp"></span><button id="fbCancel">キャンセル</button><button id="fbOk" class="primary">このフォルダを選択</button></h2>
        <div class="fb"><div class="fbPlaces">${d.places.map(x => `<div class="fbPlace${cur === x.path || cur.startsWith(x.path + '/') && x.path !== d.places[0].path ? ' on' : ''}" data-p="${esc(x.path)}">${esc(x.name)}</div>`).join('')}</div>
        <div class="fbMain"><div class="fbPath">${d.parent ? `<button data-p="${esc(d.parent)}">上へ</button>` : ''}<span>${esc(d.path)}</span><span class="fbCnt">素材 ${d.media}</span></div>
        <div class="fbList">${d.error ? (/not permitted/i.test(d.error) ? `<div class="perm"><div class="pt">Macの許可が必要です</div><ol><li>「再起動」を押す</li><li>「セリフテイクがリムーバブルボリューム上のファイルにアクセスしようとしています」と出たら「許可」を押す</li><li>出ないときは「許可の設定を表示」→「フルディスクアクセス」で「セリフテイク」をオン</li></ol><div class="row"><button id="fbRelaunch" class="primary">再起動</button><button id="fbPerm">許可の設定を表示</button></div><div class="diag" id="fbDiag"></div></div>` : `<div class="empty">開けません：${esc(d.error)}</div>`) : ''}${d.dirs.map(n => `<div class="fbDir" data-p="${esc(d.path.replace(/\/$/, '') + '/' + n)}">${esc(n)}</div>`).join('') || (d.error ? '' : '<div class="empty">フォルダなし</div>')}</div></div></div>`);
      $('#fbCancel').onclick = () => { closeSheet(); resolve(null); };
      $('#fbOk').onclick = () => { localStorage.setItem('st-lastdir', cur); closeSheet(); resolve(cur); };
      $('#sheetIn').querySelectorAll('[data-p]').forEach(n => n.onclick = () => draw(n.dataset.p));
      if ($('#fbDiag')) fetch('/api/diag').then(r => r.json()).then(j => { $('#fbDiag').textContent = JSON.stringify(j); }).catch(() => { });
      if ($('#fbPerm')) $('#fbPerm').onclick = () => fetch('/api/open-privacy', { method: 'POST' });
      if ($('#fbRelaunch')) $('#fbRelaunch').onclick = () => { localStorage.setItem('st-lastdir', cur); fetch('/api/relaunch', { method: 'POST' }); };
    };
    draw(cur);
  });
}

async function pickFolder() {
  if (LOCAL) {
    const path = await browseFolder();
    if (!path) return;
    const r = await withBusy(() => awaitJob(fetch('/api/pick-folder', { method: 'POST', body: JSON.stringify({ path }) }).then(r => r.json())));
    if (r && r.error) { toast('フォルダを開けませんでした：' + r.error); return; }
    if (!r || r.cancel || !r.path) return;
    P.roots = [...new Set([...(P.roots || []), r.path])];
    await withBusy(() => registerFiles(r.files.map(f => ({ file: new RemoteFile(f), rel: f.rel }))));
    return;
  }
  if (window.showDirectoryPicker) {
    try {
      const h = await window.showDirectoryPicker({ id: 'serifu-take', mode: 'read' });
      await withBusy(async () => {
        const out = []; await walkHandle(h, '', out);
        await saveHandles([h]);
        await registerFiles(out);
      });
    } catch (e) { if (e.name !== 'AbortError') toast('フォルダを開けませんでした'); }
  } else $('#fileInput').click();
}

async function restoreLocal() {
  const out = [];
  for (const root of P.roots || []) {
    const r = await fetch('/api/list?p=' + encodeURIComponent(root)).then(r => r.json()).catch(() => null);
    if (r && r.files) for (const f of r.files) out.push({ file: new RemoteFile(f), rel: f.rel });
  }
  if (out.length) await registerFiles(out);
}

async function restoreHandles(ask) {
  const hs = (await store.get('handles', 'list')) || [];
  let need = false;
  const out = [];
  for (const h of hs) {
    try {
      let p = await h.queryPermission({ mode: 'read' });
      if (p === 'prompt' && ask) p = await h.requestPermission({ mode: 'read' });
      if (p === 'granted') await walkHandle(h, '', out);
      else need = true;
    } catch (e) { }
  }
  if (out.length) await registerFiles(out);
  return need;
}

function missingCount() {
  return Object.keys(P.media).filter(k => !files.has(k)).length;
}

// ===== 台本 =====
async function applyScript(text) {
  await ensureTokenizer();
  const old = new Map();
  for (const sc of P.scenes) for (const ln of sc.lines) if (ln.userCuts) P.cutsByText[ln.text] = ln.cuts;
  P.scriptText = text;
  P.scenes = parseScript(text);
  for (const sc of P.scenes) for (const ln of sc.lines) {
    if (P.cutsByText[ln.text]) { ln.cuts = P.cutsByText[ln.text]; ln.userCuts = true; }
    else ln.cuts = autoCuts(ln.text);
  }
  clearReadingCache();
  reorganize();
  save();
}

async function ensureTokenizer() {
  if (hasTokenizer()) return;
  await withBusy(() => initTokenizer(new URL(BASE).pathname).catch(e => { console.warn(e); toast('辞書を読み込めませんでした'); }));
}

// ===== 解析パイプライン =====
let running = false, rerun = false;
const statusState = { text: '', on: false };
function setStatus(text, on = true) {
  statusState.text = text; statusState.on = on;
  $('#status').innerHTML = text ? `${on ? '<span class="dot"></span>' : ''}${esc(text)}` : '';
}

function needsAnalysis() {
  return Object.values(P.media).some(m => files.has(m.key) && !m.speech && !m.error);
}

async function runPipeline() {
  if (running) { rerun = true; return; }
  running = true;
  busy(true);
  try {
    do {
      rerun = false;
      await ensureTokenizer();
      await stepProbe();
      await stepGroups();
      await stepAsr();
      reorganize();
      render();
    } while (rerun);
    const n = Object.keys(P.media).length;
    setStatus(n ? `整理済み ${n}本` : '', false);
  } catch (e) {
    console.error(e);
    setStatus('解析エラー：' + (e.message || e), false);
  } finally {
    running = false;
    busy(false);
  }
}

async function stepProbe() {
  const todo = Object.values(P.media).filter(m => files.has(m.key) && !m.speech && !m.error);
  let done = 0;
  const work = async (m) => {
    const f = files.get(m.key);
    try {
      const info = await probe(f);
      const { pcm, offset } = await audio16k(f, info);
      const db = envelope(pcm);
      const sp = detectSpeech(db);
      // 無音（音声欠損）区間
      const silent = [];
      let s = -1;
      for (let i = 0; i <= db.length; i++) {
        const z = i < db.length && db[i] < -90;
        if (z && s < 0) s = i;
        if (!z && s >= 0) { if (i - s > 20) silent.push([s * HOP + offset, i * HOP + offset]); s = -1; }
      }
      const shiftList = (l) => l.map(r => [r[0] + offset, r[1] + offset]);
      delete info._audio;
      m.info = info;
      m.audioOffset = offset;
      m.speech = { voiced: shiftList(sp.voiced), regions: shiftList(sp.regions), silentRanges: silent, peak: sp.peak };
      await store.put('env', m.key, { db, offset });
    } catch (e) {
      console.warn(m.name, e);
      m.error = String(e.message || e);
    }
    done++;
    setStatus(`解析 ${done}/${todo.length}`);
  };
  const q = todo.slice();
  await Promise.all([0, 1].map(async () => { while (q.length) await work(q.shift()); }));
  if (todo.length) save();
}

async function stepGroups() {
  const list = Object.values(P.media).filter(m => m.info && m.speech);
  if (!list.length) { P.groups = []; return; }
  autoCameras(list);
  setStatus('同期');
  const arr = [];
  for (const m of list) {
    const env = await store.get('env', m.key);
    if (!env) { if (files.has(m.key)) { delete m.speech; rerun = true; } continue; }
    // 時刻を素材の時刻にそろえるため、先頭の補正分だけずらす
    let feat = syncFeature(env.db);
    const off = Math.round((env.offset || 0) / HOP);
    if (off > 0) { const f2 = new Float32Array(feat.length + off); f2.set(feat, off); feat = f2; }
    arr.push({ key: m.key, feat, created: m.info.created || null, duration: m.info.duration || 0, isAudio: m.info.kind === 'audio', camera: cameraOf(P, m.key) });
  }
  const groups = buildGroups(arr, (p) => setStatus(`同期 ${Math.round(p * 100)}%`));
  // 既に文字起こし済みのメンバーがいれば代表にする
  for (const g of groups) {
    if (P.transcripts[g.rep]) continue;
    const m = g.members.find(x => P.transcripts[x.key]);
    if (m) {
      const s0 = m.shift;
      g.members.forEach(x => { x.shift -= s0; });
      g.rep = m.key; g.id = 'G:' + m.key;
    }
  }
  P.groups = groups;
  save();
}

// 音声認識ワーカー
let worker = null, jobId = 0;
const jobs = new Map();
let workerQuality = null;
let lastWorkerMsg = 0;
// 取り込みや処理が止まったら作り直す
setInterval(() => {
  if (!worker || !jobs.size) return;
  if (Date.now() - lastWorkerMsg > 180000) {
    worker.terminate(); worker = null;
    for (const j of jobs.values()) j.rej(new Error('stall'));
    jobs.clear();
  }
}, 5000);
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    lastWorkerMsg = Date.now();
    if (m.type === 'model-progress') { if (!m.total) return; setStatus(`AIモデル読込 ${Math.round(m.loaded / 1048576)}/${Math.round(m.total / 1048576)}MB`); return; }
    if (m.type === 'model-ready') { workerQuality = m.model; return; }
    const j = jobs.get(m.id);
    if (!j) return;
    if (m.type === 'progress') j.onProgress && j.onProgress(m.done, m.total);
    if (m.type === 'result') { jobs.delete(m.id); j.res(m.segments); }
    if (m.type === 'error') { jobs.delete(m.id); j.rej(new Error(m.message)); }
  };
  worker.onerror = (e) => { for (const j of jobs.values()) j.rej(new Error(e.message || '音声認識エラー')); jobs.clear(); worker = null; };
  return worker;
}
function transcribe(pcm, regions, quality, onProgress) {
  const w = getWorker();
  const id = ++jobId;
  return new Promise((res, rej) => {
    jobs.set(id, { res, rej, onProgress });
    lastWorkerMsg = Date.now();
    w.postMessage({ type: 'transcribe', id, pcm, regions, quality }, [pcm.buffer]);
  });
}

async function transcribeLocal(pcm, onProgress) {
  const r = await fetch('/api/transcribe', { method: 'POST', body: pcm.buffer }).then(r => r.json());
  if (!r.id) throw new Error('文字起こしを開始できません');
  for (;;) {
    await sleep(1000);
    const j = await fetch('/api/job?id=' + r.id).then(r => r.json());
    if (j.error) throw new Error(j.error);
    onProgress && onProgress(Math.round((j.progress || 0) * 100), 100);
    if (j.done) return j.segments || [];
  }
}

// 声の無いところの文字起こし（聞き違いの作文）を除く
function keepVoiced(segs, voiced, offset) {
  return segs.filter(s => {
    const a = s.start + offset, b = s.end + offset;
    const d = Math.max(0.05, b - a);
    let ov = 0;
    for (const v of voiced) ov += Math.max(0, Math.min(b, v[1]) - Math.max(a, v[0]));
    return ov / d >= 0.2;
  });
}

async function stepAsr() {
  const todo = P.groups.filter(g => !P.transcripts[g.rep] && files.has(g.rep) && P.media[g.rep].speech);
  let i = 0;
  for (const g of todo) {
    i++;
    const m = P.media[g.rep];
    setStatus(`文字起こし ${i}/${todo.length}`);
    const regions = asrBlocks(m.speech.regions);
    if (!regions.length) { P.transcripts[g.rep] = []; continue; }
    let quality = P.settings.quality;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const f = files.get(g.rep);
        const { pcm, offset } = await audio16k(f, await probe(f));
        // ワーカーへは素材時刻でなく pcm 時刻で渡す
        const rr = regions.map(r => [r[0] - offset, r[1] - offset]);
        const prog = (d, t) => setStatus(`文字起こし ${i}/${todo.length}・${Math.round(d / t * 100)}%`);
        let segs = window.__stMockAsr ? await window.__stMockAsr(g.rep, rr, pcm)
          : (LOCAL && LOCAL.whisper && LOCAL.model) ? await transcribeLocal(pcm, prog)
          : await transcribe(pcm, rr, quality, prog);
        segs = keepVoiced(segs, m.speech.voiced, offset);
        P.transcripts[g.rep] = segs.map(s => ({ ...s, start: s.start + offset, end: s.end + offset }));
        P.transcriptModel[g.rep] = quality;
        break;
      } catch (e) {
        console.warn(e);
        if (attempt < 2) { if (quality === 'high') quality = 'std'; worker && worker.terminate(); worker = null; setStatus('AIモデル再接続'); continue; }
        m.asrError = String(e.message || e);
        break;
      }
    }
    save();
    if (i % 3 === 0) { reorganize(); render(); }
  }
}

function reorganize() {
  if (!P.scenes.length) { P.runs = []; P.freeAdlibs = []; D = derive(P, { speechOf }); return; }
  const { runs, freeAdlibs } = buildRuns(P.scenes, P.groups, P.transcripts, speechOf);
  P.runs = runs; P.freeAdlibs = freeAdlibs;
  D = derive(P, { speechOf });
  save();
}

// 間（息継ぎ）を見てセリフをさらに分ける
function refineCuts() {
  let changed = false;
  for (const sc of P.scenes) for (const ln of sc.lines) {
    if (ln.userCuts) continue;
    const { weak } = boundaryCandidates(ln.text);
    const rd = lineReading(ln);
    for (const c of weak) {
      if ((ln.cuts || []).includes(c)) continue;
      const k = rd.src.findIndex(s => s >= c);
      if (k <= 1 || k >= rd.chars.length - 1) continue;
      let have = 0, pause = 0;
      for (const r of P.runs) {
        const L = r.lines[ln.id];
        if (!L) continue;
        const a = L.t[(k - 1) * 2 + 1], b = L.t[k * 2];
        if (a == null || b == null) continue;
        have++;
        const sp = speechOf(r.rep);
        const gapReal = sp && sp.voiced.some((v, i) => i + 1 < sp.voiced.length && Math.abs(v[1] - a) < 0.25 && sp.voiced[i + 1][0] - v[1] >= 0.28);
        if (b - a >= 0.28 || gapReal) pause++;
      }
      if (have >= 1 && pause / have >= 0.5 && (have >= 2 || pause >= 1)) {
        ln.cuts = [...(ln.cuts || []), c].sort((x, y) => x - y);
        changed = true;
      }
    }
  }
  return changed;
}

// ===== 描画：台本ツリー =====
let query = '';
let cutEditLine = null;
function statusOf(item, fileKey) { return P.user.status[item.key + '|' + fileKey] || ''; }
const MARK = { ok: '○', maybe: '△', ng: '×' };

function phraseSummary(entry) {
  let n = 0, ok = 0, maybe = 0, ng = 0, best = 9;
  for (const t of entry.takes) {
    for (const c of t.cams) {
      if (c.isAudio) continue;
      n++;
      const s = statusOf(t, c.fileKey);
      if (s === 'ok') ok++; else if (s === 'maybe') maybe++;
      if (t.ng.length || c.ng.length) ng++;
    }
    best = Math.min(best, t.level || 9);
  }
  return { n, ok, maybe, ng, best, takes: entry.takes.length };
}

function render() {
  renderTree();
  renderTakes();
  renderEmpty();
}

function renderEmpty() {
  const hasMedia = Object.keys(P.media).length > 0;
  const pe = $('#pvEmpty');
  if (!sel.item) {
    pe.innerHTML = hasMedia || P.scenes.length
      ? `<div class="big">${P.scenes.length ? 'セリフを選択' : '台本を追加'}</div>`
      : `<div class="big">台本と素材フォルダをドロップ</div><div class="row"><button data-act="pick">素材フォルダ選択</button><button data-act="script">台本貼り付け</button></div>`;
  } else pe.innerHTML = '';
}

function renderTree() {
  const el = $('#tree');
  const scrollTop = $('#left').scrollTop;
  if (!D) D = derive(P, { speechOf });
  const h = [];
  const miss = missingCount();
  if (miss && Object.keys(P.media).length) {
    h.push(`<div class="banner">素材未接続 ${miss}本<button data-act="reconnect">素材フォルダ接続</button></div>`);
  }
  if (!P.scenes.length) {
    h.push(`<div class="empty">台本がありません<br><br><button data-act="script">台本貼り付け</button></div>`);
  }
  const takeQ = /^(?:take|テイク)\s*\d+$/i.test(query.trim());
  const camNames = new Set(Object.keys(P.media).map(k => cameraOf(P, k)));
  const filterTree = query && !takeQ && !camNames.has(query.trim());
  for (const sc of P.scenes) {
    const parts = [];
    let lastRole = null;
    let scCount = 0;
    for (const ln of sc.lines) {
      const phs = phrasesOf(ln);
      const rows = [];
      const lineAd = D.adlibs.filter(a => a.lineId === ln.id).length;
      phs.forEach((ph, pi) => {
        const e = D.phrases.get(ph.key);
        if (!e) return;
        if (filterTree && !matchesQuery(query, ph.text, ln.role, sc.name, ln.text)) return;
        const s = phraseSummary(e);
        scCount++;
        const isSel = sel.kind === 'phrase' && sel.key === ph.key;
        const st = s.ok ? '<span class="st mark ok">○</span>' : s.maybe ? '<span class="st mark maybe">△</span>' : '<span class="st"></span>';
        const pause = pi < phs.length - 1 ? '' : '';
        rows.push(`<div class="ph${isSel ? ' sel' : ''}" data-ph="${esc(ph.key)}" data-drop="${esc(ph.key)}">${st}<span class="txt">${esc(ph.text)}</span><span class="badges">${s.best < 9 ? `<span class="lv lv${s.best}">L${s.best}</span>` : ''}${pi === phs.length - 1 && lineAd ? `<span class="badge ad">アドリブ ${lineAd}</span>` : ''}${s.ng ? `<span class="badge ng">NG ${s.ng}</span>` : ''}<span class="n${s.takes ? '' : ' zero'}">${s.takes}</span></span></div>${pause}`);
      });
      if (!rows.length) continue;
      if (ln.role !== lastRole) { parts.push(`<div class="role">${esc(ln.role)}</div>`); lastRole = ln.role; }
      parts.push(`<div class="lineBox" data-line="${esc(ln.id)}">${rows.join('')}${cutEditLine === ln.id ? cutEditor(ln) : ''}</div>`);
    }
    // アドリブ
    const ads = D.adlibs.filter(a => a.sceneId === sc.id && (!filterTree || matchesQuery(query, a.text)));
    if (ads.length) {
      parts.push(`<div class="adHead" data-drop="adlib">アドリブ</div><div class="lineBox">`);
      for (const a of ads) {
        const isSel = sel.kind === 'adlib' && sel.key === a.key;
        const ok = a.cams.some(c => statusOf(a, c.fileKey) === 'ok');
        parts.push(`<div class="ph adItem${isSel ? ' sel' : ''}" data-ad="${esc(a.key)}">${ok ? '<span class="st mark ok">○</span>' : '<span class="st"></span>'}<span class="txt">${esc(a.text)}</span><span class="badges">${a.take ? `<span class="badge">T${a.take}</span>` : ''}</span></div>`);
      }
      parts.push('</div>');
    } else if (!filterTree) parts.push(`<div class="adHead" data-drop="adlib" style="opacity:.35">アドリブ</div>`);
    if (filterTree && !scCount && !ads.length) continue;
    const runsN = P.runs.filter(r => r.sceneId === sc.id).length;
    h.push(`<div class="scene"><div class="sceneH" data-scene="${esc(sc.id)}">${esc(sc.name)}<span class="cnt">テイク ${runsN}</span></div>${parts.join('')}</div>`);
  }
  // どの場面にも入らないアドリブ
  const orphan = D.adlibs.filter(a => !a.sceneId && (!filterTree || matchesQuery(query, a.text)));
  if (orphan.length) {
    h.push(`<div class="scene"><div class="sceneH">台本外の発話<span class="cnt">${orphan.length}</span></div><div class="lineBox">`);
    for (const a of orphan) h.push(`<div class="ph adItem${sel.kind === 'adlib' && sel.key === a.key ? ' sel' : ''}" data-ad="${esc(a.key)}"><span class="st"></span><span class="txt">${esc(a.text)}</span></div>`);
    h.push('</div></div>');
  }
  el.innerHTML = h.join('');
  $('#left').scrollTop = scrollTop;
}

function cutEditor(ln) {
  const cuts = new Set(ln.cuts || []);
  let s = '';
  for (let i = 0; i < ln.text.length; i++) {
    if (i > 0) s += `<span class="gap${cuts.has(i) ? ' on' : ''}" data-cut="${i}"></span>`;
    s += esc(ln.text[i]);
  }
  return `<div class="cutEd" data-line="${esc(ln.id)}"><div class="chars">${s}</div><div class="row"><button data-act="cutauto" data-line="${esc(ln.id)}">自動</button><button data-act="cutdone">完了</button></div></div>`;
}

function findLine(id) { for (const sc of P.scenes) for (const ln of sc.lines) if (ln.id === id) return ln; return null; }

// ===== 描画：テイク一覧 =====
function currentEntry() {
  if (!D) return null;
  if (sel.kind === 'phrase') {
    const e = D.phrases.get(sel.key);
    return e ? { title: e.phrase.text, sub: `${e.scene.name}・${e.line.role}`, items: e.takes } : null;
  }
  if (sel.kind === 'adlib') {
    const a = D.adlibs.find(x => x.key === sel.key);
    if (!a) return null;
    const sc = P.scenes.find(s => s.id === a.sceneId);
    return { title: a.text, sub: `${sc ? sc.name : '台本外'}・アドリブ`, items: [a] };
  }
  return null;
}

function cardList() {
  const e = currentEntry();
  if (!e) return [];
  const q = query.trim();
  const takeQ = q.match(/^(?:take|テイク)\s*(\d+)$/i);
  const out = [];
  for (const it of e.items) {
    if (takeQ && it.take !== +takeQ[1]) continue;
    for (const c of it.cams) {
      if (c.isAudio && it.cams.some(x => !x.isAudio)) continue;
      if (q && !takeQ && new Set(Object.keys(P.media).map(k => cameraOf(P, k))).has(q) && c.camera !== q) continue;
      out.push({ it, c });
    }
  }
  return out;
}

function renderTakes() {
  const el = $('#takes');
  const e = currentEntry();
  if (!e) { el.innerHTML = `<div class="empty">${P.scenes.length ? 'セリフを選択' : ''}</div>`; return; }
  const list = cardList();
  const byCam = new Map();
  for (const x of list) { if (!byCam.has(x.c.camera)) byCam.set(x.c.camera, []); byCam.get(x.c.camera).push(x); }
  const cams = [...byCam.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  const lineId = sel.kind === 'phrase' && D.phrases.get(sel.key) ? D.phrases.get(sel.key).line.id : null;
  const h = [`<div class="tkHead"><span class="ph">${esc(e.title)}</span><span class="meta">${esc(e.sub)}・テイク ${new Set(e.items.map(i => i.runId)).size}・素材 ${list.length}</span>${lineId ? `<button class="tkCut" data-act="cut" data-line="${esc(lineId)}">区切り編集</button>` : ''}</div>`];
  if (!list.length) h.push(`<div class="empty">${running ? '解析中' : '該当する素材なし'}</div>`);
  for (const cam of cams) {
    h.push(`<div class="camRow"><div class="camName">${esc(cam)}</div><div class="cards">`);
    for (const { it, c } of byCam.get(cam)) {
      const st = statusOf(it, c.fileKey);
      const isSel = sel.item && sel.item.key === it.key && sel.cam && sel.cam.fileKey === c.fileKey;
      const chips = [...it.ng.map(n => `<span class="chip ng">${esc(n)}</span>`), ...c.ng.map(n => `<span class="chip ng">${esc(n)}</span>`)];
      if (it.moved) chips.push('<span class="chip mv">手動</span>');
      if (it.adjusted) chips.push('<span class="chip mv">範囲修正</span>');
      if (it.gapAfter != null && it.gapAfter >= 0.4) chips.push(`<span class="chip">間 ${it.gapAfter.toFixed(1)}秒</span>`);
      const thumb = thumbs.get(thumbKey(c.fileKey, (c.in + c.out) / 2));
      h.push(`<div class="card${isSel ? ' sel' : ''}${st ? ' st-' + st : ''}" draggable="true" data-item="${esc(it.key)}" data-file="${esc(c.fileKey)}">
        <div class="th" data-thumb="${esc(thumbKey(c.fileKey, (c.in + c.out) / 2))}" style="${thumb ? `background-image:url(${thumb})` : ''}"><span class="mark ${st}">${MARK[st] || ''}</span><span class="dur">${(c.out - c.in).toFixed(1)}秒</span></div>
        <div class="b"><div class="t1"><span>${it.take ? 'Take ' + it.take : '台本外'}</span>${it.level ? `<span class="lv lv${it.level}">L${it.level}</span>` : ''}</div>
        <div class="chips">${chips.join('')}</div>
        <div class="stbtns"><button class="ok${st === 'ok' ? ' on ok' : ''}" data-st="ok">○</button><button class="maybe${st === 'maybe' ? ' on maybe' : ''}" data-st="maybe">△</button><button class="ng${st === 'ng' ? ' on ng' : ''}" data-st="ng">×</button></div></div></div>`);
    }
    h.push('</div></div>');
  }
  el.innerHTML = h.join('');
  queueThumbs(list);
}

// ===== サムネイル =====
const thumbs = new Map();
const thumbKey = (fk, t) => fk + '@' + t.toFixed(1);
let thumbQ = [], thumbBusy = false, thumbVideo = null;
function queueThumbs(list) {
  thumbQ = list.map(x => ({ fk: x.c.fileKey, t: (x.c.in + x.c.out) / 2 })).filter(x => files.has(x.fk) && !thumbs.has(thumbKey(x.fk, x.t)));
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQ.length) {
      const { fk, t } = thumbQ.shift();
      const k = thumbKey(fk, t);
      if (thumbs.has(k)) continue;
      let blob = await store.get('thumb', k).catch(() => null);
      if (!blob) blob = await grabThumb(fk, t);
      if (!blob) continue;
      const u = URL.createObjectURL(blob);
      thumbs.set(k, u);
      store.put('thumb', k, blob).catch(() => { });
      document.querySelectorAll(`[data-thumb="${CSS.escape(k)}"]`).forEach(n => { n.style.backgroundImage = `url(${u})`; });
    }
  } finally { thumbBusy = false; }
}
async function grabThumb(fk, t) {
  const md = P.media[fk];
  if (!md || !md.info || !md.info.hasVideo) return null;
  if (!thumbVideo) { thumbVideo = document.createElement('video'); thumbVideo.muted = true; thumbVideo.playsInline = true; thumbVideo.preload = 'auto'; }
  const v = thumbVideo;
  const u = urlOf(fk);
  if (!u) return null;
  try {
    if (v.src !== u) { v.src = u; await once(v, 'loadedmetadata', 8000); }
    v.currentTime = Math.min(Math.max(0, t), (v.duration || t + 1) - 0.05);
    await once(v, 'seeked', 8000);
    const c = document.createElement('canvas');
    c.width = 320; c.height = Math.round(320 * (v.videoHeight || 9) / (v.videoWidth || 16));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
  } catch (e) { return null; }
}
function once(el, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, f); rej(new Error('timeout')); }, ms);
    const f = () => { clearTimeout(t); res(); };
    el.addEventListener(ev, f, { once: true });
  });
}
function urlOf(fk) {
  if (urls.has(fk)) return urls.get(fk);
  const f = files.get(fk);
  if (!f) return null;
  const u = f instanceof RemoteFile ? new URL('/media?p=' + encodeURIComponent(f.abs), location.href).href : URL.createObjectURL(f);
  urls.set(fk, u);
  return u;
}

// ===== プレビュー =====
const video = $('#video');
const player = { item: null, cam: null, win: [0, 1], stopAt: null, playlist: null, pi: 0, raf: 0 };

function selectCard(it, c, autoplay = true) {
  sel.item = it; sel.cam = c;
  document.querySelectorAll('.card.sel').forEach(n => n.classList.remove('sel'));
  const n = document.querySelector(`.card[data-item="${CSS.escape(it.key)}"][data-file="${CSS.escape(c.fileKey)}"]`);
  if (n) { n.classList.add('sel'); n.scrollIntoView({ block: 'nearest' }); }
  renderEmpty();
  loadClip(it, c, autoplay);
}

async function loadClip(it, c, autoplay) {
  player.item = it; player.cam = c;
  const pre = P.settings.padPre, post = P.settings.padPost;
  const dur = (P.media[c.fileKey].info || {}).duration || c.out + 5;
  player.win = [Math.max(0, c.in - pre - 0.7), Math.min(dur, c.out + post + 0.7)];
  $('#pvInfo').textContent = `${it.take ? 'Take ' + it.take : '台本外'}・${c.camera}・${P.media[c.fileKey].name}`;
  drawRange();
  const u = urlOf(c.fileKey);
  if (!u) { toast('素材が未接続です'); return; }
  if (video.src !== u) {
    video.src = u;
    try { await once(video, 'loadedmetadata', 10000); } catch (e) { toast('この形式はプレビューできません'); return; }
  }
  video.currentTime = Math.max(0, c.in - pre);
  player.stopAt = Math.min(dur, c.out + post);
  if (autoplay) { try { await video.play(); } catch (e) { } }
  tick();
}

function drawRange() {
  const c = player.cam;
  if (!c) return;
  const [w0, w1] = player.win;
  const W = $('#rtrack').clientWidth;
  const x = (t) => (t - w0) / (w1 - w0) * W;
  const sp = speechOf(c.fileKey);
  $('#rwave').innerHTML = sp ? sp.voiced.filter(v => v[1] > w0 && v[0] < w1).map(v => `<i style="left:${x(v[0])}px;width:${Math.max(1, x(v[1]) - x(v[0]))}px"></i>`).join('') : '';
  const rs = $('#rsel');
  rs.style.width = Math.max(2, x(c.out) - x(c.in)) + 'px';
  rs.style.transform = `translateX(${x(c.in)}px)`;
}

function tick() {
  cancelAnimationFrame(player.raf);
  const step = () => {
    const [w0, w1] = player.win;
    const W = $('#rtrack').clientWidth;
    const t = video.currentTime;
    $('#rhead').style.transform = `translateX(${Math.max(0, Math.min(W - 2, (t - w0) / (w1 - w0) * W))}px)`;
    $('#pvTime').textContent = fmtTime(t);
    if (player.stopAt != null && !video.paused && t >= player.stopAt) {
      video.pause();
      if (player.playlist) { nextInPlaylist(); return; }
    }
    $('#bPlay').textContent = video.paused ? '再生' : '停止';
    player.raf = requestAnimationFrame(step);
  };
  player.raf = requestAnimationFrame(step);
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function playPause() {
  if (!player.cam) { const l = cardList(); if (l.length) selectCard(l[0].it, l[0].c); return; }
  if (video.paused) {
    if (player.stopAt != null && video.currentTime >= player.stopAt - 0.02) video.currentTime = Math.max(0, player.cam.in - P.settings.padPre);
    video.play().catch(() => { });
  } else { video.pause(); player.playlist = null; }
}

function startPlaylist(list) {
  if (!list.length) return;
  player.playlist = list; player.pi = 0;
  const x = list[0];
  selectCard(x.it, x.c, true);
}
function nextInPlaylist() {
  const l = player.playlist;
  player.pi++;
  if (!l || player.pi >= l.length) { player.playlist = null; return; }
  const x = l[player.pi];
  selectCard(x.it, x.c, true);
}
function seqPlay() {
  // 同じセリフの全テイクを順番に（選択中のカメラを優先）
  const l = cardList();
  const cam = sel.cam ? sel.cam.camera : null;
  const list = cam ? l.filter(x => x.c.camera === cam) : l;
  startPlaylist(list.length ? list : l);
}
function camCompare() {
  const l = cardList();
  const it = sel.item || (l[0] && l[0].it);
  if (!it) return;
  startPlaylist(l.filter(x => x.it.key === it.key));
}

// 範囲の手動修正
function setRange(which, fileTime) {
  const it = player.item, c = player.cam;
  if (!it || !c) return;
  const shift = c.in - it.t0;
  const repT = fileTime - shift;
  let t0 = it.t0, t1 = it.t1;
  if (which === 0) t0 = Math.min(repT, t1 - 0.05); else t1 = Math.max(repT, t0 + 0.05);
  P.user.adjust[it.key] = { t0, t1 };
  save();
  refreshKeepSel();
}
function resetRange() {
  const it = player.item;
  if (!it) return;
  delete P.user.adjust[it.key];
  save();
  refreshKeepSel();
}
function refreshKeepSel() {
  const ik = sel.item && sel.item.key, fk = sel.cam && sel.cam.fileKey;
  D = derive(P, { speechOf });
  render();
  if (ik) {
    const x = cardList().find(x => x.it.key === ik && x.c.fileKey === fk);
    if (x) {
      sel.item = x.it; sel.cam = x.c; player.item = x.it; player.cam = x.c;
      const n = document.querySelector(`.card[data-item="${CSS.escape(ik)}"][data-file="${CSS.escape(fk)}"]`);
      if (n) n.classList.add('sel');
      player.stopAt = x.c.out + P.settings.padPost;
      drawRange();
    }
  }
}

function setupRangeDrag() {
  const tr = $('#rtrack');
  let drag = null;
  const tAt = (clientX) => {
    const r = tr.getBoundingClientRect();
    const [w0, w1] = player.win;
    return w0 + (clientX - r.left) / r.width * (w1 - w0);
  };
  const snapT = (t) => {
    // 発話の境目へ吸い付く
    const c = player.cam; if (!c) return t;
    const sp = speechOf(c.fileKey);
    const r = tr.getBoundingClientRect();
    const pxPerS = r.width / (player.win[1] - player.win[0]);
    let best = t, bd = 8 / pxPerS;
    if (sp) for (const v of sp.voiced) for (const e of v) { const d = Math.abs(e - t); if (d < bd) { bd = d; best = e; } }
    return best;
  };
  tr.addEventListener('pointerdown', (e) => {
    if (!player.cam) return;
    const h = e.target.dataset && e.target.dataset.h;
    if (h != null) { drag = { h: +h }; tr.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    video.currentTime = Math.max(0, tAt(e.clientX));
    drag = { seek: true }; tr.setPointerCapture(e.pointerId);
  });
  tr.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = tAt(e.clientX);
    if (drag.seek) { video.currentTime = Math.max(0, t); return; }
    const c = player.cam;
    const st = snapT(t);
    if (drag.h === 0) c.in = Math.min(st, c.out - 0.05); else c.out = Math.max(st, c.in + 0.05);
    drawRange();
  });
  tr.addEventListener('pointerup', () => {
    if (drag && drag.h != null) {
      const c = player.cam;
      setRange(drag.h, drag.h === 0 ? c.in : c.out);
    }
    drag = null;
  });
}

// ===== 状態の設定 =====
function setStatusOf(it, fk, st) {
  const k = it.key + '|' + fk;
  if (!st || P.user.status[k] === st) delete P.user.status[k]; else P.user.status[k] = st;
  save();
  const ik = sel.item && sel.item.key, sf = sel.cam && sel.cam.fileKey;
  renderTree(); renderTakes();
  if (ik) { const n = document.querySelector(`.card[data-item="${CSS.escape(ik)}"][data-file="${CSS.escape(sf)}"]`); if (n) n.classList.add('sel'); }
}

// ===== 選択 =====
function selectPhrase(key, kind = 'phrase') {
  sel = { kind, key, item: null, cam: null };
  video.pause(); player.playlist = null; player.cam = null; player.item = null;
  $('#pvInfo').textContent = ''; $('#rwave').innerHTML = ''; $('#rsel').style.width = '0';
  renderTree(); renderTakes(); renderEmpty();
  const l = cardList();
  // 採用済みがあればそれ、なければ先頭
  const pick = l.find(x => statusOf(x.it, x.c.fileKey) === 'ok') || l[0];
  if (pick) selectCard(pick.it, pick.c, false);
}

function allPhraseKeys() {
  const out = [];
  for (const sc of P.scenes) for (const ln of sc.lines) for (const ph of phrasesOf(ln)) out.push(ph.key);
  return out;
}

// ===== イベント =====
function setupEvents() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTimeout(() => b.blur(), 0);
  });
  $('#tree').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) return handleAct(act.dataset.act, act);
    const gap = e.target.closest('[data-cut]');
    if (gap) {
      const ln = findLine(gap.closest('.cutEd').dataset.line);
      const i = +gap.dataset.cut;
      const s = new Set(ln.cuts || []);
      s.has(i) ? s.delete(i) : s.add(i);
      ln.cuts = [...s].sort((a, b) => a - b); ln.userCuts = true; P.cutsByText[ln.text] = ln.cuts;
      D = derive(P, { speechOf }); save(); renderTree();
      return;
    }
    const ph = e.target.closest('[data-ph]');
    if (ph) return selectPhrase(ph.dataset.ph);
    const ad = e.target.closest('[data-ad]');
    if (ad) return selectPhrase(ad.dataset.ad, 'adlib');
  });
  $('#pvEmpty').addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (a) handleAct(a.dataset.act, a); });
  $('#takes').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) return handleAct(act.dataset.act, act);
    const card = e.target.closest('.card');
    if (!card) return;
    const x = cardList().find(x => x.it.key === card.dataset.item && x.c.fileKey === card.dataset.file);
    if (!x) return;
    const stb = e.target.closest('[data-st]');
    if (stb) { setStatusOf(x.it, x.c.fileKey, stb.dataset.st); return; }
    player.playlist = null;
    selectCard(x.it, x.c, true);
  });
  // ドラッグで別セリフへ移動
  $('#takes').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.dataTransfer.setData('text/x-serifu-item', card.dataset.item);
    e.dataTransfer.effectAllowed = 'move';
  });
  const tree = $('#tree');
  tree.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/x-serifu-item')) return;
    const t = e.target.closest('[data-drop]');
    tree.querySelectorAll('.drop').forEach(n => n !== t && n.classList.remove('drop'));
    if (t) { e.preventDefault(); t.classList.add('drop'); }
  });
  tree.addEventListener('dragleave', (e) => { const t = e.target.closest('[data-drop]'); if (t) t.classList.remove('drop'); });
  tree.addEventListener('drop', (e) => {
    const t = e.target.closest('[data-drop]');
    const key = e.dataTransfer.getData('text/x-serifu-item');
    tree.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'));
    if (!t || !key) return;
    e.preventDefault(); e.stopPropagation();
    const target = t.dataset.drop;
    const origPh = key.includes('|') ? key.split('|')[1] : null;
    if (target === origPh) delete P.user.overrides[key];
    else P.user.overrides[key] = target;
    D = derive(P, { speechOf }); save();
    render();
    toast(target === 'adlib' ? 'アドリブへ移動しました' : '移動しました');
  });

  $('#bAdd').onclick = pickFolder;
  $('#fileInput').onchange = async (e) => {
    const list = [...e.target.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
    e.target.value = '';
    await withBusy(() => registerFiles(list));
  };
  $('#bScript').onclick = openScript;
  $('#bMedia').onclick = openMedia;
  $('#bSettings').onclick = openSettings;
  $('#bExport').onclick = openExport;
  $('#bPlay').onclick = playPause;
  $('#bSeq').onclick = seqPlay;
  $('#bCamCmp').onclick = camCompare;
  $('#bIn').onclick = () => setRange(0, video.currentTime);
  $('#bOut').onclick = () => setRange(1, video.currentTime);
  $('#bResetRange').onclick = resetRange;
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderTree(); renderTakes(); });
  const pn = $('#projName');
  pn.addEventListener('change', () => { P.name = pn.value.trim() || '新規プロジェクト'; save(); });
  pn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) pn.blur(); });
  $('#sheet').addEventListener('pointerdown', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  window.addEventListener('resize', drawRange);

  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if ($('#sheet').classList.contains('on')) { if (e.key === 'Escape') closeSheet(); return; }
    const k = e.key;
    if (k === ' ') { e.preventDefault(); playPause(); }
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const keys = allPhraseKeys().filter(k2 => D && D.phrases.get(k2));
      let i = keys.indexOf(sel.key);
      i = k === 'ArrowDown' ? Math.min(keys.length - 1, i + 1) : Math.max(0, i - 1);
      if (keys[i]) { selectPhrase(keys[i]); const n = document.querySelector(`[data-ph="${CSS.escape(keys[i])}"]`); if (n) n.scrollIntoView({ block: 'nearest' }); }
    } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      const l = cardList();
      let i = l.findIndex(x => sel.item && x.it.key === sel.item.key && x.c.fileKey === sel.cam.fileKey);
      i = k === 'ArrowRight' ? Math.min(l.length - 1, i + 1) : Math.max(0, i - 1);
      if (l[i]) { player.playlist = null; selectCard(l[i].it, l[i].c, true); }
    } else if (k === '1' || k === '2' || k === '3' || k === '0') {
      if (sel.item && sel.cam) setStatusOf(sel.item, sel.cam.fileKey, { 1: 'ok', 2: 'maybe', 3: 'ng', 0: '' }[k]);
    } else if (k === 'i' || k === 'I') setRange(0, video.currentTime);
    else if (k === 'o' || k === 'O') setRange(1, video.currentTime);
    else if (k === 'c' || k === 'C') seqPlay();
  });
}

async function handleAct(act, el) {
  if (act === 'pick' || act === 'reconnect') {
    if (act === 'reconnect' && !LOCAL && window.showDirectoryPicker) {
      const need = await withBusy(() => restoreHandles(true));
      if (missingCount()) pickFolder();
      return;
    }
    return pickFolder();
  }
  if (act === 'script') return openScript();
  if (act === 'cut') {
    cutEditLine = cutEditLine === el.dataset.line ? null : el.dataset.line; renderTree();
    const n = document.querySelector('.cutEd'); if (n) n.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (act === 'cutdone') { cutEditLine = null; renderTree(); renderTakes(); return; }
  if (act === 'cutauto') {
    const ln = findLine(el.dataset.line);
    ln.cuts = autoCuts(ln.text); ln.userCuts = false; delete P.cutsByText[ln.text];
    D = derive(P, { speechOf }); save(); renderTree();
  }
}

// ===== シート =====
function openSheet(html) { $('#sheetIn').innerHTML = html; $('#sheet').classList.add('on'); }
function closeSheet() { $('#sheet').classList.remove('on'); }

function openScript() {
  openSheet(`<h2>台本<span class="sp"></span><button id="sFile">台本ファイル読込</button><button id="sApply" class="primary">台本反映</button></h2>
    <textarea id="sText" spellcheck="false" placeholder="# Scene 1&#10;A「ふざけんなよ、あいつのこと忘れんなよ。」&#10;B「そうだけど。」">${esc(P.scriptText)}</textarea>`);
  $('#sApply').onclick = async () => {
    try { await withBusy(() => applyScript($('#sText').value)); }
    catch (e) { console.error(e); toast('台本の読み込みエラー：' + (e.message || e)); return; }
    const n = P.scenes.reduce((a, s) => a + s.lines.length, 0);
    closeSheet(); render();
    toast(n ? `台本を反映しました（${P.scenes.length}シーン・${n}セリフ）` : 'セリフが見つかりませんでした');
  };
  $('#sFile').onclick = () => $('#scriptInput').click();
}

function openMedia() {
  const list = Object.values(P.media).sort((a, b) => (a.rel || a.name).localeCompare(b.rel || b.name, 'ja', { numeric: true }));
  const takeOf = new Map();
  for (const g of P.groups) for (const m of g.members) {
    const rs = P.runs.filter(r => r.groupId === g.id).map(r => `${(P.scenes.find(s => s.id === r.sceneId) || {}).name || ''} T${r.take}`);
    takeOf.set(m.key, rs.join('・'));
  }
  const rows = list.map(m => {
    const i = m.info || {};
    const state = !files.has(m.key) ? '<td class="missing">未接続</td>' : m.error ? `<td class="err">${esc(m.error)}</td>` : m.asrError ? `<td class="err">${esc(m.asrError)}</td>` : m.speech ? '<td class="ok">解析済み</td>' : '<td>待機中</td>';
    return `<tr><td>${esc(m.rel || m.name)}</td><td><input data-cam="${esc(m.key)}" value="${esc(cameraOf(P, m.key))}"></td><td>${i.duration ? fmtTime(i.duration) : ''}</td><td>${i.width ? `${i.width}×${i.height}` : i.kind === 'audio' ? '音声' : ''} ${i.rate ? i.rate.fps : ''}</td><td>${esc(takeOf.get(m.key) || '')}</td>${state}</tr>`;
  }).join('');
  openSheet(`<h2>素材一覧<span class="sp"></span><button id="mRe">再解析</button><button id="mClose">閉じる</button></h2>
    <table class="media"><thead><tr><th>ファイル</th><th>カメラ</th><th>長さ</th><th>形式</th><th>テイク</th><th>状態</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">素材がありません</td></tr>'}</tbody></table>`);
  $('#mClose').onclick = closeSheet;
  $('#sheetIn').querySelectorAll('[data-cam]').forEach(inp => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) inp.blur(); });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const md = P.media[inp.dataset.cam];
      if (!v || v === md.cameraAuto) delete P.user.cameraNames[inp.dataset.cam]; else P.user.cameraNames[inp.dataset.cam] = v;
      save();
      runPipeline();
    });
  });
  twoStep($('#mRe'), '再解析を確定', async () => {
    for (const m of Object.values(P.media)) { delete m.speech; delete m.error; delete m.asrError; delete m.info; }
    P.transcripts = {}; P.groups = []; P.runs = [];
    save(); closeSheet(); runPipeline();
  });
}

function twoStep(btn, label, fn) {
  const orig = btn.textContent;
  let armed = false, t = null;
  btn.onclick = () => {
    if (!armed) {
      armed = true; btn.textContent = label; btn.classList.add('confirm');
      t = setTimeout(() => { armed = false; btn.textContent = orig; btn.classList.remove('confirm'); }, 3000);
      return;
    }
    clearTimeout(t); armed = false; btn.textContent = orig; btn.classList.remove('confirm');
    fn();
  };
}

function numInput(id, val, min, max, step) {
  return `<input type="text" inputmode="decimal" id="${id}" value="${val}" data-min="${min}" data-max="${max}" style="width:80px">`;
}
function bindNum(id, apply) {
  const el = $('#' + id);
  const commit = () => {
    let v = parseFloat(zen2han(el.value));
    if (isNaN(v)) v = +el.defaultValue;
    v = Math.max(+el.dataset.min, Math.min(+el.dataset.max, v));
    v = Math.round(v * 10) / 10;
    el.value = v; apply(v);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) el.blur(); });
}

function openSettings() {
  const s = P.settings;
  openSheet(`<h2>設定<span class="sp"></span><button id="stClose">閉じる</button></h2>
    <div class="frow"><label>セリフ前の余白</label>${numInput('padPre', s.padPre, 0, 3)}<span>秒</span></div>
    <div class="frow"><label>セリフ後の余白</label>${numInput('padPost', s.padPost, 0, 3)}<span>秒</span></div>
    ${LOCAL && LOCAL.whisper ? '' : `<div class="frow"><label>文字起こしの精度</label><select id="quality"><option value="high">高精度</option><option value="std">標準</option><option value="light">軽量</option></select></div>`}
    <div class="frow"><label>文字起こし</label><button id="reAsr">文字起こし再実行</button></div>
    <div class="frow"><label>プロジェクト</label><button id="reset">プロジェクト初期化</button></div>
    <div class="frow"><label>操作キー</label><span style="color:var(--fg2)">Space 再生・↑↓ セリフ・←→ テイク・1 ○・2 △・3 ×・0 未選択・I 開始位置・O 終了位置・C 連続再生</span></div>`);
  if ($('#quality')) { $('#quality').value = s.quality; $('#quality').onchange = (e) => { s.quality = e.target.value; save(); }; }
  bindNum('padPre', (v) => { s.padPre = v; save(); });
  bindNum('padPost', (v) => { s.padPost = v; save(); });
  $('#stClose').onclick = closeSheet;
  twoStep($('#reAsr'), '再実行を確定', () => { P.transcripts = {}; save(); closeSheet(); runPipeline(); });
  twoStep($('#reset'), '初期化を確定', async () => {
    P = newProject(); files.clear(); D = null; sel = { kind: null };
    await store.clear('env'); await store.clear('handles'); await store.clear('thumb');
    await store.put('kv', 'project', P);
    $('#projName').value = P.name;
    closeSheet(); render(); setStatus('', false);
  });
}

// ===== 書き出し =====
function chooseForPhrase(entry, mode) {
  for (const t of entry.takes) for (const c of t.cams) if (!c.isAudio && statusOf(t, c.fileKey) === 'ok') return { it: t, c };
  if (mode !== 'auto') return null;
  const cands = [];
  for (const t of entry.takes) for (const c of t.cams) {
    if (c.isAudio || statusOf(t, c.fileKey) === 'ng') continue;
    cands.push({ it: t, c, s: (t.level || 4) * 10 + (t.ng.length + c.ng.length) * 5 + (statusOf(t, c.fileKey) === 'maybe' ? -3 : 0) });
  }
  cands.sort((a, b) => a.s - b.s);
  return cands[0] || null;
}

function buildSelection() {
  const s = P.settings;
  const out = [];
  if (!D) return out;
  for (const sc of P.scenes) {
    for (const ln of sc.lines) {
      for (const ph of phrasesOf(ln)) {
        const e = D.phrases.get(ph.key);
        if (!e) continue;
        const ch = chooseForPhrase(e, s.unselected);
        if (ch) out.push({ ...ch, label: ph.text, role: ln.role, scene: sc.name });
      }
      for (const a of D.adlibs.filter(a => a.lineId === ln.id)) {
        const c = a.cams.find(c => !c.isAudio && statusOf(a, c.fileKey) === 'ok');
        if (c) out.push({ it: a, c, label: a.text, role: ln.role, scene: sc.name });
      }
    }
    for (const a of D.adlibs.filter(a => a.sceneId === sc.id && !a.lineId)) {
      const c = a.cams.find(c => !c.isAudio && statusOf(a, c.fileKey) === 'ok');
      if (c) out.push({ it: a, c, label: a.text, scene: sc.name });
    }
  }
  return out;
}

function openExport() {
  const s = P.settings;
  const total = D ? D.phrases.size : 0;
  let chosen = 0;
  if (D) for (const e of D.phrases.values()) if (chooseForPhrase(e, 'none')) chosen++;
  const hasAudio = Object.values(P.media).some(m => m.info && m.info.kind === 'audio');
  openSheet(`<h2>FCPXML書き出し<span class="sp"></span><button id="exClose">閉じる</button></h2>
    <div class="frow"><label>セリフ</label><span>${total}・採用済み ${chosen}</span></div>
    ${LOCAL ? '' : `<div class="frow"><label>素材フォルダの場所</label><input type="text" id="basePath" value="${esc(s.basePath)}" placeholder="Finderで素材フォルダを選んで ⌥⌘C → ここに貼り付け" spellcheck="false"></div>`}
    <div class="frow"><label>未選択のセリフ</label><select id="unsel"><option value="auto">自動候補</option><option value="none">除外</option></select></div>
    <div class="frow"><label>同じテイクの連続</label><select id="join"><option value="1">間ごと結合</option><option value="0">セリフごと分割</option></select></div>
    ${hasAudio ? `<div class="frow"><label>外部音声</label><select id="ext"><option value="1">下に配置</option><option value="0">配置なし</option></select></div>` : ''}
    <div class="frow"><label>イベント内の整理</label><select id="kw"><option value="1">セリフのキーワード付与</option><option value="0">なし</option></select></div>
    <div class="btnrow"><button id="exGo" class="primary">書き出し</button></div>`);
  $('#unsel').value = s.unselected; $('#join').value = s.joinTakes ? '1' : '0'; $('#kw').value = s.keywords ? '1' : '0';
  if ($('#ext')) $('#ext').value = s.extAudio ? '1' : '0';
  const bp = $('#basePath');
  const cleanPath = (v) => v.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ').replace(/^file:\/\//, '').replace(/\/+$/, '');
  if (bp) {
    bp.addEventListener('change', () => { bp.value = cleanPath(bp.value); s.basePath = bp.value; save(); });
    bp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) bp.blur(); });
  }
  $('#unsel').onchange = (e) => { s.unselected = e.target.value; save(); };
  $('#join').onchange = (e) => { s.joinTakes = e.target.value === '1'; save(); };
  $('#kw').onchange = (e) => { s.keywords = e.target.value === '1'; save(); };
  if ($('#ext')) $('#ext').onchange = (e) => { s.extAudio = e.target.value === '1'; save(); };
  $('#exClose').onclick = closeSheet;
  $('#exGo').onclick = () => { if (bp) { bp.value = cleanPath(bp.value); s.basePath = bp.value; } save(); doExport(); };
}

function doExport() {
  const s = P.settings;
  const selList = buildSelection();
  if (!selList.length) { toast('書き出すセリフがありません'); return; }
  if (!LOCAL && (!s.basePath || !s.basePath.startsWith('/'))) { toast('素材フォルダの場所を貼り付けてください'); $('#basePath').focus(); return; }
  // 同じテイク・同じ素材が続く場合は結合
  const segs = [];
  for (const x of selList) {
    const last = segs[segs.length - 1];
    if (s.joinTakes && last && last.fileKey === x.c.fileKey && last.runId === x.it.runId && x.c.in >= last.coreOut - 0.05 && x.c.in - last.coreOut < 8) {
      last.coreOut = x.c.out; last.labels.push(x.label);
      continue;
    }
    segs.push({ fileKey: x.c.fileKey, runId: x.it.runId, coreIn: x.c.in, coreOut: x.c.out, labels: [x.label], it: x.it, cam: x.c, groupId: x.it.groupId });
  }
  const clips = segs.map(g => {
    const dur = P.media[g.fileKey].info.duration || g.coreOut + 5;
    return { fileKey: g.fileKey, in: Math.max(0, g.coreIn - s.padPre), out: Math.min(dur, g.coreOut + s.padPost), name: g.labels.join(' '), marker: g.labels.join(' '), groupId: g.groupId, cam: g.cam };
  });
  // 外部音声
  let audioPairs = null;
  if (s.extAudio) {
    audioPairs = clips.map(c => {
      const g = P.groups.find(g => g.id === c.groupId);
      if (!g) return null;
      const me = g.members.find(m => m.key === c.fileKey);
      const au = g.members.find(m => P.media[m.key] && P.media[m.key].info && P.media[m.key].info.kind === 'audio');
      if (!me || !au) return null;
      return { fileKey: au.key, in: c.in - me.shift + au.shift };
    });
    if (!audioPairs.some(Boolean)) audioPairs = null;
  }
  // キーワード（全素材・全テイク）
  const keywordClips = [];
  if (s.keywords && D) {
    for (const e of D.phrases.values()) for (const t of e.takes) for (const c of t.cams) {
      if (!files.has(c.fileKey) && !P.media[c.fileKey]) continue;
      keywordClips.push({ fileKey: c.fileKey, in: c.in, out: c.out, keyword: `${e.scene.name} ${e.line.role} ${e.phrase.text}`.slice(0, 120) });
    }
    for (const a of D.adlibs) for (const c of a.cams) keywordClips.push({ fileKey: c.fileKey, in: c.in, out: c.out, keyword: 'アドリブ' });
  }
  const xml = buildFcpxml({ clips, media: P.media, basePath: s.basePath, projectName: P.name, eventName: P.name, keywordClips, audioPairs });
  if (LOCAL) {
    const dir = (P.roots && P.roots[0]) || '';
    awaitJob(fetch('/api/save-fcpxml', { method: 'POST', body: JSON.stringify({ name: P.name || 'セリフテイク', xml, dir, open: true }) }).then(r => r.json())).then(r => {
      if (r && r.error) { toast('保存できませんでした：' + r.error); return; }
      if (!r || r.cancel) return;
      closeSheet();
      toast(r.opened ? `Final Cut Proで開きました（${clips.length}カット）・${r.path.split('/').pop()}` : `書き出しました：${r.path}`);
    });
    return;
  }
  const blob = new Blob([xml], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (P.name || 'セリフテイク').replace(/[\/\\:*?"<>|]/g, '_') + '.fcpxml';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  closeSheet();
  toast(`FCPXMLを書き出しました（${clips.length}カット）`);
}

// ===== 分割線（中央などへ吸い付く） =====
function setupSplitters() {
  const root = document.documentElement;
  const lw = localStorage.getItem('st-leftw'), th = localStorage.getItem('st-toph');
  if (lw) root.style.setProperty('--leftw', lw);
  if (th) root.style.setProperty('--toph', th);
  const drag = (el, onMove, key) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId); el.classList.add('on');
      const mv = (ev) => onMove(ev);
      const up = () => { el.classList.remove('on'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); localStorage.setItem(key, getComputedStyle(root).getPropertyValue(key === 'st-leftw' ? '--leftw' : '--toph').trim()); drawRange(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
  };
  drag($('#vsplit'), (e) => {
    const W = window.innerWidth;
    let x = Math.max(200, Math.min(W - 400, e.clientX));
    for (const f of [0.25, 1 / 3, 0.5]) if (Math.abs(x - W * f) < 14) x = W * f;
    root.style.setProperty('--leftw', x + 'px');
  }, 'st-leftw');
  drag($('#hsplit'), (e) => {
    const r = $('#right').getBoundingClientRect();
    let p = (e.clientY - r.top) / r.height;
    p = Math.max(0.2, Math.min(0.85, p));
    for (const f of [0.5, 0.6]) if (Math.abs(p - f) * r.height < 14) p = f;
    root.style.setProperty('--toph', (p * 100).toFixed(2) + '%');
  }, 'st-toph');
}

// ===== 自動更新 =====
function setupUpdate() {
  if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register(BASE + 'sw.js').catch(() => { });
  const check = async () => {
    try {
      const r = await fetch(BASE + 'version.json?' + Date.now(), { cache: 'no-store' });
      const j = await r.json();
      if (j.version && j.version !== VERSION) {
        // 作業を邪魔しない時だけ入れ替え
        if (video.paused && !running && !$('#sheet').classList.contains('on') && (LOCAL || files.size === 0 || window.showDirectoryPicker)) location.reload();
      }
    } catch (e) { }
  };
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

// ===== 起動 =====
async function boot() {
  $('#ver').textContent = 'v' + VERSION;
  setupEvents(); setupDrop(); setupSplitters(); setupRangeDrag();
  $('#scriptInput').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const text = await f.text();
    if ($('#sText')) $('#sText').value = text;
    else { await withBusy(() => applyScript(text)); render(); }
  };
  busy(true);
  try {
    LOCAL = await fetch(BASE + 'api/ping', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (LOCAL) document.documentElement.classList.add('local');
    setupUpdate();
    let saved = LOCAL ? await fetch('/api/project').then(r => r.json()).catch(() => null) : null;
    if (!saved) saved = await store.get('kv', 'project');
    if (saved && saved.v === 1) {
      P = Object.assign(newProject(), saved);
      P.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
      if (P.settings.qv !== 2) { P.settings.quality = 'std'; P.settings.qv = 2; }
      P.user = Object.assign({ status: {}, overrides: {}, adjust: {}, cameraNames: {} }, saved.user || {});
    }
    $('#projName').value = P.name;
    render();
    await ensureTokenizer();
    if (P.scenes.length) {
      if (P.settings.cutv !== 2) { for (const sc of P.scenes) for (const ln of sc.lines) if (!ln.userCuts) ln.cuts = autoCuts(ln.text); P.settings.cutv = 2; save(); }
      clearReadingCache(); D = derive(P, { speechOf }); render();
    }
    if (LOCAL) await restoreLocal();
    else if (window.showDirectoryPicker) await restoreHandles(false);
    render();
    if (needsAnalysis() || P.groups.some(g => !P.transcripts[g.rep] && files.has(g.rep))) runPipeline();
  } finally { busy(false); }
}

window.__st = { get P() { return P; }, files, registerFiles, applyScript, runPipeline, reorganize, render, derive: () => (D = derive(P, { speechOf })), buildSelection, buildFcpxml, get D() { return D; }, selectPhrase, transcribeOverride: null };
boot();
