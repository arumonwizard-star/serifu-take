// 同期グループ・ラン・セリフ別クリップの整理
import { correlate, isGoodSync } from './analysis.js';
import { phrasesOf, toReading, normalizeSurface } from './text.js';
import { timedTranscript, findRuns, runToLines, sceneStream, leftovers } from './align.js';

// ===== 同期グループ =====
// media: [{key, info, feat(Float32Array), created, duration, isAudio}]
export function buildGroups(media, onProgress) {
  const n = media.length;
  const parent = media.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const edges = [];
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = media[i], b = media[j];
    if (!a.feat || !b.feat) continue;
    if (a.camera && b.camera && a.camera === b.camera && !a.isAudio) continue; // 同じカメラ同士は別テイク
    if (a.created && b.created) {
      const lim = Math.max(a.duration, b.duration) + 600;
      if (Math.abs(a.created - b.created) / 1000 > lim) continue;
    } else if (n > 120) continue;
    pairs.push([i, j]);
  }
  let done = 0;
  for (const [i, j] of pairs) {
    const r = correlate(media[i].feat, media[j].feat);
    if (isGoodSync(r)) edges.push({ i, j, offset: r.offset, score: r.score });
    done++;
    if (onProgress && done % 20 === 0) onProgress(done / pairs.length);
  }
  edges.sort((x, y) => y.score - x.score);
  // 最大全域木的に結合（同じカメラが同じグループに2本入らないように）
  const camsOf = media.map((m) => new Set(m.isAudio ? [] : [m.camera || m.key]));
  const adj = media.map(() => []);
  for (const e of edges) {
    const ri = find(e.i), rj = find(e.j);
    if (ri === rj) continue;
    const ci = camsOf[ri], cj = camsOf[rj];
    let clash = false;
    for (const c of cj) if (ci.has(c)) clash = true;
    if (clash) continue;
    parent[rj] = ri;
    for (const c of cj) ci.add(c);
    adj[e.i].push([e.j, e.offset]); adj[e.j].push([e.i, -e.offset]);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  const out = [];
  for (const idxs of groups.values()) {
    // 代表：外部音声 > 長いもの
    let rep = idxs[0];
    for (const i of idxs) {
      const a = media[i], b = media[rep];
      if ((a.isAudio && !b.isAudio) || (a.isAudio === b.isAudio && (a.duration || 0) > (b.duration || 0))) rep = i;
    }
    // 代表からの時間差（BFS）。offset(e)：j の時刻 t は i の時刻 t+offset → j の時刻 = i の時刻 - offset
    const shift = new Map([[rep, 0]]);
    const q = [rep];
    while (q.length) {
      const i = q.shift();
      for (const [j, off] of adj[i]) if (!shift.has(j)) { shift.set(j, shift.get(i) - off); q.push(j); }
    }
    const members = idxs.map(i => ({ key: media[i].key, shift: shift.get(i) || 0 }));
    const created = Math.min(...idxs.map(i => media[i].created || Infinity));
    out.push({ id: 'G:' + media[rep].key, rep: media[rep].key, members, created: isFinite(created) ? created : null });
  }
  out.sort((a, b) => (a.created || 0) - (b.created || 0) || a.rep.localeCompare(b.rep));
  return out;
}

// ASR 用ブロック（近い発話をまとめる）
export function asrBlocks(regions, maxLen = 24, maxGap = 2.5) {
  const out = [];
  for (const r of regions) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < maxGap && r[1] - last[0] <= maxLen) last[1] = r[1];
    else {
      // 長すぎる区間は分割
      let s = r[0];
      while (r[1] - s > maxLen + 5) { out.push([s, s + maxLen]); s += maxLen; }
      out.push([s, r[1]]);
    }
  }
  return out;
}

// ===== 照合 =====
const readingCache = new Map();
export function lineReading(line) {
  const k = line.text;
  let r = readingCache.get(k);
  if (!r) { r = toReading(line.text); readingCache.set(k, r); }
  return r;
}
export function clearReadingCache() { readingCache.clear(); }

