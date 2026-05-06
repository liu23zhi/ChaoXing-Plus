import { Project } from '../runtime/index.js';
import { $message } from '../runtime/message.js';
import { runtimeLog } from '../runtime/logger.js';

export const $console = {
  log(content: string, ...extra: unknown[]) {
    runtimeLog('log', content, ...extra);
  },
  info(content: string, ...extra: unknown[]) {
    runtimeLog('info', content, ...extra);
  },
  warn(content: string, ...extra: unknown[]) {
    runtimeLog('warn', content, ...extra);
    $message.warn(content);
  },
  error(content: string, ...extra: unknown[]) {
    runtimeLog('error', content, ...extra);
    $message.error(content);
  }
};

export const BackgroundProject = Project.create({
  name: '后台',
  domains: [],
  scripts: {}
});
