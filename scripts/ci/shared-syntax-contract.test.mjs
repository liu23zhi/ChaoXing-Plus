// Ordinary JavaScript syntax fixtures only; no external application, packaging, or host process.
import assert from 'node:assert/strict';
import test from 'node:test';
import {checkChrome75Syntax, assertChrome75Syntax} from '../../windows/share-file/chrome75-syntax.mjs';

test('plain status data remains data even when a label contains modern syntax', () => {
  const settings = {mode: 'native_browser', label: 'a?.b ?? fallback'};
  const source = 'var status = ' + JSON.stringify(settings) + ';';
  assert.deepEqual(checkChrome75Syntax(source), {ok: true, label: 'script', unsupported: []});
  assert.equal(assertChrome75Syntax('return status.mode;', {label: 'status reader', functionBody: true}).ok, true);
});
test('flags unsupported operators in executable code and reports the owner label', () => {
  const {ok, unsupported} = checkChrome75Syntax('const value = prefs?.colour ?? "auto";');
  assert.equal(ok, false);
  assert.deepEqual(new Set(unsupported), new Set(['optional chaining (?.)', 'nullish coalescing (??)']));
  assert.throws(() => assertChrome75Syntax('prefs.count ||= 1;', {label: 'settings'}), /settings.*logical assignment/);
});
