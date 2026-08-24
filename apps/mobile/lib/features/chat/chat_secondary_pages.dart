import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/chat/chat_content.dart';
import 'package:loop_mobile/features/chat/chat_state.dart';
import 'package:loop_mobile/features/chat/widgets/chat_components.dart';
import 'package:loop_mobile/integrations/communication/communication_gateway.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class GroupInfoPage extends StatefulWidget {
  const GroupInfoPage({super.key});

  @override
  State<GroupInfoPage> createState() => _GroupInfoPageState();
}

class _GroupInfoPageState extends State<GroupInfoPage> {
  var _notifications = true;
  var _mentionsOnly = false;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'Group',
      title: 'Glyph Hunters',
      subtitle: '842 members · 126 online',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/chat/search'),
          tooltip: 'Search group messages',
          icon: const Icon(Icons.search_rounded),
        ),
      ],
      bottom: const ChatMiniVoiceBar(),
      children: <Widget>[
        LoopCard(
          tone: LoopTone.market,
          accent: true,
          child: Column(
            children: <Widget>[
              const ChatAvatar(
                label: 'Glyph Hunters',
                size: 72,
                colorSeed: 2,
                icon: Icons.groups_rounded,
              ),
              const SizedBox(height: 13),
              Text(
                'Glyph Hunters',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 6),
              Text(
                'On-chain research, market structure, and fact-checked small-cap discussion.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 18),
              Row(
                children: <Widget>[
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => context.push('/chat/search'),
                      icon: const Icon(Icons.search_rounded, size: 17),
                      label: const Text('Search'),
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => context.push('/chat/voice'),
                      icon: const Icon(Icons.graphic_eq_rounded, size: 17),
                      label: const Text('Voice room'),
                      style: FilledButton.styleFrom(
                        backgroundColor: LoopColors.chat,
                        foregroundColor: LoopColors.abyss,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Announcement'),
        const LoopStateCard(
          title: 'Research before reaction',
          message:
              'Share sources with contract claims. Flag unlocks, admin controls, and concentrated ownership.',
          icon: Icons.campaign_outlined,
          tone: LoopTone.conversation,
        ),
        const LoopSectionLabel('Preferences'),
        LoopCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: <Widget>[
              Material(
                color: Colors.transparent,
                child: SwitchListTile.adaptive(
                  value: _notifications,
                  onChanged: (value) => setState(() => _notifications = value),
                  title: const Text('Notifications'),
                  subtitle: const Text('New messages and group activity'),
                  secondary: const Icon(Icons.notifications_outlined),
                ),
              ),
              const Divider(),
              Material(
                color: Colors.transparent,
                child: SwitchListTile.adaptive(
                  value: _mentionsOnly,
                  onChanged: _notifications
                      ? (value) => setState(() => _mentionsOnly = value)
                      : null,
                  title: const Text('Mentions only'),
                  subtitle: const Text(
                    'Quiet everything except direct mentions',
                  ),
                  secondary: const Icon(Icons.alternate_email_rounded),
                ),
              ),
            ],
          ),
        ),
        LoopSectionLabel(
          'Recently active',
          trailing: TextButton(
            onPressed: () => _showMemberList(context),
            child: const Text('See more'),
          ),
        ),
        const LoopCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: <Widget>[
              _MemberRow(
                alias: 'NightOwl',
                role: 'Moderator',
                colorSeed: 2,
                online: true,
              ),
              Divider(),
              _MemberRow(
                alias: '0xSable',
                role: 'Member',
                colorSeed: 4,
                online: true,
              ),
              Divider(),
              _MemberRow(
                alias: 'AtlasLoop',
                role: 'Member',
                colorSeed: 3,
                online: true,
              ),
              Divider(),
              _MemberRow(alias: 'Nori', role: 'Member', colorSeed: 6),
            ],
          ),
        ),
        const SizedBox(height: 28),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () => _confirmLeaveGroup(context),
            icon: const Icon(Icons.logout_rounded, color: LoopColors.danger),
            label: const Text('Leave group'),
            style: OutlinedButton.styleFrom(foregroundColor: LoopColors.danger),
          ),
        ),
      ],
    );
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({
    required this.alias,
    required this.role,
    required this.colorSeed,
    this.online = false,
  });

  final String alias;
  final String role;
  final int colorSeed;
  final bool online;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: ChatAvatar(
        label: alias,
        size: 40,
        colorSeed: colorSeed,
        online: online,
      ),
      title: Text(alias),
      subtitle: Text(role),
      trailing: IconButton(
        onPressed: () {},
        tooltip: 'Member options',
        icon: const Icon(Icons.more_horiz_rounded),
      ),
    );
  }
}

