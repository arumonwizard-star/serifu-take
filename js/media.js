// 素材ファイルの解析：MOV/MP4 のメタデータと音声、WAV の音声
// 動画本体は読み込まず、必要な箱と音声データだけを部分的に読む

const TEXT = new TextDecoder('latin1');

async function readBytes(file, start, len) {
  const end = Math.min(file.size, start + len);
  if (end <= start) return new DataView(new ArrayBuffer(0));
  return new DataView(await file.slice(start, end).arrayBuffer());
}

function fourcc(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
}

function u64(dv, o) {
  return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);
}

// 最上位の箱を走査して moov を探す
async function findTopBoxes(file) {
  const boxes = [];
  let pos = 0;
  let guard = 0;
  while (pos + 8 <= file.size && guard++ < 10000) {
    const h = await readBytes(file, pos, 16);
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) { size = u64(h, 8); hdr = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    boxes.push({ type, start: pos, size, hdr });
    pos += size;
  }
  return boxes;
}

function children(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(dv, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(dv, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, end: p + size, body: p + hdr });
    p += size;
  }
  return out;
}

function child(dv, box, type) {
  return children(dv, box.body, box.end).find(b => b.type === type);
}

function path(dv, box, types) {
  let b = box;
  for (const t of types) { if (!b) return null; b = child(dv, b, t); }
  return b;
}

function parseTrak(dv, trak) {
  const t = {};
  const tkhd = child(dv, trak, 'tkhd');
  const mdia = child(dv, trak, 'mdia');
  if (!mdia) return null;
  const mdhd = child(dv, mdia, 'mdhd');
  const hdlr = child(dv, mdia, 'hdlr');
  if (hdlr) t.handler = fourcc(dv, hdlr.body + 8);
  if (mdhd) {
    const v = dv.getUint8(mdhd.body);
    if (v === 1) { t.timescale = dv.getUint32(mdhd.body + 20); t.duration = u64(dv, mdhd.body + 24); }
    else { t.timescale = dv.getUint32(mdhd.body + 12); t.duration = dv.getUint32(mdhd.body + 16); }
  }
  if (tkhd) {
    const v = dv.getUint8(tkhd.body);
    const o = tkhd.body + (v === 1 ? 92 : 80) - 4;
    t.width = dv.getUint32(o) / 65536;
    t.height = dv.getUint32(o + 4) / 65536;
  }
  // edit list（最初の編集の開始位置）
  const elst = path(dv, trak, ['edts', 'elst']);
  if (elst) {
    const v = dv.getUint8(elst.body);
    const n = dv.getUint32(elst.body + 4);
    if (n > 0) {
      const o = elst.body + 8;
      t.editMediaTime = v === 1 ? u64(dv, o + 8) : dv.getInt32(o + 4);
    }
  }
  const stbl = path(dv, mdia, ['minf', 'stbl']);
  if (!stbl) return t;
  const stsd = child(dv, stbl, 'stsd');
  if (stsd) {
    const e = stsd.body + 8;
    t.codec = fourcc(dv, e + 4);
    t.sdStart = e; t.sdSize = dv.getUint32(e);
    if (t.handler === 'soun') parseSoundDesc(dv, e, t);
    if (t.handler === 'vide') {
      t.vWidth = dv.getUint16(e + 32);
      t.vHeight = dv.getUint16(e + 34);
    }
  }
  const stts = child(dv, stbl, 'stts');
  if (stts) {
    const n = dv.getUint32(stts.body + 4);
    const entries = [];
    for (let i = 0; i < n && i < 100000; i++) entries.push([dv.getUint32(stts.body + 8 + i * 8), dv.getUint32(stts.body + 12 + i * 8)]);
    t.stts = entries;
  }
  const stsz = child(dv, stbl, 'stsz');
  if (stsz) {
    t.sampleSize = dv.getUint32(stsz.body + 4);
    const n = dv.getUint32(stsz.body + 8);
    t.sampleCount = n;
    if (t.sampleSize === 0) {
      const a = new Uint32Array(n);
      for (let i = 0; i < n; i++) a[i] = dv.getUint32(stsz.body + 12 + i * 4);
      t.sizes = a;
    }
  }
  const stsc = child(dv, stbl, 'stsc');
  if (stsc) {
    const n = dv.getUint32(stsc.body + 4);
    t.stsc = [];
    for (let i = 0; i < n; i++) t.stsc.push([dv.getUint32(stsc.body + 8 + i * 12), dv.getUint32(stsc.body + 12 + i * 12)]);
  }
  const stco = child(dv, stbl, 'stco');
  const co64 = child(dv, stbl, 'co64');
  if (stco) {
    const n = dv.getUint32(stco.body + 4);
    t.chunks = new Float64Array(n);
    for (let i = 0; i < n; i++) t.chunks[i] = dv.getUint32(stco.body + 8 + i * 4);
  } else if (co64) {
    const n = dv.getUint32(co64.body + 4);
    t.chunks = new Float64Array(n);
    for (let i = 0; i < n; i++) t.chunks[i] = u64(dv, co64.body + 8 + i * 8);
  }
  return t;
}

