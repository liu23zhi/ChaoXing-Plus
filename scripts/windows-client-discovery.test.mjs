import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SKIP_DIRECTORY_NAMES,
  discoverClientExecutables,
  discoverClientCandidates,
  findPreferredClientIndex,
  isCxExamExecutablePath,
  resolveExplicitClientPath,
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
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['C:\\Games\\CXExam.exe', 'C:\\CXExam.exe']);
  assert.equal(result.candidates[0].machine, 0x014c);
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

test('fallback scan selects the first encountered x64 when no x86 exists', async () => {
  const tree = createTree({
    'D:\\': [{ name: 'alpha', directory: true }, { name: 'beta', directory: true }],
    'D:\\alpha': [{ name: 'nested', directory: true }],
    'D:\\beta': [{ name: 'nested', directory: true }],
    'D:\\alpha\\nested': [{ name: 'CXExam.exe' }],
    'D:\\beta\\nested': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['D:\\alpha\\nested\\CXExam.exe', 0x8664],
    ['D:\\beta\\nested\\CXExam.exe', 0x8664]
  ]));
  const result = await discoverClientCandidates({
    scanMode: 'fallback-all',
    commonRootProvider: async () => [],
    driveRootProvider: async () => ['D:\\'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });
  assert.equal(result.source, 'full');
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['D:\\alpha\\nested\\CXExam.exe', 'D:\\beta\\nested\\CXExam.exe']);
  assert.equal(result.selected.path, 'D:\\alpha\\nested\\CXExam.exe');
  assert.equal(result.selected.machine, 0x8664);
});

