// 台本と文字起こしの照合
import { toReading } from './text.js';

const MATCH = 2, MIS = -1.2, GAP_OPEN = -2.2, GAP_EXT = -0.45;
// 音が近い文字は部分一致
const SIMILAR = [
  'あぁ', 'いぃ', 'うぅ', 'えぇ', 'おぉを', 'やゃ', 'ゆゅ', 'よょ', 'つっ', 'ずづ', 'じぢ', 'わゎは', 'へえ', 'んむ', 'ーあいうえお',
];
const SIM = new Map();
for (const g of SIMILAR) for (const a of g) for (const b of g) if (a !== b) SIM.set(a + b, 1);
function sc(a, b) {
  if (a === b) return MATCH;
  if (SIM.has(a + b)) return 0.8;
  // 濁点違い
  if (a.normalize('NFD')[0] === b.normalize('NFD')[0]) return 0.6;
  return MIS;
}

// 文字起こしの文字に時刻を割り当てる
// segments: [{start,end,text}]  voiced: [[t0,t1],...]
export function timedTranscript(segments, voiced) {
  const out = { chars: [], t0: [], t1: [], seg: [], surf: [], segText: segments.map(s => s.text) };
  segments.forEach((sg, si) => {
    const rd = toReading(sg.text);
    if (!rd.chars.length) return;
    // 区間内の有声部分
    let vs = voiced.filter(v => v[1] > sg.start && v[0] < sg.end).map(v => [Math.max(v[0], sg.start), Math.min(v[1], sg.end)]);
    if (!vs.length) vs = [[sg.start, sg.end]];
    const total = vs.reduce((s, v) => s + v[1] - v[0], 0);
    const wsum = rd.w.reduce((s, x) => s + x, 0) || 1;
    // 有声時間を文字の重みで配分
    const pos = (frac) => {
      let rem = frac * total;
      for (const v of vs) { const d = v[1] - v[0]; if (rem <= d) return v[0] + rem; rem -= d; }
      return vs[vs.length - 1][1];
    };
    let acc = 0;
    for (let i = 0; i < rd.chars.length; i++) {
      const a = acc / wsum; acc += rd.w[i]; const b = acc / wsum;
      out.chars.push(rd.chars[i]); out.t0.push(pos(a)); out.t1.push(pos(b)); out.seg.push(si);
      out.surf.push(rd.src[i]);
    }
  });
  return out;
}

// 局所アライメント（アフィンギャップ）。mask された文字起こし位置は使わない
function localAlign(S, T, mask) {
  const m = S.length, n = T.length;
  if (!m || !n) return null;
  const W = n + 1;
  const H = new Float32Array((m + 1) * W), E = new Float32Array((m + 1) * W), F = new Float32Array((m + 1) * W);
  const tb = new Uint8Array((m + 1) * W); // 0 stop,1 diag,2 up(E: S gap in T = deletion),3 left(F: insertion in T)
  const tbE = new Uint8Array((m + 1) * W), tbF = new Uint8Array((m + 1) * W);
  let best = 0, bi = 0, bj = 0;
  const NEG = -1e9;
  for (let j = 0; j <= n; j++) { E[j] = NEG; F[j] = NEG; }
  for (let i = 1; i <= m; i++) {
    const r = i * W, pr = (i - 1) * W;
    E[r] = NEG; F[r] = NEG;
    for (let j = 1; j <= n; j++) {
      // E：S の文字を飛ばす（台本の文字が言われていない）
      const eOpen = H[pr + j] + GAP_OPEN, eExt = E[pr + j] + GAP_EXT;
      if (eOpen >= eExt) { E[r + j] = eOpen; tbE[r + j] = 0; } else { E[r + j] = eExt; tbE[r + j] = 1; }
      // F：T の文字を飛ばす（台本に無い発話）
      const fOpen = H[r + j - 1] + GAP_OPEN * 0.7, fExt = F[r + j - 1] + GAP_EXT * 0.6;
      if (fOpen >= fExt) { F[r + j] = fOpen; tbF[r + j] = 0; } else { F[r + j] = fExt; tbF[r + j] = 1; }
      let d = mask[j - 1] ? NEG : H[pr + j - 1] + sc(S[i - 1], T[j - 1]);
      let h = 0, t = 0;
      if (d > h) { h = d; t = 1; }
      if (E[r + j] > h) { h = E[r + j]; t = 2; }
      if (F[r + j] > h) { h = F[r + j]; t = 3; }
      H[r + j] = h; tb[r + j] = t;
      if (h > best) { best = h; bi = i; bj = j; }
    }
  }
  if (best <= 0) return null;
  // トレースバック
  const pairs = [];
  let i = bi, j = bj, st = 0; // 0:H 2:E 3:F
  while (i > 0 && j > 0) {
    const k = i * W + j;
    if (st === 0) {
      const t = tb[k];
      if (t === 0) break;
      if (t === 1) { pairs.push([i - 1, j - 1]); i--; j--; }
      else st = t;
    } else if (st === 2) {
      pairs.push([i - 1, -1]); const ext = tbE[k]; i--; st = ext ? 2 : 0;
    } else {
      pairs.push([-1, j - 1]); const ext = tbF[k]; j--; st = ext ? 3 : 0;
    }
  }
  pairs.reverse();
  return { score: best, pairs };
}

