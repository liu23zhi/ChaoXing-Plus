import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function readWindowsBuildFeatures({ root = repositoryRoot, release = false } = {}) {
  // Release builds cannot inherit the developer's ignored local switches.
  if (release) return { injectionLog: false };
  let text;
  try {
    text = await readFile(join(root, 'windows', 'local-features.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { injectionLog: false };
    throw new Error('Cannot read windows/local-features.json', { cause: error });
  }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error('Invalid windows/local-features.json', { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.hasOwn(value, 'injectionLog') && typeof value.injectionLog !== 'boolean')) {
    throw new Error('windows/local-features.json injectionLog must be a boolean');
  }
  return { injectionLog: value.injectionLog === true };
}
