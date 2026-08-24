import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/chat/chat_content.dart';
import 'package:loop_mobile/features/chat/chat_state.dart';
import 'package:loop_mobile/features/chat/widgets/chat_components.dart';
import 'package:loop_mobile/integrations/communication/communication_gateway.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

enum _InboxFilter { all, groups, direct }

class ChatInboxPage extends ConsumerStatefulWidget {
  const ChatInboxPage({super.key});

  @override
  ConsumerState<ChatInboxPage> createState() => _ChatInboxPageState();
}

class _ChatInboxPageState extends ConsumerState<ChatInboxPage> {
  static const _aliases = <String>[
    ChatContent.currentAlias,
    'MintNomad',
    'QuietOrbit',
    'AbyssWalker',
  ];

  var _aliasIndex = 0;
  var _filter = _InboxFilter.all;

  @override
  Widget build(BuildContext context) {
    final conversations = ref.watch(conversationListProvider);
    return LoopPage(
      eyebrow: 'Discuss',
      title: 'Chats',
      subtitle:
          'Move from market signal to conversation without losing context.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/chat/search'),
          tooltip: 'Search messages',
          icon: const Icon(Icons.search_rounded),
        ),
        IconButton(
          onPressed: () => context.push('/chat/requests'),
          tooltip: 'Message requests',
          icon: Badge(
            label: const Text('2'),
            backgroundColor: LoopColors.chat,
            textColor: LoopColors.abyss,
            child: const Icon(Icons.person_add_alt_1_outlined),
          ),
        ),
      ],
      bottom: const ChatMiniVoiceBar(),
      children: <Widget>[
        const LoopContextRail(stage: LoopStage.discuss),
        const SizedBox(height: 16),
        ChatAliasBar(
          alias: _aliases[_aliasIndex],
          onShuffle: () {
            setState(() => _aliasIndex = (_aliasIndex + 1) % _aliases.length);
            ScaffoldMessenger.of(context)
              ..hideCurrentSnackBar()
              ..showSnackBar(
                SnackBar(
                  content: Text(
                    'You now appear as ${_aliases[(_aliasIndex)]}.',
                  ),
                ),
              );
          },
        ),
        LoopSectionLabel(
          'Conversations',
          trailing: TextButton.icon(
            onPressed: () => context.push('/chat/requests'),
            icon: const Icon(Icons.mail_outline_rounded, size: 16),
            label: const Text('2 requests'),
          ),
        ),
        SegmentedButton<_InboxFilter>(
          segments: const <ButtonSegment<_InboxFilter>>[
            ButtonSegment<_InboxFilter>(
              value: _InboxFilter.all,
              label: Text('All'),
            ),
            ButtonSegment<_InboxFilter>(
              value: _InboxFilter.groups,
              label: Text('Groups'),
            ),
            ButtonSegment<_InboxFilter>(
              value: _InboxFilter.direct,
              label: Text('Direct'),
            ),
          ],
          selected: <_InboxFilter>{_filter},
          showSelectedIcon: false,
          style: ButtonStyle(
            visualDensity: VisualDensity.compact,
            side: const WidgetStatePropertyAll(
              BorderSide(color: LoopColors.line),
            ),
            backgroundColor: WidgetStateProperty.resolveWith((states) {
              return states.contains(WidgetState.selected)
                  ? LoopColors.chat.withValues(alpha: 0.12)
                  : LoopColors.basalt;
            }),
            foregroundColor: WidgetStateProperty.resolveWith((states) {
              return states.contains(WidgetState.selected)
                  ? LoopColors.chat
                  : LoopColors.vapor;
            }),
          ),
          onSelectionChanged: (selection) {
            setState(() => _filter = selection.first);
          },
        ),
        const SizedBox(height: 10),
        conversations.when(
          data: (items) {
            final visible = items.where(_matchesFilter).toList(growable: false);
            if (visible.isEmpty) {
              return const LoopStateCard(
                title: 'No conversations here',
                message: 'Choose another filter or start a new conversation.',
                icon: Icons.chat_bubble_outline_rounded,
              );
            }
            return Column(
              children: <Widget>[
                for (
                  var index = 0;
                  index < visible.length;
                  index++
                ) ...<Widget>[
                  ConversationRow(
                    conversation: visible[index],
                    onTap: () => _openConversation(context, visible[index]),
                  ),
                  if (index != visible.length - 1) const Divider(),
                ],
              ],
            );
          },
          loading: () => const _ConversationLoading(),
          error: (error, stackTrace) => LoopStateCard(
            title: 'Chats are unavailable',
            message: 'Check your connection, then try again.',
            icon: Icons.cloud_off_outlined,
            tone: LoopTone.warning,
            action: OutlinedButton.icon(
              onPressed: () => ref.invalidate(conversationListProvider),
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Try again'),
            ),
          ),
        ),
      ],
    );
  }

  bool _matchesFilter(ConversationSummary conversation) => switch (_filter) {
    _InboxFilter.all => true,
    _InboxFilter.groups =>
      conversation.kind == ConversationKind.group ||
          conversation.kind == ConversationKind.voice,
    _InboxFilter.direct => conversation.kind == ConversationKind.direct,
  };

  static void _openConversation(
    BuildContext context,
    ConversationSummary conversation,
  ) {
    switch (conversation.kind) {
      case ConversationKind.group:
        context.push('/chat/group');
      case ConversationKind.direct:
        context.push('/chat/dm');
      case ConversationKind.voice:
        context.push('/chat/voice');
      case ConversationKind.meeting:
        context.push('/chat/meeting');
    }
  }
}

class _ConversationLoading extends StatelessWidget {
  const _ConversationLoading();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: List<Widget>.generate(3, (index) {
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 9),
          child: Row(
            children: <Widget>[
              const _Skeleton(width: 44, height: 44, radius: 24),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const <Widget>[
                    _Skeleton(width: 138, height: 13),
                    SizedBox(height: 9),
                    _Skeleton(width: double.infinity, height: 10),
                  ],
                ),
              ),
            ],
          ),
        );
      }),
    );
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton({required this.width, required this.height, this.radius = 7});

  final double width;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: LoopColors.elevated,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}