class MessageRequestsPage extends ConsumerWidget {
  const MessageRequestsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final requests = ref.watch(messageRequestsProvider);
    return LoopPage(
      eyebrow: 'Inbox',
      title: 'Message requests',
      subtitle: 'People outside your conversations appear here first.',
      children: <Widget>[
        const LoopStateCard(
          title: 'You stay in control',
          message:
              'Accepting a request starts a conversation. Ignoring it does not notify the sender.',
          icon: Icons.mark_email_unread_outlined,
          tone: LoopTone.conversation,
        ),
        const LoopSectionLabel('Pending'),
        requests.when(
          data: (items) {
            if (items.isEmpty) {
              return const LoopStateCard(
                title: 'No pending requests',
                message:
                    'New requests from people you do not know will appear here.',
                icon: Icons.inbox_outlined,
              );
            }
            return Column(
              children: items
                  .map((request) {
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _RequestCard(
                        request: request,
                        onAccept: () => _resolveRequest(
                          context,
                          ref,
                          request,
                          accept: true,
                        ),
                        onIgnore: () => _resolveRequest(
                          context,
                          ref,
                          request,
                          accept: false,
                        ),
                        onReport: () => _reportRequest(context, ref, request),
                      ),
                    );
                  })
                  .toList(growable: false),
            );
          },
          loading: () =>
              const Center(child: CircularProgressIndicator(strokeWidth: 2)),
          error: (error, stackTrace) => LoopStateCard(
            title: 'Requests are unavailable',
            message: 'Check your connection, then try again.',
            icon: Icons.cloud_off_outlined,
            tone: LoopTone.warning,
            action: OutlinedButton.icon(
              onPressed: () => ref.invalidate(messageRequestsProvider),
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Try again'),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _resolveRequest(
    BuildContext context,
    WidgetRef ref,
    MessageRequestSummary request, {
    required bool accept,
  }) async {
    final gateway = ref.read(communicationGatewayProvider);
    final result = accept
        ? await gateway.acceptMessageRequest(request.id)
        : await gateway.ignoreMessageRequest(request.id);
    if (!context.mounted) return;
    if (result.isSuccess) {
      ref.invalidate(messageRequestsProvider);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              accept
                  ? 'Request accepted. You can now reply to ${request.alias}.'
                  : 'Request ignored.',
            ),
          ),
        );
    } else {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('Request not updated. Try again.')),
        );
    }
  }

  Future<void> _reportRequest(
    BuildContext context,
    WidgetRef ref,
    MessageRequestSummary request,
  ) async {
    final reason = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  child: Text(
                    'Report ${request.alias}',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                ),
                for (final reason in <String>[
                  'Spam',
                  'Scam attempt',
                  'Harassment',
                ])
                  ListTile(
                    leading: const Icon(Icons.flag_outlined),
                    title: Text(reason),
                    onTap: () => Navigator.of(sheetContext).pop(reason),
                  ),
              ],
            ),
          ),
        );
      },
    );
    if (reason == null || !context.mounted) return;
    final result = await ref
        .read(communicationGatewayProvider)
        .reportMessageRequest(requestId: request.id, reason: reason);
    if (!context.mounted) return;
    if (result.isSuccess) {
      ref.invalidate(messageRequestsProvider);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(
            content: Text('Report submitted and request removed.'),
          ),
        );
    } else {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('Report not submitted. Try again.')),
        );
    }
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard({
    required this.request,
    required this.onAccept,
    required this.onIgnore,
    required this.onReport,
  });

  final MessageRequestSummary request;
  final VoidCallback onAccept;
  final VoidCallback onIgnore;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      padding: const EdgeInsets.all(15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              ChatAvatar(label: request.alias, colorSeed: request.colorSeed),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            request.alias,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        Text(
                          request.timeLabel,
                          style: Theme.of(context).textTheme.labelMedium,
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      request.sharedContext,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: LoopColors.market,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                onPressed: onReport,
                tooltip: 'Report request',
                icon: const Icon(Icons.flag_outlined, size: 19),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(request.preview, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 14),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  onPressed: onIgnore,
                  child: const Text('Ignore'),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: FilledButton(
                  onPressed: onAccept,
                  child: const Text('Accept'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

enum _SearchFilter { all, groups, direct }

class MessageSearchPage extends ConsumerStatefulWidget {
  const MessageSearchPage({super.key});

  @override
  ConsumerState<MessageSearchPage> createState() => _MessageSearchPageState();
}

class _MessageSearchPageState extends ConsumerState<MessageSearchPage> {
  final _controller = TextEditingController(text: 'unlock');
  var _results = ChatContent.searchResults;
  var _loading = false;
  var _filter = _SearchFilter.all;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _results
        .where((result) {
          return switch (_filter) {
            _SearchFilter.all => true,
            _SearchFilter.groups => result.kind == ConversationKind.group,
            _SearchFilter.direct => result.kind == ConversationKind.direct,
          };
        })
        .toList(growable: false);
    return LoopPage(
      eyebrow: 'Chats',
      title: 'Search messages',
      subtitle: 'Find a source, ticker, address, or earlier conversation.',
      children: <Widget>[
        TextField(
          controller: _controller,
          autofocus: false,
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => _search(),
          decoration: InputDecoration(
            hintText: 'Search messages',
            prefixIcon: const Icon(Icons.search_rounded),
            suffixIcon: _loading
                ? const Padding(
                    padding: EdgeInsets.all(14),
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    onPressed: () {
                      _controller.clear();
                      _search();
                    },
                    tooltip: 'Clear search',
                    icon: const Icon(Icons.close_rounded),
                  ),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: <Widget>[
            ChoiceChip(
              label: const Text('All'),
              selected: _filter == _SearchFilter.all,
              onSelected: (_) => setState(() => _filter = _SearchFilter.all),
            ),
            ChoiceChip(
              label: const Text('Groups'),
              selected: _filter == _SearchFilter.groups,
              onSelected: (_) => setState(() => _filter = _SearchFilter.groups),
            ),
            ChoiceChip(
              label: const Text('Direct'),
              selected: _filter == _SearchFilter.direct,
              onSelected: (_) => setState(() => _filter = _SearchFilter.direct),
            ),
          ],
        ),
        LoopSectionLabel('${filtered.length} results'),
        if (!_loading && filtered.isEmpty)
          const LoopStateCard(
            title: 'No messages found',
            message: 'Try a shorter phrase, ticker, or sender name.',
            icon: Icons.search_off_rounded,
          )
        else
          for (final result in filtered) ...<Widget>[
            _SearchResultCard(result: result),
            const SizedBox(height: 10),
          ],
      ],
    );
  }

  Future<void> _search() async {
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => _loading = true);
    final result = await ref
        .read(communicationGatewayProvider)
        .searchMessages(query: _controller.text);
    if (!mounted) return;
    setState(() {
      _loading = false;
      _results = result.value ?? const <MessageSearchResult>[];
    });
    if (!result.isSuccess) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('Search is unavailable. Try again.')),
        );
    }
  }
}

