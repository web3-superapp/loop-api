import 'package:loop_mobile/integrations/communication/communication_gateway.dart';

/// A narrow bridge for the future Agora Chat and RTC SDK packages.
///
/// No application ID, token, certificate, or user credential belongs in the
/// mobile repository. A production bridge must receive short-lived tokens from
/// the BFF and implement this interface in the application composition root.
abstract interface class AgoraCommunicationBridge {
  Future<List<ConversationSummary>> loadConversations();

  Future<List<ConversationMessage>> loadMessages(String conversationId);

  Future<ConversationMessage> sendText({
    required String conversationId,
    required String text,
  });

  Future<List<MessageSearchResult>> searchMessages({
    required String query,
    String? conversationId,
  });

  Future<List<MessageRequestSummary>> loadMessageRequests();

  Future<void> acceptMessageRequest(String requestId);

  Future<void> ignoreMessageRequest(String requestId);

  Future<void> reportMessageRequest({
    required String requestId,
    required String reason,
  });

  Future<VoiceRoomSummary> joinVoiceRoom({
    required String roomId,
    required bool microphoneMuted,
  });

  Future<void> leaveVoiceRoom(String roomId);

  Future<void> setMicrophoneMuted({
    required String roomId,
    required bool muted,
  });
}

class AgoraCommunicationGateway implements CommunicationGateway {
  const AgoraCommunicationGateway({this.bridge, this.tokenEndpoint});

  /// The default production seam. It intentionally performs no network work.
  const AgoraCommunicationGateway.unconfigured()
    : bridge = null,
      tokenEndpoint = null;

  final AgoraCommunicationBridge? bridge;
  final Uri? tokenEndpoint;

  @override
  bool get isConfigured => bridge != null && tokenEndpoint != null;

  @override
  Future<CommunicationResult<void>> acceptMessageRequest(String requestId) {
    return _run<void>(() => bridge!.acceptMessageRequest(requestId));
  }

  @override
  Future<CommunicationResult<void>> ignoreMessageRequest(String requestId) {
    return _run<void>(() => bridge!.ignoreMessageRequest(requestId));
  }

  @override
  Future<CommunicationResult<VoiceRoomSummary>> joinVoiceRoom({
    required String roomId,
    required bool microphoneMuted,
  }) {
    return _run<VoiceRoomSummary>(
      () => bridge!.joinVoiceRoom(
        roomId: roomId,
        microphoneMuted: microphoneMuted,
      ),
    );
  }

  @override
  Future<CommunicationResult<void>> leaveVoiceRoom(String roomId) {
    return _run<void>(() => bridge!.leaveVoiceRoom(roomId));
  }

  @override
  Future<CommunicationResult<void>> reportMessageRequest({
    required String requestId,
    required String reason,
  }) {
    return _run<void>(
      () => bridge!.reportMessageRequest(requestId: requestId, reason: reason),
    );
  }

  @override
  Future<CommunicationResult<List<ConversationSummary>>> loadConversations() {
    return _run<List<ConversationSummary>>(() => bridge!.loadConversations());
  }

  @override
  Future<CommunicationResult<List<MessageRequestSummary>>>
  loadMessageRequests() {
    return _run<List<MessageRequestSummary>>(
      () => bridge!.loadMessageRequests(),
    );
  }

  @override
  Future<CommunicationResult<List<ConversationMessage>>> loadMessages(
    String conversationId,
  ) {
    return _run<List<ConversationMessage>>(
      () => bridge!.loadMessages(conversationId),
    );
  }

  @override
  Future<CommunicationResult<List<MessageSearchResult>>> searchMessages({
    required String query,
    String? conversationId,
  }) {
    return _run<List<MessageSearchResult>>(
      () =>
          bridge!.searchMessages(query: query, conversationId: conversationId),
    );
  }

  @override
  Future<CommunicationResult<ConversationMessage>> sendText({
    required String conversationId,
    required String text,
  }) {
    return _run<ConversationMessage>(
      () => bridge!.sendText(conversationId: conversationId, text: text),
    );
  }

  @override
  Future<CommunicationResult<void>> setMicrophoneMuted({
    required String roomId,
    required bool muted,
  }) {
    return _run<void>(
      () => bridge!.setMicrophoneMuted(roomId: roomId, muted: muted),
    );
  }

  Future<CommunicationResult<T>> _run<T>(Future<T> Function() operation) async {
    if (!isConfigured) {
      return CommunicationResult<T>.failure(CommunicationFailure.notConfigured);
    }
    try {
      return CommunicationResult<T>.success(await operation());
    } catch (_) {
      return CommunicationResult<T>.failure(
        const CommunicationFailure(
          code: 'communication_unavailable',
          message: 'Communication is temporarily unavailable.',
        ),
      );
    }
  }
}
