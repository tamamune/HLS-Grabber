import { parsePlaylist, importAesKey, decryptSegment, vttChunk } from './lib/hls.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const srcUrl = params.get('url');
const referer = params.get('referer') || '';
const pageTitle = params.get('title') || 'video';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / (1 << 20)).toFixed(1) + ' MB');
const fmtDur = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const sanitize = (s) =>
  s.replace(/[\\/:*?"<>|~\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'video';

let running = false;

// ---------- 設定の保存 ----------
const SETTINGS_KEY = 'settings';
const DEFAULTS = { conc: 6, nameTpl: '{title}_{date}', autostop: 0, toMp4: false, merge: true };
async function loadSettings() {
  try { return { ...DEFAULTS, ...((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {}) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  const s = { conc: +$('conc').value || 6, nameTpl: $('nameTpl').value, autostop: +$('autostop').value || 0, toMp4: $('toMp4').checked, merge: $('merge').checked };
  chrome.storage.local.set({ [SETTINGS_KEY]: s }).catch(() => {});
}
function buildName(tpl) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return sanitize((tpl || '{title}').replace(/\{title\}/g, pageTitle).replace(/\{date\}/g, date).replace(/\{time\}/g, time));
}

// ---------- Referer / Origin をページに合わせる ----------
let ruleId = null;
async function setupReferer() {
  if (!referer) return;
  let origin;
  try { origin = new URL(referer).origin; } catch { return; }
  const tab = await chrome.tabs.getCurrent();
  ruleId = tab.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: referer },
          { header: 'Origin', operation: 'set', value: origin },
        ],
      },
      condition: { tabIds: [ruleId], resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  });
}
window.addEventListener('pagehide', () => {
  if (ruleId != null) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
});
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 取得 ----------
async function fetchRetry(url, { range, signal, text } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.start}-${range.end}`;
      const r = await fetch(url, { headers, credentials: 'include', cache: 'no-store', signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return text ? await r.text() : await r.arrayBuffer();
    } catch (e) {
      if (signal?.aborted || attempt >= 4) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}
const fetchText = (url, signal) => fetchRetry(url, { text: true, signal });

// ---------- 保存先 (OPFS に逐次書き込み、使えなければメモリ) ----------
class Sink {
  async open(name) {
    this.name = name;
    this.size = 0;
    try {
      const root = await navigator.storage.getDirectory();
      this.fh = await root.getFileHandle(name, { create: true });
      this.w = await this.fh.createWritable();
    } catch (e) {
      console.warn('OPFS が使えないためメモリに保存します', e);
      this.chunks = [];
    }
  }
  async write(buf) {
    this.size += buf.byteLength;
    if (this.w) await this.w.write(buf);
    else this.chunks.push(buf);
  }
  async blob(type) {
    if (this.w) { await this.w.close(); this.w = null; return this.fh.getFile(); }
    return new Blob(this.chunks, { type });
  }
  async cleanup() {
    try {
      if (this.w) await this.w.abort();
      if (this.fh) await (await navigator.storage.getDirectory()).removeEntry(this.name);
    } catch {}
    this.chunks = null;
  }
}

async function cleanupOldTemp() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'file') continue;
      const f = await h.getFile();
      if (Date.now() - f.lastModified > 24 * 3600 * 1000) await root.removeEntry(name);
    }
  } catch {}
}

// ---------- TS → fMP4 逐次変換 (mux.js) ----------
// 1セグメントずつ push → flush し、出てきた MP4 断片を返す。init セグメントは最初の1回だけ。
function makeTransmuxer() {
  const lib = globalThis.muxjs;
  const T = lib && (lib.mp4 || lib).Transmuxer;
  if (!T) throw new Error('mux.js を読み込めませんでした');
  const t = new T({ remux: true, keepOriginalTimestamps: false });
  let out = [];
  let inited = false;
  t.on('data', (seg) => {
    if (!inited && seg.initSegment) { out.push(seg.initSegment); inited = true; }
    if (seg.data && seg.data.byteLength) out.push(seg.data);
  });
  return (buf) => {
    t.push(new Uint8Array(buf));
    t.flush();
    const r = out;
    out = [];
    return r;
  };
}

// ---------- ダウンロード本体 ----------
async function run(playlistUrl, baseName, opts = {}) {
  const { isSub = false } = opts;
  const toMp4 = $('toMp4').checked;
  saveSettings();
  const autostop = Math.max(0, +$('autostop').value || 0);
  const conc = Math.max(1, Math.min(16, +$('conc').value || 6));
  // 別トラック音声の結合: 先に音声を取得しておく
  let aud = null;
  if (opts.audioUrl) {
    aud = await run(opts.audioUrl, baseName, { collect: true, label: '音声' });
    if (!aud) return; // 中止された
  }
  const ctl = new AbortController();
  const signal = ctl.signal;

  let pl = parsePlaylist(await fetchText(playlistUrl, signal), playlistUrl);
  if (pl.type !== 'media') throw new Error('メディアプレイリストではありません');
  const bad = pl.segments.find((s) => s.key && s.key.method !== 'AES-128');
  if (bad) throw new Error(`暗号方式 ${bad.key.method} には対応していません（DRM 保護の可能性があります）`);
  if (!pl.segments.length) throw new Error('セグメントがありません');

  const live = !pl.ended;
  if (live && (opts.collect || opts.audioUrl)) throw new Error('ライブ配信では音声の結合はできません。「音声を結合」のチェックを外してください');
  const isVtt = isSub || /\.(vtt|webvtt)(\?|$)/i.test(pl.segments[0].url);
  const isFmp4 = !isVtt && (pl.segments.some((s) => s.map) || /\.(m4s|mp4|m4a|m4v)(\?|$)/i.test(pl.segments[0].url));
  let ext = isVtt ? 'vtt' : isFmp4 ? (/\.m4a(\?|$)/i.test(pl.segments[0].url) ? 'm4a' : 'mp4') : 'ts';
  // TS → MP4 はダウンロード中にセグメントごとに変換してディスクへ書く（サイズ上限なし・ライブも可）。
  // 別トラック音声の結合は ffmpeg.wasm で後処理する。
  const tm = toMp4 && ext === 'ts' && !opts.collect && !opts.audioUrl ? makeTransmuxer() : null;
  if (tm) ext = 'mp4';

  const sink = new Sink();
  await sink.open(`tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

  const queue = [];
  let lastSeq = -Infinity;
  const addSegs = (segs) => { for (const s of segs) if (s.seq > lastSeq) { queue.push(s); lastSeq = s.seq; } };
  addSegs(live ? pl.segments.slice(-3) : pl.segments); // ライブは「今」から録画

  let dispatched = 0, written = 0, inflight = 0, failed = 0, durSum = 0;
  let polling = live, aborted = false, lastMapKey = null, wroteAny = false, finishResolve;
  const results = new Map();
  const keyCache = new Map();
  const mapCache = new Map();
  const finished = new Promise((r) => (finishResolve = r));
  const t0 = performance.now();

  const getKey = (uri) => {
    if (!keyCache.has(uri)) {
      if (/^skd:/i.test(uri)) throw new Error('FairPlay DRM には対応していません');
      keyCache.set(uri, fetchRetry(uri, { signal }).then(importAesKey));
    }
    return keyCache.get(uri);
  };

  async function load(seg) {
    let buf = await fetchRetry(seg.url, { range: seg.range, signal });
    if (seg.key) {
      if (!seg.key.uri) throw new Error('鍵の URI がありません');
      buf = await decryptSegment(await getKey(seg.key.uri), buf, seg);
    }
    return buf;
  }

  const checkDone = () => { if ((aborted || !polling) && written >= queue.length && inflight === 0) finishResolve(); };

  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (!aborted && results.has(written)) {
        const r = results.get(written);
        results.delete(written);
        const seg = queue[written];
        if (r.error) {
          failed++;
          console.warn('segment failed', seg.url, r.error);
        } else {
          if (seg.map) {
            const k = seg.map.url + JSON.stringify(seg.map.range);
            if (k !== lastMapKey) {
              if (!mapCache.has(k)) mapCache.set(k, await fetchRetry(seg.map.url, { range: seg.map.range, signal }));
              await sink.write(mapCache.get(k));
              lastMapKey = k;
            }
          }
          if (tm) { for (const part of tm(r.buf)) await sink.write(part); }
          else await sink.write(isVtt ? vttChunk(r.buf, wroteAny).buffer : r.buf);
          wroteAny = true;
          durSum += seg.dur;
        }
        written++;
        render();
      }
    } catch (e) {
      if (!aborted) showError(e);
    } finally {
      flushing = false;
    }
    checkDone();
  }

  function pump() {
    while (!aborted && inflight < conc && dispatched < queue.length) {
      const i = dispatched++;
      inflight++;
      load(queue[i])
        .then((buf) => results.set(i, { buf }), (error) => results.set(i, { error }))
        .finally(() => { inflight--; flush(); pump(); });
    }
    checkDone();
  }

  // ---- UI ----
  $('progress').hidden = false;
  $('status').textContent = '準備中…';
  $('bar').classList.toggle('live', live);
  $('stop').textContent = live ? '録画停止して保存' : '途中で停止して保存';
  $('stop').disabled = false;
  $('cancel').disabled = false;
  let rafPending = false;
  let uiDone = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (uiDone) return;
      const sec = (performance.now() - t0) / 1000;
      $('status').textContent = live ? (polling ? '● ライブ録画中' : '保存処理中…') : `${opts.label ? opts.label + ': ' : ''}ダウンロード中 ${Math.floor((written / queue.length) * 100)}%`;
      document.title = live ? `● 録画中 ${fmtDur(durSum)} - HLS Grabber` : `${Math.floor((written / queue.length) * 100)}% - HLS Grabber`;
      $('bar').firstElementChild.style.width = live ? '100%' : `${(written / queue.length) * 100}%`;
      $('sSeg').textContent = live ? String(written) : `${written} / ${queue.length}`;
      $('sSize').textContent = fmtSize(sink.size);
      $('sSpeed').textContent = sec > 1 ? fmtSize(sink.size / sec) + '/s' : '-';
      $('sDur').textContent = fmtDur(durSum);
      $('sFail').textContent = String(failed);
    });
  }

  $('stop').onclick = () => {
    $('stop').disabled = true;
    polling = false;
    queue.length = dispatched; // 未着手のセグメントは捨てる
    $('status').textContent = '残りの取得を待っています…';
    checkDone();
  };
  $('cancel').onclick = () => {
    if (!confirm('ダウンロードを中止しますか？保存されません。')) return;
    aborted = true;
    polling = false;
    ctl.abort();
    finishResolve();
  };

  // ライブ: 指定時間で自動停止
  if (live && autostop > 0) setTimeout(() => { if (polling && !$('stop').disabled) $('stop').click(); }, autostop * 60 * 1000);

  // ライブ: プレイリストを定期的に再取得
  if (live) {
    (async () => {
      while (polling) {
        await sleep(Math.max(1, pl.target / 2) * 1000);
        if (!polling) break;
        try {
          const p = parsePlaylist(await fetchText(playlistUrl, signal), playlistUrl);
          if (p.type === 'media') {
            pl = p;
            if (polling) addSegs(p.segments);
            if (p.ended) polling = false;
            pump();
          }
        } catch (e) {
          if (!aborted) console.warn('playlist refresh failed', e);
        }
        render();
      }
      checkDone();
    })();
  }

  render();
  pump();
  await finished;
  rafPending = false;
  uiDone = true;
  $('bar').classList.remove('live');
  $('bar').firstElementChild.style.width = '100%';
  $('sSeg').textContent = String(written);
  $('sSize').textContent = fmtSize(sink.size);
  $('sDur').textContent = fmtDur(durSum);
  $('sFail').textContent = String(failed);

  $('stop').disabled = true;
  $('cancel').disabled = true;

  if (aborted) {
    await sink.cleanup();
    $('status').textContent = '中止しました';
    return;
  }
  if (sink.size === 0) {
    await sink.cleanup();
    if (tm && written > failed) throw new Error('MP4 に変換できませんでした。「MP4に変換して保存」のチェックを外して .ts で保存してください');
    throw new Error('1つもセグメントを取得できませんでした');
  }

  if (opts.collect) return { sink, ext, failed };

  const base = sanitize(baseName);
  const sinks = [sink];
  const cleanupAll = () => sinks.forEach((x) => x.cleanup());
  const mimeOf = (e) => (e === 'vtt' ? 'text/vtt' : e === 'ts' ? 'video/mp2t' : e === 'm4a' ? 'audio/mp4' : 'video/mp4');
  const toBlob = async (sk, e) => new Blob([await sk.blob(mimeOf(e))], { type: mimeOf(e) });
  const saveBlob = async (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url, filename });
    return new Promise((resolve) => {
      chrome.downloads.onChanged.addListener(function onChange(d) {
        if (d.id === id && d.state && d.state.current !== 'in_progress') {
          chrome.downloads.onChanged.removeListener(onChange);
          URL.revokeObjectURL(url);
          resolve();
        }
      });
    });
  };

  document.title = '書き出し中 - HLS Grabber';
  const saved = [];
  const mainBlob = await toBlob(sink, ext);
  const audBlob = aud ? await toBlob(aud.sink, aud.ext) : null;
  if (aud) sinks.push(aud.sink);

  let mp4 = null;
  if (!isVtt && (aud || (toMp4 && ext === 'ts'))) {
    $('status').textContent = 'MP4 に変換しています…（ffmpeg.wasm）';
    try {
      const { toMp4: convert } = await import('./lib/convert.js');
      mp4 = await convert(
        { blob: mainBlob, ext },
        aud ? { blob: audBlob, ext: aud.ext } : null,
        (r) => { $('status').textContent = `MP4 に変換しています… ${Math.floor(r * 100)}%`; },
      );
    } catch (e) {
      console.error(e);
      showError(new Error('MP4 変換に失敗したため、元の形式で保存します: ' + (e?.message || e)));
    }
  }

  $('status').textContent = 'ファイルを書き出しています…';
  const pending = [];
  if (mp4) {
    pending.push(saveBlob(mp4, `${base}.mp4`));
    saved.push(`${base}.mp4`);
  } else {
    pending.push(saveBlob(mainBlob, `${base}.${ext}`));
    saved.push(`${base}.${ext}`);
    if (aud) {
      pending.push(saveBlob(audBlob, `${base}_audio.${aud.ext}`));
      saved.push(`${base}_audio.${aud.ext}`);
    }
  }
  const totalSize = sink.size + (aud ? aud.sink.size : 0);
  Promise.all(pending).then(cleanupAll, cleanupAll);
  document.title = '完了 - HLS Grabber';
  $('status').innerHTML = '';
  const ok = document.createElement('span');
  ok.className = 'ok';
  ok.textContent = `保存しました: ${saved.join(' , ')}（${fmtSize(totalSize)}${failed ? `、失敗 ${failed} 件` : ''}）`;
  $('status').appendChild(ok);
}

