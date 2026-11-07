// m3u8 リクエストを監視してタブごとに記録する
const KEY = (tabId) => `tab_${tabId}`;
const M3U8_RE = /\.m3u8?(\?|#|$)/i;
const M3U8_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.warn(e)));

function isOwn(details) {
  return details.initiator && details.initiator.startsWith('chrome-extension://');
}

function add(tabId, url) {
  if (tabId < 0) return;
  serial(async () => {
    const k = KEY(tabId);
    const list = (await chrome.storage.session.get(k))[k] || [];
    if (list.some((x) => x.url === url)) return;
    list.push({ url, time: Date.now() });
    await chrome.storage.session.set({ [k]: list });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e53935' });
    await chrome.action.setBadgeText({ tabId, text: String(list.length) });
  });
}

function clear(tabId) {
  serial(async () => {
    await chrome.storage.session.remove(KEY(tabId));
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch {}
  });
}

// URL が .m3u8 のもの
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame') { clear(d.tabId); return; }
    if (isOwn(d)) return;
    try {
      if (M3U8_RE.test(new URL(d.url).pathname)) add(d.tabId, d.url);
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
