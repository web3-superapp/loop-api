#!/usr/bin/env python3
"""Fail-closed verifier for the integrated Stream Chat/Video v5 contract."""
from __future__ import annotations
import argparse, json, os, re, shutil, stat, subprocess, sys, tempfile
from pathlib import Path
from typing import Any

EXACT_CONTRACT_TREE={"README.md","contract.json","offline-fixture.json","sdk-lock.json","token-service.openapi.yaml"}
SDK_PINS={
 "stream_chat_flutter":("10.3.0","4075c2412a092f02f40ce3b9c1272cecf4ae4f81c81a502ed10a8dbdb6745f14"),
 "stream_chat_flutter_core":("10.3.0","5f1b2134f3d6bf0e0d9e8ebb0a907508646fb43f57d0290980cba79030b7d559"),
 "stream_chat":("10.3.0","276fd564da7939e8be024efe11d0329523925b0ce96762e89885b62873f0e812"),
 "stream_chat_persistence":("10.3.0","ecba2583f33fa0b56228acc41f14e2ec5e04e4afcbf4edfab3e6252b148bda2e"),
 "stream_video_flutter":("1.4.3","d2e8456a68ab65c3f33166a7b8f658a0310fa04f74b39f529a714b14eee7d622"),
 "stream_video":("1.4.3","df6d6da21bdfd1b3170d1b7eec0fd33d017d06e26b32b9ee9918f8721c70cc35")}
REQUIRED_OPERATIONS={
 "connect_user","disconnect_chat","query_channels","watch_channel","send_message","update_message","delete_message","send_thread_reply","send_reaction","delete_reaction","mark_read","mark_unread","query_members","flag_message","mute_user","ban_user","upload_attachment","delete_attachment","refresh_attachment","reconcile_chat_object","map_token_card_attachment","connect_video","disconnect_video","make_audio_room","get_or_create_audio_room","join_audio_room","leave_audio_room","set_microphone_enabled","request_speaking_permission","go_live","stop_live","end_audio_room","observe_call_participants","mute_audio_room_user","block_audio_room_user","kick_audio_room_user"}
CHAT_EVENTS={"connection.changed","connection.recovered","message.new","message.updated","message.deleted","message.read","reaction.new","reaction.updated","reaction.deleted","member.added","member.updated","member.removed","notification.mark_read","notification.mark_unread"}
VIDEO_EVENTS={"call.session_participant_joined","call.session_participant_left","call.permission_request","call.ended","call.updated","call.live_started"}
VIDEO_NORMALIZATION={
 "call.session_participant_joined":"read_call_participants_projection",
 "call.session_participant_left":"read_call_participants_projection",
 "call.permission_request":"read_call_permissions_projection",
 "call.ended":"read_call_state_projection","call.updated":"read_call_state_projection","call.live_started":"read_call_state_projection"}
SUBJECT_PATTERN=r"^loop_[a-z0-9_-]{8,58}$"
BLOCKED_CHAT_MUTATIONS={
 "connect_user","query_channels","watch_channel","send_message","update_message","delete_message",
 "send_thread_reply","send_reaction","delete_reaction","mark_read","mark_unread",
 "flag_message","mute_user","ban_user","upload_attachment","delete_attachment"}
CHAT_READ_BRIDGE_METHODS={"queryMembers","getMessage","disconnectUser"}
FORBIDDEN_CHAT_SIDE_EFFECT_BRIDGE_METHODS={"connectUser","watchChannel","queryChannels","markChannelsDelivered","markRead","markUnread"}
AUDITED_SOURCE_FILES={
 "stream_chat_client":{
  "path":"packages/stream_chat/lib/src/client/client.dart",
  "source":"https://raw.githubusercontent.com/GetStream/stream-chat-flutter/v10.3.0/packages/stream_chat/lib/src/client/client.dart",
  "sha256":"b166b4f63f1a99b5996569acc02372b4c6aef2f1765c31d859f63270394574b6",
  "evidence":"queryChannels_online_impl_submits_to_ChannelDeliveryReporter_and_markChannelsDelivered_callback_calls_provider_API"},
 "channel_delivery_reporter":{
  "path":"packages/stream_chat/lib/src/client/channel_delivery_reporter.dart",
  "source":"https://raw.githubusercontent.com/GetStream/stream-chat-flutter/v10.3.0/packages/stream_chat/lib/src/client/channel_delivery_reporter.dart",
  "sha256":"5a6b8f69ec994c738c8cfbce65fe5c2a95849edcab24f7a8357dc1394afe5efe",
  "evidence":"submitForDelivery_schedules_candidates_and_invokes_onMarkChannelsDelivered"}}

class VerificationError(AssertionError): pass
def strict_object(pairs:list[tuple[str,Any]])->dict[str,Any]:
 out={}
 for key,value in pairs:
  if key in out: raise VerificationError(f"duplicate JSON key: {key}")
  out[key]=value
 return out
def load_json(path:Path)->Any:return json.loads(path.read_text(encoding="utf-8"),object_pairs_hook=strict_object)
def require_regular_confined(root:Path,path:Path)->None:
 rr=root.resolve(strict=True);rp=path.resolve(strict=True)
 if rr!=rp and rr not in rp.parents:raise VerificationError(f"path escapes root: {path}")
 info=path.lstat()
 if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):raise VerificationError(f"not regular: {path}")
