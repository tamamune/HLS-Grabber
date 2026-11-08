// ffmpeg.wasm（同梱）で TS/fMP4 を MP4 に変換、または映像と音声を結合する
let ffPromise = null;

async function getFFmpeg() {
  if (!ffPromise) {
    ffPromise = (async () => {
      const { FFmpeg } = await import('./ffmpeg/index.js');
      const ff = new FFmpeg();
      await ff.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm'),
      });
      return ff;
    })();
    ffPromise.catch(() => { ffPromise = null; });
  }
  return ffPromise;
}

/** 先頭の1フレームを JPEG の dataURL にする（映像が無ければ例外） */
export async function frameThumb(blob, ext, width = 224) {
  const ff = await getFFmpeg();
  const vin = `th_${Math.random().toString(36).slice(2)}.${ext}`;
  const out = vin + '.jpg';
  try {
    await ff.writeFile(vin, new Uint8Array(await blob.arrayBuffer()));
    const code = await ff.exec(['-i', vin, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', out]);
    if (code !== 0) throw new Error('フレームを取得できません');
    const data = await ff.readFile(out);
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(new Blob([data], { type: 'image/jpeg' }));
    });
  } finally {
    for (const f of [vin, out]) { try { await ff.deleteFile(f); } catch {} }
  }
}

const MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // wasm のメモリ上限に余裕を持たせる

/**
 * @param {{blob: Blob, ext: string}} video  映像（または音声付き）ファイル
 * @param {{blob: Blob, ext: string}|null} audio  別トラックの音声（結合する場合）
 * @param {(ratio:number)=>void} onProgress
 * @returns {Promise<Blob>} MP4
 */
export async function toMp4(video, audio, onProgress) {
  const total = video.blob.size + (audio ? audio.blob.size : 0);
  if (total > MAX_BYTES) throw new Error(`ファイルが大きすぎるため変換できません（${(total / 2 ** 30).toFixed(1)} GB / 上限 1.5 GB）`);

  const ff = await getFFmpeg();
  const progress = ({ progress }) => onProgress && onProgress(Math.max(0, Math.min(1, progress)));
  ff.on('progress', progress);
  const files = [];
  try {
    const put = async (name, blob) => {
      await ff.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
      files.push(name);
    };
    const vin = `in_v.${video.ext}`;
    await put(vin, video.blob);
    const args = ['-i', vin];
    if (audio) {
      const ain = `in_a.${audio.ext}`;
      await put(ain, audio.blob);
      args.push('-i', ain, '-map', '0:v:0', '-map', '1:a:0');
    }
    args.push('-c', 'copy', '-movflags', '+faststart', 'out.mp4');
    const code = await ff.exec(args);
    files.push('out.mp4');
    if (code !== 0) throw new Error(`ffmpeg が終了コード ${code} で失敗しました`);
    const data = await ff.readFile('out.mp4');
    if (!data || !data.byteLength) throw new Error('変換結果が空でした');
    return new Blob([data], { type: 'video/mp4' });
  } finally {
    ff.off('progress', progress);
    for (const f of files) { try { await ff.deleteFile(f); } catch {} }
  }
}
