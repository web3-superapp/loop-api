#!/usr/bin/env python3
"""Focused contract verifier for the Stream E1-E4 presentation slice.

This verifier deliberately treats the current prototype as production HTML with an
explicit read-only offline preview. It never accepts preview data as evidence of a
connected Stream client and never permits a UI control to bypass the provider gate.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def read(root: Path, relative: str) -> str:
    path = root / relative
    require(path.is_file(), f"missing {relative}")
    return path.read_text()


def strict_json(path: Path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"duplicate JSON key {key} in {path}")
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(), object_pairs_hook=pairs)
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"invalid JSON {path}: {error}") from error


def exact_keys(value, keys, where: str) -> None:
    require(isinstance(value, dict), f"{where} must be object")
    require(set(value) == set(keys), f"{where} exact keys drift: {sorted(value)}")


def extract_function(source: str, name: str) -> str:
    marker = f"function {name}("
    start = source.find(marker)
    require(start >= 0, f"missing function {name}")
    brace = source.find("{", start)
    require(brace >= 0, f"missing function body {name}")
    depth = 0
    quote = None
    escaped = False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise VerificationError(f"unterminated function {name}")


def verify(root: Path) -> dict:
    contract_path = root / "contracts/stream-ui/contract.json"
    contract = strict_json(contract_path)
    exact_keys(contract, [
        "schema_version", "delivery", "routes", "dto_schema", "dto", "writes", "voice",
        "privacy", "accessibility", "pending_gates",
    ], "contract")
    require(contract["schema_version"] == 1, "schema version drift")

    delivery = contract["delivery"]
    exact_keys(delivery, [
        "authority", "production_provider", "production_scripts",
        "production_connected_claim", "offline_preview", "test_fixture_in_bundle",
        "custom_communication_core",
    ], "delivery")
    require(delivery == {
        "authority": "stream_chat_and_video_only",
        "production_provider": "src/stream-chat-provider.js",
        "production_scripts": 10,
        "production_connected_claim": False,
        "offline_preview": "explicit_read_only_not_connection_evidence",
        "test_fixture_in_bundle": False,
        "custom_communication_core": False,
    }, "delivery contract weakened")

    routes = contract["routes"]
    require(routes == {
        "E1": "#chat", "E2": "#group", "E3": "#voiceroom", "E4": "#dm",
        "dm_screen_strategy": "reuse_conversation_shell_preserve_37_screen_manifest_and_shared_f11_bound",
        "account_guard": "existing_guardAccountRoute",
    }, "route contract drift")

    require(contract["dto_schema"] == {
        "path": "contracts/stream-ui/dto.schema.json",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "additional_properties": False,
    }, "typed DTO schema reference drift")
    schema = strict_json(root / contract["dto_schema"]["path"])
    exact_keys(schema, ["$schema", "$id", "title", "oneOf", "$defs"], "dto schema")
    require(schema["$schema"] == contract["dto_schema"]["draft"], "DTO draft drift")
    require(schema["$id"] == "https://loop.local/contracts/stream-ui/dto.schema.json",
            "DTO schema id drift")
    require(schema["oneOf"] == [
        {"$ref": "#/$defs/channel_list"}, {"$ref": "#/$defs/message_timeline"},
        {"$ref": "#/$defs/audio_room"},
    ], "DTO union drift")
    require(set(schema["$defs"]) == {"channel", "channel_list", "message", "message_timeline", "participant", "audio_room"},
            "DTO definitions drift")
    for name, definition in schema["$defs"].items():
        require(definition.get("type") == "object" and definition.get("additionalProperties") is False,
                f"DTO {name} is not exact")
        require(set(definition.get("properties", {})) == set(definition.get("required", [])),
                f"DTO {name} permits optional/unknown shape drift")
    require(schema["$defs"]["audio_room"]["properties"]["visible_participants"]["maxItems"] == 250,
            "audio DTO visible participant cap drift")
    require(schema["$defs"]["audio_room"]["properties"]["participant_count"] ==
            {"type": "integer", "minimum": 0, "maximum": 50000},
            "audio DTO participant count bounds drift")
    for name in ["channel_list", "message_timeline"]:
        require(schema["$defs"][name]["properties"]["mode"] == {"const": "offline_preview"} and
                schema["$defs"][name]["properties"]["connected"] == {"const": False},
                f"{name} offline DTO can claim a connection")
    require(schema["$defs"]["channel_list"]["properties"]["authority"] == {"const": "stream_chat_sdk_state"},
            "channel DTO authority drift")
    require(schema["$defs"]["message_timeline"]["properties"]["authority"] == {"const": "stream_chat_sdk_channel_state"},
            "message DTO authority drift")
    require(schema["$defs"]["audio_room"]["properties"]["authority"] == {"const": "stream_video_sdk_call_state"},
            "audio DTO authority drift")
    require(schema["$defs"]["audio_room"]["properties"]["complete_roster_status"] == {"const": "PENDING"},
            "audio DTO complete roster gate drift")
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    valid_offline = [
        {"authority": "stream_chat_sdk_state", "mode": "offline_preview",
         "connected": False, "channels": []},
        {"authority": "stream_chat_sdk_channel_state", "mode": "offline_preview",
         "connected": False, "cid": "messaging:glyph-hunters", "messages": []},
        {"authority": "stream_video_sdk_call_state", "mode": "offline_preview",
         "connection": "disconnected", "status": "unavailable", "participant_count": 0,
         "visible_participants": [], "complete_roster_status": "PENDING"},
    ]
    for index, fixture in enumerate(valid_offline):
        require(not list(validator.iter_errors(fixture)),
                f"valid offline DTO {index} rejected")
    hostile_dtos = [
        {**valid_offline[0], "connected": True},
        {**valid_offline[1], "connected": True},
        {**valid_offline[2], "connection": "connected", "status": "joined"},
        {**valid_offline[2], "connection": "reconnecting", "status": "reconnecting"},
        {**valid_offline[2], "participant_count": 200000},
        {**valid_offline[2], "participant_count": 50001},
        {**valid_offline[2], "participant_count": "1"},
        {**valid_offline[2], "visible_participants": [
            {"user_id": f"loop_participant_{index:03d}", "alias": "preview", "is_speaking": False}
            for index in range(251)
        ]},
        {**valid_offline[2], "visible_participants": [
            {"user_id": "loop_participant_001", "alias": "preview", "is_speaking": False}
        ]},
        {**valid_offline[2], "mode": "production", "connection": "connected",
         "status": "joined", "participant_count": 1},
    ]
    for index, fixture in enumerate(hostile_dtos):
        require(list(validator.iter_errors(fixture)),
                f"hostile/off-authority DTO {index} survived schema")

    dto = contract["dto"]
    exact_keys(dto, ["channel_list", "message_timeline", "audio_room"], "dto")
    require(dto["channel_list"] == {
        "authority": "stream_chat_sdk_state",
        "states": ["preview", "loading", "empty", "offline"],
        "fields": ["cid", "kind", "name", "member_count", "unread_count", "muted", "last_message"],
    }, "channel DTO drift")
    require(dto["message_timeline"] == {
        "authority": "stream_chat_sdk_channel_state",
        "fields": ["id", "cid", "user_id", "alias", "text", "created_at", "parent_id", "mentioned_user_ids", "reaction_counts", "pinned_at"],
        "projection_only": ["reply", "reaction", "mention", "pin"],
    }, "message DTO drift")
    require(dto["audio_room"] == {
        "authority": ["StreamVideo.state.connection", "CallState.status", "CallState.callParticipants", "CallState.participantCount"],
        "participant_count_limit": 50000,
        "visible_participant_limit": 250,
        "complete_roster": "PENDING",
        "projection_only": True,
    }, "audio room DTO drift")

    writes = contract["writes"]
    expected_writes = [
        "connect_user", "query_channels", "watch_channel", "send_message",
        "send_thread_reply", "send_reaction", "mark_read", "join_audio_room",
        "leave_audio_room", "set_microphone_enabled", "request_speaking_permission",
    ]
    require(writes == {
        "ui_controls": "disabled_aria_disabled",
        "behavior": "PENDING_fail_closed_no_provider_call",
        "operations": expected_writes,
    }, "write gate drift")
    require(contract["voice"] == {
        "rtc_authority": "stream_video_sdk",
        "local_join_simulation": False,
        "local_presence_or_roster": False,
        "local_voice_state_persistence": False,
        "offline_room_dto": "disconnected_unavailable_zero_empty",
        "home_entry": "canonical_audio_room_dto_projection_or_fail_closed",
        "minibar": "official_projection_or_explicit_offline_preview_only",
        "credentials_license_200k_audio_r0": "PENDING",
    }, "voice contract drift")
    require(contract["privacy"] == {
        "dm_e2ee_claim": False,
        "large_group_e2ee_claim": False,
        "copy": "transport_and_message_protection_depend_on_provider_and_account_policy",
    }, "privacy claim drift")
    require(contract["accessibility"] == {
        "minimum_target_css_px": 44,
        "focus_visible": True,
        "inactive_views_inert": True,
        "reduced_motion": True,
        "mobile_and_desktop": True,
    }, "accessibility contract drift")
    require(contract["pending_gates"] == [
        "credentials", "license", "enterprise_200k_channels", "audio_room_r0",
        "complete_audio_roster_over_250", "all_chat_provider_writes",
    ], "pending gates drift")

    provider = read(root, "src/stream-chat-provider.js")
    wallet_review = read(root, "src/wallet-review.js")
    provider_sha = hashlib.sha256(provider.encode()).hexdigest()
    require(provider_sha == "4eb46706d60cdfc04d63cf6abb451e6626006eec104c26dd2bce943bd7d132f0",
            f"production boundary changed: {provider_sha}")
    require("function origin(value){const item=record(value,['stack'],[],'origin')" in wallet_review and
            "record(value,['stack','voice']" not in wallet_review,
            "F11 still captures provider-shaped voice state in its origin")
    scripts = read(root, "src/scripts-order.txt").splitlines()
    require(scripts == [
        "vendor/qrcode-generator-1.4.4.js", "wallet-provider.js",
        "wallet-review.js", "wallet-transfer.js", "stream-chat-provider.js",
        "platform-provider.js", "platform-offline-fixture.js",
        "perp-read-provider.js", "perp-offline-fixture.js",
        "perp-account-provider.js", "perp-account-offline-fixture.js", "app.js",
    ], "production script order drift")
    require(read(root, "src/screens-order.txt").splitlines() == [
        "splash", "auth", "auth-otp", "auth-wallet", "wallet-create", "wallet-backup",
        "seed-show", "seed-verify", "wallet-import", "home", "pay", "notifications",
        "search", "market", "perp-markets", "perp-market", "perp-order", "perp-confirm",
        "perp-positions", "perp-orders", "perp-position", "perp-account",
        "perp-transfer", "perp-deposit", "perp-funding", "perp-risk-notice",
        "token", "launchpad", "chat", "group", "wallet", "asset",
        "send", "send-to", "send-confirm", "receive", "tx-result", "swap", "dapp",
        "profile", "privacy", "security",
    ], "42-screen post-Stream + Perp manifest / shared F11 bound drift")

    app = read(root, "src/app.js")
    home = read(root, "src/screens/home.html")
    chat = read(root, "src/screens/chat.html")
    group = read(root, "src/screens/group.html")
    shell = read(root, "src/shell-close.html")
    stream_css = read(root, "src/stream-ui.css")
    css = read(root, "src/style.css") + stream_css
    build = read(root, "build.py")
    html = read(root, "app.html")

    require("dm:{screen:'scr-group',stack:['scr-chat','scr-group']}" in app,
            "#dm canonical route missing")
    require("target==='dm'" in app and "conversationMode='dm'" in app,
            "#dm route does not select DM conversation")
    require("target=guardAccountRoute(target)" in app, "route account guard missing")
    require("conversationMode==='dm'?'dm':'group'" in app,
            "conversation canonical hash missing")
    require("function openDM()" in app and "function openGroup()" in app,
            "conversation entrypoints missing")

    require('id="home-audio-room"' in home and
            'data-stream-authority="StreamVideo.state.connection CallState.status CallState.participantCount"' in home,
            "Home E3 entry lacks official Stream projection authority")
    require('data-stream-mode="offline_preview"' in home and
            'data-stream-connection="disconnected"' in home and
            'data-stream-status="unavailable"' in home and
            'data-stream-participant-count="0"' in home,
            "Home E3 entry is not the canonical disconnected/unavailable/count-0 preview")
    require('id="home-audio-status">Unavailable · Stream Video not connected · 0 participants<' in home,
            "Home E3 unavailable copy drift")
    require('<button type="button" id="home-audio-preview" class="btn btn-ghost stream-home-audio-open" onclick="returnToVoiceRoom()">Open preview</button>' in home,
            "Home E3 preview action semantics drift")
    for claim in ["Live now", "listening", "hosted by"]:
        require(claim.lower() not in home.lower(),
                f"Home E3 contains unsourced live claim: {claim}")
    require("data-stream-provider-mutation" not in home and ">Join<" not in home,
            "Home E3 exposes a provider-like join action")
    home_projection = extract_function(app, "renderHomeAudioRoomProjection")
    require("textContent" in home_projection and "innerHTML" not in home_projection and
            "localStorage" not in home_projection and "sessionStorage" not in home_projection and
            "fetch(" not in home_projection and "WebSocket" not in home_projection,
            "Home E3 renderer owns state/network behavior or uses unsafe markup")
    for token in ["stream_video_sdk_call_state", "offline_preview", "disconnected",
                  "unavailable", "participant_count", "visible_participants",
                  "complete_roster_status", "PENDING"]:
        require(token in home_projection, f"Home E3 canonical DTO gate missing: {token}")
    require("return false" in home_projection and "value('participant_count')!==0" in home_projection and
            "visible_participants.length!==0" in home_projection,
            "Home E3 positive/malformed production projection does not fail closed")

    for screen, name in [(chat, "chat"), (group, "group")]:
        require("Offline preview" in screen, f"{name} lacks explicit offline preview label")
        require("not connected" in screen.lower(), f"{name} could masquerade as connected")
        require("data-stream-authority=" in screen, f"{name} authority markers missing")
    require(chat.count("Offline preview · not connected") == 1,
            "E1 preview label count drift")
    require(group.count("Offline preview · not connected") == 2,
            "E2/E4 preview label count drift")

    for state in ["preview", "loading", "empty", "offline"]:
        require(f'data-stream-list-state="{state}"' in chat,
                f"E1 state missing: {state}")
    for kind in ["group", "voice", "dm"]:
        require(f'data-channel-kind="{kind}"' in chat, f"E1 channel kind missing: {kind}")
    require(chat.count("data-unread-count=") == 3 and chat.count("data-muted=") == 3,
            "E1 unread/mute projection missing")

    require('data-conversation-view="group"' in group and
            'data-conversation-view="dm"' in group, "group/DM views missing")
    for field in ["data-provider-message-id", "data-provider-cid", "data-parent-id",
                  "data-mention-user", "data-reaction-count", "data-pinned-at"]:
        require(group.count(field) == 4, f"E2/E4 DTO projection marker count drift: {field}")
    require(group.count('data-stream-authority="stream_chat_sdk_channel_state"') == 2,
            "E2 official channel state authority missing")
    require('data-stream-authority="CallState.callParticipants"' in group and
            'data-stream-count-authority="CallState.participantCount"' in group,
            "E3 participant/count authority missing")
    require('data-visible-participant-limit="250"' in group and
            "Complete roster PENDING" in group, "E3 250/complete roster gate missing")

    ui = "\n".join([chat, group, shell])
    forbidden_claims = ["Agora RTC", "end-to-end encrypted", "E2EE protected", "encrypted invites"]
    for claim in forbidden_claims:
        require(claim.lower() not in ui.lower(), f"unsupported communication claim: {claim}")
    require("End-to-end encryption is not claimed" in group,
            "DM E2EE non-claim missing")
    require("provider and account policy" in group,
            "DM protection authority copy missing")

    controls = re.findall(r"<button\b[^>]*data-stream-provider-mutation=\"([^\"]+)\"[^>]*>", ui)
    require(set(expected_writes) - {"connect_user", "query_channels", "watch_channel", "mark_read"} <= set(controls),
            f"required mutation controls missing: {sorted(set(expected_writes) - set(controls))}")
    for tag in re.findall(r"<button\b[^>]*data-stream-provider-mutation=\"[^\"]+\"[^>]*>", ui):
        require(re.search(r"\sdisabled(?:\s|>|=)", tag) is not None,
                f"provider mutation control enabled: {tag}")
        require('aria-disabled="true"' in tag, f"provider mutation lacks aria-disabled: {tag}")

    for name in ["streamMutationPending", "joinVoiceRoom", "leaveVoiceRoom", "toggleMute", "toggleHand"]:
        function = extract_function(app, name)
        require("setTimeout" not in function and "fetch(" not in function and
                "WebSocket" not in function and "localStorage" not in function,
                f"{name} owns communication behavior")
    for name in ["joinVoiceRoom", "leaveVoiceRoom", "toggleMute", "toggleHand"]:
        function = extract_function(app, name)
        require("streamMutationPending(" in function, f"{name} bypasses PENDING UI gate")
        require("voice.state=" not in function and "voice.listeners=" not in function and
                "voice.muted=" not in function and "voice.hand=" not in function,
                f"{name} mutates provider-like state")
    render_voice = extract_function(app, "renderVoice")
    require("innerHTML" not in render_voice and "VR_SEATS" not in app and
            "simulateDrop" not in app, "custom roster/reconnect simulation remains")
    require("const voice =" not in app and "const voice=" not in app,
            "local RTC/presence-shaped voice record remains")
    require("if(!event.persisted) return;\n  refreshRegionalBlockedSessionLatch();\n  voicePanel.open=false;voicePanel.minimized=false;\n  renderVoice();" in app,
            "BFCache restore does not clear ephemeral voice UI projection")
    require("joinedAt" not in app and "listeners:" not in app and "speakers:" not in app and
            "hand:" not in app and "muted:" not in app and "weak:" not in app,
            "provider-shaped voice fields remain in local application state")
    for name in ["navigationStorageProjection", "syncHash", "persist",
                 "sanitizeReviewProjectionForWrite", "reviewOriginProjection"]:
        section = extract_function(app, name) if name not in {
            "navigationStorageProjection", "sanitizeReviewProjectionForWrite"
        } else app[app.index(f"const {name}="):]
        if name == "navigationStorageProjection":
            section = section[:section.index("function activeScr")]
        elif name == "sanitizeReviewProjectionForWrite":
            section = section[:section.index("const reviewRuntime")]
        require("voice" not in section.lower(),
                f"{name} persists or snapshots local voice authority")

    require("stream-ui.css" in build, "dedicated Stream UI stylesheet not built")
    require(stream_css.count(":focus-visible") >= 5 and "prefers-reduced-motion" in stream_css,
            "focus/reduced motion support missing")
    for selector in [".stream-state-tab:focus-visible", "#gcHead button:focus-visible",
                     "#composer input:focus-visible", "#callbar button:focus-visible",
                     ".stream-conversation-shell button:focus-visible"]:
        require(selector in stream_css, f"focused control coverage missing: {selector}")
    require(re.search(r"\.stream-(?:state-tab|action|icon-btn)[^{]*\{[^}]*min-height:\s*44px", stream_css),
            "44px Stream target rule missing")
    for rule in [
        ".stream-home-audio-open{min-width:44px;min-height:44px}",
        ".stream-list-shell .alias-bar button{min-width:44px;min-height:44px}",
        ".stream-conversation-shell .tc-actions button,.stream-conversation-shell .risk-strip button,.stream-conversation-shell .am-act button{min-width:44px;min-height:44px}",
        "#gcHead .back,#gcHead .icon-btn,#composer .icon-btn,#composer .send,#composer input,#callbar button{min-width:44px;min-height:44px}",
    ]:
        require(rule in stream_css, f"44px full-control rule missing: {rule[:48]}")
    require("@media(max-width:640px)" in stream_css and "@media(min-width:900px)" in stream_css,
            "mobile/desktop Stream layout rules missing")
    require("[inert]" in css or "inert" in app, "inactive view inert support missing")

    require("stream-chat-offline-fixture.js" not in html and
            "Offline fixture — Stream credentials not connected" not in html,
            "test-only fixture leaked into production bundle")
    require("stream_chat_sdk_state" in html and "CallState.callParticipants" in html and
            'id="home-audio-room"' in html and "StreamVideo.state.connection CallState.status CallState.participantCount" in html,
            "built UI authority markers missing")
    require(app.count("STREAM_CHAT_PROVIDER_MUTATION_PENDING") == 2,
            "UI PENDING error code missing")

    forbidden_core = ["new WebSocket", "socket.io", "RTCPeerConnection", "getUserMedia(",
                      "indexedDB", "messageStore", "deliveryQueue", "presenceStore"]
    stream_slice = "\n".join([home, chat, group, shell,
                              extract_function(app, "renderHomeAudioRoomProjection"),
                              extract_function(app, "streamMutationPending"),
                              extract_function(app, "renderVoice")])
    for token in forbidden_core:
        require(token not in stream_slice, f"custom communication core token present: {token}")

    return {"provider_sha256": provider_sha, "controls": len(controls)}


def replace(root: Path, relative: str, old: str, new: str) -> None:
    path = root / relative
    text = path.read_text()
    require(old in text, f"mutation setup missing {old!r} in {relative}")
    path.write_text(text.replace(old, new, 1))


def run_mutations(root: Path) -> int:
    mutations = [
        ("authority", "contracts/stream-ui/contract.json", '"stream_chat_and_video_only"', '"loop_chat"'),
        ("connected claim", "contracts/stream-ui/contract.json", '"production_connected_claim": false', '"production_connected_claim": true'),
        ("fixture bundle", "contracts/stream-ui/contract.json", '"test_fixture_in_bundle": false', '"test_fixture_in_bundle": true'),
        ("custom core", "contracts/stream-ui/contract.json", '"custom_communication_core": false', '"custom_communication_core": true'),
        ("voice persistence", "contracts/stream-ui/contract.json", '"local_voice_state_persistence": false', '"local_voice_state_persistence": true'),
        ("offline room semantics", "contracts/stream-ui/contract.json", '"offline_room_dto": "disconnected_unavailable_zero_empty"', '"offline_room_dto": "connected_joined"'),
        ("Home projection gate", "contracts/stream-ui/contract.json", '"home_entry": "canonical_audio_room_dto_projection_or_fail_closed"', '"home_entry": "static_live_claim"'),
        ("DTO path", "contracts/stream-ui/contract.json", '"path": "contracts/stream-ui/dto.schema.json"', '"path": "contracts/stream-ui/untyped.json"'),
        ("DTO draft", "contracts/stream-ui/dto.schema.json", '"$schema": "https://json-schema.org/draft/2020-12/schema"', '"$schema": "draft-local"'),
        ("DTO union", "contracts/stream-ui/dto.schema.json", '{"$ref": "#/$defs/audio_room"}', '{"$ref": "#/$defs/message"}'),
        ("channel DTO open", "contracts/stream-ui/dto.schema.json", '"channel": {\n      "type": "object",\n      "additionalProperties": false', '"channel": {\n      "type": "object",\n      "additionalProperties": true'),
        ("message authority", "contracts/stream-ui/dto.schema.json", '"authority": {"const": "stream_chat_sdk_channel_state"}', '"authority": {"const": "loop_message_state"}'),
        ("audio authority", "contracts/stream-ui/dto.schema.json", '"authority": {"const": "stream_video_sdk_call_state"}', '"authority": {"const": "loop_rtc"}'),
        ("audio DTO cap", "contracts/stream-ui/dto.schema.json", '"maxItems": 250', '"maxItems": 251'),
        ("offline chat connected", "contracts/stream-ui/dto.schema.json", '"connected": {"const": false}', '"connected": {"const": true}'),
        ("offline audio connected", "contracts/stream-ui/dto.schema.json", '"connection": {"const": "disconnected"}', '"connection": {"const": "connected"}'),
        ("offline audio joined", "contracts/stream-ui/dto.schema.json", '"status": {"const": "unavailable"}', '"status": {"const": "joined"}'),
        ("participant count bound", "contracts/stream-ui/dto.schema.json", '"maximum": 50000', '"maximum": 200000'),
        ("offline roster nonempty", "contracts/stream-ui/dto.schema.json", '"visible_participants": {"maxItems": 0}', '"visible_participants": {"maxItems": 250}'),
        ("audio roster ready", "contracts/stream-ui/dto.schema.json", '"complete_roster_status": {"const": "PENDING"}', '"complete_roster_status": {"const": "READY"}'),
        ("DM route", "src/app.js", "dm:{screen:'scr-group',stack:['scr-chat','scr-group']}", "dm:{screen:'scr-dm',stack:['scr-chat','scr-dm']}"),
        ("DM mode", "src/app.js", "target==='dm'", "target==='direct-message'"),
        ("account guard", "src/app.js", "target=guardAccountRoute(target)", "target=target"),
        ("canonical DM", "src/app.js", "conversationMode==='dm'?'dm':'group'", "'group'"),
        ("chat label", "src/screens/chat.html", "Offline preview", "Preview"),
        ("group label", "src/screens/group.html", "Offline preview · not connected</b>\n            <span>Message", "Preview</b>\n            <span>Message"),
        ("chat connected", "src/screens/chat.html", "not connected", "connected"),
        ("group connected", "src/screens/group.html", "not connected", "connected"),
        ("loading state", "src/screens/chat.html", 'data-stream-list-state="loading"', 'data-stream-list-state="busy"'),
        ("empty state", "src/screens/chat.html", 'data-stream-list-state="empty"', 'data-stream-list-state="none"'),
        ("offline state", "src/screens/chat.html", 'data-stream-list-state="offline"', 'data-stream-list-state="disconnected"'),
        ("DM kind", "src/screens/chat.html", 'data-channel-kind="dm"', 'data-channel-kind="direct"'),
        ("unread", "src/screens/chat.html", "data-unread-count=", "data-local-unread="),
        ("group view", "src/screens/group.html", 'data-conversation-view="group"', 'data-conversation-view="room"'),
        ("DM view", "src/screens/group.html", 'data-conversation-view="dm"', 'data-conversation-view="direct"'),
        ("message ID", "src/screens/group.html", "data-provider-message-id", "data-local-message-id"),
        ("parent", "src/screens/group.html", "data-parent-id", "data-reply-id"),
        ("mention", "src/screens/group.html", "data-mention-user", "data-mention"),
        ("reaction", "src/screens/group.html", "data-reaction-count", "data-reactions"),
        ("pin", "src/screens/group.html", "data-pinned-at", "data-pin-time"),
        ("chat state authority", "src/screens/group.html", "stream_chat_sdk_channel_state", "loop_message_state"),
        ("participant authority", "src/screens/group.html", "CallState.callParticipants", "localParticipants"),
        ("count authority", "src/screens/group.html", "CallState.participantCount", "participants.length"),
        ("250", "src/screens/group.html", 'data-visible-participant-limit="250"', 'data-visible-participant-limit="500"'),
        ("roster gate", "src/screens/group.html", "Complete roster PENDING", "Complete roster ready"),
        ("Home authority", "src/screens/home.html", 'data-stream-authority="StreamVideo.state.connection CallState.status CallState.participantCount"', 'data-stream-authority="localVoiceState"'),
        ("Home preview mode", "src/screens/home.html", 'data-stream-mode="offline_preview"', 'data-stream-mode="production"'),
        ("Home disconnected", "src/screens/home.html", 'data-stream-connection="disconnected"', 'data-stream-connection="connected"'),
        ("Home unavailable", "src/screens/home.html", 'data-stream-status="unavailable"', 'data-stream-status="joined"'),
        ("Home participant count", "src/screens/home.html", 'data-stream-participant-count="0"', 'data-stream-participant-count="214"'),
        ("Home non-live copy", "src/screens/home.html", "Voice room", "Live now"),
        ("Home count copy", "src/screens/home.html", "Unavailable · Stream Video not connected · 0 participants", "214 listening · hosted by shadowfax.eth"),
        ("Home preview action", "src/screens/home.html", ">Open preview</button>", ">Join</button>"),
        ("E2EE nonclaim", "src/screens/group.html", "End-to-end encryption is not claimed", "E2EE protected"),
        ("send enabled", "src/shell-close.html", 'data-stream-provider-mutation="send_message" disabled', 'data-stream-provider-mutation="send_message"'),
        ("send aria", "src/shell-close.html", 'data-stream-provider-mutation="send_message" disabled aria-disabled="true"', 'data-stream-provider-mutation="send_message" disabled'),
        ("reply enabled", "src/screens/group.html", 'data-stream-provider-mutation="send_thread_reply" disabled', 'data-stream-provider-mutation="send_thread_reply"'),
        ("reaction enabled", "src/screens/group.html", 'data-stream-provider-mutation="send_reaction" disabled', 'data-stream-provider-mutation="send_reaction"'),
        ("join enabled", "src/screens/group.html", 'data-stream-provider-mutation="join_audio_room" disabled', 'data-stream-provider-mutation="join_audio_room"'),
        ("leave enabled", "src/shell-close.html", 'data-stream-provider-mutation="leave_audio_room" disabled', 'data-stream-provider-mutation="leave_audio_room"'),
        ("join gate", "src/app.js", "function joinVoiceRoom(){streamMutationPending('join_audio_room')}", "function joinVoiceRoom(){voice.state='joined';renderVoice()}"),
        ("leave gate", "src/app.js", "function leaveVoiceRoom(){streamMutationPending('leave_audio_room')}", "function leaveVoiceRoom(){voice.state='idle';renderVoice()}"),
        ("mute gate", "src/app.js", "function toggleMute(){streamMutationPending('set_microphone_enabled')}", "function toggleMute(){voice.muted=!voice.muted}"),
        ("hand gate", "src/app.js", "function toggleHand(){streamMutationPending('request_speaking_permission')}", "function toggleHand(){voice.hand=!voice.hand}"),
        ("local voice record", "src/app.js", "const voicePanel={open:false,minimized:false}", "const voice = {state:'joined',listeners:200000}"),
        ("voice session persistence", "src/app.js", "navigationStorageProjection.serialize(stack)", "navigationStorageProjection.serialize(stack,{voice:'joined'})"),
        ("BFCache voice reset", "src/app.js", "refreshRegionalBlockedSessionLatch();\n  voicePanel.open=false;voicePanel.minimized=false;", "refreshRegionalBlockedSessionLatch();\n  voicePanel.open=true;voicePanel.minimized=true;"),
        ("F11 voice origin", "src/wallet-review.js", "record(value,['stack'],[],'origin')", "record(value,['stack','voice'],[],'origin')"),
        ("PENDING code", "src/app.js", "STREAM_CHAT_PROVIDER_MUTATION_PENDING", "STREAM_CHAT_PROVIDER_READY"),
        ("stylesheet build", "build.py", "stream-ui.css", "style.css"),
        ("focus", "src/stream-ui.css", ":focus-visible", ":focus"),
        ("reduced motion", "src/stream-ui.css", "prefers-reduced-motion", "prefers-motion"),
        ("44px", "src/stream-ui.css", "min-height:44px", "min-height:38px"),
        ("44px Home audio", "src/stream-ui.css", ".stream-home-audio-open{min-width:44px;min-height:44px}", ".stream-home-audio-open{min-width:44px;min-height:34px}"),
        ("44px alias", "src/stream-ui.css", ".stream-list-shell .alias-bar button{min-width:44px;min-height:44px}", ".stream-list-shell .alias-bar button{min-width:40px;min-height:40px}"),
        ("44px token actions", "src/stream-ui.css", ".stream-conversation-shell .tc-actions button,.stream-conversation-shell .risk-strip button,.stream-conversation-shell .am-act button{min-width:44px;min-height:44px}", ".stream-conversation-shell .tc-actions button,.stream-conversation-shell .risk-strip button,.stream-conversation-shell .am-act button{min-width:32px;min-height:32px}"),
        ("44px chrome", "src/stream-ui.css", "#gcHead .back,#gcHead .icon-btn,#composer .icon-btn,#composer .send,#composer input,#callbar button{min-width:44px;min-height:44px}", "#gcHead .back,#gcHead .icon-btn,#composer .icon-btn,#composer .send,#composer input,#callbar button{min-width:32px;min-height:32px}"),
        ("mobile", "src/stream-ui.css", "@media(max-width:640px)", "@media(max-width:320px)"),
        ("desktop", "src/stream-ui.css", "@media(min-width:900px)", "@media(min-width:1900px)"),
    ]
    killed = 0
    for name, relative, old, new in mutations:
        with tempfile.TemporaryDirectory(prefix="stream-ui-mut-") as temp:
            case = Path(temp) / "repo"
            shutil.copytree(root, case, ignore=shutil.ignore_patterns(".git", "._*", "__pycache__"))
            replace(case, relative, old, new)
            try:
                verify(case)
            except VerificationError:
                killed += 1
            else:
                raise VerificationError(f"mutation survived: {name}")
    require(killed == len(mutations), "mutation count mismatch")
    return killed


def run_runtime(root: Path) -> dict:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise VerificationError(f"Playwright unavailable: {error}") from error
    errors = []
    requests = []
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.on("request", lambda request: requests.append(request.url)
                if not request.url.startswith("file:") else None)
        uri = (root / "app.html").resolve().as_uri()
        target_selector = (".scr.active button,.scr.active a[href],"
                           ".scr.active [role=button],.scr.active [role=tab],"
                           ".scr.active [role=link],.scr.active input,"
                           ".scr.active textarea,.scr.active select,"
                           ".scr.active [contenteditable=true],#gcHead button,"
                           "#gcHead a[href],#composer button,#composer input,#callbar button")
        sizes = []
        def collect_targets(label: str):
            return page.locator(target_selector).evaluate_all(
                """(els,label) => els.filter(el => !el.hidden && el.offsetParent !== null).map(el => {
                  const r=el.getBoundingClientRect();return {route:label,
                    id:el.id||el.className||el.tagName,width:r.width,height:r.height};})""", label)
        page.goto(uri + "#home")
        require(page.locator("#scr-home.active").count() == 1, "#home runtime route failed")
        home_projection = page.locator("#home-audio-room")
        require(home_projection.get_attribute("data-stream-authority") ==
                "StreamVideo.state.connection CallState.status CallState.participantCount" and
                home_projection.get_attribute("data-stream-mode") == "offline_preview" and
                home_projection.get_attribute("data-stream-connection") == "disconnected" and
                home_projection.get_attribute("data-stream-status") == "unavailable" and
                home_projection.get_attribute("data-stream-participant-count") == "0" and
                page.locator("#home-audio-status").inner_text() ==
                "Unavailable · Stream Video not connected · 0 participants",
                "#home E3 projection can masquerade as live")
        require(page.get_by_role("button", name="Open preview").count() == 1 and
                page.get_by_role("button", name="Join").count() == 0,
                "#home E3 action is not a truthful non-mutating preview")
        hostile_home = page.evaluate("""() => {
          const accepted=renderHomeAudioRoomProjection({
            authority:'stream_video_sdk_call_state',mode:'production',
            connection:'connected',status:'joined',participant_count:214,
            visible_participants:[],complete_roster_status:'PENDING'});
          const room=document.getElementById('home-audio-room');
          return {accepted,mode:room.dataset.streamMode,
            connection:room.dataset.streamConnection,status:room.dataset.streamStatus,
            count:room.dataset.streamParticipantCount,
            copy:document.getElementById('home-audio-status').textContent,
            title:document.getElementById('home-audio-title').textContent,
            action:document.getElementById('home-audio-preview').textContent};
        }""")
        require(hostile_home == {
            "accepted": False, "mode": "offline_preview", "connection": "disconnected",
            "status": "unavailable", "count": "0",
            "copy": "Unavailable · Stream Video not connected · 0 participants",
            "title": "Voice room", "action": "Open preview",
        }, f"#home accepted an unverified production/live projection: {hostile_home}")
        sizes.extend(collect_targets("home"))
        page.get_by_role("button", name="Open preview").click()
        require(page.url.endswith("#voiceroom") and page.locator("#voiceRoomCard").is_visible(),
                "#home Open preview did not navigate without a provider write")
        page.goto(uri + "#chat")
        require(page.locator("#scr-chat.active").count() == 1, "#chat runtime route failed")
        require(page.locator("#stream-preview-status").inner_text().startswith("Offline preview · not connected"),
                "#chat runtime could masquerade as connected")
        sizes.extend(collect_targets("chat-preview"))
        page.get_by_role("tab", name="Loading").click()
        require(page.locator('[data-stream-list-state="loading"]:not([hidden])').count() == 1,
                "loading presentation state failed")
        require(page.locator('[data-stream-list-state="preview"][inert]').count() == 1,
                "inactive list state is not inert")
        sizes.extend(collect_targets("chat-loading"))

        page.goto(uri + "#dm")
        require(page.locator("#scr-group.active").count() == 1, "#dm runtime route failed")
        require(page.locator('[data-conversation-view="dm"]:not([hidden])').count() == 1 and
                page.locator('[data-conversation-view="group"][inert]').count() == 1,
                "#dm view/inert boundary failed")
        require(page.locator("#stream-conversation-title").inner_text() == "shadowfax.eth",
                "#dm header projection failed")
        require(page.locator("#composer button:not([disabled]),#composer input:not([disabled])").count() == 0,
                "DM composer exposes a provider mutation")
        sizes.extend(collect_targets("dm"))

        page.goto(uri + "#group")
        require(page.locator('[data-conversation-view="group"]:not([hidden])').count() == 1,
                "#group runtime route failed")
        sizes.extend(collect_targets("group"))

        page.goto(uri + "#voiceroom")
        require(page.locator("#voiceRoomCard").is_visible(), "#voiceroom preview missing")
        require(page.locator("#vrJoinBtn[disabled][aria-disabled=true]").count() == 1,
                "audio join is not fail closed")
        page.locator("#vrToggleBtn").click()
        require(page.locator("#callbar").is_visible() and
                page.locator("#cbStatus").inner_text() == "Unavailable · Stream Video not connected",
                "offline Stream Video minibar projection failed")
        result = page.evaluate("""() => {
          const before=JSON.stringify(history.state);
          const pending=streamMutationPending('send_message');
          const stored=sessionStorage.getItem('loop.proto.state');
          return {before,after:JSON.stringify(history.state),pending,stored,
            hasVoiceState:Boolean(globalThis.voice),inCall:inCall(),hash:location.hash};
        }""")
        require(result["before"] == result["after"] and not result["hasVoiceState"] and
                result["inCall"] is False and result["stored"] ==
                '{"stack":["scr-chat","scr-group"]}' and
                result["pending"] == {"ok": False, "error": {"code": "STREAM_CHAT_PROVIDER_MUTATION_PENDING"}},
                f"PENDING runtime gate mutated communication state: {result}")
        require(result["hash"] == "#voiceroom", f"minibar lost canonical #voiceroom route: {result}")
        sizes.extend(collect_targets("voiceroom"))
        undersized = [item for item in sizes if item["width"] < 44 or item["height"] < 44]
        require(not undersized, f"Stream targets below 44px: {undersized}")
        page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        require(not page.locator("#callbar").is_visible() and
                page.locator("#cbStatus").inner_text() == "Unavailable · Stream Video not connected",
                "BFCache restore without an official DTO retained voice UI projection")
        page.reload()
        require(page.locator("#cbStatus").inner_text() == "Unavailable · Stream Video not connected" and
                not page.locator("#callbar").is_visible(),
                "reload without an official provider DTO did not reset voice UI to unavailable")
        desktop = browser.new_page(viewport={"width": 1440, "height": 1000})
        desktop.on("pageerror", lambda error: errors.append(str(error)))
        desktop.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        desktop.on("request", lambda request: requests.append(request.url)
                   if not request.url.startswith("file:") else None)
        desktop.goto(uri + "#home")
        desktop_home = desktop.evaluate("""selector => {
          const room=document.getElementById('home-audio-room');
          const targets=[...document.querySelectorAll(selector)]
            .filter(el=>!el.hidden&&el.offsetParent!==null).map(el=>{
              const r=el.getBoundingClientRect();return {route:'home-desktop',
                id:el.id||el.className||el.tagName,width:r.width,height:r.height};});
          return {documentOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
            active:[...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id),
            mode:room.dataset.streamMode,connection:room.dataset.streamConnection,
            status:room.dataset.streamStatus,count:room.dataset.streamParticipantCount,targets};
        }""", target_selector)
        require(desktop_home["documentOverflow"] == 0 and
                desktop_home["active"] == ["scr-home"] and
                desktop_home["mode"] == "offline_preview" and
                desktop_home["connection"] == "disconnected" and
                desktop_home["status"] == "unavailable" and
                desktop_home["count"] == "0",
                f"desktop Home authority/layout failed: {desktop_home}")
        sizes.extend(desktop_home["targets"])
        desktop.goto(uri + "#dm")
        desktop_metrics = desktop.evaluate("""() => ({
          documentOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
          active:[...document.querySelectorAll('.scr.active:not([inert])')].map(node=>node.id),
          dmVisible:!document.querySelector('[data-conversation-view="dm"]').hidden,
          groupInert:document.querySelector('[data-conversation-view="group"]').hasAttribute('inert')
        })""")
        require(desktop_metrics == {"documentOverflow": 0, "active": ["scr-group"],
                "dmVisible": True, "groupInert": True},
                f"desktop DM layout/route failed: {desktop_metrics}")
        browser.close()
    require(not errors, f"runtime console/page errors: {errors}")
    require(not requests, f"runtime made external requests: {requests}")
    return {"routes": 6, "targets": len(sizes)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--mutations", action="store_true")
    parser.add_argument("--runtime", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        result = verify(root)
        mutations = run_mutations(root) if args.mutations else 0
        runtime = run_runtime(root) if args.runtime else {"routes": 0, "targets": 0}
    except VerificationError as error:
        print(f"FAIL: {error}")
        return 1
    print(f"PASS: Stream E1-E4 UI provider projection contract controls={result['controls']} mutations={mutations} runtime_routes={runtime['routes']} runtime_targets={runtime['targets']} provider={result['provider_sha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
