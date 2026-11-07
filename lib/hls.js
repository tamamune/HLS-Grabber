// HLS プレイリスト解析と AES-128 復号

export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

export function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('m3u8 プレイリストではありません');

  // マスタープレイリスト
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audios = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          variants.push({
            bandwidth: +a.BANDWIDTH || 0,
            resolution: a.RESOLUTION || '',
            codecs: a.CODECS || '',
            audio: a.AUDIO || null,
            url: new URL(lines[j], base).href,
          });
        }
        i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) {
          audios.push({ group: a['GROUP-ID'], name: a.NAME || '', lang: a.LANGUAGE || '', url: new URL(a.URI, base).href });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: 'master', variants, audios };
  }

  // メディアプレイリスト
  const segments = [];
  let seq = 0, key = null, map = null, dur = 0, target = 6, ended = false;
  let br = null, lastUri = null, lastEnd = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.slice(22), 10) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = parseFloat(l.slice(22)) || 6;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? new URL(a.URI, base).href : null, iv: a.IV || null };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      let range = null;
      if (a.BYTERANGE) {
        const [len, off] = a.BYTERANGE.split('@');
        range = { start: +off || 0, end: (+off || 0) + +len - 1 };
      }
      map = { url: new URL(a.URI, base).href, range };
    } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) br = l.slice(17);
    else if (l === '#EXT-X-ENDLIST') ended = true;
    else if (!l.startsWith('#')) {
      const url = new URL(l, base).href;
      let range = null;
      if (br) {
        const [len, off] = br.split('@');
        const start = off !== undefined ? +off : url === lastUri ? lastEnd : 0;
        range = { start, end: start + +len - 1 };
        lastEnd = range.end + 1;
        lastUri = url;
        br = null;
      }
      segments.push({ seq, url, dur, key, map, range });
      seq++;
      dur = 0;
    }
  }
  return { type: 'media', segments, target, ended };
}

export function ivFor(seg) {
  if (seg.key.iv) {
    const h = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  }
  // IV 未指定時はメディアシーケンス番号 (128bit ビッグエンディアン)
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  dv.setUint32(8, Math.floor(seg.seq / 2 ** 32));
  dv.setUint32(12, seg.seq >>> 0);
  return iv;
}

export async function importAesKey(raw) {
  if (raw.byteLength !== 16) throw new Error(`鍵の長さが不正です (${raw.byteLength} bytes)`);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
}

export async function decryptSegment(cryptoKey, data, seg) {
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, cryptoKey, data);
}
