// m3u8 の先頭セグメントから1フレームを取り出してサムネイル(dataURL)を作る
import { parsePlaylist, importAesKey, decryptSegment } from './hls.js';

const CACHE = (url) => `thumb_${url}`;
let chain = Promise.resolve();

async function getText(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function getBuf(url, range) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
  const r = await fetch(url, { headers, cache: 'no-store', credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.arrayBuffer();
}

async function build(url) {
  let pl = parsePlaylist(await getText(url), url);
  if (pl.type === 'master') {
    // 一番軽い画質から取る
    const v = [...pl.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    if (!v) throw new Error('画質がありません');
    url = v.url;
    pl = parsePlaylist(await getText(url), url);
  }
  const seg = pl.segments[0];
  if (!seg) throw new Error('セグメントがありません');
  if (seg.key && seg.key.method !== 'AES-128') throw new Error('暗号化されています');

  let data = await getBuf(seg.url, seg.range);
  if (seg.key) {
    if (!seg.key.uri) throw new Error('鍵がありません');
    data = await decryptSegment(await importAesKey(await getBuf(seg.key.uri)), data, seg);
  }
  const parts = [];
  if (seg.map) parts.push(await getBuf(seg.map.url, seg.map.range));
  parts.push(data);
  const isFmp4 = !!seg.map || /\.(m4s|mp4|m4v)(\?|$)/i.test(seg.url);
  const { frameThumb } = await import('./convert.js');
  return frameThumb(new Blob(parts), isFmp4 ? 'mp4' : 'ts');
}

/** キャッシュ付き。同時には1件ずつ処理する（ffmpeg を1つしか使わないため）。失敗時は null */
export function getThumb(url) {
  const job = chain.then(async () => {
    const k = CACHE(url);
    try {
      const c = (await chrome.storage.session.get(k))[k];
      if (c) return c === 'none' ? null : c;
    } catch {}
    let result = null;
    try { result = await build(url); } catch (e) { console.warn('thumb failed', url, e); }
    try { await chrome.storage.session.set({ [k]: result || 'none' }); } catch {}
    return result;
  });
  chain = job.catch(() => {});
  return job;
}
