import { getThumb } from './lib/thumb.js';

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = `tab_${tab.id}`;
  const list = (await chrome.storage.session.get(k))[k] || [];
  const ul = document.getElementById('list');

  // ダウンロードの自動/手動（自動: HLS 検出時にダウンロードタブを裏で開いて開始）
  const modeSel = document.getElementById('autoMode');
  try { modeSel.value = (await chrome.storage.local.get('autoMode')).autoMode || 'manual'; } catch {}
  modeSel.onchange = () => chrome.storage.local.set({ autoMode: modeSel.value });

  document.getElementById('gallery').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`gallery.html?tab=${tab.id}`) });
  };
  document.getElementById('clear').onclick = async () => {
    await chrome.storage.session.remove(k);
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    location.reload();
  };

  if (!list.length) {
    ul.innerHTML = '<div class="empty">動画・画像はまだ検出されていません。<br>ページを表示・再生してからもう一度開いてください。</div>';
    return;
  }

  const hlsItems = list.filter((x) => (x.kind || 'hls') === 'hls');
  const videos = list.filter((x) => x.kind === 'video').reverse();
  const images = list.filter((x) => x.kind === 'image').reverse();
  const heading = (text) => {
    const h = document.createElement('li');
    h.className = 'heading';
    h.textContent = text;
    ul.appendChild(h);
  };
  if (hlsItems.length && (videos.length || images.length)) heading(`動画（HLS） ${hlsItems.length}`);

  for (const item of hlsItems) {
    const li = document.createElement('li');
    let name;
    try { name = decodeURIComponent(new URL(item.url).pathname.split('/').pop()); } catch { name = item.url; }
    li.innerHTML = `
      <div class="item">
        <div class="thumb">読込中…</div>
        <div class="body">
          <div class="name"></div>
          <div class="url"></div>
          <div class="row">
            <button class="primary dl">ダウンロード / 録画</button>
            <button class="copy">URLコピー</button>
          </div>
        </div>
      </div>`;
    getThumb(item.url).then((src) => {
      const box = li.querySelector('.thumb');
      if (!src) { box.textContent = 'プレビュー\nなし'; return; }
      box.textContent = '';
      const img = document.createElement('img');
      img.src = src;
      box.appendChild(img);
    });
    li.querySelector('.name').textContent = name;
    li.querySelector('.url').textContent = item.url;
    // 種別・画質数・長さを表示（取得できない場合は何も出さない）
    fetch(item.url, { cache: 'no-store' }).then((r) => r.text()).then((t) => {
      let label = '';
      if (/#EXT-X-STREAM-INF/.test(t)) {
        const n = (t.match(/#EXT-X-STREAM-INF/g) || []).length;
        label = `マスター（${n}画質）← 画質を選べます`;
      } else {
        const total = [...t.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + parseFloat(m[1]), 0);
        const m = Math.floor(total / 60);
        label = /#EXT-X-ENDLIST/.test(t) ? `VOD・約${m}分` : 'ライブ配信';
      }
      const d = document.createElement('div');
      d.className = 'url';
      d.style.color = '#f0b429';
      d.textContent = label;
      li.querySelector('.url').after(d);
    }).catch(() => {});
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

  // ---- X (Twitter) の MP4 動画 / 画像 ----
  const mediaRow = (item, { filename, label, thumb }) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="item">
        <div class="thumb"></div>
        <div class="body">
          <div class="name"></div>
          <div class="url"></div>
          <div class="row">
            <button class="primary dl">保存</button>
            <button class="copy">URLコピー</button>
          </div>
        </div>
      </div>`;
    li.querySelector('.thumb').appendChild(thumb);
    li.querySelector('.name').textContent = label;
    li.querySelector('.url').textContent = item.url;
    const dl = li.querySelector('.dl');
    dl.onclick = async () => {
      try {
        await chrome.downloads.download({ url: item.url, filename });
        dl.textContent = '保存しました';
      } catch (e) {
        dl.textContent = '失敗';
        console.error(e);
      }
    };
    li.querySelector('.copy').onclick = async (e) => {
      await navigator.clipboard.writeText(item.url);
      e.target.textContent = 'コピーしました';
    };
    ul.appendChild(li);
    return li;
  };

  if (videos.length) heading(`動画（MP4） ${videos.length}`);
  for (const item of videos) {
    const v = document.createElement('video');
    v.src = item.url + '#t=0.1';
    v.preload = 'metadata';
    v.muted = true;
    const tail = item.url.split('/').pop().replace(/\.mp4$/i, '').slice(0, 12);
    mediaRow(item, {
      filename: `x_${tail}_${item.res || 'video'}.mp4`,
      label: `MP4 ${item.res || ''}`.trim(),
      thumb: v,
    });
  }

  // ---- Instagram ----
  const igAudio = list.filter((x) => x.kind === 'igvideo' && x.stream === 'audio');
  const igVideos = list
    .filter((x) => x.kind === 'igvideo' && x.stream !== 'audio')
    .sort((a, b) => (parseInt(b.res) || 0) - (parseInt(a.res) || 0));
  if (igVideos.length) heading(`動画（Instagram） ${igVideos.length}`);
  for (const item of igVideos) {
    const v = document.createElement('video');
    v.src = item.url + '#t=0.1';
    v.preload = 'metadata';
    v.muted = true;
    // 映像のみの配信は、検出時刻が一番近い音声と結合する
    const audio = item.progressive ? null : [...igAudio].sort((a, b) => Math.abs(a.time - item.time) - Math.abs(b.time - item.time))[0];
    const row = mediaRow(item, {
      filename: `ig_${item.id}.mp4`,
      label: `動画 ${item.res || ''}${audio ? '（音声と結合）' : item.progressive ? '' : '（映像のみ）'}`.trim(),
      thumb: v,
    });
    if (audio) {
      row.querySelector('.dl').onclick = () => {
        const p = new URLSearchParams({ v: item.url, a: audio.url, name: `ig_${item.id}` });
        chrome.tabs.create({ url: chrome.runtime.getURL('mediadl.html?' + p) });
      };
    }
  }
  const igImages = list.filter((x) => x.kind === 'igimage').reverse();
  if (igImages.length) heading(`画像（Instagram） ${igImages.length}`);
  for (const item of igImages) {
    const img = document.createElement('img');
    img.src = item.url;
    const row = mediaRow(item, { filename: `ig_${item.id}.${item.fmt === 'jpeg' ? 'jpg' : item.fmt}`, label: '画像', thumb: img });
    img.onload = () => { row.querySelector('.name').textContent = `画像 ${img.naturalWidth}x${img.naturalHeight}`; };
  }

  if (images.length) heading(`画像 ${images.length}`);
  for (const item of images) {
    const img = document.createElement('img');
    img.src = item.url.replace('name=orig', 'name=small');
    mediaRow(item, {
      filename: `x_${item.id}.${item.fmt === 'jpeg' ? 'jpg' : item.fmt}`,
      label: `画像（原寸） .${item.fmt}`,
      thumb: img,
    });
  }
})();
