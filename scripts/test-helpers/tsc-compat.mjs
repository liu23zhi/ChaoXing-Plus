import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const compiler = resolve('node_modules/@typescript/typescript6/bin/tsc6');
const result = spawnSync(process.execPath, [
  compiler,
  ...process.argv.slice(2),
  '--ignoreConfig',
  '--types', 'node',
  '--ignoreDeprecations', '6.0'
], { stdio: 'inherit' });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