PRODUCTION_SCRIPTS=[
 "vendor/qrcode-generator-1.4.4.js","wallet-provider.js","wallet-review.js",
 "wallet-transfer.js","stream-chat-provider.js","platform-provider.js",
 "platform-offline-fixture.js","perp-read-provider.js",
 "perp-offline-fixture.js","perp-account-provider.js",
 "perp-account-offline-fixture.js","app.js"]
PROVIDER_BANNER="/* ============ SCRIPT: stream-chat-provider.js ============ */"
FIXTURE_SENTINELS=("StreamChatOfflineFixture","installStreamCommunicationOfflineFixture","Offline fixture — Stream credentials not connected")
PROVIDER_SUCCESS_SENTINELS=("STREAM_CHAT_PROVIDER_READY","STREAM_CHAT_PROVIDER_CONNECTED","Stream credentials connected")

def check_tree(root:Path)->tuple[Path,Path,Path]:
 d=root/"contracts"/"stream-chat"
 if not d.is_dir() or d.is_symlink():raise VerificationError("missing contracts/stream-chat directory")
 actual={p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file() or p.is_symlink()}
 if actual!=EXACT_CONTRACT_TREE:raise VerificationError(f"contract tree mismatch: {sorted(actual)}")
 for rel in EXACT_CONTRACT_TREE:require_regular_confined(root,d/rel)
 provider=root/"src"/"stream-chat-provider.js";fixture=root/"src"/"test-fixtures"/"stream-chat-offline-fixture.js"
 for path in (provider,fixture,Path(__file__)):require_regular_confined(root,path)
 return d,provider,fixture

def check_contract(d:Path)->None:
 c=load_json(d/"contract.json")
 if c.get("schema_version")!=5:raise VerificationError("v5 schema required")
 if c.get("provider")!="stream_chat_and_video" or c.get("production_mode")!="fail_closed":raise VerificationError("Stream-only fail-closed authority missing")
 if c.get("html_mode")!="production_boundary_fail_closed_fixture_test_only":raise VerificationError("offline mode mismatch")
 if c.get("build_integration")!={"production_script":"src/stream-chat-provider.js","production_order_after":"wallet-transfer.js","production_order_before":"app.js","offline_fixture":"src/test-fixtures/stream-chat-offline-fixture.js","offline_fixture_in_app_html":False,"connected_or_ready_success_claim_in_app_html":False}:raise VerificationError("build integration boundary mismatch")
 if set(c.get("operations",{}))!=REQUIRED_OPERATIONS:raise VerificationError("operation surface mismatch")
 for op in BLOCKED_CHAT_MUTATIONS-{"query_channels"}:
  item=c["operations"][op]
  if item.get("mutation") is not True or item.get("availability")!="pending_credentialed_chat_mutation_audit" or item.get("fail_closed") is not True:raise VerificationError(f"unsafe provider mutation gate: {op}")
 if c["operations"]["disconnect_chat"]!={"authority":"stream_chat_sdk_disconnectUser","mutation":False,"provider_state_effect":"connection_teardown_only"}:raise VerificationError("disconnect classification mismatch")
 if c["operations"]["query_channels"]!={"authority":"stream_chat_sdk_queryChannels_delivery_reporter_markChannelsDelivered","mutation":True,"availability":"pending_proven_no_write_channel_list_path","fail_closed":True}:raise VerificationError("queryChannels delivery mutation gate mismatch")
 if c.get("chat_provider_mutation_policy")!={
  "scope":"every_exposed_operation_that_can_write_persistent_Stream_Chat_provider_state",
  "blocked_operations":sorted(BLOCKED_CHAT_MUTATIONS),
  "connect_user_official_behavior":"connectUser_upserts_user",
  "watch_channel_official_behavior":"channel.watch_get_or_create",
  "query_channels_official_behavior":"queryChannels_watch_false_submits_delivery_candidates_then_markChannelsDelivered",
  "production_adapter_chat_mutation_bridge_methods":[],
  "production_adapter_read_bridge_methods":["disconnectUser","getMessage","queryMembers"],
  "production_gate":"all_exposed_chat_provider_mutations_fail_closed",
  "release_evidence":"PENDING"}:raise VerificationError("provider mutation inventory mismatch")
 if c.get("sdk_side_effect_classification")!={
  "basis":"pinned_stream_chat_10_3_0_actual_call_graph_not_method_name_or_watch_flag",
  "query_channels_watch_false":"persistent_provider_delivery_mutation_via_ChannelDeliveryReporter_then_markChannelsDelivered",
  "query_members":"direct_general_api_query_no_client_mark_read_watch_or_delivery_hook_in_pinned_source",
  "get_message":"direct_message_api_query_no_client_mark_read_watch_or_delivery_hook_in_pinned_source",
  "disconnect_user":"connection_teardown_only",
  "forbidden_mutating_or_side_effect_aliases":["channel.watch","connectUser","markChannelsDelivered","markRead","markUnread","queryChannels"],
  "channel_list_no_write_path":"PENDING_official_server_or_BFF_query_with_source_and_credentialed_runtime_proof"}:raise VerificationError("SDK side-effect classification mismatch")
 auth=c.get("authentication",{})
 if auth.get("subject_pattern")!=SUBJECT_PATTERN or auth.get("client_user_id_input")!="forbidden":raise VerificationError("subject grammar mismatch")
 if auth.get("api_secret_location")!="server_only" or auth.get("refresh")!="sdk_token_provider":raise VerificationError("token boundary mismatch")
 if c.get("chat_write_safety")!={
  "sdk_observed_behavior":"RetryQueue_retries_failed_messages_on_connection_recovered",
  "automatic_retry_suppression_evidence":"PENDING",
  "production_write_gate":"disabled_pending_credentialed_chat_mutation_audit",
  "provider_stable_id":"same_id_for_submit_receipt_and_authoritative_query",
  "ambiguous_outcome":"hold_same_id_and_reconcile_never_replay",
  "same_id_refresh_and_replay":"forbidden","new_id_without_user_reconfirmation":"forbidden"}:raise VerificationError("RetryQueue/write safety mismatch")
 p=c.get("event_projection",{})
 if set(p.get("chat_provider_events",[]))!=CHAT_EVENTS or set(p.get("video_provider_events",[]))!=VIDEO_EVENTS:raise VerificationError("provider event mismatch")
 if p.get("video_event_normalization")!=VIDEO_NORMALIZATION:raise VerificationError("video normalization mismatch")
 if p.get("dedupe")!="none_lossless_allow_duplicates" or p.get("timestamp_authority") is not False:raise VerificationError("lossy dedupe forbidden")
 if p.get("video_state_sources")!={"connection":"StreamVideo.state.connection","call_status":"CallState.status","participants":"CallState.callParticipants"}:raise VerificationError("Video state source mismatch")
 participants=c.get("audio_room_lifecycle",{}).get("participants",{})
 if participants!={"realtime_source":"CallState.callParticipants","visible_projection_limit":250,"complete_count_source":"CallState.participantCount","query_members_is_realtime_participants":False,"large_room_delivery":"PENDING"}:raise VerificationError("participant projection mismatch")
 if c.get("privacy",{}).get("wallet_address_as_user_id") is not False or c.get("privacy",{}).get("persist_tokens") is not False:raise VerificationError("privacy mismatch")
 expected_r0={"token_identity_binding","connect_user_identity_upsert","watch_channel_get_or_create","query_channels_delivery_receipt_or_proven_no_write_list_path","chat_retry_queue_suppression_or_safe_integration","ambiguous_write_same_id_reconciliation","channel_membership_permissions","message_thread_reaction_read_unread","moderation_roles","attachment_access_refresh_delete","reconnect_recovery","privacy_export_delete","enterprise_large_channel_semantics","audio_room_permissions_lifecycle","audio_room_reconnect_media_privacy","audio_room_scale_over_250"}
 if set(c.get("credentialed_r0_gates",[]))!=expected_r0:raise VerificationError("R0 matrix mismatch")

