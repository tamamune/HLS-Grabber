// 検出済みの X / Instagram の画像・動画を大きなサムネで表示して保存する別ページ。
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const main = document.getElementById('main');
const imageSavers = [];

const ext = (fmt) => (fmt === 'jpeg' ? 'jpg' : fmt);

function card(media, { label, save }) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = '<div class="media"></div><div class="info"><div class="label"></div><button class="primary">保存</button></div>';
  c.querySelector('.media').appendChild(media);
  c.querySelector('.label').textContent = label;
  const btn = c.querySelector('button');
  const run = async () => {
    try { await save(); btn.textContent = '保存しました'; } catch (e) { console.error(e); btn.textContent = '失敗'; }
  };
  btn.onclick = run;
  return { el: c, run, setLabel: (t) => { c.querySelector('.label').textContent = t; } };
}

function section(title, cards) {
  if (!cards.length) return;
  const h = document.createElement('h2');
  h.textContent = `${title} ${cards.length}`;
  const g = document.createElement('div');
  g.className = 'grid';
  cards.forEach((x) => g.appendChild(x.el));
  main.append(h, g);
}

const dl = (url, filename) => chrome.downloads.download({ url, filename });

async function render() {
  main.textContent = '';
  imageSavers.length = 0;
  const k = `tab_${tabId}`;
  const list = (await chrome.storage.session.get(k))[k] || [];
  if (!list.length) {
    main.innerHTML = '<div class="empty">検出されたメディアがありません。元のタブでページを表示してから「更新」を押してください。</div>';
    return;
  }

  // X の画像（表示は large、保存は原寸 orig）
  const xImages = list.filter((x) => x.kind === 'image').reverse().map((item) => {
    const img = document.createElement('img');
    img.src = item.url.replace('name=orig', 'name=large');
    const c = card(img, { label: `原寸 .${item.fmt}`, save: () => dl(item.url, `x_${item.id}.${ext(item.fmt)}`) });
    img.onload = () => c.setLabel(`表示 ${img.naturalWidth}x${img.naturalHeight}（保存は原寸 .${item.fmt}）`);
    imageSavers.push(c);
    return c;
  });

  const xVideos = list.filter((x) => x.kind === 'video').reverse().map((item) => {
    const v = document.createElement('video');
    v.src = item.url + '#t=0.1';
    v.preload = 'metadata';
    v.controls = true;
    v.muted = true;
    const tail = item.url.split('/').pop().replace(/\.mp4$/i, '').slice(0, 12);
    return card(v, { label: `MP4 ${item.res || ''}`, save: () => dl(item.url, `x_${tail}_${item.res || 'video'}.mp4`) });
  });

  // Instagram
  const igAudio = list.filter((x) => x.kind === 'igvideo' && x.stream === 'audio');
  const igVideos = list.filter((x) => x.kind === 'igvideo' && x.stream !== 'audio')
    .sort((a, b) => (parseInt(b.res) || 0) - (parseInt(a.res) || 0)).map((item) => {
      const v = document.createElement('video');
      v.src = item.url + '#t=0.1';
      v.preload = 'metadata';
      v.controls = true;
      v.muted = true;
      const audio = item.progressive ? null : [...igAudio].sort((a, b) => Math.abs(a.time - item.time) - Math.abs(b.time - item.time))[0];
      return card(v, {
        label: `動画 ${item.res || ''}${audio ? '（音声と結合）' : item.progressive ? '' : '（映像のみ）'}`.trim(),
        save: async () => {
          if (audio) {
            const p = new URLSearchParams({ v: item.url, a: audio.url, name: `ig_${item.id}` });
            await chrome.tabs.create({ url: chrome.runtime.getURL('mediadl.html?' + p), active: false });
          } else {
            await dl(item.url, `ig_${item.id}.mp4`);
          }
        },
      });
    });

  const igImages = list.filter((x) => x.kind === 'igimage').reverse().map((item) => {
    const img = document.createElement('img');
    img.src = item.url;
    const c = card(img, { label: '画像', save: () => dl(item.url, `ig_${item.id}.${ext(item.fmt)}`) });
    img.onload = () => c.setLabel(`画像 ${img.naturalWidth}x${img.naturalHeight}`);
    imageSavers.push(c);
    return c;
  });

  section('画像（X）', xImages);
  section('動画（X）', xVideos);
  section('動画（Instagram）', igVideos);
  section('画像（Instagram）', igImages);
  if (!main.children.length) main.innerHTML = '<div class="empty">X / Instagram のメディアはまだ検出されていません。</div>';
}

document.getElementById('size').oninput = (e) => document.documentElement.style.setProperty('--size', e.target.value + 'px');
document.getElementById('reload').onclick = render;
document.getElementById('all').onclick = async () => { for (const c of imageSavers) await c.run(); };
render();
