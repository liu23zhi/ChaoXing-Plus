import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKIP_DIRECTORY_NAMES,
  discoverClientExecutables,
  findPreferredClientIndex,
  getDefaultDiscoveryRoots
} from '../windows/host/client-discovery.mjs';

function createTree(entries, validExecutables = new Map()) {
  const directories = new Map();
  for (const [directory, children] of Object.entries(entries)) {
    directories.set(directory, children.map((child) => ({
      name: child.name,
      isDirectory: () => child.directory === true,
      isSymbolicLink: () => child.symlink === true
    })));
  }
  return {
    fsProvider: {
      async readdir(directory) {
        if (!directories.has(directory)) {
          const error = new Error(`missing ${directory}`);
          error.code = 'ENOENT';
          throw error;
        }
        return directories.get(directory);
      },
      async stat(directory) {
        if (!directories.has(directory)) {
          const error = new Error(`missing ${directory}`);
          error.code = 'ENOENT';
          throw error;
        }
        return { isDirectory: () => true };
      }
    },
    async peMachineReader(filePath) {
      return validExecutables.get(filePath) ?? null;
    }
  };
}

test('discoverClientExecutables recursively finds valid CXExam.exe files, deduplicates paths, and skips system folders', async () => {
  const tree = createTree({
    'C:\\Desktop': [
      { name: 'CXExam.exe' },
      { name: 'nested', directory: true },
      { name: 'Windows', directory: true }
    ],
    'C:\\Desktop\\nested': [
      { name: 'cxexam.EXE' },
      { name: 'deep', directory: true }
    ],
    'C:\\Desktop\\nested\\deep': [{ name: 'CXExam.exe' }],
    'C:\\Desktop\\Windows': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\Desktop\\CXExam.exe', 0x014c],
    ['C:\\Desktop\\nested\\cxexam.EXE', 0x8664],
    ['C:\\Desktop\\nested\\deep\\CXExam.exe', null],
    ['C:\\Desktop\\Windows\\CXExam.exe', 0x014c]
  ]));

  const results = await discoverClientExecutables({
    roots: ['C:\\Desktop', 'c:\\desktop'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    maxDepth: 3
  });

  assert.deepEqual(results.map((item) => item.path), [
    'C:\\Desktop\\CXExam.exe',
    'C:\\Desktop\\nested\\cxexam.EXE'
  ]);
  assert.equal(results[0].machine, 0x014c);
  assert.equal(results[1].machine, 0x8664);
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('windows'), true);
});

test('discoverClientExecutables tolerates inaccessible folders and enforces maxDepth', async () => {
  const tree = createTree({
    'D:\\root': [{ name: 'level1', directory: true }],
    'D:\\root\\level1': [{ name: 'level2', directory: true }, { name: 'CXExam.exe' }],
    'D:\\root\\level1\\level2': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['D:\\root\\level1\\CXExam.exe', 0x014c],
    ['D:\\root\\level1\\level2\\CXExam.exe', 0x014c]
  ]));

  const results = await discoverClientExecutables({
    roots: ['D:\\root', 'D:\\missing'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    maxDepth: 1
  });

  assert.deepEqual(results.map((item) => item.path), ['D:\\root\\level1\\CXExam.exe']);
});

test('discoverClientExecutables accepts an injected root provider', async () => {
  const tree = createTree({
    'E:\\picked-root': [{ name: 'CXExam.exe' }]
  }, new Map([['E:\\picked-root\\CXExam.exe', 0x014c]]));
  let rootProviderCalls = 0;

  const results = await discoverClientExecutables({
    rootProvider: async ({ fsProvider }) => {
      rootProviderCalls += 1;
      assert.equal(fsProvider, tree.fsProvider);
      return ['E:\\picked-root'];
    },
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });

  assert.equal(rootProviderCalls, 1);
  assert.deepEqual(results.map((item) => item.path), ['E:\\picked-root\\CXExam.exe']);
});

test('getDefaultDiscoveryRoots uses conventional Windows locations and existing drive roots', async () => {
  const existing = new Set(['C:\\Users\\Test\\Desktop', 'C:\\Users\\Test\\OneDrive\\Desktop', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\']);
  const roots = await getDefaultDiscoveryRoots({
    env: {
      USERPROFILE: 'C:\\Users\\Test',
      OneDrive: 'C:\\Users\\Test\\OneDrive',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      SystemDrive: 'C:'
    },
    fsProvider: {
      async stat(directory) {
        if (!existing.has(directory)) throw new Error('missing');
        return { isDirectory: () => true };
      }
    },
    driveLetters: ['C', 'Z']
  });

  assert.deepEqual(roots, [
    'C:\\Users\\Test\\Desktop',
    'C:\\Users\\Test\\OneDrive\\Desktop',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\'
  ]);
});

test('default candidate selection prefers compatible x86 clients without hiding x64 discoveries', () => {
  const candidates = [
    { path: 'C:\\Exam64\\CXExam.exe', machine: 0x8664 },
    { path: 'C:\\Exam32\\CXExam.exe', machine: 0x014c }
  ];
  assert.equal(findPreferredClientIndex(candidates), 1);
  assert.equal(candidates.length, 2);
});

test('AppData and ProgramData are not excluded from recursive discovery', () => {
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('appdata'), false);
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('programdata'), false);
});