def check_sdk_lock(d:Path)->None:
 lock=load_json(d/"sdk-lock.json")
 if lock.get("schema_version")!=1 or lock.get("resolved_at")!="2026-08-23":raise VerificationError("SDK lock metadata")
 packages=lock.get("packages")
 if not isinstance(packages,dict) or set(packages)!=set(SDK_PINS):raise VerificationError("SDK pins")
 for name,(version,digest) in SDK_PINS.items():
  item=packages[name];expected_license="9cdb667ca0efaecfbcabea9bed4da1e33e182effbb76f2cd1878034eedddba00" if name.startswith("stream_video") else "2ae19400d4ddde4d4a54e6194f6a089184fe35d415abebb61020b9ba485672bc"
  if item.get("version")!=version or item.get("archive_sha256")!=digest or item.get("source")!=f"https://pub.dev/api/archives/{name}-{version}.tar.gz":raise VerificationError(f"bad pin: {name}")
  if item.get("license")!="Stream Source Code License Agreement" or item.get("license_sha256")!=expected_license:raise VerificationError(f"bad license: {name}")
 if lock.get("install_status")!="declared_not_installed":raise VerificationError("SDK install status")
 if lock.get("audited_source_files")!=AUDITED_SOURCE_FILES:raise VerificationError("audited SDK source hash evidence")
def check_openapi(d:Path)->None:
 text=(d/"token-service.openapi.yaml").read_text(encoding="utf-8")
 for marker in ["openapi: 3.1.0","/v1/chat/token:","operationId: mintStreamChatToken","X-CSRF-Token","HttpOnly","SameSite=Strict","additionalProperties: false","expires_at","Cache-Control","no-store","STREAM_API_SECRET","client supplied user_id is rejected","429","503","pattern: '^loop_[a-z0-9_-]{8,58}$'"]:
  if marker not in text:raise VerificationError(f"OpenAPI missing: {marker}")
 for marker in ["devToken","STREAM_API_SECRET:","api_secret:"]:
  if marker in text:raise VerificationError(f"unsafe OpenAPI: {marker}")
