(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = `tab_${tab.id}`;
  const list = (await chrome.storage.session.get(k))[k] || [];
  const ul = document.getElementById('list');

  document.getElementById('clear').onclick = async () => {
    await chrome.storage.session.remove(k);
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    location.reload();
  };

  if (!list.length) {
    ul.innerHTML = '<div class="empty">m3u8 はまだ検出されていません。<br>動画を再生してからもう一度開いてください。</div>';
    return;
  }

  for (const item of list) {
    const li = document.createElement('li');
    let name;
    try { name = decodeURIComponent(new URL(item.url).pathname.split('/').pop()); } catch { name = item.url; }
    li.innerHTML = `
      <div class="name"></div>
      <div class="url"></div>
      <div class="row">
        <button class="primary dl">ダウンロード / 録画</button>
        <button class="copy">URLコピー</button>
      </div>`;
    li.querySelector('.name').textContent = name;
    li.querySelector('.url').textContent = item.url;
    li.querySelector('.dl').onclick = () => {
      const p = new URLSearchParams({ url: item.url, referer: tab.url || '', title: tab.title || 'video' });
      chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html?' + p) });
    };
    li.querySelector('.copy').onclick = async (e) => {
      await navigator.clipboard.writeText(item.url);
      e.target.textContent = 'コピーしました';
    };
    ul.appendChild(li);
  }
})();
