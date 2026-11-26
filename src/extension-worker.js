import './extension-tab-pause.js';
import { registerDiagnostics } from './extension-diagnostics.js';

import { registerAgreement } from './extension-agreement-worker.js';
import { defaultBase } from './extension-agreement-config.js';

registerDiagnostics(chrome);
registerAgreement(chrome, defaultBase);
