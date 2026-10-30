'use strict';

// SEA keeps the existing ESM host and its resources in memory; no unpack step.
const { getAsset } = require('node:sea');
const { register } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function start() {
  const payload = JSON.parse(getAsset('host-payload.json', 'utf8'));
  const hostDirectory = path.join(path.dirname(process.execPath), 'windows', 'node-source');
  const mainPath = path.join(hostDirectory, 'main.mjs');
  const files = Object.entries(payload.modules).map(([name, source]) => [
    pathToFileURL(path.join(hostDirectory, name)).href, source
  ]);
  globalThis.__CX_NODE_SEA__ = true;
  globalThis.__CX_SILENT_EMBEDDED_ASSETS__ = Object.freeze(payload.assets);
  globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = Object.freeze(payload.scripts);
  globalThis.__CX_EMBEDDED_CONFIG_EXAMPLE__ = payload.configExample;
  globalThis.__CX_SILENT_EMBEDDED_STATS__ = Object.freeze({
    modules: files.length, scripts: Object.keys(payload.scripts).length, assets: 4
  });

  const loader = `let files;
export function initialize(data) { files = new Map(data.files); }
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:')) return nextResolve(specifier, context);
  const url = new URL(specifier, context.parentURL).href;
  if (files.has(url)) return { url, shortCircuit: true };
  throw new Error('SEA module is not embedded: ' + specifier);
}
export function load(url, context, nextLoad) {
  if (files.has(url)) return { format: 'module', source: files.get(url), shortCircuit: true };
  return nextLoad(url, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(loader)}`, { data: { files } });
  process.argv = [process.execPath, mainPath, ...process.argv.slice(2)];
  await import(pathToFileURL(mainPath).href);
}

start().catch((error) => {
  console.error(`[node-exe] ${error.stack || error}`);
  process.exitCode = 1;
});
