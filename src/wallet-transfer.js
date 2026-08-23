(()=>{
  'use strict';

  function emptyController(){
    return Object.freeze({});
  }

  function createDraftController(){
    return emptyController();
  }

  function createResultController(){
    return emptyController();
  }

  globalThis.LoopWalletTransfer = Object.freeze({createDraftController,createResultController});
})();
