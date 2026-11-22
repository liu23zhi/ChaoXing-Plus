import test from 'node:test';
import assert from 'node:assert/strict';
import {captureExamGrant,dispatchWithExamGrant,needsExamGrant,hasActivationInput} from '../windows/node-source/owned-script-authority.mjs';

test('owner launcher separates read-only options from exam launch',()=>{
  for(const k of ['version','help','capabilities','selfCheck','listClients','printEffectiveConfig']) assert.equal(needsExamGrant({[k]:true}),false);
  assert.equal(needsExamGrant({listClients:true,attachPort:5678}),true); assert.equal(needsExamGrant({}),true);assert.equal(needsExamGrant({clientPath:'fixture'}),true);
  assert.equal(hasActivationInput({}),false);assert.equal(hasActivationInput({ 'common.settings.tiku-adapter.key':'tk_ordinary'}),false);
});
test('only an originally exchanged, same-service same-token same-identity unexpired grant reaches the no-op runner',()=>{
  const keys={base:'common.settings.tiku-adapter.baseurl',key:'common.settings.tiku-adapter.key',session:'common.settings.tiku-adapter.script-session-token',id:'common.settings.tiku-adapter.script-identity'};
  const k='sr_'+'q'.repeat(35), now=1700000000000;
  const settings={[keys.base]:'https://service.invalid',[keys.key]:k,[keys.session]:k,[keys.id]:'fixture'};
  const receipt={key:k,identity:'fixture',expiresAt:new Date(now+20000).toISOString()};
  let calls=0; const run=()=>++calls;
  for(const v of [null,{...receipt,key:'tk_ordinary'},{...receipt,identity:''},{...receipt,expiresAt:'2000-01-01T00:00:00Z'}]){
    const g=captureExamGrant(settings,v,now);assert.equal(g,null);assert.throws(()=>dispatchWithExamGrant(g,settings,run,now));
  }
  const valid=captureExamGrant(settings,receipt,now);assert.ok(valid);
  for(const change of [{[keys.id]:'different'},{[keys.key]:'tk_ordinary'},{[keys.base]:'https://other.invalid'}]){
    assert.throws(()=>dispatchWithExamGrant(valid,{...settings,...change},run,now));
  }
  assert.throws(()=>dispatchWithExamGrant(valid,settings,run,now+21000));assert.equal(calls,0);
  dispatchWithExamGrant(valid,settings,run,now);assert.equal(calls,1);
});
