import './extension-tab-pause.js';
import { registerReceiptDiagnostics } from './extension-diagnostic-receipt.js';

import { registerAgreement } from './extension-agreement-worker.js';
import { registerDeepThinking } from './extension-deep-thinking-worker.js';
import { defaultBase } from './extension-agreement-config.js';

registerReceiptDiagnostics(chrome, registerAgreement(chrome, defaultBase));
registerDeepThinking(chrome);
