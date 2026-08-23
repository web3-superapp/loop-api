(function installStreamCommunicationBoundary(root){
  'use strict';
  const freeze=Object.freeze,getDescriptors=Object.getOwnPropertyDescriptors;
  const getPrototypeOf=Object.getPrototypeOf,ownKeys=Reflect.ownKeys;
  const objectPrototype=Object.prototype,hasOwnProperty=objectPrototype.hasOwnProperty;
  const reflectApply=Reflect.apply,stringTrim=String.prototype.trim;
  const CHAT_WRITE_SAFETY='disabled_pending_credentialed_chat_mutation_audit';
  const WRITE_ERROR='STREAM_CHAT_PROVIDER_MUTATION_PENDING';
  const same_id_query_only_never_replay='same_id_query_only_never_replay';
  const PARTICIPANT_SOURCE='CallState.callParticipants';
  const USER_ID=/^loop_[a-z0-9_-]{8,58}$/;
  const SIMPLE_ID=/^[a-z0-9][a-z0-9_-]{0,63}$/;
  const PROVIDER_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  const CHAT_EVENTS=freeze([
    'connection.changed','connection.recovered','message.new','message.updated',
    'message.deleted','message.read','reaction.new','reaction.updated',
    'reaction.deleted','member.added','member.updated','member.removed',
    'notification.mark_read','notification.mark_unread'
  ]);
  const VIDEO_EVENTS=freeze([
    'call.session_participant_joined','call.session_participant_left',
    'call.permission_request','call.ended','call.updated','call.live_started'
  ]);
  const VIDEO_EVENT_ACTIONS=freeze({
    'call.session_participant_joined':'read_call_participants_projection',
    'call.session_participant_left':'read_call_participants_projection',
    'call.permission_request':'read_call_permissions_projection',
    'call.ended':'read_call_state_projection',
    'call.updated':'read_call_state_projection',
    'call.live_started':'read_call_state_projection'
  });
  const BRIDGE_METHODS=freeze([
    'disconnectUser','queryMembers','getMessage',
    'connectVideo','disconnectVideo','makeAudioRoom',
    'getOrCreateAudioRoom','joinAudioRoom','leaveAudioRoom','setMicrophoneEnabled',
    'requestSpeakingPermission','goLive','stopLive','endAudioRoom','readCallState',
    'muteAudioRoomUser','blockAudioRoomUser','kickAudioRoomUser'
  ]);

  function boundaryError(code){const error=new Error(code);error.code=code;return error}
  function ownData(descriptors,key){
    const descriptor=descriptors[key];
    return descriptor&&reflectApply(hasOwnProperty,descriptor,['value'])?descriptor.value:undefined;
  }
  function plainLike(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    try{const prototype=getPrototypeOf(value);return prototype===null||prototype===objectPrototype||(prototype&&getPrototypeOf(prototype)===null)}catch(_error){return false}
  }
  function exactRecord(value,keys,label){
    if(!plainLike(value))throw boundaryError('INVALID_'+label);
    let descriptors;try{descriptors=getDescriptors(value)}catch(_error){throw boundaryError('INVALID_'+label)}
    const actual=ownKeys(descriptors);
    if(actual.length!==keys.length)throw boundaryError('INVALID_'+label);
    for(let index=0;index<actual.length;index+=1){
      const key=actual[index];
      if(typeof key!=='string'||keys.indexOf(key)<0||!reflectApply(hasOwnProperty,descriptors[key],['value']))throw boundaryError('INVALID_'+label);
    }
    const result=Object.create(null);
    for(let index=0;index<keys.length;index+=1)result[keys[index]]=ownData(descriptors,keys[index]);
    return result;
  }
  function text(value,min,max,code){
    if(typeof value!=='string')throw boundaryError(code);
    const normalized=reflectApply(stringTrim,value,[]);
    if(normalized.length<min||normalized.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized))throw boundaryError(code);
    return normalized;
  }
  function nullableProviderId(value){return value===null?null:providerId(value,'INVALID_PROVIDER_EVENT_ID')}
  function userId(value){const normalized=text(value,13,63,'INVALID_USER_ID');if(!USER_ID.test(normalized))throw boundaryError('INVALID_USER_ID');return normalized}
  function simpleId(value,code){const normalized=text(value,1,64,code);if(!SIMPLE_ID.test(normalized))throw boundaryError(code);return normalized}
  function providerId(value,code){const normalized=text(value,1,128,code);if(!PROVIDER_ID.test(normalized))throw boundaryError(code);return normalized}
  function cid(value){
    const normalized=text(value,3,129,'INVALID_CID'),parts=normalized.split(':');
    if(parts.length!==2||!SIMPLE_ID.test(parts[0])||!SIMPLE_ID.test(parts[1]))throw boundaryError('INVALID_CID');
    return normalized;
  }
  function cursor(value){return value===null?null:text(value,1,512,'INVALID_CURSOR')}
  function limit(value){if(!Number.isInteger(value)||value<1||value>100)throw boundaryError('INVALID_LIMIT');return value}
  function callRef(value){
    const item=exactRecord(value,['callType','callId'],'CALL_REF'),callType=simpleId(item.callType,'INVALID_CALL_TYPE');
    if(callType!=='audio_room')throw boundaryError('INVALID_CALL_TYPE');
    return freeze({callType,callId:simpleId(item.callId,'INVALID_CALL_ID')});
  }
  function bridgeSnapshot(value){
    const source=exactRecord(value,BRIDGE_METHODS,'BRIDGE'),bridge=Object.create(null);
    for(let index=0;index<BRIDGE_METHODS.length;index+=1){const name=BRIDGE_METHODS[index];if(typeof source[name]!=='function')throw boundaryError('INVALID_BRIDGE');bridge[name]=source[name]}
    return freeze(bridge);
  }

  function createProductionBoundary(options){
    const source=exactRecord(options,['mode','apiKey','tokenProvider','bridge','chatWriteSafety'],'OPTIONS');
    if(source.mode!=='production'||source.chatWriteSafety!==CHAT_WRITE_SAFETY)throw boundaryError('STREAM_COMMUNICATION_UNAVAILABLE');
    const apiKey=text(source.apiKey,1,256,'STREAM_COMMUNICATION_UNAVAILABLE');
    if(typeof source.tokenProvider!=='function')throw boundaryError('STREAM_COMMUNICATION_UNAVAILABLE');
    const tokenProvider=source.tokenProvider,bridge=bridgeSnapshot(source.bridge);
    let projectionSequence=0;
    function invoke(name,payload){return reflectApply(bridge[name],undefined,[payload])}
    function writePending(){throw boundaryError(WRITE_ERROR)}
    function connectVideo(value){
      const item=exactRecord(value,['userId','alias'],'VIDEO_USER');
      const user=freeze({id:userId(item.userId),name:text(item.alias,1,80,'INVALID_ALIAS')});
      return reflectApply(bridge.connectVideo,undefined,[user,tokenProvider,apiKey]);
    }
    function queryMembers(value){const item=exactRecord(value,['cid','limit','cursor'],'MEMBERS');return invoke('queryMembers',freeze({cid:cid(item.cid),limit:limit(item.limit),cursor:cursor(item.cursor)}))}
    function reconcileChatObject(value){
      const item=exactRecord(value,['kind','cid','providerObjectId'],'RECONCILE');
      if(item.kind!=='message')throw boundaryError('INVALID_RECONCILE_KIND');
      const normalized=freeze({kind:'message',cid:cid(item.cid),providerObjectId:providerId(item.providerObjectId,'INVALID_PROVIDER_OBJECT_ID'),policy:same_id_query_only_never_replay});
      return invoke('getMessage',normalized);
    }
    function refreshAttachment(value){
      const item=exactRecord(value,['providerObjectId'],'ATTACHMENT_REFRESH');
      return invoke('getMessage',freeze({kind:'message',providerObjectId:providerId(item.providerObjectId,'INVALID_PROVIDER_OBJECT_ID'),policy:same_id_query_only_never_replay}));
    }
    function createTokenCardAttachment(value){
      const item=exactRecord(value,['assetId','chainId','contractId','snapshotAt'],'TOKEN_CARD');
      const snapshotAt=text(item.snapshotAt,24,24,'INVALID_TOKEN_CARD_TIME');
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshotAt))throw boundaryError('INVALID_TOKEN_CARD_TIME');
      return freeze({type:'token_card',extraData:freeze({loop_schema:'token_card.v1',asset_id:text(item.assetId,1,32,'INVALID_ASSET_ID'),chain_id:simpleId(item.chainId,'INVALID_CHAIN_ID'),contract_id:text(item.contractId,1,128,'INVALID_CONTRACT_ID'),snapshot_at:snapshotAt})});
    }
    function audioAction(name,value){return invoke(name,callRef(value))}
    function setMicrophoneEnabled(value){
      const item=exactRecord(value,['callType','callId','enabled'],'MICROPHONE');
      if(typeof item.enabled!=='boolean')throw boundaryError('INVALID_MICROPHONE_STATE');
      const ref=callRef(freeze({callType:item.callType,callId:item.callId}));
      return invoke('setMicrophoneEnabled',freeze({callType:ref.callType,callId:ref.callId,enabled:item.enabled}));
    }
    function readCallParticipants(value){
      const ref=callRef(value);
      return invoke('readCallState',freeze({callType:ref.callType,callId:ref.callId,projection:PARTICIPANT_SOURCE,maxVisible:250,countProjection:'CallState.participantCount'}));
    }
    function audioModeration(name,value){
      const item=exactRecord(value,['callType','callId','userId'],'AUDIO_MODERATION'),ref=callRef(freeze({callType:item.callType,callId:item.callId}));
      return invoke(name,freeze({callType:ref.callType,callId:ref.callId,userId:userId(item.userId)}));
    }
    function ingestOfficialSignal(value){
      const item=exactRecord(value,['source','type','providerEventId','providerObjectId'],'OFFICIAL_SIGNAL');
      const sourceName=text(item.source,1,32,'INVALID_EVENT_SOURCE'),type=text(item.type,1,64,'INVALID_EVENT');
      let action,authority;
      if(sourceName==='chat_event'){
        if(CHAT_EVENTS.indexOf(type)<0)throw boundaryError('INVALID_EVENT');
        action=type==='connection.recovered'?'read_chat_sdk_projection_after_recovery':'present_chat_sdk_projection';authority='stream_chat_sdk_state';
      }else if(sourceName==='stream_video_event'){
        if(VIDEO_EVENTS.indexOf(type)<0)throw boundaryError('INVALID_EVENT');
        action=VIDEO_EVENT_ACTIONS[type];authority='stream_video_sdk';
      }else if(sourceName==='video_client_state'){
        if(type!=='connection')throw boundaryError('INVALID_EVENT');
        action='read_video_connection_projection';authority='StreamVideo.state.connection';
      }else if(sourceName==='video_call_state'){
        if(type!=='status'&&type!=='callParticipants')throw boundaryError('INVALID_EVENT');
        action=type==='status'?'read_call_state_projection':'read_call_participants_projection';authority=type==='status'?'CallState.status':PARTICIPANT_SOURCE;
      }else throw boundaryError('INVALID_EVENT_SOURCE');
      projectionSequence+=1;
      return freeze({accepted:true,action,authority,sequence:projectionSequence,dedupe:'none_lossless_projection',providerEventId:nullableProviderId(item.providerEventId),providerObjectId:item.providerObjectId===null?null:providerId(item.providerObjectId,'INVALID_PROVIDER_OBJECT_ID')});
    }
    function disconnectChat(){return reflectApply(bridge.disconnectUser,undefined,[])}
    function disconnectVideo(){return reflectApply(bridge.disconnectVideo,undefined,[])}

    return freeze({
      provider:'stream_chat_and_video',mode:'production',tokenStrategy:'sdk_token_provider',
      chatWriteSafety:CHAT_WRITE_SAFETY,ambiguousMutationPolicy:same_id_query_only_never_replay,
      connect:writePending,disconnectChat,queryChannels:writePending,watchChannel:writePending,queryMembers,
      sendMessage:writePending,sendThreadReply:writePending,updateMessage:writePending,
      deleteMessage:writePending,sendReaction:writePending,deleteReaction:writePending,
      markRead:writePending,markUnread:writePending,flagMessage:writePending,
      muteUser:writePending,banUser:writePending,uploadAttachment:writePending,
      deleteAttachment:writePending,reconcileChatObject,refreshAttachment,
      createTokenCardAttachment,connectVideo,disconnectVideo,
      makeAudioRoom:value=>audioAction('makeAudioRoom',value),
      getOrCreateAudioRoom:value=>audioAction('getOrCreateAudioRoom',value),
      joinAudioRoom:value=>audioAction('joinAudioRoom',value),
      leaveAudioRoom:value=>audioAction('leaveAudioRoom',value),setMicrophoneEnabled,
      requestSpeakingPermission:value=>audioAction('requestSpeakingPermission',value),
      goLive:value=>audioAction('goLive',value),stopLive:value=>audioAction('stopLive',value),
      endAudioRoom:value=>audioAction('endAudioRoom',value),readCallParticipants,
      muteAudioRoomUser:value=>audioModeration('muteAudioRoomUser',value),
      blockAudioRoomUser:value=>audioModeration('blockAudioRoomUser',value),
      kickAudioRoomUser:value=>audioModeration('kickAudioRoomUser',value),
      ingestOfficialSignal
    });
  }
  root.StreamChatBoundary=freeze({createProductionBoundary});
})(globalThis);
