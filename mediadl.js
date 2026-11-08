// 映像(v)と音声(a)の MP4 を取得して結合し、保存する。a が無ければ v だけ保存する。
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const vUrl = params.get('v');
const aUrl = params.get('a');
const name = (params.get('name') || 'video').replace(/[\\/:*?"<>|]/g, '_');

async function fetchBlob(url, label, from, span) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${label}の取得に失敗しました (HTTP ${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  const chunks = [];
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    $('status').textContent = `${label}をダウンロード中… ${(got / 1048576).toFixed(1)} MB`;
    if (total) $('bar').style.width = `${from + (got / total) * span}%`;
  }
  return new Blob(chunks, { type: 'video/mp4' });
}

async function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const id = await chrome.downloads.download({ url, filename });
  chrome.downloads.onChanged.addListener(function onChange(d) {
    if (d.id === id && d.state && d.state.current !== 'in_progress') {
      chrome.downloads.onChanged.removeListener(onChange);
      URL.revokeObjectURL(url);
    }
  });
}

(async () => {
  try {
    if (!vUrl) throw new Error('URL が指定されていません');
    $('detail').textContent = vUrl;
    const video = await fetchBlob(vUrl, '映像', 0, aUrl ? 40 : 100);
    if (!aUrl) {
      await save(video, `${name}.mp4`);
      $('status').innerHTML = `<span class="ok">保存しました: ${name}.mp4</span>`;
      return;
    }
    const audio = await fetchBlob(aUrl, '音声', 40, 30);
    $('status').textContent = '映像と音声を結合しています…（ffmpeg.wasm）';
    try {
      const { toMp4 } = await import('./lib/convert.js');
      const out = await toMp4({ blob: video, ext: 'mp4' }, { blob: audio, ext: 'mp4' }, (r) => {
        $('bar').style.width = `${70 + r * 30}%`;
      });
      await save(out, `${name}.mp4`);
      $('bar').style.width = '100%';
      $('status').innerHTML = `<span class="ok">保存しました: ${name}.mp4</span>`;
    } catch (e) {
      console.error(e);
      $('error').textContent = '結合に失敗したため、映像と音声を別々に保存します: ' + (e?.message || e);
      await save(video, `${name}.mp4`);
      await save(audio, `${name}_audio.mp4`);
      $('status').textContent = '別々に保存しました';
    }
  } catch (e) {
    console.error(e);
    $('status').textContent = '失敗しました';
    $('error').textContent = 'エラー: ' + (e?.message || e);
  }
})();
