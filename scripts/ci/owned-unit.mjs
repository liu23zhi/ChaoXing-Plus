// Explicit first-party tests: adding a new test that controls an external program must
// never opt it into hosted CI merely by matching a wildcard.
import {spawnSync} from 'node:child_process';
const files = [
  'answer-judgement-synonyms', 'answer-text-matching', 'check-coverage', 'coverage-ts-scope',
  'device-identity', 'device-identity-headers', 'device-quota', 'diagnostic-outbox', 'extension-diagnostic-receipt',
  'cx-incident-announcement', 'extension-diagnostics', 'ime-spoofing-freeze', 'manifest-permissions', 'motion-preference', 'ordinary-native-activation', 'ordinary-native-authority', 'owned-script-authority',
  'panel-glass-dry', 'panel-runtime', 'pink-panel-ui', 'panel-status-tab', 'panel-status-visibility', 'panel-ui-contrast', 'panel-visibility',
  'runtime-request-error-classification', 'runtime-request-retry', 'runtime-store',
  'status-panel', 'status-panel-http', 'test-temp-directories',
  'tiku-adapter-error-classification', 'tiku-adapter-errors', 'tiku-adapter-health', 'tiku-adapter-quota',
  'tiku-config-section', 'windows-config-reload',
].map(name => 'scripts/' + name + '.test.mjs');
files.push('scripts/ci/shared-syntax-contract.test.mjs');
// Explicitly name the surfaces that this Node/V8 run can measure: it cannot observe
// Chromium-rendered UI, a Win32 executable or an external client. Keep the existing
// src / node-source / share-file thresholds; real browser/Win32 behavior has its own gates.
const measured = [
  'src/extension-diagnostics.js',
  'src/core/utils/request.ts', 'src/core/utils/string.ts', 'src/core/utils/tiku-adapter-error.ts',
  'windows/node-source/extension-diagnostics.mjs', 'windows/node-source/owned-script-authority.mjs',
  'windows/share-file/chrome75-syntax.mjs',
];
const result = spawnSync(process.execPath, [
  '--import', './scripts/ci/coverage-register.mjs', '--test', '--test-reporter=tap',
  '--test-concurrency=2', '--test-timeout=120000', '--experimental-test-coverage',
  ...measured.map(file => '--test-coverage-include=' + file), ...files,
], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