function parseSoundDesc(dv, e, t) {
  const ver = dv.getUint16(e + 16);
  t.channels = dv.getUint16(e + 24);
  t.bits = dv.getUint16(e + 26);
  t.sampleRate = dv.getUint32(e + 32) / 65536;
  let ext = e + 36;
  if (ver === 1) {
    t.samplesPerPacket = dv.getUint32(e + 36);
    t.bytesPerFrame = dv.getUint32(e + 44);
    ext = e + 52;
  } else if (ver === 2) {
    t.sampleRate = dv.getFloat64(e + 40);
    t.channels = dv.getUint32(e + 48);
    t.bits = dv.getUint32(e + 56);
    t.lpcmFlags = dv.getUint32(e + 60);
    t.bytesPerFrame = dv.getUint32(e + 64);
    t.samplesPerPacket = dv.getUint32(e + 68);
    ext = e + 72;
  }
  const end = e + dv.getUint32(e);
  // esds / wave 内の esds（AAC の設定）
  const findEsds = (s, en, depth) => {
    for (const b of children(dv, s, en)) {
      if (b.type === 'esds') return b;
      if (b.type === 'wave' && depth < 2) { const r = findEsds(b.body, b.end, depth + 1); if (r) return r; }
    }
    return null;
  };
  const esds = findEsds(ext, end, 0);
  if (esds) t.asc = parseEsds(dv, esds.body + 4, esds.end);
}

function parseEsds(dv, p, end) {
  const readLen = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = dv.getUint8(p++); n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return n; };
  while (p < end) {
    const tag = dv.getUint8(p++);
    const len = readLen();
    if (tag === 0x03) { p += 2; const f = dv.getUint8(p++); if (f & 0x80) p += 2; if (f & 0x40) p += dv.getUint8(p) + 1; if (f & 0x20) p += 2; continue; }
    if (tag === 0x04) { p += 13; continue; }
    if (tag === 0x05) { const a = []; for (let i = 0; i < len; i++) a.push(dv.getUint8(p + i)); return a; }
    p += len;
  }
  return null;
}

function fpsFromTrack(t) {
  if (!t || !t.stts || !t.stts.length || !t.timescale) return null;
  let best = t.stts[0];
  for (const e of t.stts) if (e[0] > best[0]) best = e;
  const delta = best[1];
  return { num: delta, den: t.timescale, fps: t.timescale / delta };
}

// 一般的なフレームレートに丸める
export function normalizeRate(fps) {
  const table = [
    [23.976, 1001, 24000], [24, 100, 2400], [25, 100, 2500], [29.97, 1001, 30000], [30, 100, 3000],
    [47.952, 1001, 48000], [48, 100, 4800], [50, 100, 5000], [59.94, 1001, 60000], [60, 100, 6000],
    [100, 100, 10000], [119.88, 1001, 120000], [120, 100, 12000],
  ];
  let best = table[3], bd = 1e9;
  for (const r of table) { const d = Math.abs(r[0] - fps); if (d < bd) { bd = d; best = r; } }
  return { fps: best[0], num: best[1], den: best[2] };
}

