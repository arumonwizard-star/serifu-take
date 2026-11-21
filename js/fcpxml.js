// FCPXML 書き出し
import { normalizeRate } from './media.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rateOf(info) {
  if (info && info.rate) return info.rate;
  return normalizeRate(info && info.rawFps || 29.97);
}

function fileUrl(base, rel) {
  let b = (base || '').trim().replace(/\\/g, '/');
  if (b.startsWith('file://')) b = decodeURI(b.slice(7));
  if (b && !b.endsWith('/')) b += '/';
  // 選んだフォルダ名が rel の先頭に含まれる場合の重複を避ける
  const parts = rel.split('/');
  const last = b.replace(/\/$/, '').split('/').pop();
  if (last && parts.length > 1 && parts[0] === last) parts.shift();
  const full = b + parts.join('/');
  return 'file://' + full.split('/').map(p => encodeURIComponent(p)).join('/').replace(/%3A/g, ':');
}

// clips: [{fileKey, in, out, name, keyword}]（秒・素材内時刻、余白込み）
export function buildFcpxml(opt) {
  const { clips, media, basePath, projectName, eventName, keywordClips, audioPairs } = opt;
  const assets = new Map();
  const formats = new Map();
  let rid = 1;
  const fmtId = (info) => {
    const r = rateOf(info);
    const k = `${info.width}x${info.height}@${r.num}/${r.den}`;
    if (!formats.has(k)) formats.set(k, { id: 'r' + rid++, w: info.width || 1920, h: info.height || 1080, r });
    return formats.get(k);
  };
  const assetOf = (key) => {
    if (assets.has(key)) return assets.get(key);
    const md = media[key];
    const info = md.info;
    const a = { id: 'r' + rid++, key, md, info };
    if (info.kind === 'audio') {
      a.audio = true;
      a.sr = info.audioRate;
      a.startUnits = Math.round((info.tcStart || 0) * a.sr);
    } else {
      a.fmt = fmtId(info);
      a.r = a.fmt.r;
      a.startFrames = info.tcFrames != null && info.tcRate && Math.abs(info.tcRate.frameDuration / info.tcRate.timescale - a.r.num / a.r.den) < 1e-4 ? info.tcFrames : Math.round((info.tcStart || 0) * a.r.den / a.r.num);
    }
    assets.set(key, a);
    return a;
  };
  // 素材内の時刻 → FCPXML の時刻表記
  const assetTime = (a, t) => a.audio ? `${a.startUnits + Math.round(t * a.sr)}/${a.sr}s` : `${(a.startFrames + Math.round(t * a.r.den / a.r.num)) * a.r.num}/${a.r.den}s`;
  const assetDur = (a, d) => a.audio ? `${Math.round(d * a.sr)}/${a.sr}s` : `${Math.max(1, Math.round(d * a.r.den / a.r.num)) * a.r.num}/${a.r.den}s`;

  const vclips = clips.filter(c => media[c.fileKey] && media[c.fileKey].info);
  vclips.forEach(c => assetOf(c.fileKey));
  (keywordClips || []).forEach(k => assetOf(k.fileKey));
  (audioPairs || []).forEach(p => p && assetOf(p.fileKey));
  const first = vclips.map(c => assets.get(c.fileKey)).find(a => !a.audio);
  const seqFmt = first ? first.fmt : fmtId({ width: 1920, height: 1080, rate: normalizeRate(29.97) });
  const sr = seqFmt.r;
  const seqFrames = (d) => Math.max(1, Math.round(d * sr.den / sr.num));
  const ft = (f) => `${f * sr.num}/${sr.den}s`;

  let off = 0;
  const spine = [];
  vclips.forEach((c, i) => {
    const a = assets.get(c.fileKey);
    const nf = seqFrames(c.out - c.in);
    const d = nf * sr.num / sr.den;
    const tag = a.audio ? 'asset-clip' : 'asset-clip';
    let inner = '';
    const ap = audioPairs && audioPairs[i];
    if (ap) {
      const b = assetOf(ap.fileKey);
      inner += `\n          <asset-clip ref="${b.id}" lane="-1" offset="${assetTime(a, c.in)}" name="${esc(b.md.name)}" start="${assetTime(b, ap.in)}" duration="${assetDur(b, d)}" format="${a.audio ? '' : ''}"/>`.replace(' format=""', '');
    }
    if (c.marker) inner += `\n          <marker start="${assetTime(a, c.in)}" duration="${assetDur(a, 1 / 30)}" value="${esc(c.marker)}"/>`;
    spine.push(`        <${tag} ref="${a.id}" offset="${ft(off)}" name="${esc(c.name || a.md.name)}" start="${assetTime(a, c.in)}" duration="${ft(nf)}"${a.audio ? '' : ' tcFormat="NDF"'}>${inner}${inner ? '\n        ' : ''}</${tag}>`);
    off += nf;
  });

  const res = [];
  for (const f of formats.values()) res.push(`    <format id="${f.id}" frameDuration="${f.r.num}/${f.r.den}s" width="${f.w}" height="${f.h}"/>`);
  for (const a of assets.values()) {
    const info = a.info;
    const url = fileUrl(basePath, a.md.rel || a.md.name);
    if (a.audio) {
      res.push(`    <asset id="${a.id}" name="${esc(a.md.name)}" start="${assetTime(a, 0)}" duration="${assetDur(a, info.duration || 0)}" hasAudio="1" audioSources="1" audioChannels="${info.audioChannels || 2}" audioRate="${info.audioRate || 48000}">\n      <media-rep kind="original-media" src="${esc(url)}"/>\n    </asset>`);
    } else {
      res.push(`    <asset id="${a.id}" name="${esc(a.md.name)}" start="${assetTime(a, 0)}" duration="${assetDur(a, info.duration || 0)}" hasVideo="1" format="${a.fmt.id}"${info.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="${info.audioChannels || 2}" audioRate="${info.audioRate || 48000}"` : ''}>\n      <media-rep kind="original-media" src="${esc(url)}"/>\n    </asset>`);
    }
  }

  // イベント内：素材ごとにセリフのキーワード
  const ev = [];
  const byFile = new Map();
  for (const k of keywordClips || []) { if (!byFile.has(k.fileKey)) byFile.set(k.fileKey, []); byFile.get(k.fileKey).push(k); }
  for (const [key, list] of byFile) {
    const a = assets.get(key);
    const info = a.info;
    const kws = list.map(k => `\n        <keyword start="${assetTime(a, Math.max(0, k.in))}" duration="${assetDur(a, Math.max(0.04, k.out - k.in))}" value="${esc(k.keyword.replace(/[,，]/g, '、'))}"/>`).join('');
    ev.push(`      <asset-clip ref="${a.id}" name="${esc(a.md.name)}" start="${assetTime(a, 0)}" duration="${assetDur(a, info.duration || 0)}"${a.audio ? '' : ' tcFormat="NDF"'}>${kws}\n      </asset-clip>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${res.join('\n')}
  </resources>
  <library>
    <event name="${esc(eventName || projectName)}">
${ev.join('\n')}${ev.length ? '\n' : ''}      <project name="${esc(projectName)}">
        <sequence format="${seqFmt.id}" duration="${ft(off || 1)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.map(s => '    ' + s).join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