def check_fixture(d:Path)->None:
 f=load_json(d/"offline-fixture.json")
 if f.get("mode")!="offline_fixture" or f.get("network")!="disabled" or f.get("mutable") is not False:raise VerificationError("fixture mode")
 if f.get("authority")!="non_production_stream_shaped_fixture":raise VerificationError("fixture authority")
 pattern=re.compile(SUBJECT_PATTERN)
 identities=[f.get("current_user",{}).get("id","")]+[item.get("user_id","") for item in f.get("messages",[])]
 if not identities or any(not pattern.fullmatch(identity) for identity in identities):raise VerificationError("fixture user id grammar")

def check_source_static(provider:Path,fixture:Path)->None:
 p=provider.read_text(encoding="utf-8");combined=p+"\n"+fixture.read_text(encoding="utf-8")
 forbidden={"SDK import":r"\b(?:import\s|require\s*\()","install":r"\b(?:npm|pnpm|yarn|dart|flutter)\s+(?:add|install|pub)","transport":r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b","secret":r"(?:STREAM_API_SECRET|apiSecret|private[_-]?key|seed phrase)","dev token":r"\bdevToken\b","storage":r"\b(?:localStorage|sessionStorage|indexedDB)\b","unsafe HTML":r"\.innerHTML\b|insertAdjacentHTML","dynamic code":r"\beval\s*\(|new\s+Function\b","timestamp dedupe":r"versions\s*=\s*new Map|ISO_VERSION|ignore_stale_or_duplicate"}
 for label,pattern in forbidden.items():
  if re.search(pattern,combined,re.I):raise VerificationError(f"forbidden {label}")
 for marker in ["createProductionBoundary","disabled_pending_credentialed_chat_mutation_audit","STREAM_CHAT_PROVIDER_MUTATION_PENDING","connect:writePending","queryChannels:writePending","watchChannel:writePending","reconcileChatObject","same_id_query_only_never_replay","disconnectChat","disconnectVideo","readCallParticipants","CallState.callParticipants","call.session_participant_joined","call.session_participant_left","none_lossless_projection","Object.freeze"]:
  if marker not in p:raise VerificationError(f"provider marker missing: {marker}")
 for forbidden_method in sorted(FORBIDDEN_CHAT_SIDE_EFFECT_BRIDGE_METHODS):
  if f"'{forbidden_method}'" in p:raise VerificationError(f"side-effect-capable Chat bridge method exposed: {forbidden_method}")
 if re.search(r"\bwatch\s*:\s*false\b",p):raise VerificationError("watch:false is not read-only proof")
 if "'disconnectUser','queryMembers','getMessage'" not in p:raise VerificationError("exact Chat read bridge allowlist missing")
 if "const USER_ID=/^loop_[a-z0-9_-]{8,58}$/;" not in p:raise VerificationError("provider subject grammar drift")

NODE_HARNESS=r"""
'use strict';const fs=require('fs'),vm=require('vm'),root=process.argv[1],context=vm.createContext({});for(const rel of ['src/stream-chat-provider.js','src/test-fixtures/stream-chat-offline-fixture.js'])vm.runInContext(fs.readFileSync(root+'/'+rel,'utf8'),context,{filename:rel});const api=context.StreamChatBoundary,fx=context.StreamChatOfflineFixture;function ok(v,m){if(!v)throw new Error(m)}function blocked(fn,code){try{fn()}catch(e){return e&&e.code===code}return false}ok(Object.isFrozen(api)&&Object.isFrozen(fx),'frozen');
let attacks=0;for(const options of [{},{mode:'production',apiKey:'',tokenProvider:async()=>'',bridge:{},chatWriteSafety:'disabled_pending_credentialed_chat_mutation_audit'},{mode:'offline_fixture',apiKey:'x',tokenProvider:async()=>'',bridge:{},chatWriteSafety:'disabled_pending_credentialed_chat_mutation_audit'},{mode:'production',apiKey:'x',tokenProvider:async()=>'',bridge:{},chatWriteSafety:'enabled_without_audit'}]){try{api.createProductionBoundary(options)}catch(_){attacks++}}let getterCalls=0;const malicious={};Object.defineProperty(malicious,'mode',{get(){getterCalls++;return'production'}});try{api.createProductionBoundary(malicious)}catch(_){attacks++}ok(getterCalls===0,'accessor');
const calls=[],names=['disconnectUser','queryMembers','getMessage','connectVideo','disconnectVideo','makeAudioRoom','getOrCreateAudioRoom','joinAudioRoom','leaveAudioRoom','setMicrophoneEnabled','requestSpeakingPermission','goLive','stopLive','endAudioRoom','readCallState','muteAudioRoomUser','blockAudioRoomUser','kickAudioRoomUser'],makeBridge=()=>{const value={};for(const name of names)value[name]=(...args)=>{calls.push([name,args]);return Promise.resolve({name,args})};return value},bridge=makeBridge();Object.freeze(bridge);const tokenProvider=async id=>'opaque-'+id;const options=Object.freeze({mode:'production',apiKey:'public-key',tokenProvider,bridge,chatWriteSafety:'disabled_pending_credentialed_chat_mutation_audit'}),boundary=api.createProductionBoundary(options);ok(Object.isFrozen(boundary),'boundary frozen');
for(const alias of ['connectUser','watch','channelWatch','queryChannelList','listChannels','channelQuery','markChannelsDelivered','send','sendMessageUnsafe','upsertUser'])ok(!(alias in boundary),'side-effect alias exposed '+alias);const expectedPublic=['ambiguousMutationPolicy','banUser','blockAudioRoomUser','chatWriteSafety','connect','connectVideo','createTokenCardAttachment','deleteAttachment','deleteMessage','deleteReaction','disconnectChat','disconnectVideo','endAudioRoom','flagMessage','getOrCreateAudioRoom','goLive','ingestOfficialSignal','joinAudioRoom','kickAudioRoomUser','leaveAudioRoom','makeAudioRoom','markRead','markUnread','mode','muteAudioRoomUser','muteUser','provider','queryChannels','queryMembers','readCallParticipants','reconcileChatObject','refreshAttachment','requestSpeakingPermission','sendMessage','sendReaction','sendThreadReply','setMicrophoneEnabled','stopLive','tokenStrategy','updateMessage','uploadAttachment','watchChannel'].sort();ok(JSON.stringify(Object.keys(boundary).sort())===JSON.stringify(expectedPublic),'public surface drift');
for(const extra of ['connectUser','watchChannel','queryChannels','markChannelsDelivered','queryChannelList']){const poisoned=makeBridge();poisoned[extra]=()=>Promise.resolve();Object.freeze(poisoned);try{api.createProductionBoundary(Object.freeze({mode:'production',apiKey:'public-key',tokenProvider,bridge:poisoned,chatWriteSafety:'disabled_pending_credentialed_chat_mutation_audit'}))}catch(_){attacks++}}
const pending='STREAM_CHAT_PROVIDER_MUTATION_PENDING';const pendingWrites=[()=>boundary.connect({userId:'loop_member_0007',alias:'Voyager_7'}),()=>boundary.queryChannels({limit:20,cursor:null}),()=>boundary.watchChannel({type:'messaging',id:'glyph-hunters'}),()=>boundary.sendMessage({}),()=>boundary.sendThreadReply({}),()=>boundary.updateMessage({}),()=>boundary.deleteMessage({}),()=>boundary.sendReaction({}),()=>boundary.deleteReaction({}),()=>boundary.markRead({}),()=>boundary.markUnread({}),()=>boundary.flagMessage({}),()=>boundary.muteUser({}),()=>boundary.banUser({}),()=>boundary.uploadAttachment({}),()=>boundary.deleteAttachment({})];for(const write of pendingWrites)if(blocked(write,pending))attacks++;
const invalid=[()=>boundary.connectVideo({userId:'0x1111111111111111111111111111111111111111',alias:'wallet'}),()=>boundary.connectVideo({userId:'loop_'+('a'.repeat(7)),alias:'short'}),()=>boundary.connectVideo({userId:'loop_'+('a'.repeat(59)),alias:'long'}),()=>boundary.connectVideo({userId:'loop_member_0007',alias:'ok',role:'admin'}),()=>boundary.queryMembers({cid:'messaging:glyph-hunters',limit:101,cursor:null}),()=>boundary.reconcileChatObject({kind:'message',cid:'messaging:glyph-hunters',providerObjectId:'bad id'}),()=>boundary.makeAudioRoom({callType:'video_call',callId:'glyph-watch-party'}),()=>boundary.setMicrophoneEnabled({callType:'audio_room',callId:'glyph-watch-party',enabled:'false'}),()=>boundary.ingestOfficialSignal({source:'stream_video_event',type:'call.participant_joined',providerEventId:null,providerObjectId:'room_1'}),()=>boundary.ingestOfficialSignal({source:'video_call_state',type:'queryMembers',providerEventId:null,providerObjectId:'room_1'}),()=>boundary.ingestOfficialSignal({source:'chat_event',type:'custom.untrusted',providerEventId:null,providerObjectId:null})];for(const attack of invalid){try{attack()}catch(_){attacks++}}ok(attacks===33,'mutations '+attacks);
(async()=>{await boundary.queryChannels(Object.freeze({limit:20,cursor:null}));await boundary.queryMembers(Object.freeze({cid:'messaging:glyph-hunters',limit:20,cursor:null}));await boundary.reconcileChatObject(Object.freeze({kind:'message',cid:'messaging:glyph-hunters',providerObjectId:'msg_00000001'}));await boundary.refreshAttachment(Object.freeze({providerObjectId:'msg_00000001'}));const card=boundary.createTokenCardAttachment(Object.freeze({assetId:'GLYPH',chainId:'base',contractId:'0x1f9e4c8ad98523631ae4a59f267346ea31fa31f',snapshotAt:'2026-08-23T14:07:00.000Z'}));ok(card.type==='token_card','card');await boundary.connectVideo(Object.freeze({userId:'loop_'+('a'.repeat(8)),alias:'Min'}));await boundary.connectVideo(Object.freeze({userId:'loop_'+('b'.repeat(58)),alias:'Max'}));await boundary.connectVideo(Object.freeze({userId:'loop_member_0007',alias:'Voyager_7'}));await boundary.makeAudioRoom(Object.freeze({callType:'audio_room',callId:'glyph-watch-party'}));await boundary.joinAudioRoom(Object.freeze({callType:'audio_room',callId:'glyph-watch-party'}));await boundary.setMicrophoneEnabled(Object.freeze({callType:'audio_room',callId:'glyph-watch-party',enabled:false}));await boundary.readCallParticipants(Object.freeze({callType:'audio_room',callId:'glyph-watch-party'}));await boundary.leaveAudioRoom(Object.freeze({callType:'audio_room',callId:'glyph-watch-party'}));
const r1=boundary.ingestOfficialSignal(Object.freeze({source:'chat_event',type:'reaction.new',providerEventId:null,providerObjectId:'msg_00000001'})),r2=boundary.ingestOfficialSignal(Object.freeze({source:'chat_event',type:'reaction.updated',providerEventId:null,providerObjectId:'msg_00000001'}));ok(r1.accepted&&r2.accepted&&r1.sequence+1===r2.sequence,'same-ms reactions');const d1=boundary.ingestOfficialSignal(Object.freeze({source:'chat_event',type:'message.updated',providerEventId:'evt_00000001',providerObjectId:'msg_00000001'})),d2=boundary.ingestOfficialSignal(Object.freeze({source:'chat_event',type:'message.updated',providerEventId:'evt_00000001',providerObjectId:'msg_00000001'}));ok(d1.accepted&&d2.accepted,'duplicates');const recovered=boundary.ingestOfficialSignal(Object.freeze({source:'chat_event',type:'connection.recovered',providerEventId:'evt_recovered_01',providerObjectId:null}));ok(recovered.action==='read_chat_sdk_projection_after_recovery','recovery projection');const joined=boundary.ingestOfficialSignal(Object.freeze({source:'stream_video_event',type:'call.session_participant_joined',providerEventId:'evt_video_01',providerObjectId:'room_1'})),left=boundary.ingestOfficialSignal(Object.freeze({source:'stream_video_event',type:'call.session_participant_left',providerEventId:'evt_video_02',providerObjectId:'room_1'})),connection=boundary.ingestOfficialSignal(Object.freeze({source:'video_client_state',type:'connection',providerEventId:null,providerObjectId:null})),status=boundary.ingestOfficialSignal(Object.freeze({source:'video_call_state',type:'status',providerEventId:null,providerObjectId:'room_1'}));ok(joined.action==='read_call_participants_projection'&&left.action===joined.action,'video events');ok(connection.action==='read_video_connection_projection'&&status.action==='read_call_state_projection','video state');await boundary.disconnectChat();await boundary.disconnectVideo();const called=new Set(calls.map(x=>x[0]));for(const name of ['queryChannels','queryMembers','getMessage','readCallState','connectVideo','disconnectUser','disconnectVideo'])ok(called.has(name),'missing '+name);ok(!called.has('connectUser')&&!called.has('watchChannel'),'write bridge called');const channelQuery=calls.find(x=>x[0]==='queryChannels');ok(channelQuery&&channelQuery[1][0].watch===false&&channelQuery[1][0].state===true&&channelQuery[1][0].presence===false,'queryChannels no-watch');ok(calls.filter(x=>x[0]==='disconnectUser').length===1&&calls.filter(x=>x[0]==='disconnectVideo').length===1,'independent disconnect');const reconcile=calls.find(x=>x[0]==='getMessage'&&x[1][0].cid==='messaging:glyph-hunters');ok(reconcile&&reconcile[1][0].providerObjectId==='msg_00000001'&&reconcile[1][0].policy==='same_id_query_only_never_replay','same-id reconciliation');const fixture=fx.createOfflineFixture(),snapshot=fixture.snapshot();ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.channels),'fixture');console.log('MUTATION PASS 33');console.log('NODE CONTRACT PASS')})().catch(e=>{console.error(e.stack||e);process.exit(1)});
"""
NODE_HARNESS=NODE_HARNESS.replace("ok(attacks===33,'mutations '+attacks)","ok(attacks===37,'mutations '+attacks)")
NODE_HARNESS=NODE_HARNESS.replace("await boundary.queryChannels(Object.freeze({limit:20,cursor:null}));","")
NODE_HARNESS=NODE_HARNESS.replace("['queryChannels','queryMembers','getMessage','readCallState','connectVideo','disconnectUser','disconnectVideo']","['queryMembers','getMessage','readCallState','connectVideo','disconnectUser','disconnectVideo']")
NODE_HARNESS=NODE_HARNESS.replace("ok(!called.has('connectUser')&&!called.has('watchChannel'),'write bridge called');const channelQuery=calls.find(x=>x[0]==='queryChannels');ok(channelQuery&&channelQuery[1][0].watch===false&&channelQuery[1][0].state===true&&channelQuery[1][0].presence===false,'queryChannels no-watch');","ok(!called.has('connectUser')&&!called.has('watchChannel')&&!called.has('queryChannels')&&!called.has('markChannelsDelivered'),'side-effect bridge called');")
NODE_HARNESS=NODE_HARNESS.replace("MUTATION PASS 33","MUTATION PASS 37")
def check_runtime(root:Path)->None:
 result=subprocess.run(["node","-e",NODE_HARNESS,str(root)],text=True,capture_output=True,check=False,timeout=30)
 if result.returncode!=0:raise VerificationError(f"Node contract failed:\n{result.stdout}{result.stderr}")
 if "NODE CONTRACT PASS" not in result.stdout or "MUTATION PASS 37" not in result.stdout:raise VerificationError("runtime did not pass")
def check_integrated_build(root:Path,provider:Path,fixture:Path)->None:
 manifest=(root/"src"/"scripts-order.txt").read_text(encoding="utf-8").splitlines()
 if manifest!=PRODUCTION_SCRIPTS:raise VerificationError(f"exact twelve-script production order mismatch: {manifest}")
 source_js={p.relative_to(root/"src").as_posix() for p in (root/"src").rglob("*.js") if not p.name.startswith("._") and not (len(p.relative_to(root/"src").parts)>1 and p.relative_to(root/"src").parts[0]=="test-fixtures")}
 if source_js!=set(PRODUCTION_SCRIPTS):raise VerificationError(f"production source inventory mismatch: {sorted(source_js)}")
 if fixture.relative_to(root/"src").as_posix()!="test-fixtures/stream-chat-offline-fixture.js":raise VerificationError("offline fixture is not test-only")
 build_source=(root/"build.py").read_text(encoding="utf-8")
 if "exact pinned twelve-script order" not in build_source or "stream-chat-provider.js" not in build_source:raise VerificationError("builder twelve-script pin missing")
 first=subprocess.run([sys.executable,"build.py"],cwd=root,text=True,capture_output=True,check=False,timeout=60)
 if first.returncode!=0:raise VerificationError(f"integrated build failed:\n{first.stdout}{first.stderr}")
 app=root/"app.html";first_bytes=app.read_bytes();second=subprocess.run([sys.executable,"build.py"],cwd=root,text=True,capture_output=True,check=False,timeout=60)
 if second.returncode!=0 or app.read_bytes()!=first_bytes:raise VerificationError("integrated build is not deterministic")
 generated=first_bytes.decode("utf-8")
 if generated.count(PROVIDER_BANNER)!=1:raise VerificationError("generated provider banner must occur exactly once")
 if generated.count(provider.read_text(encoding="utf-8").rstrip("\n"))!=1:raise VerificationError("production provider bytes must occur exactly once")
 for sentinel in (*FIXTURE_SENTINELS,*PROVIDER_SUCCESS_SENTINELS):
  if sentinel in generated:raise VerificationError(f"test/success sentinel leaked into app.html: {sentinel}")
 if fixture.read_text(encoding="utf-8").rstrip("\n") in generated:raise VerificationError("offline fixture bytes leaked into app.html")
def check_file_mutations(root:Path)->None:
 cases=[
  ("contracts/stream-chat/contract.json",'"connect_user": {"authority": "stream_chat_sdk_connectUser_upsert", "mutation": true, "availability": "pending_credentialed_chat_mutation_audit", "fail_closed": true}','"connect_user": {"authority": "stream_chat_sdk_connectUser_upsert", "mutation": true, "availability": "available", "fail_closed": false}',"connect_user release"),
  ("contracts/stream-chat/contract.json",'"watch_channel": {"authority": "stream_chat_sdk_channel.watch_get_or_create", "mutation": true, "availability": "pending_credentialed_chat_mutation_audit", "fail_closed": true}','"watch_channel": {"authority": "stream_chat_sdk_channel.watch_get_or_create", "mutation": false, "availability": "available", "fail_closed": false}',"watch_channel misclassified"),
  ("contracts/stream-chat/contract.json",'"query_channels": {"authority": "stream_chat_sdk_queryChannels_delivery_reporter_markChannelsDelivered", "mutation": true, "availability": "pending_proven_no_write_channel_list_path", "fail_closed": true}','"query_channels": {"authority": "stream_chat_sdk_queryChannels_watch_false", "mutation": false}',"query_channels watch:false misclassified as read"),
  ("contracts/stream-chat/contract.json",'"availability": "pending_proven_no_write_channel_list_path", "fail_closed": true','"availability": "available", "fail_closed": false',"query_channels released without no-write evidence"),
  ("src/stream-chat-provider.js","connect:writePending","connect:()=>freeze({allowed:true})","connect runtime bypass"),
  ("src/stream-chat-provider.js","watchChannel:writePending","watchChannel:()=>freeze({allowed:true})","watch runtime bypass"),
  ("src/stream-chat-provider.js","connect:writePending,disconnectChat","connect:writePending,connectUser:writePending,disconnectChat","connect alias"),
  ("src/stream-chat-provider.js","'disconnectUser','queryMembers'","'connectUser','disconnectUser','queryMembers'","connect bridge"),
  ("src/stream-chat-provider.js","'disconnectUser','queryMembers'","'disconnectUser','watchChannel','queryMembers'","watch bridge"),
  ("src/stream-chat-provider.js","'disconnectUser','queryMembers'","'disconnectUser','queryChannels','queryMembers'","queryChannels bridge restored"),
  ("src/stream-chat-provider.js","queryChannels:writePending","queryChannels:value=>invoke('queryChannels',freeze({value,watch:false}))","watch:false treated as read runtime bypass"),
  ("src/stream-chat-provider.js","queryChannels:writePending","queryChannels:writePending,listChannels:writePending","channel-list side-effect alias"),
  ("contracts/stream-chat/sdk-lock.json","b166b4f63f1a99b5996569acc02372b4c6aef2f1765c31d859f63270394574b6","a166b4f63f1a99b5996569acc02372b4c6aef2f1765c31d859f63270394574b6","client source hash drift"),
  ("contracts/stream-chat/sdk-lock.json","5a6b8f69ec994c738c8cfbce65fe5c2a95849edcab24f7a8357dc1394afe5efe","4a6b8f69ec994c738c8cfbce65fe5c2a95849edcab24f7a8357dc1394afe5efe","delivery reporter source hash drift"),
  ("src/stream-chat-provider.js","function writePending(){throw boundaryError(WRITE_ERROR)}","function writePending(){return freeze({allowed:true})}","shared mutation gate bypass")]
 composite_cases=[
  ("src/stream-chat-provider.js",[
   ("'disconnectUser','queryMembers'","'disconnectUser','queryChannels','queryMembers'"),
   ("queryChannels:writePending","queryChannels:value=>invoke('queryChannels',freeze({value,watch:false,state:true,presence:false}))")],
   "restore normal queryChannels watch:false delivery path")]
 source_files=[Path("contracts/stream-chat")/name for name in EXACT_CONTRACT_TREE]+[Path("src/stream-chat-provider.js"),Path("src/test-fixtures/stream-chat-offline-fixture.js"),Path("_tmp/verify_stream_chat.py")]
 killed=0
 for relative,old,new,label in cases:
  with tempfile.TemporaryDirectory(prefix="stream-v5-mutation-") as raw:
   mutant=Path(raw)
   for rel in source_files:
    target=mutant/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/rel,target)
   path=mutant/relative;source=path.read_text(encoding="utf-8")
   if source.count(old)!=1:raise VerificationError(f"mutation anchor drift: {label}")
   path.write_text(source.replace(old,new,1),encoding="utf-8")
   env=dict(os.environ);env["STREAM_VERIFY_MUTATION_CHILD"]="1"
   result=subprocess.run([sys.executable,str((mutant/"_tmp/verify_stream_chat.py").resolve()),"--root",str(mutant)],text=True,capture_output=True,check=False,timeout=30,env=env)
   if result.returncode==0:raise VerificationError(f"file mutation survived: {label}")
   killed+=1
 for relative,edits,label in composite_cases:
  with tempfile.TemporaryDirectory(prefix="stream-v5-mutation-") as raw:
   mutant=Path(raw)
   for rel in source_files:
    target=mutant/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/rel,target)
   path=mutant/relative;source=path.read_text(encoding="utf-8")
   for old,new in edits:
    if source.count(old)!=1:raise VerificationError(f"mutation anchor drift: {label}")
    source=source.replace(old,new,1)
   path.write_text(source,encoding="utf-8")
   env=dict(os.environ);env["STREAM_VERIFY_MUTATION_CHILD"]="1"
   result=subprocess.run([sys.executable,str((mutant/"_tmp/verify_stream_chat.py").resolve()),"--root",str(mutant)],text=True,capture_output=True,check=False,timeout=30,env=env)
   if result.returncode==0:raise VerificationError(f"file mutation survived: {label}")
   killed+=1
 expected=len(cases)+len(composite_cases)
 if killed!=expected:raise VerificationError("file mutation corpus incomplete")
 print(f"FILE MUTATION PASS {killed}/{expected}")