// 撮影の合図（よーいはい・カット等）は台本照合とアドリブから除く
export const CUE_RE = /(?:よ[ー〜～ぉお]*い[、,\s]*(?:はい|スタート|どん|アクション)?|用意[、,\s]*(?:はい|スタート)?|アクション|カット|本番|回(?:った|して|ります)|オッケー|ＯＫ|OK|テイク\s*\d*)[！!。、,\s]*/gi;
export function stripCues(segs) {
  const out = [];
  for (const sg of segs || []) {
    const t = (sg.text || '').replace(CUE_RE, '').trim();
    if (t.replace(/[、。！？!?\s…]/g, '')) out.push(t === sg.text ? sg : { ...sg, text: t });
  }
  return out;
}
// NG の合図（ここより後ろは使わない）
export const NG_RE = /すみません|すいません|ごめんなさい|ごめん|もう一回|もう一度|もう1回|やり直|噛んだ|かんだ|間違え|まちがえ|NG|エヌジー|ストップ|止めて/i;

function sceneText(scenes, id) {
  const sc = scenes.find(x => x.id === id);
  return sc ? sc.lines.map(l => l.text).join('') : '';
}

// groups と transcripts と speech から runs を作る
export function buildRuns(scenes, groups, transcripts, speechOf) {
  const streams = scenes.map(s => sceneStream(s, lineReading)).filter(s => s.chars.length);
  const allRuns = [];
  const freeAdlibs = [];
  for (const g of groups) {
    const rawSegs = transcripts[g.rep];
    if (!rawSegs || !rawSegs.length) continue;
    const segs = stripCues(rawSegs);
    const ngSegs = rawSegs.filter(sg => NG_RE.test(sg.text || ''));
    const sp = speechOf(g.rep);
    const tt = timedTranscript(segs, sp ? sp.voiced : []);
    const { runs, mask } = findRuns(streams, tt);
    for (const r of runs) {
      const { lines, adlibs } = runToLines(r, tt);
      const t0 = tt.t0[r.tlo], t1 = tt.t1[r.thi];
      allRuns.push({
        id: g.rep + '#' + Math.round(t0 * 10),
        groupId: g.id, rep: g.rep, sceneId: r.sceneId, score: r.score,
        t0, t1, lines, adlibs: adlibs.map(a => ({ ...a, id: g.rep + '#a' + Math.round(a.t0 * 10) })),
        text: segs.filter(s => s.end > t0 - 0.1 && s.start < t1 + 0.1).map(s => s.text).join(' '),
        // NG の言葉が出た時刻（このテイクの中、または直後3秒以内）
        ngAt: (ngSegs.find(sg => sg.start >= t0 - 0.2 && sg.start <= t1 + 3 && !sceneText(scenes, r.sceneId).includes(sg.text.match(NG_RE)[0])) || {}).start ?? null,
      });
    }
    for (const l of leftovers(tt, mask)) {
      // 前後のランから場面を推定
      const near = allRuns.filter(r => r.rep === g.rep).sort((a, b) => Math.abs((a.t0 + a.t1) / 2 - l.t0) - Math.abs((b.t0 + b.t1) / 2 - l.t0))[0];
      // ランの直後・直前（3秒以内）なら、そのテイクの最後／最初の行に付ける
      let lineId = null, take = null;
      if (near && l.t0 < near.t1 + 3 && l.t1 > near.t0 - 3) {
        take = near.take || null;
        const ids = Object.keys(near.lines);
        const sc = scenes.find(s => s.id === near.sceneId);
        const ordered = sc ? sc.lines.map(x => x.id).filter(id => ids.includes(id)) : ids;
        lineId = l.t0 >= near.t1 - 0.2 ? ordered[ordered.length - 1] : ordered[0];
      }
      freeAdlibs.push({ id: g.rep + '#f' + Math.round(l.t0 * 10), rep: g.rep, groupId: g.id, sceneId: near ? near.sceneId : null, runId: near ? near.id : null, lineId, text: l.text, t0: l.t0, t1: l.t1, _near: near ? near.id : null });
    }
  }
  // テイク番号：場面ごとに時系列で
  const groupOrder = new Map(groups.map((g, i) => [g.id, i]));
  const byScene = {};
  for (const r of allRuns) (byScene[r.sceneId] ||= []).push(r);
  for (const list of Object.values(byScene)) {
    list.sort((a, b) => groupOrder.get(a.groupId) - groupOrder.get(b.groupId) || a.t0 - b.t0);
    list.forEach((r, i) => { r.take = i + 1; });
  }
  const byId = new Map(allRuns.map(r => [r.id, r]));
  for (const a of freeAdlibs) { if (a._near && a.lineId) a.take = byId.get(a._near).take; delete a._near; }
  return { runs: allRuns, freeAdlibs };
}

