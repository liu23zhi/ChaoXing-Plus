import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKIP_DIRECTORY_NAMES,
  discoverClientExecutables,
  discoverClientCandidates,
  findPreferredClientIndex,
  isCxExamExecutablePath,
  getDefaultDiscoveryRoots,
  getDefaultDriveRoots
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

test('common scan defaults to the root and one direct child level', async () => {
  const tree = createTree({
    'C:\\Desktop': [{ name: 'level1', directory: true }],
    'C:\\Desktop\\level1': [
      { name: 'CXExam.exe' },
      { name: 'level2', directory: true }
    ],
    'C:\\Desktop\\level1\\level2': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\Desktop\\level1\\CXExam.exe', 0x014c],
    ['C:\\Desktop\\level1\\level2\\CXExam.exe', 0x8664]
  ]));

  const results = await discoverClientExecutables({
    roots: ['C:\\Desktop'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });

  assert.deepEqual(results.map((item) => item.path), ['C:\\Desktop\\level1\\CXExam.exe']);
});

test('full scan mode remains recursive and can stop at the first compatible machine', async () => {
  const tree = createTree({
    'C:\\Disk': [{ name: 'level1', directory: true }],
    'C:\\Disk\\level1': [{ name: 'level2', directory: true }],
    'C:\\Disk\\level1\\level2': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\Disk\\level1\\level2\\CXExam.exe', 0x014c]
  ]));

  const results = await discoverClientExecutables({
    roots: ['C:\\Disk'],
    scanMode: 'fallback-all',
    stopOnMachine: 0x014c,
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });

  assert.deepEqual(results.map((item) => item.path), ['C:\\Disk\\level1\\level2\\CXExam.exe']);
});

test('full scan selection keeps the complete candidate list when the caller needs an index', async () => {
  const tree = createTree({
    'C:\\Disk': [{ name: 'a', directory: true }, { name: 'b', directory: true }],
    'C:\\Disk\\a': [{ name: 'CXExam.exe' }],
    'C:\\Disk\\b': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\Disk\\a\\CXExam.exe', 0x014c],
    ['C:\\Disk\\b\\CXExam.exe', 0x8664]
  ]));

  const result = await discoverClientCandidates({
    scanMode: 'all',
    stopOnMachine: null,
    commonRootProvider: async () => [],
    driveRootProvider: async () => ['C:\\Disk'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.path), [
    'C:\\Disk\\a\\CXExam.exe',
    'C:\\Disk\\b\\CXExam.exe'
  ]);
  assert.equal(result.selected.path, 'C:\\Disk\\a\\CXExam.exe');
});

test('conventional disk root and one direct child are common candidates; a common x64 prevents recursive fallback', async () => {
  const tree = createTree({
    'C:\\': [{ name: 'CXExam.exe' }, { name: 'Games', directory: true }],
    'C:\\Games': [{ name: 'CXExam.exe' }, { name: 'deep', directory: true }],
    'C:\\Games\\deep': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\CXExam.exe', 0x8664],
    ['C:\\Games\\CXExam.exe', 0x014c],
    ['C:\\Games\\deep\\CXExam.exe', 0x014c]
  ]));
  let fullScanCalls = 0;
  const result = await discoverClientCandidates({
    scanMode: 'fallback-all',
    commonRootProvider: async () => [],
    driveRootProvider: async () => ['C:\\'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    onFullScan: () => { fullScanCalls += 1; }
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['C:\\CXExam.exe', 'C:\\Games\\CXExam.exe']);
  assert.equal(result.candidates[0].machine, 0x8664);
  assert.equal(fullScanCalls, 0);
});

test('fallback scan retains the first x64 and stops at the first x86 in encounter order', async () => {
  const tree = createTree({
    'D:\\': [{ name: 'z', directory: true }, { name: 'a', directory: true }],
    'D:\\a': [{ name: 'nested', directory: true }],
    'D:\\z': [{ name: 'nested', directory: true }],
    'D:\\a\\nested': [{ name: 'CXExam.exe' }],
    'D:\\z\\nested': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['D:\\a\\nested\\CXExam.exe', 0x8664],
    ['D:\\z\\nested\\CXExam.exe', 0x014c]
  ]));
  let fullScanCalls = 0;
  const result = await discoverClientCandidates({
    scanMode: 'fallback-all',
    commonRootProvider: async () => [],
    driveRootProvider: async () => ['D:\\'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    onFullScan: () => { fullScanCalls += 1; }
  });
  assert.equal(fullScanCalls, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['D:\\a\\nested\\CXExam.exe', 'D:\\z\\nested\\CXExam.exe']);
  assert.equal(result.selected.path, 'D:\\z\\nested\\CXExam.exe');
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

test('common roots can exclude fixed-disk roots so fallback remains explicit', async () => {
  const existing = new Set(['C:\\Users\\Test\\Desktop', 'C:\\Program Files', 'C:\\']);
  const fsProvider = {
    async stat(directory) {
      if (!existing.has(directory)) throw new Error('missing');
      return { isDirectory: () => true };
    }
  };
  const commonRoots = await getDefaultDiscoveryRoots({
    env: {
      USERPROFILE: 'C:\\Users\\Test',
      ProgramFiles: 'C:\\Program Files',
      SystemDrive: 'C:'
    },
    fsProvider,
    driveLetters: ['C'] ,
    includeDriveRoots: false
  });
  assert.deepEqual(commonRoots, ['C:\\Users\\Test\\Desktop', 'C:\\Program Files']);
  assert.deepEqual(await getDefaultDriveRoots({
    env: { SystemDrive: 'C:' },
    fsProvider,
    driveLetters: ['C']
  }), ['C:\\']);
});

test('default candidate selection prefers compatible x86 clients without hiding x64 discoveries', () => {
  const candidates = [
    { path: 'C:\\Exam64\\CXExam.exe', machine: 0x8664 },
    { path: 'C:\\Exam32\\CXExam.exe', machine: 0x014c }
  ];
  assert.equal(findPreferredClientIndex(candidates), 1);
  assert.equal(candidates.length, 2);
});

test('manual client selection accepts CXExam.exe path separators but rejects unrelated executables', () => {
  assert.equal(isCxExamExecutablePath('D:\\Exam Files\\CXExam.exe'), true);
  assert.equal(isCxExamExecutablePath('D:/Exam Files/cxexam.EXE'), true);
  assert.equal(isCxExamExecutablePath('D:\\Exam Files\\Other.exe'), false);
});

test('AppData and ProgramData are not excluded from recursive discovery', () => {
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('appdata'), false);
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('programdata'), false);
});