// 1つの文字起こし（音声グループ）と台本全体を照合し、ラン（1回の通し・部分）を取り出す
// sceneStreams: [{sceneId, chars, lineIdx:[...], lineChar:[...]}]
export function findRuns(sceneStreams, tt, opt = {}) {
  const T = tt.chars;
  const mask = new Uint8Array(T.length);
  const runs = [];
  const minScore = opt.minScore || 7;
  for (let iter = 0; iter < 40; iter++) {
    let best = null;
    for (const ss of sceneStreams) {
      const r = localAlign(ss.chars, T, mask);
      if (r && (!best || r.score > best.score)) best = { ...r, ss };
    }
    if (!best || best.score < minScore) break;
    const tIdx = best.pairs.filter(p => p[1] >= 0).map(p => p[1]);
    const lo = Math.min(...tIdx), hi = Math.max(...tIdx);
    for (let k = lo; k <= hi; k++) mask[k] = 1;
    const matched = best.pairs.filter(p => p[0] >= 0 && p[1] >= 0 && best.ss.chars[p[0]] === T[p[1]]).length;
    if (matched < 3) continue;
    runs.push({ sceneId: best.ss.sceneId, score: best.score, pairs: best.pairs, ss: best.ss, tlo: lo, thi: hi });
  }
  runs.sort((a, b) => tt.t0[a.tlo] - tt.t0[b.tlo]);
  return { runs, mask };
}

// ランを「行ごとの文字時刻」に変換
export function runToLines(run, tt) {
  const ss = run.ss;
  const lines = {};
  for (const [si, ti] of run.pairs) {
    if (si < 0) continue;
    const li = ss.lineIdx[si], lc = ss.lineChar[si];
    const lineId = ss.lineIds[li];
    let L = lines[lineId];
    if (!L) {
      const len = ss.lineLen[li];
      L = lines[lineId] = { t: new Array(len * 2).fill(null), eq: new Array(len).fill(0), ins: [] };
    }
    if (ti >= 0) {
      L.t[lc * 2] = tt.t0[ti]; L.t[lc * 2 + 1] = tt.t1[ti];
      L.eq[lc] = ss.chars[si] === tt.chars[ti] ? 1 : sc(ss.chars[si], tt.chars[ti]) > 0 ? 0.6 : 0;
    }
  }
  // 挿入（台本に無い発話）をまとめる
  const inserts = [];
  let cur = null, lastS = -1;
  for (const [si, ti] of run.pairs) {
    if (si >= 0) { lastS = si; if (cur) { inserts.push(cur); cur = null; } continue; }
    if (ti < 0) continue;
    if (!cur) cur = { afterS: lastS, from: ti, to: ti };
    cur.to = ti;
  }
  if (cur) inserts.push(cur);
  const adlibs = [];
  for (const c of inserts) {
    const text = transcriptText(tt, c.from, c.to);
    if (c.to - c.from + 1 < 3) continue;
    const li = c.afterS >= 0 ? ss.lineIdx[c.afterS] : 0;
    adlibs.push({ text, t0: tt.t0[c.from], t1: tt.t1[c.to], lineId: ss.lineIds[li], lineChar: c.afterS >= 0 ? ss.lineChar[c.afterS] : -1, chars: tt.chars.slice(c.from, c.to + 1).join('') });
  }
  return { lines, adlibs };
}

export function transcriptText(tt, from, to) {
  // 元の表記で返す（区間をまたぐときは空白でつなぐ）
  if (!tt.segText) return tt.chars.slice(from, to + 1).join('');
  const parts = [];
  let i = from;
  while (i <= to) {
    const sg = tt.seg[i];
    let j = i;
    while (j + 1 <= to && tt.seg[j + 1] === sg) j++;
    const txt = tt.segText[sg];
    let a = tt.surf[i], b = tt.surf[j] + 1;
    // 同じ表記文字にまたがる読みの続きも含める
    parts.push(txt.slice(a, b).replace(/^[、。！？!?\s]+|[、。\s]+$/g, ''));
    i = j + 1;
  }
  return parts.filter(Boolean).join(' ');
}

// 台本の場面ごとの読みストリーム
export function sceneStream(scene, readingOf) {
  const chars = [], lineIdx = [], lineChar = [], lineIds = [], lineLen = [];
  scene.lines.forEach((ln, li) => {
    const rd = readingOf(ln);
    lineIds.push(ln.id); lineLen.push(rd.chars.length);
    rd.chars.forEach((c, k) => { chars.push(c); lineIdx.push(li); lineChar.push(k); });
  });
  return { sceneId: scene.id, chars, lineIdx, lineChar, lineIds, lineLen };
}

// 未使用の発話区間（アドリブ候補）
export function leftovers(tt, mask) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= tt.chars.length; i++) {
    const free = i < tt.chars.length && !mask[i];
    const newSeg = free && s >= 0 && tt.seg[i] !== tt.seg[i - 1] && tt.t0[i] - tt.t1[i - 1] > 0.8;
    if ((!free || newSeg) && s >= 0) {
      if (i - s >= 2) out.push({ from: s, to: i - 1, text: transcriptText(tt, s, i - 1), t0: tt.t0[s], t1: tt.t1[i - 1] });
      s = -1;
    }
    if (free && s < 0) s = i;
  }
  return out;
}
