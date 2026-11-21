import './extension-tab-pause.js';
import { defaultTikuBaseUrl } from './extension-build-defaults.js';
import { registerDiagnostics } from './extension-diagnostics.js';

registerDiagnostics(chrome, defaultTikuBaseUrl);
