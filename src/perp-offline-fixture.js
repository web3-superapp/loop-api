(()=>{
  'use strict';

  const LABEL='Simulated Hyperliquid testnet fixture — no network, signing, or submission';
  const provider=globalThis.LoopHyperliquidPerp;
  const markets=[
    {coin:'BTC',display_name:'Bitcoin',mark_px:'64280.0',change_24h:'2.41',volume_24h:'1824000000',
      funding:'0.00011',open_interest:'812000000',best_bid:'64279.0',best_ask:'64280.0',
      freshness_ms:320,source_revision:'fixture-epoch-1:41:btc'},
    {coin:'ETH',display_name:'Ethereum',mark_px:'3842.1',change_24h:'3.82',volume_24h:'684000000',
      funding:'0.00008',open_interest:'446000000',best_bid:'3842.0',best_ask:'3842.1',
      freshness_ms:420,source_revision:'fixture-epoch-1:42:eth'},
    {coin:'SOL',display_name:'Solana',mark_px:'142.36',change_24h:'-1.24',volume_24h:'228000000',
      funding:'-0.00003',open_interest:'172000000',best_bid:'142.35',best_ask:'142.36',
      freshness_ms:510,source_revision:'fixture-epoch-1:43:sol'}
  ];
  const positions=[
    {id:'position-eth-long',coin:'ETH',side:'long',size:'0.42',entry_px:'3718.4',
      mark_px:'3842.1',leverage:'3',margin:'520.58',unrealized_pnl:'51.95',
      liquidation_px:'2684.32',freshness_ms:460,source_revision:'fixture-position-19'}
  ];
  const orders=[
    {id:'order-btc-open',coin:'BTC',side:'buy',type:'Limit',size:'0.01',
      price:'63120.0',status:'Open',filled_size:'0',created_label:'Today · 14:21',
      freshness_ms:610,source_revision:'fixture-order-31'},
    {id:'order-eth-fill',coin:'ETH',side:'buy',type:'Market · IOC',size:'0.42',
      price:'3718.4',status:'Filled',filled_size:'0.42',created_label:'Yesterday · 09:14',
      freshness_ms:610,source_revision:'fixture-order-30'},
    {id:'order-sol-cancel',coin:'SOL',side:'sell',type:'Limit',size:'2.5',
      price:'151.2',status:'Cancelled',filled_size:'0',created_label:'12 Aug · 19:42',
      freshness_ms:610,source_revision:'fixture-order-29'}
  ];
  const snapshot=Object.freeze({
    mode:'offline_readonly',label:LABEL,
    markets:Object.freeze(markets.map(Object.freeze)),
    positions:Object.freeze(positions.map(Object.freeze)),
    orders:Object.freeze(orders.map(Object.freeze))
  });
  const adapter=provider?.createOfflineReadOnlyAdapter(snapshot)||null;
  globalThis.LoopHyperliquidPerpOfflineFixture=Object.freeze({
    create:()=>adapter,label:LABEL,mode:'offline_readonly'
  });
})();