// ---------- 初期画面 ----------
function showError(e) {
  console.error(e);
  $('error').textContent = 'エラー: ' + (e?.message || e);
}

function addOption(label, sub, value, checked, extra = {}) {
  const el = document.createElement('label');
  el.className = 'opt';
  el.innerHTML = '<input type="radio" name="track"><span><span class="l"></span> <span class="sub"></span></span>';
  const input = el.querySelector('input');
  input.value = value;
  input.checked = checked;
  Object.assign(input.dataset, extra);
  el.querySelector('.l').textContent = label;
  el.querySelector('.sub').textContent = sub;
  $('options').appendChild(el);
}

async function describeMedia(url) {
  const p = parsePlaylist(await fetchText(url), url);
  if (p.type !== 'media') return '';
  const total = p.segments.reduce((a, s) => a + s.dur, 0);
  const enc = p.segments.find((s) => s.key)?.key.method;
  return [p.ended ? `VOD・${fmtDur(total)}` : 'ライブ配信', `${p.segments.length} セグメント`, enc ? `暗号化: ${enc}` : '暗号化なし'].join(' / ');
}

async function init() {
  $('src').textContent = srcUrl || '(URL なし)';
  const st = await loadSettings();
  $('conc').value = st.conc;
  $('autostop').value = st.autostop;
  $('nameTpl').value = st.nameTpl;
  $('toMp4').checked = st.toMp4;
  $('merge').checked = st.merge;
  $('name').value = buildName(st.nameTpl);
  $('nameTpl').oninput = () => { $('name').value = buildName($('nameTpl').value); };
  cleanupOldTemp();
  if (!srcUrl) return showError('URL が指定されていません');
  await setupReferer();

  let pl;
  try {
    pl = parsePlaylist(await fetchText(srcUrl), srcUrl);
  } catch (e) {
    return showError(e);
  }

  if (pl.type === 'master') {
    $('info').textContent = `マスタープレイリスト（${pl.variants.length} 画質）`;
    pl.variants.forEach((v, i) => {
      const mbps = v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : '';
      const sep = !!(v.audio && pl.audios.some((a) => a.group === v.audio));
      addOption(v.resolution || `画質 ${i + 1}`, [mbps, v.codecs, sep ? '音声別' : ''].filter(Boolean).join(' · '), v.url, i === 0, { sep: sep ? '1' : '', agroup: v.audio || '' });
    });
    const seen = new Set();
    for (const a of pl.audios) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      addOption(`音声: ${a.name || a.lang || a.group}`, a.lang, a.url, false, { audio: '1', group: a.group || '' });
    }
    const seenSub = new Set();
    for (const s of pl.subs || []) {
      if (seenSub.has(s.url)) continue;
      seenSub.add(s.url);
      addOption(`字幕: ${s.name || s.lang || s.group}`, s.lang, s.url, false, { sub: '1' });
    }
    const updateNote = () => {
      const sel = document.querySelector('input[name=track]:checked');
      const sep = !!(sel && sel.dataset.sep);
      $('audioNote').hidden = !sep || $('merge').checked;
      $('mergeRow').hidden = !sep;
    };
    $('options').addEventListener('change', updateNote);
    $('merge').addEventListener('change', updateNote);
    updateNote();
    $('pick').hidden = false;
  } else {
    describeMedia(srcUrl).then((t) => ($('info').textContent = t)).catch(() => {});
  }
  $('settings').hidden = false;

  $('start').onclick = async () => {
    const sel = document.querySelector('input[name=track]:checked');
    const url = sel ? sel.value : srcUrl;
    const name = ($('name').value || 'video') + (sel?.dataset.audio ? '_audio' : sel?.dataset.sub ? '_sub' : '');
    $('start').disabled = true;
    $('start').textContent = 'ダウンロード中…';
    $('error').textContent = '';
    running = true;
    try {
      let audioUrl = null;
      if (sel?.dataset.sep && $('merge').checked) {
        const a = [...document.querySelectorAll('input[data-audio="1"]')].find((x) => x.dataset.group === sel.dataset.agroup);
        audioUrl = a ? a.value : null;
      }
      await run(url, name, { isSub: !!sel?.dataset.sub, audioUrl });
    } catch (e) {
      showError(e);
      $('status').textContent = '失敗しました';
    } finally {
      running = false;
      $('start').disabled = false;
      $('start').textContent = '別のトラックをダウンロード';
    }
  };

  // 自動DL でポップアップのボタンから開かれた場合: すぐ開始（ライブも含む）
  if (params.get('auto') === 'click') {
    $('start').click();
    return;
  }
  // 検出時に自動で開かれた場合: VOD なら既定の画質（最高画質）で開始。ライブは無限に録画しないよう開始しない。
  if (params.get('auto') === '1') {
    const sel = document.querySelector('input[name=track]:checked');
    const url = sel ? sel.value : srcUrl;
    try {
      const p = parsePlaylist(await fetchText(url), url);
      if (p.type === 'media' && !p.ended && !(+$('autostop').value > 0)) {
        $('info').textContent += '（自動: ライブ配信のため開始していません。「ライブ自動停止」を設定すると自動で録画します）';
        return;
      }
    } catch (e) {
      return showError(e);
    }
    $('start').click();
  }
}

init();
