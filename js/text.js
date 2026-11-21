// 日本語テキスト：読み変換・正規化・台本解析・セリフ分解
let tokenizer = null;
let loading = null;

export function initTokenizer(base) {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const go = () => window.kuromoji.builder({ dicPath: base + 'vendor/kuromoji/dict/' }).build((e, t) => {
      if (e) { loading = null; rej(e); } else { tokenizer = t; res(t); }
    });
    if (window.kuromoji) go();
    else {
      const s = document.createElement('script');
      s.src = base + 'vendor/kuromoji/kuromoji.js';
      s.onload = go; s.onerror = () => { loading = null; rej(new Error('辞書の読み込みに失敗')); };
      document.head.appendChild(s);
    }
  });
  return loading;
}

export function hasTokenizer() { return !!tokenizer; }

const PUNCT = /[\s、。，．,.！？!?…‥・「」『』（）()［］\[\]【】〈〉《》〔〕“”"'’‘―—〜~ー－\-:：;；\/／♪☆★○●◎◇◆□■△▲▽▼※＊*#＃]/;
const PUNCT_STRONG = /[\s、。，．,.！？!?…‥「」『』（）()―—〜~:：;；]/;

export function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function normalizeSurface(s) {
  return kataToHira((s || '').normalize('NFKC').toLowerCase());
}

const SMALL = 'ゃゅょぁぃぅぇぉゎ';

// 文字列を「読み」の文字列に変換。各文字に元の位置と長さの重みを持たせる
export function toReading(text) {
  const chars = [], src = [], w = [];
  const tokens = [];
  if (!tokenizer) {
    // 辞書が無いときは表記のまま
    const t = normalizeSurface(text);
    for (let i = 0; i < text.length; i++) {
      const c = normalizeSurface(text[i]);
      if (!c || PUNCT.test(text[i]) && text[i] !== 'ー') continue;
      for (const cc of c) { chars.push(cc); src.push(i); w.push(/[一-鿿]/.test(cc) ? 1.8 : SMALL.includes(cc) ? 0.3 : 1); }
    }
    return { chars, src, w, tokens };
  }
  const toks = tokenizer.tokenize(text);
  let pos = 0;
  for (const tk of toks) {
    const surf = tk.surface_form;
    const start = tk.word_position ? tk.word_position - 1 : pos;
    pos = start + surf.length;
    const isSym = tk.pos === '記号' || PUNCT.test(surf) && surf.length === 1 && surf !== 'ー';
    tokens.push({ surf, start, end: start + surf.length, pos: tk.pos, pos1: tk.pos_detail_1, rs: chars.length, sym: isSym });
    if (isSym) { tokens[tokens.length - 1].re = chars.length; continue; }
    let r = tk.reading && tk.reading !== '*' ? tk.reading : surf;
    r = normalizeSurface(r);
    const rr = [...r].filter(c => !PUNCT.test(c) || c === 'ー');
    for (let i = 0; i < rr.length; i++) {
      chars.push(rr[i]);
      // 元の文字位置は比例で割り当て
      src.push(start + Math.min(surf.length - 1, Math.floor(i * surf.length / rr.length)));
      w.push(SMALL.includes(rr[i]) ? 0.3 : /[a-z0-9]/.test(rr[i]) ? 0.7 : 1);
    }
    tokens[tokens.length - 1].re = chars.length;
  }
  return { chars, src, w, tokens };
}

// ===== 台本 =====
const SCENE_RE = /^\s*(?:[#＃]+\s*|[○〇◯●]\s*|(?:scene|ｓｃｅｎｅ|シーン|ｓ|s)\s*[\d０-９]+|第\s*[\d０-９一二三四五六七八九十]+\s*[場話景]|[\d０-９]+\s*[.．]\s+)/i;

export function parseScript(text) {
  const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
  const scenes = [];
  let scene = null;
  let pendingRole = null;
  let lastRole = null;
  let n = 0;
  const others = [];
  const newScene = (name) => { scene = { id: 'S' + (scenes.length + 1), name: name || ('Scene ' + (scenes.length + 1)), lines: [] }; scenes.push(scene); pendingRole = null; lastRole = null; };
  const addLine = (role, t) => {
    t = t.trim().replace(/^[「『]/, '').replace(/[」』]$/, '').trim();
    if (!t) return;
    if (!scene) newScene();
    n++;
    scene.lines.push({ id: scene.id + 'L' + (scene.lines.length + 1), role: role || '?', text: t });
    lastRole = role;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { pendingRole = null; continue; }
    if (SCENE_RE.test(line) && !/[「」]/.test(line)) { newScene(line.replace(/^[#＃]+\s*/, '').trim()); continue; }
    let m;
    // 名前「セリフ」
    if ((m = line.match(/^([^「『：:\s]{1,12})\s*[「『](.*?)[」』]?\s*$/))) { addLine(m[1], m[2]); pendingRole = null; continue; }
    // 名前：セリフ
    if ((m = line.match(/^([^「『：:]{1,12}?)\s*[：:]\s*(.+)$/))) { addLine(m[1].trim(), m[2]); pendingRole = null; continue; }
    // 「セリフ」のみ（直前の名前行か直前の話者）
    if ((m = line.match(/^[「『](.*?)[」』]?\s*$/))) { addLine(pendingRole || lastRole || '?', m[1]); continue; }
    // 名前　セリフ（全角スペース・タブ・空白区切り）
    if ((m = line.match(/^([^\s　「『：:（(、。]{1,8})[\t　 ]+(.+)$/)) && !/^[（(]/.test(m[2])) { addLine(m[1], m[2]); pendingRole = null; continue; }
    // 名前だけの行
    if (line.length <= 10 && !/[。、！？!?]/.test(line)) { pendingRole = line; continue; }
    // 名前の直後の行はセリフ
    if (pendingRole) { addLine(pendingRole, line); continue; }
    // それ以外はト書き
    pendingRole = null;
    others.push(line);
  }
  // セリフが1つも見つからないときは、各行をセリフとして扱う
  if (!n) {
    for (const l of others) addLine('?', l);
  }
  return scenes;
}

// ===== セリフ分解 =====
// 戻り値：cuts（line.text の中の区切り位置の配列）
const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '接続詞', '感動詞', '形容動詞', '接頭詞']);

export function boundaryCandidates(text) {
  const rd = toReading(text);
  const strong = new Set();
  const weak = new Set();
  // 強い区切り：句読点・記号
  for (let i = 1; i < text.length; i++) {
    if (PUNCT_STRONG.test(text[i - 1]) && !PUNCT_STRONG.test(text[i])) strong.add(i);
  }
  // 弱い区切り：文節の始まり
  const tk = rd.tokens;
  for (let i = 1; i < tk.length; i++) {
    const t = tk[i], p = tk[i - 1];
    if (t.sym || p.sym) continue;
    if (!CONTENT_POS.has(t.pos)) continue;
    if (t.pos1 === '非自立' || t.pos1 === '接尾' || t.pos1 === '数') continue;
    if (p.pos === '接頭詞') continue;
    if (t.pos === '名詞' && p.pos === '名詞') continue;
    weak.add(t.start);
  }
  return { strong: [...strong].sort((a, b) => a - b), weak: [...weak].sort((a, b) => a - b), reading: rd };
}

function readingLen(rd, a, b) {
  let n = 0;
  for (let i = 0; i < rd.src.length; i++) if (rd.src[i] >= a && rd.src[i] < b) n += rd.w[i];
  return n;
}

export function autoCuts(text, opt = {}) {
  const maxLen = opt.maxLen || 10;
  const { strong, weak, reading } = boundaryCandidates(text);
  const cuts = new Set(strong);
  const sorted = () => [0, ...[...cuts].sort((a, b) => a - b), text.length];
  // 長い区間を文節で割る
  let changed = true, guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    const b = sorted();
    for (let i = 0; i < b.length - 1; i++) {
      const a = b[i], e = b[i + 1];
      const len = readingLen(reading, a, e);
      if (len < maxLen) continue;
      let best = -1, bd = 1e9;
      for (const c of weak) {
        if (c <= a || c >= e) continue;
        const l = readingLen(reading, a, c), r = readingLen(reading, c, e);
        if (l < 3 || r < 3) continue;
        const d = Math.abs(l - r);
        if (d < bd) { bd = d; best = c; }
      }
      if (best > 0) { cuts.add(best); changed = true; }
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

export function phrasesOf(line) {
  const cuts = line.cuts || [];
  const b = [0, ...cuts, line.text.length];
  const out = [];
  for (let i = 0; i < b.length - 1; i++) {
    const t = line.text.slice(b[i], b[i + 1]);
    const clean = t.replace(new RegExp(PUNCT_STRONG.source, 'g'), '').trim();
    if (!clean) continue;
    out.push({ key: line.id + '@' + b[i], lineId: line.id, start: b[i], end: b[i + 1], text: t.replace(/^[、。！？!?…\s]+/, '').replace(/[、。\s]+$/, '') });
  }
  return out;
}

export function displayClean(t) {
  return (t || '').replace(/^[「『]/, '').replace(/[」』]$/, '');
}
