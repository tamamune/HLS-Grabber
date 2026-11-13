// m3u8 リクエストを監視してタブごとに記録する
const KEY = (tabId) => `tab_${tabId}`;
const M3U8_RE = /\.m3u8?(\?|#|$)/i;
const M3U8_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.warn(e)));

function isOwn(details) {
  return details.initiator && details.initiator.startsWith('chrome-extension://');
}

const MAX_ITEMS = 300;

// kind: 'hls'（既定）/ 'image' / 'video'（MP4）。extra: 表示用の補足
function add(tabId, url, kind = 'hls', extra = {}) {
  if (tabId < 0) return;
  serial(async () => {
    const k = KEY(tabId);
    const list = (await chrome.storage.session.get(k))[k] || [];
    if (list.some((x) => x.url === url)) return;
    list.push({ url, kind, time: Date.now(), ...extra });
    if (list.length > MAX_ITEMS) list.shift();
    await chrome.storage.session.set({ [k]: list });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e53935' });
    await chrome.action.setBadgeText({ tabId, text: String(list.length) });
    if (kind === 'hls') scheduleAuto(tabId);
  });
}

// ---- 自動ダウンロード ----
// 検出が落ち着くまで少し待ち（マスターと各画質がまとめて来るため）、
// マスタープレイリストがあればそれを、無ければ最初の m3u8 を1ページにつき1回だけ開始する。
const AUTO_FLAG = (tabId) => `auto_${tabId}`;
const autoTimers = new Map();
function scheduleAuto(tabId) {
  clearTimeout(autoTimers.get(tabId));
  autoTimers.set(tabId, setTimeout(() => {
    autoTimers.delete(tabId);
    serial(() => runAuto(tabId));
  }, 2500));
}

async function runAuto(tabId) {
  const { autoMode } = await chrome.storage.local.get('autoMode');
  if (autoMode !== 'auto') return;
  const fk = AUTO_FLAG(tabId);
  if ((await chrome.storage.session.get(fk))[fk]) return;
  const list = ((await chrome.storage.session.get(KEY(tabId)))[KEY(tabId)] || []).filter((x) => (x.kind || 'hls') === 'hls');
  if (!list.length) return;
  let pick = null;
  for (const it of list) {
    try {
      const t = await (await fetch(it.url, { cache: 'no-store', credentials: 'include' })).text();
      if (/#EXT-X-STREAM-INF/.test(t)) { pick = it; break; }
    } catch {}
  }
  pick = pick || list[0];
  await chrome.storage.session.set({ [fk]: true });
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch {}
  const p = new URLSearchParams({ url: pick.url, referer: tab?.url || '', title: tab?.title || 'video', auto: '1' });
  await chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html?' + p), active: false, ...(tab ? { index: tab.index + 1, windowId: tab.windowId } : {}) });
}

// ---- Instagram ----
const isIgHost = (h) => (h.endsWith('.cdninstagram.com') || h.endsWith('.fbcdn.net')) && !h.startsWith('static.');

// key で重複を判定し、より大きい画像（w）が来たら差し替える
function addKeyed(tabId, key, item) {
  if (tabId < 0) return;
  serial(async () => {
    const k = KEY(tabId);
    const list = (await chrome.storage.session.get(k))[k] || [];
    const i = list.findIndex((x) => x.key === key);
    if (i >= 0) {
      if ((item.w || 0) <= (list[i].w || 0)) return;
      list[i] = { ...list[i], ...item, key };
    } else {
      list.push({ ...item, key, time: Date.now() });
      if (list.length > MAX_ITEMS) list.shift();
    }
    await chrome.storage.session.set({ [k]: list });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e53935' });
    await chrome.action.setBadgeText({ tabId, text: String(list.length) });
  });
}

function handleInstagram(d, u) {
  const file = u.pathname.split('/').pop();
  if (/\.mp4$/i.test(file)) {
    // DASH の分割取得 (bytestart/byteend) を外すと全体のファイルになる
    const clean = new URL(u.href);
    clean.searchParams.delete('bytestart');
    clean.searchParams.delete('byteend');
    let tag = '';
    try {
      const efg = (u.searchParams.get('efg') || '').replace(/-/g, '+').replace(/_/g, '/');
      tag = JSON.parse(atob(efg)).vencode_tag || '';
    } catch {}
    const stream = /audio/i.test(tag) ? 'audio' : 'video';
    const res = (tag.match(/(\d{3,4})p/) || [])[1] || '';
    addKeyed(d.tabId, 'v:' + u.pathname, {
      url: clean.href, kind: 'igvideo', stream, res: res ? res + 'p' : '', progressive: /progressive/i.test(tag), id: file.replace(/\.mp4$/i, '').slice(0, 24),
    });
  } else if (d.type === 'image' && /\.(jpe?g|png|webp|heic)$/i.test(file)) {
    if (u.pathname.includes('t51.2885-19')) return; // プロフィール画像
    const m = u.searchParams.get('stp') || '';
    const w = +((m.match(/[ps](\d{3,4})x\d{3,4}/) || [])[1] || 0);
    addKeyed(d.tabId, 'i:' + u.pathname, { url: u.href, kind: 'igimage', w, id: file.replace(/\.\w+$/, '').slice(0, 24), fmt: file.split('.').pop().toLowerCase() });
  }
}

function clear(tabId) {
  serial(async () => {
    await chrome.storage.session.remove([KEY(tabId), AUTO_FLAG(tabId)]);
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
  });
}

// URL が .m3u8 のもの
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame') { clear(d.tabId); return; }
    if (isOwn(d)) return;
    try {
      const u = new URL(d.url);
      if (M3U8_RE.test(u.pathname)) return add(d.tabId, d.url);
      // X (Twitter): 画像は原寸 URL に正規化、動画は MP4 を拾う
      if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) {
        const m = u.pathname.slice(7).match(/^([\w-]+)(?:\.(\w+))?/);
        if (!m) return;
        const fmt = u.searchParams.get('format') || m[2] || 'jpg';
        add(d.tabId, `https://pbs.twimg.com/media/${m[1]}?format=${fmt}&name=orig`, 'image', { id: m[1], fmt });
      } else if (u.hostname === 'video.twimg.com' && /\.mp4$/i.test(u.pathname)) {
        const r = u.pathname.match(/\/(\d+)x(\d+)\//);
        add(d.tabId, u.origin + u.pathname, 'video', { res: r ? `${r[1]}x${r[2]}` : '' });
      } else if (isIgHost(u.hostname)) {
        // initiator で判定できないときは、タブの URL が Instagram かで判定する
        if (/instagram\.com/.test(d.initiator || '')) handleInstagram(d, u);
        else if (d.tabId >= 0) {
          chrome.tabs.get(d.tabId).then((t) => { if (/instagram\.com/.test(t.url || '')) handleInstagram(d, u); }).catch(() => {});
        }
      }
    } catch {}
  },
  { urls: ['<all_urls>'] }
);

// 拡張子がなくても Content-Type が m3u8 のもの
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (isOwn(d) || d.tabId < 0) return;
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    if (ct && M3U8_TYPES.some((t) => ct.value.toLowerCase().includes(t))) add(d.tabId, d.url);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => clear(tabId));
