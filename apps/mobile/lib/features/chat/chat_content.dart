import 'package:loop_mobile/integrations/communication/communication_gateway.dart';

abstract final class ChatContent {
  static const currentAlias = 'Voyager_7';
  static const groupId = 'glyph-hunters';
  static const directId = 'sable-direct';
  static const voiceRoomId = 'eth-macro-room';

  static const conversations = <ConversationSummary>[
    ConversationSummary(
      id: groupId,
      title: 'Glyph Hunters',
      preview: 'NightOwl: LP unlocks in 3 days',
      timeLabel: '14:12',
      kind: ConversationKind.group,
      unreadCount: 12,
      memberLabel: '842 members',
      accentSeed: 2,
    ),
    ConversationSummary(
      id: voiceRoomId,
      title: 'ETH Macro Room',
      preview: 'Weekly positioning roundtable',
      timeLabel: 'Live',
      kind: ConversationKind.voice,
      unreadCount: 3,
      memberLabel: '84 listening',
      accentSeed: 1,
    ),
    ConversationSummary(
      id: directId,
      title: '0xSable',
      preview: 'That unlock schedule is worth watching.',
      timeLabel: '13:46',
      kind: ConversationKind.direct,
      muted: true,
      accentSeed: 4,
    ),
    ConversationSummary(
      id: 'weekly-briefing',
      title: 'Community briefing',
      preview: 'Video and scheduled meetings arrive later.',
      timeLabel: 'Mon',
      kind: ConversationKind.meeting,
      accentSeed: 5,
    ),
  ];

  static const groupMessages = <ConversationMessage>[
    ConversationMessage(
      id: 'g1',
      conversationId: groupId,
      senderId: 'nightowl',
      senderAlias: 'NightOwl',
      timeLabel: '14:02',
      kind: MessageKind.text,
      text:
          'Small-cap find. Checking the unlock schedule before making a call.',
      reactions: <String, int>{'👀': 18, '🧭': 6},
    ),
    ConversationMessage(
      id: 'g2',
      conversationId: groupId,
      senderId: 'sable',
      senderAlias: '0xSable',
      timeLabel: '14:07',
      kind: MessageKind.token,
      text: 'GLYPH',
      replyLabel: 'Replying to NightOwl',
      reactions: <String, int>{'⚠️': 9},
    ),
    ConversationMessage(
      id: 'g3',
      conversationId: groupId,
      senderId: 'voyager',
      senderAlias: currentAlias,
      timeLabel: '14:09',
      kind: MessageKind.text,
      text: 'The unlock is the deciding fact for me. Watching, not entering.',
      isMine: true,
    ),
    ConversationMessage(
      id: 'g4',
      conversationId: groupId,
      senderId: 'atlas',
      senderAlias: 'AtlasLoop',
      timeLabel: '14:12',
      kind: MessageKind.assetSnapshot,
      text: 'ETH',
      reactions: <String, int>{'🔥': 11, '🧠': 4},
    ),
  ];

  static const directMessages = <ConversationMessage>[
    ConversationMessage(
      id: 'd1',
      conversationId: directId,
      senderId: 'sable',
      senderAlias: '0xSable',
      timeLabel: '13:41',
      kind: MessageKind.text,
      text: 'Saw your note in Glyph Hunters. Do you track the vesting wallet?',
    ),
    ConversationMessage(
      id: 'd2',
      conversationId: directId,
      senderId: 'voyager',
      senderAlias: currentAlias,
      timeLabel: '13:44',
      kind: MessageKind.text,
      text: 'Yes. I saved the address and set an alert for outbound transfers.',
      isMine: true,
    ),
    ConversationMessage(
      id: 'd3',
      conversationId: directId,
      senderId: 'sable',
      senderAlias: '0xSable',
      timeLabel: '13:46',
      kind: MessageKind.text,
      text: 'That unlock schedule is worth watching.',
    ),
  ];

  static const voiceRoom = VoiceRoomSummary(
    id: voiceRoomId,
    groupId: groupId,
    title: 'ETH Macro Room',
    topic: 'Weekly positioning roundtable',
    listenerCount: 84,
    speakerCount: 4,
    participants: <VoiceParticipant>[
      VoiceParticipant(
        id: 'ava',
        alias: 'AvaMacro',
        isHost: true,
        isSpeaking: true,
        isMuted: false,
        colorSeed: 1,
      ),
      VoiceParticipant(
        id: 'atlas',
        alias: 'AtlasLoop',
        isSpeaking: true,
        isMuted: false,
        colorSeed: 3,
      ),
      VoiceParticipant(
        id: 'sable',
        alias: '0xSable',
        isMuted: false,
        colorSeed: 4,
      ),
      VoiceParticipant(id: 'nori', alias: 'Nori', colorSeed: 6),
      VoiceParticipant(id: 'nightowl', alias: 'NightOwl', colorSeed: 2),
      VoiceParticipant(id: 'mina', alias: 'Mina.Ξ', colorSeed: 7),
    ],
  );