// ===== セリフ別クリップの導出 =====
const LAUGH = /[（(\[【〔][^）)\]】〕]*?(笑|咳|せき|くしゃみ|拍手|音楽|ノイズ)|^(?:は|あ|ふ|へ)\1{2,}|ははは|あはは|ふふふ|へへへ|くすくす|ごほ|げほ/;

function snap(t, voiced, side) {
  let best = t, bd = 0.22;
  for (const v of voiced) {
    const edge = side === 0 ? v[0] : v[1];
    const d = Math.abs(edge - t);
    if (d < bd) { bd = d; best = edge; }
  }
  return best;
}

export function levelOf(id) {
  if (id >= 0.9) return 1;
  if (id >= 0.7) return 2;
  if (id >= 0.45) return 3;
  return 4;
}

// 戻り値：{ phrases: Map(phraseKey -> {phrase, line, scene, takes:[...]}), adlibs: [...], pauses }
export function derive(project, ctx) {
  const { scenes, groups, runs, freeAdlibs } = project;
  const user = project.user;
  const media = project.media;
  const groupById = new Map(groups.map(g => [g.id, g]));
  const phrases = new Map();
  const order = [];
  for (const sc of scenes) for (const ln of sc.lines) for (const ph of phrasesOf(ln)) {
    phrases.set(ph.key, { phrase: ph, line: ln, scene: sc, takes: [] });
    order.push(ph.key);
  }
  const adlibItems = [];
  const pauses = {};
  const speechOf = ctx.speechOf;
  for (const run of runs) {
    const sc = scenes.find(s => s.id === run.sceneId);
    if (!sc) continue;
    const g = groupById.get(run.groupId);
    const sp = speechOf(run.rep);
    const voiced = sp ? sp.voiced : [];
    const runPh = [];
    sc.lines.forEach((ln, li) => {
      const L = run.lines[ln.id];
      if (!L) return;
      const rd = lineReading(ln);
      for (const ph of phrasesOf(ln)) {
        let n = 0, got = 0, eq = 0, t0 = Infinity, t1 = -Infinity;
        for (let k = 0; k < rd.chars.length; k++) {
          if (rd.src[k] < ph.start || rd.src[k] >= ph.end) continue;
          n++;
          const a = L.t[k * 2];
          if (a == null) continue;
          got++; eq += L.eq[k];
          t0 = Math.min(t0, a); t1 = Math.max(t1, L.t[k * 2 + 1]);
        }
        if (!n || got / n < 0.35 || !isFinite(t0)) continue;
        const ident = eq / n;
        t0 = snap(t0, voiced, 0); t1 = snap(t1, voiced, 1);
        runPh.push({ ph, li, t0, t1, ident, cov: got / n });
      }
    });
    // 話した順に並べて、間を記録
    runPh.sort((a, b) => a.t0 - b.t0);
    // NG：最初に崩れたところ（セリフ違い・言い直し・NGの言葉）から後ろは使わない
    let ngAt = run.ngAt != null ? run.ngAt : Infinity;
    for (const p of runPh) {
      const bad = p.ident < 0.6 || (run.adlibs || []).some(a => a.t0 > p.t0 - 0.3 && a.t0 < p.t1 && NG_RE.test(a.text));
      if (bad) { ngAt = Math.min(ngAt, p.t0); break; }
    }
    for (const a of run.adlibs || []) if (NG_RE.test(a.text)) ngAt = Math.min(ngAt, a.t0);
    if (isFinite(ngAt)) { for (let i = runPh.length - 1; i >= 0; i--) if (runPh[i].t0 >= ngAt - 0.05) runPh.splice(i, 1); }
    run._ngAt = isFinite(ngAt) ? ngAt : null;
    for (let i = 0; i < runPh.length; i++) {
      const p = runPh[i];
      const key = run.id + '|' + p.ph.key;
      const adj = user.adjust[key];
      const t0 = adj ? adj.t0 : p.t0, t1 = adj ? adj.t1 : p.t1;
      const ng = [];
      if (p.ident < 0.7) ng.push('セリフ違い');
      if (p.cov < 0.75) ng.push('途中停止');
      // 言い直し：直前の挿入が同じ語の頭を含む
      const segText = (run.adlibs || []).filter(a => a.t1 > t0 - 0.2 && a.t0 < t1 + 0.1);
      const head = lineReading(sc.lines[p.li]);
      const phChars = head.chars.filter((c, k) => head.src[k] >= p.ph.start && head.src[k] < p.ph.end).join('');
      if (segText.some(a => phChars.length >= 2 && a.chars && a.chars.includes(phChars.slice(0, 2)))) ng.push('言い直し');
      if (segText.length && !ng.includes('言い直し')) ng.push('余分な発話');
      if (LAUGH.test(run.text) && segText.some(a => LAUGH.test(a.text))) ng.push('笑い');
      const next = runPh[i + 1];
      const gapAfter = next ? next.t0 - p.t1 : null;
      if (next && gapAfter > 0) pauses[run.id + '|' + p.ph.key] = gapAfter;
      const item = {
        key, runId: run.id, take: run.take, sceneId: run.sceneId, phraseKey: p.ph.key,
        t0, t1, autoT0: p.t0, autoT1: p.t1, adjusted: !!adj,
        level: levelOf(p.ident), ident: p.ident, ng, groupId: run.groupId,
        nextKey: next ? next.ph.key : null, gapAfter,
        cams: camsFor(g, media, t0, t1, project, ctx),
      };
      const target = user.overrides[key] || p.ph.key;
      if (target === 'adlib') {
        adlibItems.push({ ...item, id: key, text: p.ph.text, moved: true, sceneId: run.sceneId });
      } else {
        const dst = phrases.get(target) || phrases.get(p.ph.key);
        dst.takes.push({ ...item, moved: target !== p.ph.key });
      }
    }
    for (const a of run.adlibs || []) {
      if (run._ngAt != null && a.t0 >= run._ngAt - 0.05) continue;
      if (NG_RE.test(a.text) || !a.text.replace(CUE_RE, '').replace(/[、。！？!?\s…]/g, '')) continue;
      const item = { id: a.id, key: a.id, runId: run.id, take: run.take, sceneId: run.sceneId, text: a.text, t0: a.t0, t1: a.t1, lineId: a.lineId, groupId: run.groupId, cams: camsFor(g, media, a.t0, a.t1, project, ctx), level: 4, ng: [] };
      const target = user.overrides[a.id];
      if (target && phrases.get(target)) phrases.get(target).takes.push({ ...item, phraseKey: target, moved: true, ident: 0 });
      else adlibItems.push(item);
    }
  }
  const runById = new Map(runs.map(r => [r.id, r]));
  for (const a of freeAdlibs || []) {
    const near = a.runId && runById.get(a.runId);
    if (near && near._ngAt != null && a.t0 >= near._ngAt - 0.05) continue;
    if (NG_RE.test(a.text) || !a.text.replace(CUE_RE, '').replace(/[、。！？!?\s…]/g, '')) continue;
    const g = groupById.get(a.groupId);
    const item = { ...a, key: a.id, take: a.take || null, cams: camsFor(g, media, a.t0, a.t1, project, ctx), level: 4, ng: [] };
    const target = user.overrides[a.id];
    if (target && phrases.get(target)) phrases.get(target).takes.push({ ...item, phraseKey: target, moved: true, ident: 0 });
    else adlibItems.push(item);
  }
  for (const v of phrases.values()) v.takes.sort((a, b) => (a.take || 999) - (b.take || 999) || a.t0 - b.t0);
  return { phrases, order, adlibs: adlibItems, pauses };
}