test('common-only scan mode never falls back to recursive disk scanning', async () => {
  const tree = createTree({
    'D:\\': [{ name: 'alpha', directory: true }],
    'D:\\alpha': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['D:\\alpha\\CXExam.exe', 0x8664]
  ]));
  let fullScanCalls = 0;
  const result = await discoverClientCandidates({
    scanMode: 'common',
    commonRootProvider: async () => [],
    driveRootProvider: async () => ['D:\\'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    onFullScan: () => { fullScanCalls += 1; }
  });
  assert.equal(fullScanCalls, 0);
  assert.equal(result.source, 'common');
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['D:\\alpha\\CXExam.exe']);
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
    desktopRootProvider: async () => '',
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
    desktopRootProvider: async () => '',
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

test('实际桌面 Known Folder 优先，并按路径去重且保留其它 OneDrive 根目录', async () => {
  const desktop = 'D:\\学校云盘\\Desktop';
  const existing = new Set([desktop, 'C:\\Users\\Test\\Desktop', 'E:\\私人云盘\\Desktop', 'C:\\Program Files']);
  let desktopCalls = 0;
  const roots = await getDefaultDiscoveryRoots({
    env: {
      USERPROFILE: 'C:\\Users\\Test',
      OneDrive: 'D:\\学校云盘',
      OneDriveConsumer: 'E:\\私人云盘',
      ProgramFiles: 'C:\\Program Files'
    },
    desktopRootProvider: async () => { desktopCalls += 1; return 'D:/学校云盘/Desktop/'; },
    fsProvider: { async stat(directory) { if (!existing.has(directory)) throw new Error('missing'); return { isDirectory: () => true }; } },
    includeDriveRoots: false
  });
  assert.equal(desktopCalls, 1);
  assert.deepEqual(roots, [desktop, 'E:\\私人云盘\\Desktop', 'C:\\Program Files']);
});

test('实际桌面查询失败、为空或不存在时回退 USERPROFILE Desktop', async () => {
  const fallback = 'C:\\Users\\Test\\Desktop';
  for (const desktopRootProvider of [
    async () => { throw new Error('PowerShell unavailable'); },
    async () => '',
    async () => 'D:\\missing\\Desktop'
  ]) {
    const roots = await getDefaultDiscoveryRoots({
      env: { USERPROFILE: 'C:\\Users\\Test' },
      desktopRootProvider,
      fsProvider: { async stat(directory) { if (directory !== fallback) throw new Error('missing'); return { isDirectory: () => true }; } },
      includeDriveRoots: false
    });
    assert.deepEqual(roots, [fallback]);
  }
});

test('重定向桌面一级客户端进入常规结果，已有 x64 不触发递归扫描', async () => {
  const desktop = 'D:\\学习资料\\桌面';
  const tree = createTree({
    [desktop]: [{ name: '考试客户端', directory: true }],
    [`${desktop}\\考试客户端`]: [{ name: 'CXExam.exe' }, { name: 'deep', directory: true }],
    [`${desktop}\\考试客户端\\deep`]: [{ name: 'CXExam.exe' }],
    'C:\\Program Files': [{ name: 'Exam64', directory: true }],
    'C:\\Program Files\\Exam64': [{ name: 'CXExam.exe' }],
    'C:\\': [{ name: 'Program Files', directory: true }],
    'D:\\': [{ name: '学习资料', directory: true }],
    'D:\\学习资料': [{ name: '桌面', directory: true }]
  }, new Map([
    [`${desktop}\\考试客户端\\CXExam.exe`, 0x014c],
    [`${desktop}\\考试客户端\\deep\\CXExam.exe`, 0x014c],
    ['C:\\Program Files\\Exam64\\CXExam.exe', 0x8664]
  ]));
  let fullScanCalls = 0;
  const inspected = [];
  const result = await discoverClientCandidates({
    scanMode: 'fallback-all',
    desktopRootProvider: async () => desktop,
    commonRootProvider: (options) => getDefaultDiscoveryRoots({
      ...options,
      env: { USERPROFILE: 'C:\\Users\\Test', ProgramFiles: 'C:\\Program Files' },
      includeDriveRoots: false
    }),
    driveRootProvider: async () => ['C:\\', 'D:\\'],
    fsProvider: tree.fsProvider,
    peMachineReader: async (candidate) => { inspected.push(candidate); return tree.peMachineReader(candidate); },
    onFullScan: () => { fullScanCalls += 1; }
  });
  assert.equal(result.source, 'common');
  assert.deepEqual(result.candidates.map((item) => item.path), [`${desktop}\\考试客户端\\CXExam.exe`, 'C:\\Program Files\\Exam64\\CXExam.exe']);
  assert.equal(result.selected.path, `${desktop}\\考试客户端\\CXExam.exe`);
  assert.equal(inspected.includes(`${desktop}\\考试客户端\\deep\\CXExam.exe`), false);
  assert.equal(fullScanCalls, 0);
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

test('显式客户端目标支持安装目录并只解析根目录或一级子目录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-explicit-client-'));
  const child = path.join(directory, 'release');
  const deep = path.join(child, 'nested');
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(directory, 'CXExam.exe'), 'root');
  await fs.writeFile(path.join(child, 'CXExam.exe'), 'child');
  await fs.writeFile(path.join(deep, 'CXExam.exe'), 'deep');
  try {
    const resolved = await resolveExplicitClientPath(directory, {
      peMachineReader: async (filePath) => filePath.endsWith(`${path.sep}release${path.sep}CXExam.exe`) ? 0x014c : 0x8664
    });
    assert.equal(resolved, path.join(child, 'CXExam.exe'));
    assert.equal(await resolveExplicitClientPath(path.join(child, 'CXExam.exe')), path.join(child, 'CXExam.exe'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('常规扫描根目录包含 APPDATA、LOCALAPPDATA 和 PROGRAMDATA', async () => {
  const roots = await getDefaultDiscoveryRoots({
    env: {
      USERPROFILE: 'C:\\Users\\Test',
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      ProgramData: 'C:\\ProgramData'
    },
    desktopRootProvider: async () => '',
    fsProvider: { async stat() { return { isDirectory: () => true }; } },
    driveLetters: ['C'],
    includeDriveRoots: false
  });
  assert.deepEqual(roots, [
    'C:\\Users\\Test\\Desktop',
    'C:\\Program Files',
    'C:\\Users\\Test\\AppData\\Roaming',
    'C:\\Users\\Test\\AppData\\Local',
    'C:\\ProgramData'
  ]);
});

test('扫描跳过符号链接目录与符号链接文件', async () => {
  const tree = createTree({
    'D:\\root': [{ name: 'linked-dir', directory: true, symlink: true }, { name: 'real', directory: true }],
    'D:\\root\\linked-dir': [{ name: 'CXExam.exe' }],
    'D:\\root\\real': [{ name: 'CXExam.exe' }, { name: 'linked.exe', symlink: true }]
  }, new Map([
    ['D:\\root\\linked-dir\\CXExam.exe', 0x014c],
    ['D:\\root\\real\\CXExam.exe', 0x8664],
    ['D:\\root\\real\\linked.exe', 0x014c]
  ]));
  const results = await discoverClientExecutables({
    roots: ['D:\\root'],
    maxDepth: 3,
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });
  assert.deepEqual(results.map((candidate) => candidate.path), ['D:\\root\\real\\CXExam.exe']);
});

test('AppData and ProgramData are not excluded from recursive discovery', () => {
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('appdata'), false);
  assert.equal(DEFAULT_SKIP_DIRECTORY_NAMES.has('programdata'), false);
});

function createCacheFs() {
  const files = new Map();
  return {
    files,
    async readFile(filePath) {
      if (!files.has(filePath)) {
        const error = new Error('missing cache');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    async mkdir() {},
    async writeFile(filePath, value) { files.set(filePath, value); }
  };
}

test('默认 fallback-all 完整常规扫描命中后可复用缓存且不触发全盘', async () => {
  const cachePath = 'C:\\cache\\scan-cache.json';
  const cacheFs = createCacheFs();
  const tree = createTree({ 'C:\\Clients': [{ name: 'CXExam.exe' }] }, new Map([['C:\\Clients\\CXExam.exe', 0x8664]]));
  let fullScans = 0;
  const options = {
    cachePath, cacheFs,
    commonRootProvider: async () => ['C:\\Clients'],
    driveRootProvider: async () => [],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    onFullScan: () => { fullScans += 1; }
  };
  assert.equal((await discoverClientCandidates(options)).source, 'common');
  for (const stopOnMachine of [0x014c, null]) {
    const result = await discoverClientCandidates({
      ...options,
      stopOnMachine,
      fsProvider: {
        async stat() { return { isFile: () => true }; },
        async readdir() { assert.fail('valid common cache must not enumerate directories'); }
      }
    });
    assert.equal(result.source, 'cache');
    assert.equal(result.selected.path, 'C:\\Clients\\CXExam.exe');
  }
  assert.equal(fullScans, 0);
  assert.equal(JSON.parse(cacheFs.files.get(cachePath)).complete, true);
});

test('需要完整候选列表时拒绝不完整的新格式常规缓存', async () => {
  const cachePath = 'C:\\cache\\scan-cache.json';
  const cacheFs = createCacheFs();
  const tree = createTree({
    'C:\\Clients': [{ name: 'a', directory: true }, { name: 'b', directory: true }],
    'C:\\Clients\\a': [{ name: 'CXExam.exe' }],
    'C:\\Clients\\b': [{ name: 'CXExam.exe' }]
  }, new Map([['C:\\Clients\\a\\CXExam.exe', 0x014c], ['C:\\Clients\\b\\CXExam.exe', 0x8664]]));
  const options = {
    cachePath, cacheFs,
    commonRootProvider: async () => ['C:\\Clients'], driveRootProvider: async () => [],
    fsProvider: { ...tree.fsProvider, async stat() { return { isFile: () => true }; } },
    peMachineReader: tree.peMachineReader
  };
  await discoverClientCandidates(options);
  const partial = JSON.parse(cacheFs.files.get(cachePath));
  partial.complete = false;
  partial.candidates = partial.candidates.slice(0, 1);
  cacheFs.files.set(cachePath, JSON.stringify(partial));
  const result = await discoverClientCandidates({ ...options, stopOnMachine: null });
  assert.equal(result.source, 'common');
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ['C:\\Clients\\a\\CXExam.exe', 'C:\\Clients\\b\\CXExam.exe']);
});

test('常规根目录或固定磁盘根目录变化时不复用原扫描缓存', async () => {
  for (const changedRoots of ['common', 'drive']) {
    const cacheFs = createCacheFs();
    const tree = createTree({
      'C:\\Old': [{ name: 'CXExam.exe' }],
      'D:\\New': [{ name: 'CXExam.exe' }]
    }, new Map([['C:\\Old\\CXExam.exe', 0x8664], ['D:\\New\\CXExam.exe', 0x014c]]));
    const options = {
      scanMode: 'common', cachePath: 'C:\\cache\\scan-cache.json', cacheFs,
      commonRootProvider: async () => changedRoots === 'common' ? ['C:\\Old'] : [],
      driveRootProvider: async () => changedRoots === 'drive' ? ['C:\\Old'] : [],
      fsProvider: { ...tree.fsProvider, async stat() { return { isFile: () => true }; } },
      peMachineReader: tree.peMachineReader
    };
    await discoverClientCandidates(options);
    const result = await discoverClientCandidates({
      ...options,
      commonRootProvider: async () => changedRoots === 'common' ? ['D:\\New'] : [],
      driveRootProvider: async () => changedRoots === 'drive' ? ['D:\\New'] : []
    });
    assert.equal(result.source, 'common');
    assert.equal(result.selected.path, 'D:\\New\\CXExam.exe');
  }
});

test('目录排除策略变化时重新扫描，不复用被排除客户端的缓存', async () => {
  const excludedName = 'cache-policy-child';
  const cacheFs = createCacheFs();
  const tree = createTree({
    'C:\\Clients': [{ name: 'CXExam.exe' }, { name: excludedName, directory: true }],
    ['C:\\Clients\\' + excludedName]: [{ name: 'CXExam.exe' }]
  }, new Map([
    ['C:\\Clients\\CXExam.exe', 0x8664],
    ['C:\\Clients\\' + excludedName + '\\CXExam.exe', 0x014c]
  ]));
  const options = {
    scanMode: 'common', cachePath: 'C:\\cache\\scan-cache.json', cacheFs,
    commonRootProvider: async () => ['C:\\Clients'], driveRootProvider: async () => [],
    fsProvider: { ...tree.fsProvider, async stat() { return { isFile: () => true }; } },
    peMachineReader: tree.peMachineReader
  };
  assert.equal((await discoverClientCandidates(options)).selected.machine, 0x014c);
  DEFAULT_SKIP_DIRECTORY_NAMES.add(excludedName);
  try {
    const result = await discoverClientCandidates(options);
    assert.equal(result.source, 'common');
    assert.equal(result.selected.path, 'C:\\Clients\\CXExam.exe');
  } finally {
    DEFAULT_SKIP_DIRECTORY_NAMES.delete(excludedName);
  }
});

test('常规候选与 common 缓存均按 x86 优先、同架构路径排序', async () => {
  const candidates = [
    { path: 'C:\\Clients\\a64\\CXExam.exe', machine: 0x8664 },
    { path: 'C:\\Clients\\b64\\CXExam.exe', machine: 0x8664 },
    { path: 'C:\\Clients\\y32\\CXExam.exe', machine: 0x014c },
    { path: 'C:\\Clients\\z32\\CXExam.exe', machine: 0x014c }
  ];
  const tree = createTree({
    'C:\\Clients': candidates.map((item) => ({ name: path.win32.basename(path.win32.dirname(item.path)), directory: true })),
    ...Object.fromEntries(candidates.map((item) => [path.win32.dirname(item.path), [{ name: 'CXExam.exe' }]]))
  }, new Map(candidates.map((item) => [item.path, item.machine])));
  const cachePath = 'C:\\cache\\scan-cache.json';
  const cacheFs = createCacheFs();
  const options = {
    scanMode: 'common', stopOnMachine: null, cachePath, cacheFs,
    commonRootProvider: async () => ['C:\\Clients'], driveRootProvider: async () => [],
    fsProvider: tree.fsProvider, peMachineReader: tree.peMachineReader
  };
  const expectedPaths = [candidates[2].path, candidates[3].path, candidates[0].path, candidates[1].path];
  const scanned = await discoverClientCandidates(options);
  assert.deepEqual(scanned.candidates.map((item) => item.path), expectedPaths);
  assert.equal(scanned.selected.path, expectedPaths[0]);

  const cached = JSON.parse(cacheFs.files.get(cachePath));
  cached.candidates = [...candidates].reverse();
  cacheFs.files.set(cachePath, JSON.stringify(cached));
  const fromCache = await discoverClientCandidates({
    ...options,
    fsProvider: { async stat() { return { isFile: () => true }; }, async readdir() { throw new Error('cache hit must not scan'); } }
  });
  assert.equal(fromCache.source, 'cache');
  assert.deepEqual(fromCache.candidates.map((item) => item.path), expectedPaths);
  assert.equal(fromCache.selected.path, expectedPaths[0]);
});

test('扫描缓存只复用仍存在且架构未变化的有效候选', async () => {
  const cacheFs = createCacheFs();
  const tree = createTree({ 'C:\\Disk': [{ name: 'CXExam.exe' }] }, new Map([['C:\\Disk\\CXExam.exe', 0x014c]]));
  let scans = 0;
  const providers = {
    commonRootProvider: async () => { scans += 1; return ['C:\\Disk']; },
    driveRootProvider: async () => []
  };
  const first = await discoverClientCandidates({
    ...providers,
    scanMode: 'common',
    cachePath: 'C:\\cache\\scan-cache.json',
    cacheFs,
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });
  assert.equal(first.source, 'common');
  assert.equal(scans, 1);

  const second = await discoverClientCandidates({
    ...providers,
    scanMode: 'common',
    cachePath: 'C:\\cache\\scan-cache.json',
    cacheFs,
    fsProvider: {
      async stat() { return { isFile: () => true }; },
      async readdir() { throw new Error('cache hit must not scan'); }
    },
    peMachineReader: tree.peMachineReader
  });
  assert.equal(second.source, 'cache');
  assert.deepEqual(second.candidates.map((candidate) => candidate.path), ['C:\\Disk\\CXExam.exe']);
  assert.equal(scans, 2, 'cache reuse still resolves the current roots without enumerating directories');
});

test('扫描缓存候选失效或架构变化时自动放弃缓存并重扫', async () => {
  for (const changedCandidate of ['missing', 'architecture']) {
    const cacheFs = createCacheFs();
    const executables = new Map([['C:\\Disk\\CXExam.exe', 0x014c]]);
    const tree = createTree({ 'C:\\Disk': [{ name: 'CXExam.exe' }] }, executables);
    const options = {
      scanMode: 'common', cachePath: 'C:\\cache\\scan-cache.json', cacheFs,
      commonRootProvider: async () => ['C:\\Disk'], driveRootProvider: async () => [],
      fsProvider: tree.fsProvider, peMachineReader: tree.peMachineReader
    };
    await discoverClientCandidates(options);
    if (changedCandidate === 'missing') executables.delete('C:\\Disk\\CXExam.exe');
    else executables.set('C:\\Disk\\CXExam.exe', 0x8664);
    const result = await discoverClientCandidates({
      ...options,
      fsProvider: {
        ...tree.fsProvider,
        async stat() {
          if (changedCandidate === 'missing') throw new Error('candidate removed');
          return { isFile: () => true };
        }
      }
    });
    assert.equal(result.source, 'common');
    if (changedCandidate === 'missing') assert.equal(result.candidates.length, 0);
    else assert.equal(result.candidates[0].machine, 0x8664);
  }
});

test('强制重扫绕过旧缓存但仍写回最新结果', async () => {
  const cacheFs = createCacheFs();
  const cachePath = 'C:\\cache\\scan-cache.json';
  const tree = createTree({ 'C:\\Disk': [{ name: 'CXExam.exe' }] }, new Map([['C:\\Disk\\CXExam.exe', 0x014c]]));
  let scans = 0;
  const common = {
    scanMode: 'common',
    cachePath,
    cacheFs,
    commonRootProvider: async () => { scans += 1; return ['C:\\Disk']; },
    driveRootProvider: async () => [],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  };
  await discoverClientCandidates(common);
  const firstCache = cacheFs.files.get(cachePath);
  const result = await discoverClientCandidates({ ...common, forceRescan: true });
  assert.equal(result.source, 'common');
  assert.equal(scans, 2);
  assert.ok(cacheFs.files.get(cachePath));
  assert.equal(JSON.parse(cacheFs.files.get(cachePath)).createdAt >= JSON.parse(firstCache).createdAt, true);
  assert.equal(JSON.parse(cacheFs.files.get(cachePath)).candidates[0].machine, 0x014c);
});

test('全盘缓存只复用完整递归结果，并保留全盘扫描顺序', async () => {
  const cacheFs = createCacheFs();
  const cachePath = 'C:\\cache\\scan-cache.json';
  cacheFs.files.set(cachePath, JSON.stringify({
    version: 1,
    createdAt: Date.now(),
    scanMode: 'fallback-all',
    source: 'common',
    complete: true,
    candidates: [
      { path: 'D:\\level1\\z\\CXExam.exe', machine: 0x8664 },
      { path: 'D:\\level1\\a\\CXExam.exe', machine: 0x014c }
    ]
  }));
  const tree = createTree({
    'D:\\': [{ name: 'level1', directory: true }],
    'D:\\level1': [{ name: 'a', directory: true }, { name: 'z', directory: true }],
    'D:\\level1\\a': [{ name: 'CXExam.exe' }],
    'D:\\level1\\z': [{ name: 'CXExam.exe' }]
  }, new Map([
    ['D:\\level1\\a\\CXExam.exe', 0x014c],
    ['D:\\level1\\z\\CXExam.exe', 0x8664]
  ]));
  let scans = 0;
  const common = {
    scanMode: 'fallback-all',
    stopOnMachine: null,
    cachePath,
    cacheFs,
    commonRootProvider: async () => [],
    driveRootProvider: async () => { scans += 1; return ['D:\\']; },
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  };
  const result = await discoverClientCandidates(common);
  assert.equal(result.source, 'full');
  assert.equal(scans, 1);

  const cached = JSON.parse(cacheFs.files.get(cachePath));
  cached.candidates.reverse();
  cacheFs.files.set(cachePath, JSON.stringify(cached));
  const hit = await discoverClientCandidates({ ...common, fsProvider: { async stat() { return { isFile: () => true }; }, async readdir() { throw new Error('full cache hit must not scan'); } } });
  assert.equal(hit.source, 'cache');
  assert.deepEqual(hit.candidates.map((candidate) => candidate.path), ['D:\\level1\\z\\CXExam.exe', 'D:\\level1\\a\\CXExam.exe']);
});

test('fallback-all 不会把旧的常规扫描缓存当作完整扫描结果', async () => {
  const cacheFs = createCacheFs();
  const cachePath = 'C:\\cache\\scan-cache.json';
  cacheFs.files.set(cachePath, JSON.stringify({
    version: 1,
    createdAt: Date.now(),
    scanMode: 'fallback-all',
    source: 'common',
    complete: true,
    candidates: [{ path: 'D:\\shallow\\CXExam.exe', machine: 0x8664 }]
  }));
  const tree = createTree({
    'D:\\': [{ name: 'deep', directory: true }],
    'D:\\deep': [{ name: 'nested', directory: true }],
    'D:\\deep\\nested': [{ name: 'CXExam.exe' }]
  }, new Map([['D:\\deep\\nested\\CXExam.exe', 0x014c]]));
  let fullScans = 0;
  const result = await discoverClientCandidates({
    scanMode: 'fallback-all',
    stopOnMachine: 0x014c,
    cachePath,
    cacheFs,
    commonRootProvider: async () => [],
    driveRootProvider: async () => { fullScans += 1; return ['D:\\']; },
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader
  });
  assert.equal(result.source, 'full');
  assert.equal(fullScans, 1);
  assert.equal(result.selected.path, 'D:\\deep\\nested\\CXExam.exe');
});

test('no-scan-cache 和 no-disk-write 完全禁止扫描缓存读写', async () => {
  for (const disabled of [{ noScanCache: true }, { noDiskWrite: true }]) {
    const cacheFs = createCacheFs();
    const tree = createTree({ 'C:\\Disk': [{ name: 'CXExam.exe' }] }, new Map([['C:\\Disk\\CXExam.exe', 0x014c]]));
    let scans = 0;
    const result = await discoverClientCandidates({
      ...disabled,
      scanMode: 'common',
      cachePath: 'C:\\cache\\scan-cache.json',
      cacheFs,
      commonRootProvider: async () => { scans += 1; return ['C:\\Disk']; },
      driveRootProvider: async () => [],
      fsProvider: tree.fsProvider,
      peMachineReader: tree.peMachineReader
    });
    assert.equal(result.source, 'common');
    assert.equal(scans, 1);
    assert.equal(cacheFs.files.size, 0);
  }
});

test('提前停止的全盘扫描结果不会污染需要完整候选列表的缓存', async () => {
  const cacheFs = createCacheFs();
  const tree = createTree({ 'D:\\': [{ name: 'level1', directory: true }], 'D:\\level1': [{ name: 'deep', directory: true }], 'D:\\level1\\deep': [{ name: 'CXExam.exe' }] }, new Map([['D:\\level1\\deep\\CXExam.exe', 0x014c]]));
  const common = { commonRootProvider: async () => [], driveRootProvider: async () => ['D:\\'], fsProvider: tree.fsProvider, peMachineReader: tree.peMachineReader };
  const early = await discoverClientCandidates({ ...common, scanMode: 'fallback-all', stopOnMachine: 0x014c, cachePath: 'C:\\cache\\scan-cache.json', cacheFs });
  assert.equal(early.source, 'full');
  assert.equal(cacheFs.files.size, 0);
  const complete = await discoverClientCandidates({ ...common, scanMode: 'fallback-all', stopOnMachine: null, cachePath: 'C:\\cache\\scan-cache.json', cacheFs });
  assert.equal(complete.source, 'full');
  assert.equal(cacheFs.files.size, 1);
  const cacheText = cacheFs.files.get('C:\\cache\\scan-cache.json');
  assert.equal(JSON.parse(cacheText).complete, true);
});

test('discoverClientExecutables 报告目录进度并支持 AbortSignal 取消', async () => {
  const tree = createTree({
    'C:\\Root': [
      { name: 'Alpha', directory: true },
      { name: 'Beta', directory: true }
    ],
    'C:\\Root\\Alpha': [{ name: 'CXExam.exe' }],
    'C:\\Root\\Beta': []
  }, new Map([['C:\\Root\\Alpha\\CXExam.exe', 0x014c]]));
  const progress = [];
  const candidates = await discoverClientExecutables({
    roots: ['C:\\Root'],
    scanMode: 'all',
    maxDepth: 3,
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    progressIntervalMs: 0,
    onProgress: (update) => progress.push(update)
  });
  assert.equal(candidates.length, 1);
  assert.ok(progress.length >= 3, JSON.stringify(progress));
  const last = progress[progress.length - 1];
  assert.equal(last.directoriesVisited, 3);
  assert.equal(last.candidatesFound, 1);
  assert.equal(typeof last.elapsedMs, 'number');

  const abortedBeforeStart = new AbortController();
  abortedBeforeStart.abort();
  await assert.rejects(discoverClientExecutables({
    roots: ['C:\\Root'],
    scanMode: 'all',
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    signal: abortedBeforeStart.signal
  }), { name: 'AbortError', code: 'ABORT_ERR' });

  const abortedMidScan = new AbortController();
  const observed = [];
  await assert.rejects(discoverClientExecutables({
    roots: ['C:\\Root'],
    scanMode: 'all',
    maxDepth: 3,
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    progressIntervalMs: 0,
    signal: abortedMidScan.signal,
    onProgress: (update) => {
      observed.push(update);
      abortedMidScan.abort();
    }
  }), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(observed.length, 1);
});

test('discoverClientCandidates 把进度与取消信号传递给全盘扫描', async () => {
  const tree = createTree({
    'C:\\Root': [{ name: 'CXExam.exe' }]
  }, new Map([['C:\\Root\\CXExam.exe', 0x014c]]));
  const scans = [];
  const run = (extra = {}) => discoverClientCandidates({
    scanMode: 'all',
    driveRootProvider: async () => ['C:\\Root'],
    fsProvider: tree.fsProvider,
    peMachineReader: tree.peMachineReader,
    stopOnMachine: null,
    progressIntervalMs: 0,
    onProgress: (update) => scans.push(update),
    ...extra
  });
  const result = await run();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.source, 'full');
  assert.ok(scans.length >= 1);
  assert.equal(scans[scans.length - 1].candidatesFound, 1);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(run({ signal: aborted.signal }), { name: 'AbortError' });
});