  static const requests = <MessageRequestSummary>[
    MessageRequestSummary(
      id: 'r1',
      alias: 'onchain.mia',
      preview: 'I found the same treasury movement. Want the address?',
      timeLabel: '12 min',
      sharedContext: 'Both follow ETH Macro Room',
      colorSeed: 1,
    ),
    MessageRequestSummary(
      id: 'r2',
      alias: '0xHarbor',
      preview: 'Can I invite you to our market research group?',
      timeLabel: '2 hr',
      sharedContext: '2 shared groups',
      colorSeed: 5,
    ),
  ];

  static const searchResults = <MessageSearchResult>[
    MessageSearchResult(
      id: 's1',
      conversationId: groupId,
      conversationTitle: 'Glyph Hunters',
      senderAlias: 'NightOwl',
      snippet: 'Checking the unlock schedule before making a call.',
      timeLabel: 'Today · 14:02',
      kind: ConversationKind.group,
    ),
    MessageSearchResult(
      id: 's2',
      conversationId: directId,
      conversationTitle: '0xSable',
      senderAlias: '0xSable',
      snippet: 'That unlock schedule is worth watching.',
      timeLabel: 'Today · 13:46',
      kind: ConversationKind.direct,
    ),
    MessageSearchResult(
      id: 's3',
      conversationId: groupId,
      conversationTitle: 'Glyph Hunters',
      senderAlias: currentAlias,
      snippet: 'The unlock is the deciding fact for me.',
      timeLabel: 'Today · 14:09',
      kind: ConversationKind.group,
    ),
  ];
}

class MemoryCommunicationGateway implements CommunicationGateway {
  MemoryCommunicationGateway()
    : _requests = List<MessageRequestSummary>.of(ChatContent.requests),
      _groupMessages = List<ConversationMessage>.of(ChatContent.groupMessages),
      _directMessages = List<ConversationMessage>.of(
        ChatContent.directMessages,
      );

  final List<MessageRequestSummary> _requests;
  final List<ConversationMessage> _groupMessages;
  final List<ConversationMessage> _directMessages;

  @override
  bool get isConfigured => true;

  @override
  Future<CommunicationResult<void>> acceptMessageRequest(
    String requestId,
  ) async {
    _requests.removeWhere((item) => item.id == requestId);
    return const CommunicationResult<void>.success(null);
  }

  @override
  Future<CommunicationResult<void>> ignoreMessageRequest(
    String requestId,
  ) async {
    _requests.removeWhere((item) => item.id == requestId);
    return const CommunicationResult<void>.success(null);
  }

  @override
  Future<CommunicationResult<VoiceRoomSummary>> joinVoiceRoom({
    required String roomId,
    required bool microphoneMuted,
  }) async {
    return const CommunicationResult<VoiceRoomSummary>.success(
      ChatContent.voiceRoom,
    );
  }

  @override
  Future<CommunicationResult<void>> leaveVoiceRoom(String roomId) async {
    return const CommunicationResult<void>.success(null);
  }

  @override
  Future<CommunicationResult<List<ConversationSummary>>>
  loadConversations() async {
    return const CommunicationResult<List<ConversationSummary>>.success(
      ChatContent.conversations,
    );
  }

  @override
  Future<CommunicationResult<List<MessageRequestSummary>>>
  loadMessageRequests() async {
    return CommunicationResult<List<MessageRequestSummary>>.success(
      List<MessageRequestSummary>.unmodifiable(_requests),
    );
  }

  @override
  Future<CommunicationResult<List<ConversationMessage>>> loadMessages(
    String conversationId,
  ) async {
    final source = conversationId == ChatContent.directId
        ? _directMessages
        : _groupMessages;
    return CommunicationResult<List<ConversationMessage>>.success(
      List<ConversationMessage>.unmodifiable(source),
    );
  }

  @override
  Future<CommunicationResult<List<MessageSearchResult>>> searchMessages({
    required String query,
    String? conversationId,
  }) async {
    final normalized = query.trim().toLowerCase();
    final matches = ChatContent.searchResults
        .where((item) {
          final inConversation =
              conversationId == null || item.conversationId == conversationId;
          final searchable =
              '${item.conversationTitle} ${item.senderAlias} ${item.snippet}'
                  .toLowerCase();
          return inConversation &&
              (normalized.isEmpty || searchable.contains(normalized));
        })
        .toList(growable: false);
    return CommunicationResult<List<MessageSearchResult>>.success(matches);
  }

  @override
  Future<CommunicationResult<void>> reportMessageRequest({
    required String requestId,
    required String reason,
  }) async {
    _requests.removeWhere((item) => item.id == requestId);
    return const CommunicationResult<void>.success(null);
  }

  @override
  Future<CommunicationResult<ConversationMessage>> sendText({
    required String conversationId,
    required String text,
  }) async {
    final target = conversationId == ChatContent.directId
        ? _directMessages
        : _groupMessages;
    final message = ConversationMessage(
      id: 'local-${target.length + 1}',
      conversationId: conversationId,
      senderId: 'voyager',
      senderAlias: ChatContent.currentAlias,
      timeLabel: 'Now',
      kind: MessageKind.text,
      text: text,
      isMine: true,
    );
    target.add(message);
    return CommunicationResult<ConversationMessage>.success(message);
  }

  @override
  Future<CommunicationResult<void>> setMicrophoneMuted({
    required String roomId,
    required bool muted,
  }) async {
    return const CommunicationResult<void>.success(null);
  }
}
