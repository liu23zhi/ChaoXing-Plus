export * from './configs.js';
export * from './study.js';
export * from './work.js';

export async function playMedia(playFunction: () => Promise<void> | undefined | void): Promise<boolean> {
  try {
    const result = playFunction();
    if (result) await result;
    return true;
  } catch (err) {
    console.error('[chaoxing-plus] 播放失败', err);
    return false;
  }
}

export function enableCopy(elements: Array<HTMLElement | Document>) {
  for (const target of elements) {
    target.onselectstart = () => true;
    target.oncopy = () => true;
    target.onpaste = () => true;
    target.onkeydown = () => true;
  }
}