// 同期グループ内のカメラごとのクリップ
function camsFor(g, media, t0, t1, project, ctx) {
  if (!g) return [];
  const out = [];
  for (const m of g.members) {
    const md = media[m.key];
    if (!md || !md.info) continue;
    const a = t0 + m.shift, b = t1 + m.shift;
    const dur = md.info.duration || 0;
    if (b < 0 || a > dur) continue;
    const ng = [];
    const sp = ctx.speechOf(m.key);
    if (sp && sp.silentRanges && sp.silentRanges.some(r => r[1] > a && r[0] < b)) ng.push('音声欠損');
    out.push({ fileKey: m.key, camera: cameraOf(project, m.key), isAudio: md.info.kind === 'audio', in: Math.max(0, a), out: Math.min(dur, b), ng });
  }
  out.sort((x, y) => x.camera.localeCompare(y.camera, 'ja'));
  return out;
}

export function cameraOf(project, key) {
  const md = project.media[key];
  if (!md) return '?';
  if (project.user.cameraNames[key]) return project.user.cameraNames[key];
  return md.cameraAuto || 'A';
}

// カメラ名の自動推定
export function autoCameras(list) {
  const vids = list.filter(m => m.info && m.info.kind !== 'audio');
  const dirs = new Set(vids.map(m => dirOf(m.rel)));
  const devs = new Set(vids.map(m => (m.info.device || '') + ' ' + m.info.width + 'x' + m.info.height));
  for (const m of list) {
    if (m.info && m.info.kind === 'audio') { m.cameraAuto = '音声'; continue; }
    if (dirs.size > 1) {
      const d = dirOf(m.rel).split('/').pop() || 'A';
      const mm = d.match(/^([A-Za-zＡ-Ｚ])\s*(?:カメ|cam|camera)?$/i);
      m.cameraAuto = mm ? mm[1].toUpperCase() + 'カメ' : d;
      continue;
    }
    const p = m.name.match(/^([A-Za-z])\d{3}/);
    if (p) { m.cameraAuto = p[1].toUpperCase() + 'カメ'; continue; }
    if (devs.size > 1 && m.info) { m.cameraAuto = (m.info.device || '') + ' ' + m.info.width + 'x' + m.info.height; continue; }
    m.cameraAuto = 'Aカメ';
  }
  // 端末名の自動名を A/B/C にそろえる
  const names = [...new Set(list.filter(m => m.cameraAuto && m.cameraAuto !== '音声' && !/カメ$/.test(m.cameraAuto)).map(m => m.cameraAuto))].sort();
  if (names.length) list.forEach(m => { const i = names.indexOf(m.cameraAuto); if (i >= 0 && dirs.size <= 1) m.cameraAuto = String.fromCharCode(65 + i) + 'カメ'; });
}

function dirOf(rel) { const i = (rel || '').lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }

// 検索用
export function matchesQuery(q, ...texts) {
  if (!q) return true;
  const nq = normalizeSurface(q).replace(/\s+/g, '');
  const rq = toReading(q).chars.join('');
  for (const t of texts) {
    if (!t) continue;
    const nt = normalizeSurface(t).replace(/\s+/g, '');
    if (nt.includes(nq)) return true;
    if (rq && toReading(t).chars.join('').includes(rq)) return true;
  }
  return false;
}