def check_readme(d:Path)->None:
 text=(d/"README.md").read_text(encoding="utf-8").lower()
 for marker in ["stream is the sole communication authority","credentials later","fail closed","every chat provider mutation is gated","actual call graph","connectuser","upserts the user","`channel.watch()` is get-or-create","querychannels(watch: false)","channeldeliveryreporter","markchannelsdelivered","stream_chat_provider_mutation_pending","channel listing remains pending","official server/bff","no side-effect alias","retryqueue","connection.recovered","same provider stable id","callstate.callparticipants","truncated to 250","no sdk install/import","license review","offline fixture"]:
  if marker not in text:raise VerificationError(f"README missing: {marker}")
def main()->int:
 parser=argparse.ArgumentParser();parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[1]);root=parser.parse_args().root.resolve();checks=[]
 try:
  d,p,f=check_tree(root);checks.append("exact_tree");check_contract(d);checks.append("contract_v5");check_sdk_lock(d);checks.append("sdk_lock");check_openapi(d);checks.append("token_boundary");check_fixture(d);checks.append("offline_fixture");check_source_static(p,f);checks.append("static_security");check_runtime(root);checks.append("runtime_and_mutations");check_readme(d);checks.append("documentation")
  if os.environ.get("STREAM_VERIFY_MUTATION_CHILD")!="1":check_integrated_build(root,p,f);checks.append("integrated_build")
  if os.environ.get("STREAM_VERIFY_MUTATION_CHILD")!="1":check_file_mutations(root);checks.append("file_mutations")
 except (VerificationError,OSError,json.JSONDecodeError,subprocess.SubprocessError) as error:print(f"FAIL: {error}",file=sys.stderr);return 1
 print(f"ALL PASS ({len(checks)} sections): {', '.join(checks)}");return 0
if __name__=="__main__":raise SystemExit(main())
