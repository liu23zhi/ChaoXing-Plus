import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directories = new Set();
const removeOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const keepDirectories = process.env.CX_TEST_KEEP_TEMP === '1';

export function resolveTestPath(...parts) {
  return resolve(root, ...parts);
}

export function createTestDirectory(label) {
  if (typeof label !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) {
    throw new TypeError('Test directory label must contain lowercase letters, digits or hyphens');
  }
  const directory = mkdtempSync(resolve(root, `.tmp-tests-${label}-`));
  directories.add(directory);
  if (keepDirectories) console.error(`Preserving test directory: ${directory}`);
  return directory;
}

after(async () => {
  if (keepDirectories) return;
  const failures = [];
  for (const directory of directories) {
    try {
      await rm(directory, removeOptions);
      directories.delete(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Test directory cleanup failed');
});

// Monitor fatal exceptions without swallowing or replacing their original error.
function cleanupSync() {
  if (keepDirectories) return;
  for (const directory of directories) {
    try {
      rmSync(directory, removeOptions);
      directories.delete(directory);
    } catch (error) {
      console.error(`Test directory cleanup failed: ${directory}`, error);
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}

process.once('uncaughtExceptionMonitor', cleanupSync);
process.prependOnceListener('exit', cleanupSync);