// MOV/MP4 のメタデータ
export async function probeMovie(file) {
  const tops = await findTopBoxes(file);
  const moovBox = tops.find(b => b.type === 'moov');
  if (!moovBox) throw new Error('moov が見つかりません');
  if (moovBox.size > 300 * 1024 * 1024) throw new Error('moov が大きすぎます');
  const dv = await readBytes(file, moovBox.start, moovBox.size);
  const moov = { type: 'moov', start: 0, end: moovBox.size, body: moovBox.hdr };
  const info = { kind: 'movie', name: file.name, size: file.size };
  const mvhd = child(dv, moov, 'mvhd');
  if (mvhd) {
    const v = dv.getUint8(mvhd.body);
    const ct = v === 1 ? u64(dv, mvhd.body + 4) : dv.getUint32(mvhd.body + 4);
    const ts = v === 1 ? dv.getUint32(mvhd.body + 20) : dv.getUint32(mvhd.body + 12);
    const du = v === 1 ? u64(dv, mvhd.body + 24) : dv.getUint32(mvhd.body + 16);
    if (ct > 0) info.created = (ct - 2082844800) * 1000;
    if (ts) info.duration = du / ts;
  }
  const traks = children(dv, moov.body, moov.end).filter(b => b.type === 'trak').map(b => ({ box: b, t: parseTrak(dv, b) })).filter(x => x.t);
  const video = traks.find(x => x.t.handler === 'vide');
  const audio = traks.find(x => x.t.handler === 'soun');
  const tmcd = traks.find(x => x.t.handler === 'tmcd' || x.t.codec === 'tmcd');
  if (video) {
    const v = video.t;
    info.hasVideo = true;
    info.width = Math.round(v.width || v.vWidth || 0);
    info.height = Math.round(v.height || v.vHeight || 0);
    info.videoCodec = v.codec;
    const r = fpsFromTrack(v);
    if (r) { info.rawFps = r.fps; Object.assign(info, { rate: normalizeRate(r.fps) }); }
    if (v.timescale && v.duration) info.duration = Math.max(info.duration || 0, v.duration / v.timescale);
  }
  if (audio) {
    const a = audio.t;
    info.hasAudio = true;
    info.audioCodec = a.codec;
    info.audioChannels = a.channels;
    info.audioRate = Math.round(a.sampleRate || a.timescale || 48000);
    info._audio = a;
  }
  // 開始タイムコード
  if (tmcd && tmcd.t.chunks && tmcd.t.chunks.length) {
    try {
      const tc = tmcd.t;
      // tmcd 記述：flags(4) timescale(4) frameDuration(4) numFrames(1)
      const sd = dv;
      const e = tc.sdStart;
      const flags = sd.getUint32(e + 16 + 4);
      const tsc = sd.getUint32(e + 16 + 8);
      const fd = sd.getUint32(e + 16 + 12);
      const nf = sd.getUint8(e + 16 + 16);
      const fdv = await readBytes(file, tc.chunks[0], 4);
      const frames = fdv.getUint32(0);
      info.tcFrames = frames;
      info.tcRate = { timescale: tsc, frameDuration: fd, numFrames: nf, dropFrame: !!(flags & 1) };
      // 実時間ではなく「フレーム数 × 1フレーム長」で開始位置を表す（FCP と同じ扱い）
      info.tcStart = frames * fd / tsc;
    } catch (e) { /* タイムコード無し扱い */ }
  }
  // 撮影機材名（udta 内の簡易検索）
  const udta = child(dv, moov, 'udta');
  if (udta) {
    const s = TEXT.decode(new Uint8Array(dv.buffer, udta.body, Math.min(udta.end - udta.body, 4096)));
    const m = s.match(/(?:\xa9mak|\xa9mod)[\s\S]{4}([\x20-\x7e]{2,40})/);
    if (m) info.device = m[1].trim();
  }
  return info;
}

