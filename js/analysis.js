// 音声の包絡線・発話区間・同期
export const HOP = 0.01; // 10ms

export function envelope(pcm, sr = 16000) {
  const hop = Math.round(sr * HOP);
  const n = Math.floor(pcm.length / hop);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * hop;
    for (let k = 0; k < hop; k++) { const v = pcm[o + k]; s += v * v; }
    db[i] = 10 * Math.log10(s / hop + 1e-10);
  }
  return db;
}

function percentile(arr, p) {
  const a = Array.from(arr).filter(x => x > -95).sort((x, y) => x - y);
  if (!a.length) return -100;
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

// 発話区間の検出：voiced（短い息継ぎで区切った細かい区間）と regions（ひとまとまりの発話）
export function detectSpeech(db, opt = {}) {
  const floor = percentile(db, 0.1);
  const peak = percentile(db, 0.98);
  const thr = Math.max(floor + 9, Math.min(peak - 28, floor + 20));
  const n = db.length;
  // 移動平均で平滑化
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < n) { s += db[j]; c++; } }
    sm[i] = s / c;
  }
  const raw = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && sm[i] > thr;
    if (on && st < 0) st = i;
    if (!on && st >= 0) { raw.push([st, i]); st = -1; }
  }
  const minPause = Math.round((opt.minPause || 0.12) / HOP);
  const voiced = mergeGaps(raw, minPause).filter(r => r[1] - r[0] >= 6);
  const regionGap = Math.round((opt.regionGap || 0.7) / HOP);
  const regions = mergeGaps(voiced, regionGap).filter(r => r[1] - r[0] >= 15);
  return {
    thr, floor, peak,
    voiced: voiced.map(r => [r[0] * HOP, r[1] * HOP]),
    regions: regions.map(r => [r[0] * HOP, r[1] * HOP]),
  };
}

function mergeGaps(list, gap) {
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < gap) last[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  return out;
}

// 同期用の特徴量：局所平均を引いた対数エネルギー（立ち上がり強調）
export function syncFeature(db) {
  const n = db.length;
  const out = new Float32Array(n);
  const W = 50;
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pre[i + 1] = pre[i] + Math.max(db[i], -80); }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n, i + W);
    const mean = (pre[b] - pre[a]) / (b - a);
    const d = i > 0 ? Math.max(db[i], -80) - Math.max(db[i - 1], -80) : 0;
    out[i] = Math.max(0, Math.max(db[i], -80) - mean) + Math.max(0, d) * 0.5;
  }
  // 標準化
  let m = 0; for (let i = 0; i < n; i++) m += out[i]; m /= n || 1;
  let v = 0; for (let i = 0; i < n; i++) { out[i] -= m; v += out[i] * out[i]; }
  v = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) out[i] /= v;
  return out;
}

function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// a と b の時間差を推定。戻り値 offset：b の時刻 t は a の時刻 t + offset
export function correlate(fa, fb) {
  const na = fa.length, nb = fb.length;
  if (na < 300 || nb < 300) return null;
  let N = 1; while (N < na + nb) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(fa); br.set(fb);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < N; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  // lag k：a[i+k] と b[i] の一致。正規化は重なり長で
  let best = -1e9, bestK = 0;
  const score = (k) => {
    const ov = Math.min(na, nb + k) - Math.max(0, k);
    if (ov < 300) return -1e9;
    const v = k >= 0 ? ar[k] : ar[N + k];
    return v / Math.sqrt(ov * Math.min(na, nb));
  };
  const scores = new Map();
  for (let k = -(nb - 300); k <= na - 300; k++) {
    const s = score(k);
    scores.set(k, s);
    if (s > best) { best = s; bestK = k; }
  }
  let second = -1e9;
  for (const [k, s] of scores) if (Math.abs(k - bestK) > 30 && s > second) second = s;
  // 放物線補間
  const s0 = scores.get(bestK - 1) ?? best, s2 = scores.get(bestK + 1) ?? best;
  const den = s0 - 2 * best + s2;
  const frac = den !== 0 ? 0.5 * (s0 - s2) / den : 0;
  const ov = Math.min(na, nb + bestK) - Math.max(0, bestK);
  return { offset: (bestK + frac) * HOP, score: best, ratio: second > 0 ? best / second : 99, overlap: ov * HOP };
}

export function isGoodSync(r) {
  return r && r.score > 0.18 && r.ratio > 1.35 && r.overlap > 3;
}
