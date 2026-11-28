import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const home = readFileSync(new URL('../windows/native-source/home.c', import.meta.url), 'utf8')
const inside = (start, end) => {
  const off = home.indexOf(start)
  assert.ok(off >= 0, start)
  const stop = home.indexOf(end, off + start.length)
  assert.ok(stop > off, end)
  return home.slice(off, stop)
}

test('ordinary startup schedules explicit T07 admission, never speculates a binding', () => {
  const init = inside('static void home_initialize_device(HOME_STATE *state) {', 'static void home_show_exam')
  assert.doesNotMatch(init, /cx_device_id_ensure|home_device_(report|kick)/)
  assert.match(init, /home_begin\(state,\s*HOME_ORDINARY_ADMIT/)
})

test('a verified signed ordinary package precedes T07, and T07 precedes browser launch and readiness', () => {
  const work = inside('static DWORD WINAPI home_work(LPVOID context) {', 'static void home_buttons')
  const checked = work.lastIndexOf('cx_browser_extension_verify_ordinary')
  const admitted = work.lastIndexOf('home_ordinary_device_admit(state)')
  assert.ok(checked >= 0 && admitted > checked)
  for (const next of ['home_device_begin_injection', 'cx_browser_start']) {
    assert.ok(work.indexOf(next) > admitted, next)
  }
  assert.match(work, /HOME_ORDINARY_ADMIT[\s\S]*state->operationOK\s*=\s*TRUE;\s*goto done/)
})

test('a cold host only probes the previous exact receipt; no background re-registration', () => {
  const wiring = readFileSync(new URL('../windows/native-source/home-native-admission.inc', import.meta.url), 'utf8')
  const cold = wiring.indexOf('cx_device_host_confirmed')
  const noFirstPost = wiring.indexOf('home->operation == HOME_ORDINARY_ADMIT')
  const register = wiring.indexOf('cx_device_host_admit(path')
  assert.ok(cold >= 0 && cold < noFirstPost && noFirstPost < register)
  assert.match(wiring.slice(cold, noFirstPost), /home_ordinary_owner_current/)
})
