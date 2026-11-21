// 音声認識（端末内で処理）
import { pipeline, env } from '../vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;

const MODELS = {
  high: 'onnx-community/whisper-large-v3-turbo',
  std: 'onnx-community/whisper-small',
  light: 'onnx-community/whisper-base',
};

let asr = null, current = null;

async function hasF16() {
  try {
    const a = await navigator.gpu.requestAdapter();
    return !!a && a.features.has('shader-f16');
  } catch (e) { return false; }
}

async function load(quality) {
  if (asr && current === quality) return asr;
  const webgpu = !!self.navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  let q = quality;
  if (!webgpu && q === 'high') q = 'std';
  const model = MODELS[q] || MODELS.std;
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let l = 0, t = 0; for (const [a, b] of files.values()) { l += a; t += b; }
      postMessage({ type: 'model-progress', loaded: l, total: t });
    }
  };
  let dtype, device;
  if (webgpu) {
    device = 'webgpu';
    const f16 = await hasF16();
    dtype = { encoder_model: f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
    if (q === 'high' && !f16) dtype.encoder_model = 'q8';
  } else {
    device = 'wasm';
    dtype = { encoder_model: 'q8', decoder_model_merged: 'q8' };
  }
  asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  current = quality;
  postMessage({ type: 'model-ready', model: q, device });
  return asr;
}

const HALLUCINATION = /ご視聴ありがとう|チャンネル登録|高評価|字幕|最後までご覧|お疲れ様でした。$|^(?:\s*[。、]\s*)+$/;

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') { await load(m.quality); return; }
    if (m.type === 'transcribe') {
      const p = await load(m.quality);
      const out = [];
      const regions = m.regions;
      for (let i = 0; i < regions.length; i++) {
        const [t0, t1] = regions[i];
        const a = Math.max(0, Math.floor((t0 - 0.25) * 16000));
        const b = Math.min(m.pcm.length, Math.ceil((t1 + 0.25) * 16000));
        if (b - a < 1600) continue;
        const audio = m.pcm.subarray(a, b);
        const r = await p(audio, {
          language: 'japanese', task: 'transcribe',
          return_timestamps: true,
          chunk_length_s: 30, stride_length_s: 4,
          no_repeat_ngram_size: 0,
        });
        const base = a / 16000;
        const chunks = r.chunks && r.chunks.length ? r.chunks : [{ text: r.text, timestamp: [0, (b - a) / 16000] }];
        for (const c of chunks) {
          const text = (c.text || '').trim();
          if (!text || HALLUCINATION.test(text)) continue;
          let s = c.timestamp[0] ?? 0, e = c.timestamp[1] ?? (b - a) / 16000;
          out.push({ start: base + s, end: base + Math.max(s + 0.1, e), text });
        }
        postMessage({ type: 'progress', id: m.id, done: i + 1, total: regions.length });
      }
      postMessage({ type: 'result', id: m.id, segments: out });
    }
  } catch (e) {
    postMessage({ type: 'error', id: m.id, message: String(e && e.message || e) });
  }
};
