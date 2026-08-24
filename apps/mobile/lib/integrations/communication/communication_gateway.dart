import 'package:flutter/foundation.dart';

enum ConversationKind { group, direct, voice, meeting }

enum MessageKind { text, token, assetSnapshot, system }

enum VoiceConnectionPhase { idle, joining, joined, reconnecting, error }

@immutable
class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.title,
    required this.preview,
    required this.timeLabel,
    required this.kind,
    this.unreadCount = 0,
    this.muted = false,
    this.memberLabel,
    this.accentSeed = 0,
  });

  final String id;
  final String title;
  final String preview;
  final String timeLabel;
  final ConversationKind kind;
  final int unreadCount;
  final bool muted;
  final String? memberLabel;
  final int accentSeed;
}

@immutable
class ConversationMessage {
  const ConversationMessage({
    required this.id,
    required this.conversationId,
    required this.senderId,
    required this.senderAlias,
    required this.timeLabel,
    required this.kind,
    this.text = '',
    this.isMine = false,
    this.isPinned = false,
    this.replyLabel,
    this.reactions = const <String, int>{},
  });

  final String id;
  final String conversationId;
  final String senderId;
  final String senderAlias;
  final String timeLabel;
  final MessageKind kind;
  final String text;
  final bool isMine;
  final bool isPinned;
  final String? replyLabel;
  final Map<String, int> reactions;
}

@immutable
class VoiceParticipant {
  const VoiceParticipant({
    required this.id,
    required this.alias,
    this.isHost = false,
    this.isSpeaking = false,
    this.isMuted = true,
    this.colorSeed = 0,
  });

  final String id;
  final String alias;
  final bool isHost;
  final bool isSpeaking;
  final bool isMuted;
  final int colorSeed;
}

@immutable
class VoiceRoomSummary {
  const VoiceRoomSummary({
    required this.id,
    required this.groupId,
    required this.title,
    required this.topic,
    required this.listenerCount,
    required this.speakerCount,
    required this.participants,
  });

  final String id;
  final String groupId;
  final String title;
  final String topic;
  final int listenerCount;
  final int speakerCount;
  final List<VoiceParticipant> participants;
}

@immutable
class MessageRequestSummary {
  const MessageRequestSummary({
    required this.id,
    required this.alias,
    required this.preview,
    required this.timeLabel,
    required this.sharedContext,
    this.colorSeed = 0,
  });

  final String id;
  final String alias;
  final String preview;
  final String timeLabel;
  final String sharedContext;
  final int colorSeed;
}

@immutable
class MessageSearchResult {
  const MessageSearchResult({
    required this.id,
    required this.conversationId,
    required this.conversationTitle,
    required this.senderAlias,
    required this.snippet,
    required this.timeLabel,
    required this.kind,
  });

  final String id;
  final String conversationId;
  final String conversationTitle;
  final String senderAlias;
  final String snippet;
  final String timeLabel;
  final ConversationKind kind;
}

@immutable
class CommunicationFailure {
  const CommunicationFailure({required this.code, required this.message});

  final String code;
  final String message;

  static const notConfigured = CommunicationFailure(
    code: 'communication_not_configured',
    message: 'Communication is not available yet.',
  );
}

@immutable
class CommunicationResult<T> {
  const CommunicationResult.success(this.value) : failure = null;

  const CommunicationResult.failure(this.failure) : value = null;

  final T? value;
  final CommunicationFailure? failure;

  bool get isSuccess => failure == null;
}

abstract interface class CommunicationGateway {
  bool get isConfigured;

  Future<CommunicationResult<List<ConversationSummary>>> loadConversations();

  Future<CommunicationResult<List<ConversationMessage>>> loadMessages(
    String conversationId,
  );

  Future<CommunicationResult<ConversationMessage>> sendText({
    required String conversationId,
    required String text,
  });

  Future<CommunicationResult<List<MessageSearchResult>>> searchMessages({
    required String query,
    String? conversationId,
  });

  Future<CommunicationResult<List<MessageRequestSummary>>>
  loadMessageRequests();

  Future<CommunicationResult<void>> acceptMessageRequest(String requestId);

  Future<CommunicationResult<void>> ignoreMessageRequest(String requestId);

  Future<CommunicationResult<void>> reportMessageRequest({
    required String requestId,
    required String reason,
  });

  Future<CommunicationResult<VoiceRoomSummary>> joinVoiceRoom({
    required String roomId,
    required bool microphoneMuted,
  });

  Future<CommunicationResult<void>> leaveVoiceRoom(String roomId);

  Future<CommunicationResult<void>> setMicrophoneMuted({
    required String roomId,
    required bool muted,
  });
}
