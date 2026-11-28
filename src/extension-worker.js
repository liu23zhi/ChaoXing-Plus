import './extension-tab-pause.js';
import { registerReceiptDiagnostics } from './extension-diagnostic-receipt.js';

import { registerAgreement } from './extension-agreement-worker.js';
import { registerDeepThinking } from './extension-deep-thinking-worker.js';
import * as config from './extension-agreement-config.js';

const { defaultBase, ordinaryNative = false } = config;

const authority = registerAgreement(chrome, defaultBase, { ordinaryNative });
if (!ordinaryNative) registerReceiptDiagnostics(chrome, authority);
registerDeepThinking(chrome);
