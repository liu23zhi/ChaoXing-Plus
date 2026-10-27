import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listOwnedHostFiles } from '../windows/host/owned-files.mjs';

function comparePaths(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-owned-files-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('lists only the default config, host log files, and known timestamped diagnostics', async () => {
  await withTempDirectory(async (directory) => {
    const candidates = [
      path.join(directory, 'config.json'),
      path.join(directory, 'scan-cache.json'),
      path.join(directory, 'logs', 'host-123.log'),
      path.join(directory, 'diagnostics', '2026-10-27T19-18-14-123Z', 'render-diagnostics.json'),
      path.join(directory, 'diagnostics', '2026-10-27T19-18-14-123Z', 'render-diagnostics-window.png'),
      path.join(directory, 'diagnostics', '2026-10-27T19-18-14-123Z', 'render-diagnostics-page.png')
    ];
    for (const filePath of candidates) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'owned');
    }
    await fs.writeFile(path.join(directory, 'notes.txt'), 'keep');
    await fs.writeFile(path.join(directory, 'logs', 'host-.log'), 'owned');
    await fs.writeFile(path.join(directory, 'logs', 'custom.log'), 'keep');
    const manualDirectory = path.join(directory, 'diagnostics', 'manual');
    await fs.mkdir(manualDirectory, { recursive: true });
    await fs.writeFile(path.join(manualDirectory, 'render-diagnostics.json'), 'keep');

    const files = await listOwnedHostFiles(directory);

    assert.deepEqual(files, [
      ...candidates,
      path.join(directory, 'logs', 'host-.log')
    ].map((filePath) => path.resolve(filePath)).sort(comparePaths));
  });
});

test('does not follow symlinked data, logs, timestamp folders, or files', async () => {
  await withTempDirectory(async (directory) => {
    const root = path.join(directory, 'data');
    const outside = path.join(directory, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(path.join(outside, 'logs'), { recursive: true });
    await fs.mkdir(path.join(outside, 'diagnostics', '2026-10-27T19-18-14-123Z'), { recursive: true });
    await fs.writeFile(path.join(outside, 'config.json'), 'keep');
    await fs.writeFile(path.join(outside, 'logs', 'host-1.log'), 'keep');
    await fs.writeFile(path.join(outside, 'diagnostics', '2026-10-27T19-18-14-123Z', 'render-diagnostics.json'), 'keep');

    await fs.symlink(path.join(outside, 'config.json'), path.join(root, 'config.json'));
    await fs.symlink(path.join(outside, 'logs'), path.join(root, 'logs'), 'dir');
    await fs.symlink(path.join(outside, 'diagnostics'), path.join(root, 'diagnostics'), 'dir');

    assert.deepEqual(await listOwnedHostFiles(root), []);
    assert.equal(await fs.readFile(path.join(outside, 'config.json'), 'utf8'), 'keep');
  });
});

test('excludes explicit external config and never returns CXExam.exe', async () => {
  await withTempDirectory(async (directory) => {
    const externalConfig = path.join(directory, 'config.json');
    const dataDirectory = path.join(directory, 'data');
    const externalInside = path.join(dataDirectory, 'custom.json');
    await fs.mkdir(dataDirectory);
    await fs.writeFile(externalConfig, '{}');
    await fs.writeFile(externalInside, '{}');
    await fs.writeFile(path.join(dataDirectory, 'CXExam.exe'), 'client');
    await fs.writeFile(path.join(dataDirectory, 'config.json'), '{}');

    const files = await listOwnedHostFiles(dataDirectory, { externalConfigPath: externalConfig });

    assert.deepEqual(files, [path.join(dataDirectory, 'config.json')]);
    assert.equal(files.some((filePath) => path.basename(filePath).toLowerCase().startsWith('cxexam')), false);
  });
});

test('excludes the default config when it is explicitly designated as external config', async () => {
  await withTempDirectory(async (directory) => {
    const dataDirectory = path.join(directory, 'data');
    const defaultConfig = path.join(dataDirectory, 'config.json');
    await fs.mkdir(dataDirectory);
    await fs.writeFile(defaultConfig, '{}');

    assert.deepEqual(await listOwnedHostFiles(dataDirectory, { externalConfigPath: defaultConfig }), []);
  });
});

test('returns no candidates for a missing, non-directory, or symlinked data root', async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'config.json'), '{}');
    const link = path.join(directory, 'link');
    await fs.symlink(target, link, 'dir');
    const regularFile = path.join(directory, 'file.txt');
    await fs.writeFile(regularFile, 'not a directory');

    assert.deepEqual(await listOwnedHostFiles(path.join(directory, 'missing')), []);
    assert.deepEqual(await listOwnedHostFiles(regularFile), []);
    assert.deepEqual(await listOwnedHostFiles(link), []);
  });
});
