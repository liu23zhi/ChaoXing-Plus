import { sleep } from '../runtime/dom.js';

export async function waitForMedia(options?: {
  videoSelector?: string;
  audioSelector?: string;
  root?: HTMLElement | Document;
  timeout?: number;
  filter?: (video: HTMLVideoElement | HTMLAudioElement) => boolean;
}) {
  const deadline = Date.now() + (options?.timeout ?? 3 * 60 * 1000);
  while (Date.now() < deadline) {
    const media = (options?.root || document).querySelector<HTMLVideoElement | HTMLAudioElement>(
      `${options?.videoSelector || 'video'},${options?.audioSelector || 'audio'}`
    );
    if (media && (!options?.filter || options.filter(media))) {
      return media;
    }
    await sleep(200);
  }
  throw new Error('视频/音频未找到，或者加载超时。');
}

export async function waitForElement(
  selector: string | (() => HTMLElement | undefined),
  opts?: { timeout_seconds?: number; check_period_ms?: number }
) {
  const deadline = Date.now() + ((opts?.timeout_seconds ?? 10) * 1000);
  while (Date.now() < deadline) {
    const result = typeof selector === 'function' ? selector() : document.querySelector<HTMLElement>(selector);
    if (result) return result;
    await sleep(opts?.check_period_ms ?? 1000);
  }
  return undefined;
}