function chunkSampleCounts(t) {
  const n = t.chunks.length;
  const counts = new Uint32Array(n);
  for (let i = 0; i < t.stsc.length; i++) {
    const first = t.stsc[i][0] - 1;
    const next = i + 1 < t.stsc.length ? t.stsc[i + 1][0] - 1 : n;
    for (let c = first; c < next && c < n; c++) counts[c] = t.stsc[i][1];
  }
  return counts;
}

// 連続した範囲をまとめて読む
async function readRanges(file, ranges, onRange) {
  const MAXGAP = 256 * 1024, MAXLEN = 16 * 1024 * 1024;
  let i = 0;
  while (i < ranges.length) {
    let s = ranges[i][0], e = ranges[i][0] + ranges[i][1];
    let j = i + 1;
    while (j < ranges.length && ranges[j][0] >= e && ranges[j][0] - e < MAXGAP && ranges[j][0] + ranges[j][1] - s < MAXLEN) {
      e = ranges[j][0] + ranges[j][1]; j++;
    }
    const buf = await file.slice(s, e).arrayBuffer();
    for (let k = i; k < j; k++) onRange(k, new Uint8Array(buf, ranges[k][0] - s, ranges[k][1]));
    i = j;
  }
}

const PCM_CODECS = { sowt: 'le16', twos: 'be16', in24: 'be24', in32: 'be32', fl32: 'bef32', fl64: 'bef64', raw: 'u8', lpcm: 'lpcm', ipcm: 'be' };

// 音声を 16kHz モノラルで取得
export async function extractAudio16k(file, info, onProgress) {
  const a = info._audio;
  if (!a || !a.chunks) throw new Error('音声トラックがありません');
  const codec = a.codec;
  if (PCM_CODECS[codec] !== undefined) return extractPcm(file, a, onProgress);
  if (codec === 'mp4a') return extractAac(file, a, onProgress);
  throw new Error('対応していない音声形式：' + codec);
}

async function extractPcm(file, a, onProgress) {
  let fmt = PCM_CODECS[a.codec];
  let bits = a.bits || 16;
  let little = fmt === 'le16';
  let float = fmt === 'bef32' || fmt === 'bef64';
  if (fmt === 'lpcm') {
    const f = a.lpcmFlags || 0;
    float = !!(f & 1); little = !(f & 2);
  }
  if (fmt === 'be24') bits = 24;
  if (fmt === 'be32') bits = 32;
  if (fmt === 'bef32') bits = 32;
  if (fmt === 'bef64') bits = 64;
  if (fmt === 'u8') bits = 8;
  const ch = Math.max(1, a.channels || 1);
  const bpf = a.bytesPerFrame && a.bytesPerFrame >= ch * bits / 8 ? a.bytesPerFrame : ch * bits / 8;
  const bps = bits / 8;
  const counts = chunkSampleCounts(a);
  // サンプル数のとらえ方：stsz の sampleSize が 1 なら「フレーム」、それ以外も基本はフレーム
  const ranges = [];
  let total = 0;
  for (let i = 0; i < a.chunks.length; i++) {
    let frames = counts[i];
    if (a.samplesPerPacket > 1 && a.sampleSize > 1 && a.sampleSize !== bpf) frames = counts[i] * a.samplesPerPacket;
    ranges.push([a.chunks[i], frames * bpf]);
    total += frames;
  }
  const sr = a.sampleRate || a.timescale;
  const mono = new Float32Array(total);
  let w = 0;
  let done = 0;
  await readRanges(file, ranges, (k, u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = Math.floor(u8.byteLength / bpf);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) {
        const o = i * bpf + c * bps;
        let v;
        if (float) v = bits === 64 ? dv.getFloat64(o, little) : dv.getFloat32(o, little);
        else if (bits === 16) v = dv.getInt16(o, little) / 32768;
        else if (bits === 24) {
          const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
          let x = little ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2);
          if (x & 0x800000) x -= 0x1000000;
          v = x / 8388608;
        } else if (bits === 32) v = dv.getInt32(o, little) / 2147483648;
        else v = (dv.getUint8(o) - 128) / 128;
        sum += v;
      }
      mono[w++] = sum / ch;
    }
    done++;
    if (onProgress && done % 200 === 0) onProgress(done / ranges.length);
  });
  return { pcm: resample(mono.subarray(0, w), sr, 16000), offset: editOffset(a) };
}

