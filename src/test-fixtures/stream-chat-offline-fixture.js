(function installStreamCommunicationOfflineFixture(root){
  'use strict';
  const freeze=Object.freeze;
  function deepFreeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
    Reflect.ownKeys(value).forEach(key=>deepFreeze(value[key]));
    return freeze(value);
  }
  const data=deepFreeze({
    generatedAt:'2026-08-23T00:00:00.000Z',
    currentUser:{id:'loop_fixture_user_7',name:'Voyager_7'},
    channels:[
      {cid:'messaging:glyph-hunters',name:'Glyph Hunters',memberCount:1247,unreadCount:12},
      {cid:'messaging:eth-holders',name:'ETH Holders Lounge',memberCount:8400,unreadCount:3}
    ],
    messages:[
      {id:'fixture_m_001',cid:'messaging:glyph-hunters',userId:'loop_fixture_nightowl',alias:'NightOwl',text:'gm degens. small cap find; DYOR',createdAt:'2026-08-23T14:02:00.000Z',parentId:null,attachments:[]},
      {id:'fixture_m_002',cid:'messaging:glyph-hunters',userId:'loop_fixture_user_7',alias:'Voyager_7',text:'watch the liquidity unlock',createdAt:'2026-08-23T14:05:00.000Z',parentId:null,attachments:[]},
      {id:'fixture_m_003',cid:'messaging:glyph-hunters',userId:'loop_fixture_sable',alias:'0xSable',text:'contract facts attached',createdAt:'2026-08-23T14:07:00.000Z',parentId:'fixture_m_001',attachments:[{type:'token_card',assetId:'GLYPH',snapshot:'offline_fixture'}]}
    ],
    audioRooms:[
      {callCid:'audio_room:glyph-watch-party',name:'ETH ETF watch party',status:'offline_fixture',participantCount:214,speakerCount:8,microphoneEnabled:false}
    ]
  });
  function createOfflineFixture(){
    return freeze({
      mode:'offline_fixture',status:'network_disabled',
      label:'Offline fixture — Stream credentials not connected',
      authority:'non_production_stream_shaped_fixture',
      snapshot:()=>data
    });
  }
  root.StreamChatOfflineFixture=freeze({createOfflineFixture});
})(globalThis);
