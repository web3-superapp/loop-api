"""Build an ephemeral, test-only app with a branded production regional policy.

The generated file lives outside the repository and is never part of app.html or
the twelve-script production manifest. It preserves real provider-handle branding
while allowing existing wallet/F11 runtime tests to exercise an eligible policy.
"""
from __future__ import annotations

import atexit
from pathlib import Path
import shutil
import tempfile


MARKER = "/* ============ SCRIPT: platform-offline-fixture.js ============ */"
INJECTION = r"""
/* TEST-ONLY: credentialed regional-policy harness; never emitted by build.py. */
(function(root){
  'use strict';
  const provider=root.LoopPlatformProvider;
  const bootstrap=root.LoopPlatformProviderBootstrap;
  if(!provider||!bootstrap)throw new TypeError('test provider bootstrap unavailable');
  const handle=bootstrap.claimProductionHandle();
  const controller={state:'eligible',revision:1};
  Object.defineProperty(root,'__LoopPlatformPolicyTest',{value:controller,
    writable:false,configurable:false,enumerable:false});
  const configuration={authoritativeRecheck(){
    return {state:controller.state,revision:controller.revision,
      policy_id:'test-only-provider-policy',verified:true};
  }};
  const policy=provider.installProductionRegionalPolicy(handle,configuration);
  let pendingReplayRejected=false;
  try{provider.installProductionRegionalPolicy(handle,{authoritativeRecheck(){
    return {state:'eligible',revision:99,policy_id:'replay-policy',verified:true};
  }})}catch(_error){pendingReplayRejected=true}
  Object.defineProperties(controller,{
    pendingReplayRejected:{value:pendingReplayRejected,enumerable:true},
    replayAfterConsume:{value:function(){
      try{provider.installProductionRegionalPolicy(handle,{authoritativeRecheck(){
        return {state:'eligible',revision:100,policy_id:'replay-policy',verified:true};
      }});return true}catch(_error){return false}
    },enumerable:false}
  });
  policy.recheck({capability:'wallet_mutation',operation:'transfer',stage:'entry_gate'});
})(globalThis);
"""


def production_policy_test_app(root: Path) -> Path:
    source = (root / "app.html").read_text()
    if source.count(MARKER) != 1:
        raise RuntimeError("platform fixture marker unavailable")
    directory = Path(tempfile.mkdtemp(prefix="loop-production-policy-test-"))
    atexit.register(lambda: shutil.rmtree(directory, ignore_errors=True))
    target = directory / "app.html"
    target.write_text(source.replace(MARKER, INJECTION + "\n" + MARKER))
    return target