function editOffset(a) {
  if (a.editMediaTime > 0 && a.timescale) return -a.editMediaTime / a.timescale;
  return 0;
}

// AAC：生データに ADTS ヘッダを付けて decodeAudioData でまとめて復号
async function extractAac(file, a, onProgress) {
  if (!a.asc || a.asc.length < 2) throw new Error('AAC 設定がありません');
  const aot = a.asc[0] >> 3;
  const sfi = ((a.asc[0] & 7) << 1) | (a.asc[1] >> 7);
  const chc = (a.asc[1] >> 3) & 15;
  const profile = Math.max(0, Math.min(3, aot - 1));
  const counts = chunkSampleCounts(a);
  const ranges = [];
  let sIdx = 0;
  for (let i = 0; i < a.chunks.length; i++) {
    let off = a.chunks[i];
    for (let k = 0; k < counts[i]; k++) {
      const sz = a.sizes ? a.sizes[sIdx] : a.sampleSize;
      ranges.push([off, sz]);
      off += sz; sIdx++;
    }
  }
  const sr = a.sampleRate || a.timescale || 48000;
  const PER = Math.ceil(sr / 1024 * 120); // 約120秒ごと
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const parts = [];
  let totalLen = 0;
  for (let p = 0; p < ranges.length; p += PER) {
    const sub = ranges.slice(p, p + PER);
    const frames = [];
    let bytes = 0;
    await readRanges(file, sub, (k, u8) => { frames.push(u8.slice()); bytes += u8.byteLength + 7; });
    const adts = new Uint8Array(bytes);
    let o = 0;
    for (const f of frames) {
      const len = f.byteLength + 7;
      adts[o] = 0xff; adts[o + 1] = 0xf1;
      adts[o + 2] = (profile << 6) | (sfi << 2) | ((chc >> 2) & 1);
      adts[o + 3] = ((chc & 3) << 6) | ((len >> 11) & 3);
      adts[o + 4] = (len >> 3) & 0xff;
      adts[o + 5] = ((len & 7) << 5) | 0x1f;
      adts[o + 6] = 0xfc;
      adts.set(f, o + 7);
      o += len;
    }
    const buf = await decode(ctx, adts.buffer);
    const m = mixdown(buf);
    const r = resample(m, buf.sampleRate, 16000);
    parts.push(r); totalLen += r.length;
    if (onProgress) onProgress(Math.min(1, (p + PER) / ranges.length));
  }
  const out = new Float32Array(totalLen);
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  // AAC の先頭遅延（priming）を edit list で補正
  return { pcm: out, offset: editOffset(a) };
}

function decode(ctx, ab) {
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });
}

function mixdown(buf) {
  const n = buf.length, ch = buf.numberOfChannels;
  if (ch === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i]; }
  for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

// 簡易ローパス付きの線形補間リサンプル
export function resample(x, from, to) {
  if (Math.abs(from - to) < 1) return x;
  const ratio = from / to;
  let src = x;
  if (ratio > 1.5) {
    // 箱型フィルタで帯域制限
    const k = Math.max(1, Math.floor(ratio));
    src = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) {
      acc += x[i];
      if (i >= k) acc -= x[i - k];
      src[i] = acc / Math.min(k, i + 1);
    }
  }
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio + (ratio > 1.5 ? -(Math.floor(ratio) - 1) / 2 : 0);
    const i0 = Math.max(0, Math.floor(p)), f = p - Math.floor(p);
    const a0 = src[i0] || 0, a1 = src[Math.min(src.length - 1, i0 + 1)] || 0;
    out[i] = a0 + (a1 - a0) * f;
  }
  return out;
}

