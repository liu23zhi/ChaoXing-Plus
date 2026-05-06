import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';

process.env.VITE_CJS_IGNORE_WARNING = '1';
const _require = createRequire(import.meta.url);
const { build } = _require('vite');

const __dirname = dirname(fileURLToPath(import.meta.url));
const watchMode = process.argv.includes('--watch');

function copyStaticFiles() {
  mkdirSync('dist', { recursive: true });

  const manifest = {
    manifest_version: 3,
    name: 'ChaoXing Plus Tools',
    version: '2.0.0',
    description: '给超星网站使用的自动学习与自动搜题扩展。',
    icons: {
      '512': 'icon_512X512.png'
    },
    action: {
      default_popup: 'popup.html'
    },
    content_scripts: [
      {
        matches: [
          '*://*.chaoxing.com/*',
          '*://*.edu.cn/*',
          '*://*.org.cn/*',
          '*://*.xueyinonline.com/*',
          '*://*.hnsyu.net/*',
          '*://*.qutjxjy.cn/*',
          '*://*.ynny.cn/*',
          '*://*.hnvist.cn/*',
          '*://*.fjlecb.cn/*',
          '*://*.gdhkmooc.com/*',
          '*://*.cugbonline.cn/*',
          '*://*.zjelib.cn/*',
          '*://*.cqrspx.cn/*',
          '*://*.neauce.com/*',
          '*://*.zhihui-yun.com/*',
          '*://*.cqie.cn/*',
          '*://*.ccqmxx.com/*',
          '*://*.jxgmxy.com/*',
          '*://*.jnzyjsxy.cn/*',
          '*://*.sslibrary.com/*'
        ],
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

  if (existsSync('src/extension-entry.js')) {
    copyFileSync('src/extension-entry.js', 'dist/extension-entry.js');
  }

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
          entryFileNames: 'chaoxing-plus.js',
          inlineDynamicImports: true
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
