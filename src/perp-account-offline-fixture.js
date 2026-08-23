(()=>{
  'use strict';
  const LABEL='Simulated Hyperliquid account fixture — read-only, no network, signing, or submission';
  const provider=globalThis.LoopHyperliquidAccount;
  const snapshot=Object.freeze({
    mode:'offline_readonly',label:LABEL,
    account:Object.freeze({account_ref:'fixture-account-1',equity:'18542.31',
      available_margin:'12408.17',used_margin:'6134.14',maintenance_margin:'1124.20',
      maintenance_margin_ratio:'18.33',risk_level:'elevated',freshness_ms:360,
      source_revision:'fixture-account-epoch-17'}),
    transfer:Object.freeze({account_ref:'fixture-account-1',asset:'USDC',
      spot_available:'4200.00',perp_available:'12408.17',minimum_amount:'1.00',
      arrival_label:'Provider-confirmed after official account transfer',
      failure_policy:'No local balance mutation; reconcile official account state',
      freshness_ms:410,source_revision:'fixture-transfer-context-8'}),
    bridge:Object.freeze({account_ref:'fixture-account-1',asset:'USDC',network:'arbitrum',
      deposit_minimum:'5.00',withdraw_minimum:'10.00',
      arrival_label:'Provider-confirmed after official bridge finality',
      bridge_authority:'hyperliquid_official_bridge',freshness_ms:470,
      source_revision:'fixture-bridge-context-5'}),
    funding:Object.freeze({coin:'ETH',current_rate:'0.00008',next_settlement_in_ms:1860000,
      history:Object.freeze([
        Object.freeze({id:'funding-104',coin:'ETH',settled_at_ms:1724385600000,
          rate:'0.00008',payment:'-0.42',plot_y:68,source_revision:'fixture-funding-104'}),
        Object.freeze({id:'funding-103',coin:'ETH',settled_at_ms:1724356800000,
          rate:'0.00005',payment:'-0.26',plot_y:52,source_revision:'fixture-funding-103'}),
        Object.freeze({id:'funding-102',coin:'ETH',settled_at_ms:1724328000000,
          rate:'-0.00002',payment:'0.11',plot_y:34,source_revision:'fixture-funding-102'}),
        Object.freeze({id:'funding-101',coin:'ETH',settled_at_ms:1724299200000,
          rate:'0.00011',payment:'-0.58',plot_y:82,source_revision:'fixture-funding-101'})
      ]),freshness_ms:520,source_revision:'fixture-funding-snapshot-22'}),
    risk_notice:Object.freeze({account_ref:'fixture-account-1',notice_id:'core-perp-risk',
      revision:'risk-notice-2026-08',title:'Core perpetual leverage and liquidation risk',
      sections:Object.freeze([
        Object.freeze({id:'leverage',heading:'Leverage amplifies loss',
          body:'Losses can accelerate as leverage increases. A small market move can consume posted margin.'}),
        Object.freeze({id:'liquidation',heading:'Liquidation is provider controlled',
          body:'Hyperliquid may liquidate a position when maintenance requirements are not met.'}),
        Object.freeze({id:'funding',heading:'Funding changes over time',
          body:'Funding payments can increase the cost of holding a position and are not fixed.'})
      ]),acknowledgement_required:true,freshness_ms:300,
      source_revision:'fixture-risk-notice-2026-08-r1'})
  });
  const adapter=provider?.createOfflineReadOnlyAdapter(snapshot)||null;
  globalThis.LoopHyperliquidAccountOfflineFixture=Object.freeze({
    create:()=>adapter,label:LABEL,mode:'offline_readonly'
  });
})();