// WAV / BWF
export async function probeWav(file) {
  const head = await readBytes(file, 0, 12);
  if (head.byteLength < 12 || fourcc(head, 0) !== 'RIFF' && fourcc(head, 0) !== 'RF64' || fourcc(head, 8) !== 'WAVE') throw new Error('WAV ではありません');
  let pos = 12;
  const info = { kind: 'audio', name: file.name, size: file.size, hasAudio: true, hasVideo: false };
  let ds64 = null;
  while (pos + 8 <= file.size) {
    const h = await readBytes(file, pos, 8);
    const id = fourcc(h, 0);
    let size = h.getUint32(4, true);
    if (id === 'ds64') { const d = await readBytes(file, pos + 8, 28); ds64 = d.getUint32(8, true) + d.getUint32(12, true) * 4294967296; }
    if (id === 'data' && ds64 && size === 0xffffffff) size = ds64;
    if (id === 'fmt ') {
      const d = await readBytes(file, pos + 8, Math.min(size, 40));
      info.wavFormat = d.getUint16(0, true);
      info.audioChannels = d.getUint16(2, true);
      info.audioRate = d.getUint32(4, true);
      info.blockAlign = d.getUint16(12, true);
      info.bits = d.getUint16(14, true);
      if (info.wavFormat === 0xfffe && size >= 26) info.wavFormat = d.getUint16(24, true);
    } else if (id === 'bext') {
      const d = await readBytes(file, pos + 8, Math.min(size, 360));
      if (d.byteLength >= 346) {
        const lo = d.getUint32(338, true), hi = d.getUint32(342, true);
        info.timeReference = hi * 4294967296 + lo;
        const date = TEXT.decode(new Uint8Array(d.buffer, 320, 18)).replace(/\0/g, '');
        const m = date.match(/(\d{4})[-:\/](\d\d)[-:\/](\d\d)(\d\d)[-:.](\d\d)[-:.](\d\d)/);
        if (m) info.created = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      }
    } else if (id === 'data') {
      info.dataStart = pos + 8; info.dataSize = Math.min(size, file.size - pos - 8);
    }
    pos += 8 + size + (size & 1);
  }
  if (!info.dataStart) throw new Error('音声データがありません');
  info.duration = info.dataSize / info.blockAlign / info.audioRate;
  if (info.timeReference != null) info.tcStart = info.timeReference / info.audioRate;
  info.audioCodec = 'wav';
  return info;
}

export async function extractWav16k(file, info, onProgress) {
  const ch = info.audioChannels, bits = info.bits, ba = info.blockAlign, sr = info.audioRate;
  const float = info.wavFormat === 3;
  const total = Math.floor(info.dataSize / ba);
  const mono = new Float32Array(total);
  const STEP = ba * sr * 20;
  let w = 0;
  for (let p = 0; p < info.dataSize; p += STEP) {
    const len = Math.min(STEP, info.dataSize - p);
    const dv = await readBytes(file, info.dataStart + p, len);
    const n = Math.floor(dv.byteLength / ba);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) {
        const o = i * ba + c * (bits / 8);
        let v;
        if (float) v = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
        else if (bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (bits === 24) { let x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
        else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
        else v = (dv.getUint8(o) - 128) / 128;
        s += v;
      }
      mono[w++] = s / ch;
    }
    if (onProgress) onProgress(Math.min(1, (p + len) / info.dataSize));
  }
  return { pcm: resample(mono.subarray(0, w), sr, 16000), offset: 0 };
}

export function isMovieName(n) { return /\.(mov|mp4|m4v)$/i.test(n); }
export function isAudioName(n) { return /\.(wav|bwf)$/i.test(n); }

export async function probe(file) {
  if (isAudioName(file.name)) return probeWav(file);
  return probeMovie(file);
}

export async function audio16k(file, info, onProgress) {
  if (info.kind === 'audio') return extractWav16k(file, info, onProgress);
  return extractAudio16k(file, info, onProgress);
}
