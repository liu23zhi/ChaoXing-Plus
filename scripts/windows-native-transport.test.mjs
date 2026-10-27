import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(root, 'windows', 'native');

async function read(name) {
  return fs.readFile(path.join(nativeRoot, name), 'utf8');
}

test('native transport sources expose the no-CRT interfaces', async () => {
  const [jsonHeader, jsonSource, netHeader, netSource, processHeader, processSource, memorySource] =
    await Promise.all(['json.h', 'json.c', 'net.h', 'net.c', 'process.h', 'process.c', 'memory.c'].map(read));

  for (const name of ['json.h', 'json.c', 'net.h', 'net.c', 'process.h', 'process.c', 'memory.c']) {
    assert.ok((await fs.stat(path.join(nativeRoot, name))).isFile(), name);
  }
  for (const source of [jsonSource, netSource, processSource, memorySource]) {
    assert.doesNotMatch(source, /#\s*include\s*[<"](stdio|stdlib|string|wchar)\.h[>"]/i);
    assert.doesNotMatch(source, /#\s*pragma\s+comment\s*\(\s*lib\s*:/i);
  }
  assert.match(jsonHeader, /int\s+jparse\s*\(/);
  assert.match(jsonHeader, /BOOL\s+jwstr\s*\(/);
  assert.match(netHeader, /BOOL\s+net_http_get\s*\(/);
  assert.match(netHeader, /int\s+net_ws_read\s*\(/);
  assert.match(processHeader, /BOOL\s+proc_launch\s*\(/);
  assert.match(processHeader, /BOOL\s+proc_pe\s*\(/);
  assert.match(memorySource, /void\s*\*\s*__cdecl\s+memcpy\s*\(/);
  assert.match(netSource, /#define\s+BODY_LIMIT\s+\(8UL\s*\*\s*1024UL\s*\*\s*1024UL\)/);
  assert.match(netSource, /127\.0\.0\.1/);
  assert.match(netSource, /Rejected non-loopback or mismatched WebSocket URL/);
  assert.doesNotMatch(netSource, /HTTP body exceeds 1 MiB/);
});

test('native JSON driver source covers Unicode, nesting and malformed input', async () => {
  const source = await fs.readFile(path.join(nativeRoot, 'tests', 'json-tests.c'), 'utf8');
  assert.match(source, /decode Unicode escape/);
  assert.match(source, /nested next traversal/);
  assert.match(source, /reject trueX/);
  assert.match(source, /token capacity exhaustion/);
});

test('compiled native transport self-test', { skip: !process.env.CX_NATIVE_TRANSPORT_EXE }, async () => {
  const executable = path.resolve(process.env.CX_NATIVE_TRANSPORT_EXE);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--protocol-self-test'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('native transport self-test timed out'));
    }, 15000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:TRANSPORT|PROTOCOL)[-_ ]?SELF[-_ ]?TEST[ :]+(?:OK|PASS)/i);
});
