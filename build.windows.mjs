import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChrome75Syntax } from './windows/host/chrome75-syntax.mjs';

process.env.VITE_CJS_IGNORE_WARNING = '1';
const require = createRequire(import.meta.url);
const { build } = require('vite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, 'dist-windows');
const defaultTikuBaseUrl = process.env.DEFAULT_TIKU_BASE_URL ?? 'https://tiku.zelly.cn/';
const packageJson = JSON.parse(await readFile(path.resolve(__dirname, 'package.json'), 'utf8'));

async function verifySyntax(filePath) {
  const source = await readFile(filePath, 'utf8');
  const result = checkChrome75Syntax(source, { label: path.basename(filePath) });
  if (!result.ok) {
    throw new Error(`${filePath} 含 Chrome 75 不支持的语法：${result.unsupported.join('、')}`);
  }
  return { file: path.basename(filePath), bytes: Buffer.byteLength(source), ok: true };
}

async function copyAsset(sourcePath, targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function sha256(filePath) {
  const buffer = await readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log('[build:windows] Vite 构建业务主包（target=chrome75）…');
  await build({
    configFile: false,
    define: {
      __DEFAULT_TIKU_BASE_URL__: JSON.stringify(defaultTikuBaseUrl)
    },
    build: {
      target: 'chrome75',
      lib: {
        entry: path.resolve(__dirname, 'src/index.ts'),
        formats: ['iife'],
        name: 'ChaoxingPlusWindows',
        fileName: () => 'chaoxing-plus.windows.js'
      },
      rollupOptions: {
        output: {
          entryFileNames: 'chaoxing-plus.windows.js'
        }
      },
      outDir,
      emptyOutDir: false,
      minify: true,
      sourcemap: false
    }
  });

  console.log('[build:windows] 复制页面 bootstrap / trampoline / SweetAlert2 样式 …');
  await copyAsset(path.resolve(__dirname, 'windows/bootstrap/windows-bootstrap.js'), path.join(outDir, 'windows-bootstrap.js'));
  await copyAsset(path.resolve(__dirname, 'windows/host/trampoline.js'), path.join(outDir, 'trampoline.js'));
  await copyAsset(
    path.resolve(__dirname, 'node_modules/sweetalert2/dist/sweetalert2.min.css'),
    path.join(outDir, 'vendor', 'sweetalert2.min.css')
  );
  await copyAsset(path.resolve(__dirname, 'windows/config.example.json'), path.join(outDir, 'config.example.json'));

  console.log('[build:windows] Chrome 75 语法闸门 …');
  const syntaxReports = [];
  for (const relative of ['chaoxing-plus.windows.js', 'windows-bootstrap.js', 'trampoline.js']) {
    syntaxReports.push(await verifySyntax(path.join(outDir, relative)));
    console.log(`[build:windows]   ✓ ${relative} 通过（${syntaxReports[syntaxReports.length - 1].bytes} 字节）`);
  }

  const files = {};
  for (const relative of [
    'chaoxing-plus.windows.js',
    'windows-bootstrap.js',
    'trampoline.js',
    'vendor/sweetalert2.min.css',
    'config.example.json'
  ]) {
    files[relative] = { sha256: await sha256(path.join(outDir, relative)) };
  }
  const manifest = {
    name: 'chaoxing-plus-windows',
    version: packageJson.version,
    builtAt: new Date().toISOString(),
    chromiumTarget: '75 (CEF 75.1.4 / Chromium 75.0.3770.100)',
    entry: 'windows/host/main.mjs',
    files,
    notes: [
      '业务 bundle 由 vite 以 chrome75 为目标构建；内嵌 SweetAlert2 一并转译。',
      '内置 handler 字符串不经过构建转译，已在源码中保持 ES2019 语法并由测试校验。',
      '页面侧缺失 API（replaceChildren/Promise.allSettled/crypto.randomUUID）由 windows-bootstrap.js 补丁。'
    ]
  };
  await writeFile(path.join(outDir, 'package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[build:windows] 完成：${outDir}`);
}

main().catch((error) => {
  console.error('[build:windows] 失败：', error && error.message ? error.message : error);
  process.exitCode = 1;
});
