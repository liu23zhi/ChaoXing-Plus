import type { ProjectDefinition } from '../runtime/index.js';
import { CXProject } from './cx.js';
import { CommonProject } from './common.js';
import { BackgroundProject } from './background.js';

export { CXProject } from './cx.js';
export { CommonProject } from './common.js';
export { BackgroundProject } from './background.js';

export function definedProjects(): ProjectDefinition[] {
  return [CXProject, CommonProject, BackgroundProject];
}
