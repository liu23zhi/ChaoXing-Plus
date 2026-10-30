import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a build tool, never a runtime dependency of the native launcher.
export const runtimeFiles = [
  'chaoxing_plus.exe', 'chaoxing_plus.com',
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js',
  'assets/trampoline.js', 'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll'
];

export async function packagePayload(directory, output) {
  const parts = [Buffer.from('CXPKG001'), uint32(runtimeFiles.length)];
  let total = 12;
  for (const relative of runtimeFiles) {
    let current = path.resolve(directory);
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Payload links are not allowed: ${relative}`);
    }
    const info = await lstat(current);
    if (!info.isFile() || info.size === 0 || info.size > 256 * 1024 * 1024)
      throw new Error(`Invalid payload file: ${relative}`);
    const name = Buffer.from(relative, 'utf8');
    const bytes = await readFile(current);
    total += 8 + name.length + bytes.length;
    if (total > 512 * 1024 * 1024) throw new Error('Payload exceeds the launcher size limit');
    parts.push(uint32(name.length), uint32(bytes.length), name, bytes);
  }
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, Buffer.concat(parts));
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: package-multi-payload.mjs <runtime-directory> <output>');
  await packagePayload(process.argv[2], process.argv[3]);
}