class _SearchResultCard extends StatelessWidget {
  const _SearchResultCard({required this.result});

  final MessageSearchResult result;

  @override
  Widget build(BuildContext context) {
    final direct = result.kind == ConversationKind.direct;
    return LoopCard(
      onTap: () => context.push(direct ? '/chat/dm' : '/chat/group'),
      semanticLabel: 'Open result from ${result.conversationTitle}',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ChatAvatar(
            label: result.conversationTitle,
            size: 40,
            colorSeed: direct ? 4 : 2,
            icon: direct ? null : Icons.groups_rounded,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        result.conversationTitle,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    Text(
                      result.timeLabel,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  result.senderAlias,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: direct ? LoopColors.chat : LoopColors.market,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  result.snippet,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class MeetingPlaceholderPage extends StatelessWidget {
  const MeetingPlaceholderPage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'Coming later',
      title: 'Meet face to face',
      subtitle:
          'Scheduled video meetings will live alongside your conversations.',
      children: <Widget>[
        const SizedBox(height: 20),
        Center(
          child: Container(
            width: 148,
            height: 148,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: LoopColors.market.withValues(alpha: 0.08),
              border: Border.all(
                color: LoopColors.market.withValues(alpha: 0.28),
              ),
            ),
            child: const Stack(
              alignment: Alignment.center,
              children: <Widget>[
                Icon(
                  Icons.calendar_today_outlined,
                  size: 64,
                  color: LoopColors.market,
                ),
                Positioned(
                  right: 27,
                  bottom: 32,
                  child: CircleAvatar(
                    radius: 18,
                    backgroundColor: LoopColors.elevated,
                    child: Icon(
                      Icons.videocam_rounded,
                      size: 20,
                      color: LoopColors.chat,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 28),
        Text(
          'One place for planned conversations',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 9),
        Text(
          'Create a meeting from a group, invite members, and return to the discussion when it ends.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 26),
        const LoopCard(
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(
                label: 'Scheduled meetings',
                value: 'Coming later',
              ),
              LoopKeyValueRow(label: 'Video calls', value: 'Coming later'),
              LoopKeyValueRow(
                label: 'Calendar reminders',
                value: 'Coming later',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: null,
            icon: const Icon(Icons.notifications_none_rounded),
            label: const Text('Not available yet'),
          ),
        ),
      ],
    );
  }
}

Future<void> _showMemberList(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) {
      return SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.7,
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 14),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        'Recently active members',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.of(sheetContext).pop(),
                      tooltip: 'Close',
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
              const Divider(),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  children: const <Widget>[
                    _MemberRow(
                      alias: 'NightOwl',
                      role: 'Moderator',
                      colorSeed: 2,
                      online: true,
                    ),
                    _MemberRow(
                      alias: '0xSable',
                      role: 'Member',
                      colorSeed: 4,
                      online: true,
                    ),
                    _MemberRow(
                      alias: 'AtlasLoop',
                      role: 'Member',
                      colorSeed: 3,
                      online: true,
                    ),
                    _MemberRow(alias: 'Nori', role: 'Member', colorSeed: 6),
                    _MemberRow(alias: 'Mina.Ξ', role: 'Member', colorSeed: 7),
                    _MemberRow(
                      alias: 'OnchainMia',
                      role: 'Member',
                      colorSeed: 1,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

Future<void> _confirmLeaveGroup(BuildContext context) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return AlertDialog(
        title: const Text('Leave Glyph Hunters?'),
        content: const Text(
          'You will stop receiving messages and must be invited again to return.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Stay'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            style: FilledButton.styleFrom(
              backgroundColor: LoopColors.danger,
              foregroundColor: LoopColors.abyss,
            ),
            child: const Text('Leave'),
          ),
        ],
      );
    },
  );
}
