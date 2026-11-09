import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';

process.env.VITE_CJS_IGNORE_WARNING = '1';
const _require = createRequire(import.meta.url);
const { build } = _require('vite');

const __dirname = dirname(fileURLToPath(import.meta.url));
const watchMode = process.argv.includes('--watch');
const defaultTikuBaseUrl = process.env.DEFAULT_TIKU_BASE_URL ?? 'https://tiku.zelly.cn/';

function copyStaticFiles() {
  mkdirSync('dist', { recursive: true });

  const chaoxingHosts = [
    '*://*.chaoxing.com/*'
  ];

  const manifest = {
    manifest_version: 3,
    default_locale: 'zh_CN',
    name: '超星学习助手',
    version: '6.3.0',
    description: '给超星网站使用的自动学习与自动搜题扩展。',
    icons: {
      '512': 'icon_512X512.png'
    },
    permissions: ['storage'],
    background: { service_worker: 'extension-tab-pause.js' },
    host_permissions: chaoxingHosts,
    action: {
      default_popup: 'popup.html'
    },
    content_scripts: [
      {
        matches: chaoxingHosts,
        js: ['extension-entry.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true
      }
    ],
    web_accessible_resources: [
      {
        matches: ['<all_urls>'],
        resources: ['chaoxing-plus.js', 'vendor/sweetalert2.min.css', 'vendor/sweetalert2.all.min.js']
      }
    ]
  };

  writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
  mkdirSync('dist/_locales/zh_CN', { recursive: true });
  writeFileSync('dist/_locales/zh_CN/messages.json', JSON.stringify({}, null, 2));

  if (existsSync('src/extension-entry.js')) {
    copyFileSync('src/extension-entry.js', 'dist/extension-entry.js');
  }
  copyFileSync('src/extension-tab-pause.js', 'dist/extension-tab-pause.js');

  if (existsSync('icon/icon_512X512.png')) {
    copyFileSync('icon/icon_512X512.png', 'dist/icon_512X512.png');
  }

  if (existsSync('src/popup.html')) {
    copyFileSync('src/popup.html', 'dist/popup.html');
  }

  if (existsSync('src/popup.js')) {
    copyFileSync('src/popup.js', 'dist/popup.js');
  }

  if (existsSync('node_modules/sweetalert2/dist/sweetalert2.min.css')) {
    mkdirSync('dist/vendor', { recursive: true });
    copyFileSync('node_modules/sweetalert2/dist/sweetalert2.min.css', 'dist/vendor/sweetalert2.min.css');
  }

  if (existsSync('node_modules/sweetalert2/dist/sweetalert2.all.min.js')) {
    mkdirSync('dist/vendor', { recursive: true });
    copyFileSync('node_modules/sweetalert2/dist/sweetalert2.all.min.js', 'dist/vendor/sweetalert2.all.min.js');
  }
}

async function main() {
  await build({
    configFile: false,
    // src/core 下同时存在 .ts 与 .js，而 .js 是历史上手工分叉出来的影子文件：
    // 它们停留在 2026-05 到 2026-10 的不同时间点，缺了 .ts 后来新增的逻辑
    // （最严重的是 request.ts 里 tikuAdapter 的余额封锁前置、错误码映射与
    // 响应体 error 识别，这三段从来没进过构建产物）。
    //
    // vite 默认把 .js 排在 .ts 前面，所以源码里 'from "./x.js"' 一律解析到影子
    // 文件。这里显式让 .ts 优先，让源码只认 .ts；.js 影子保留是因为有测试直接
    // 引用它们当源码文本夹具，删掉要连带改测试，另行处理。
    resolve: { extensions: ['.ts', '.mts', '.js', '.mjs', '.json'] },
    define: {
      __DEFAULT_TIKU_BASE_URL__: JSON.stringify(defaultTikuBaseUrl),
      __CXPLUS_WINDOWS_INJECTION_LOG__: 'false'
    },
    build: {
      watch: watchMode ? {} : null,
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        formats: ['iife'],
        name: 'ChaoxingPlusScript',
        fileName: () => 'chaoxing-plus.js'
      },
      rollupOptions: {
        output: {
          entryFileNames: 'chaoxing-plus.js'
        }
      },
      outDir: 'dist',
      emptyOutDir: true
    }
  });

  copyStaticFiles();
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
