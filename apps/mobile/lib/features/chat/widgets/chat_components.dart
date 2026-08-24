import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/chat/chat_content.dart';
import 'package:loop_mobile/features/chat/chat_state.dart';
import 'package:loop_mobile/integrations/communication/communication_gateway.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

const _avatarColors = <Color>[
  LoopColors.market,
  LoopColors.chat,
  LoopColors.mint,
  Color(0xFF8D82FF),
  Color(0xFFFF7E9B),
  Color(0xFF57C8D5),
  Color(0xFFB3D66E),
  Color(0xFFB993FF),
];

class ChatAvatar extends StatelessWidget {
  const ChatAvatar({
    required this.label,
    super.key,
    this.size = 44,
    this.colorSeed = 0,
    this.icon,
    this.online = false,
  });

  final String label;
  final double size;
  final int colorSeed;
  final IconData? icon;
  final bool online;

  @override
  Widget build(BuildContext context) {
    final color = _avatarColors[colorSeed.abs() % _avatarColors.length];
    final initials = _initials(label);
    return Semantics(
      image: true,
      label: '$label avatar${online ? ', online' : ''}',
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          children: <Widget>[
            DecoratedBox(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: <Color>[
                    color.withValues(alpha: 0.82),
                    Color.lerp(color, LoopColors.abyss, 0.58)!,
                  ],
                ),
                border: Border.all(color: color.withValues(alpha: 0.5)),
              ),
              child: Center(
                child: icon != null
                    ? Icon(icon, size: size * 0.46, color: LoopColors.chalk)
                    : Text(
                        initials,
                        style: Theme.of(context).textTheme.labelLarge?.copyWith(
                          fontSize: size * 0.28,
                          color: LoopColors.chalk,
                        ),
                      ),
              ),
            ),
            if (online)
              Positioned(
                right: 0,
                bottom: 0,
                child: Container(
                  width: math.max(10, size * 0.24),
                  height: math.max(10, size * 0.24),
                  decoration: BoxDecoration(
                    color: LoopColors.mint,
                    shape: BoxShape.circle,
                    border: Border.all(color: LoopColors.abyss, width: 2),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _initials(String value) {
    final parts = value
        .replaceAll(RegExp(r'[^A-Za-z0-9 ]'), '')
        .trim()
        .split(RegExp(r'\s+'))
        .where((part) => part.isNotEmpty)
        .toList(growable: false);
    if (parts.isEmpty) return '•';
    if (parts.length == 1) {
      return parts.first.characters.take(2).toString().toUpperCase();
    }
    return '${parts.first.characters.first}${parts.last.characters.first}'
        .toUpperCase();
  }
}

class ChatAliasBar extends StatelessWidget {
  const ChatAliasBar({required this.alias, required this.onShuffle, super.key});

  final String alias;
  final VoidCallback onShuffle;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      tone: LoopTone.conversation,
      accent: true,
      padding: const EdgeInsets.fromLTRB(16, 13, 10, 13),
      child: Row(
        children: <Widget>[
          const Icon(Icons.masks_rounded, color: LoopColors.chat, size: 20),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'You appear as',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 2),
                Text(alias, style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
          ),
          IconButton(
            onPressed: onShuffle,
            tooltip: 'Change display alias',
            icon: const Icon(Icons.shuffle_rounded, size: 20),
          ),
        ],
      ),
    );
  }
}

class ConversationRow extends StatelessWidget {
  const ConversationRow({
    required this.conversation,
    required this.onTap,
    super.key,
  });

  final ConversationSummary conversation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final (icon, tone) = switch (conversation.kind) {
      ConversationKind.group => (Icons.groups_rounded, LoopColors.market),
      ConversationKind.direct => (null, LoopColors.chat),
      ConversationKind.voice => (Icons.graphic_eq_rounded, LoopColors.chat),
      ConversationKind.meeting => (Icons.video_call_outlined, LoopColors.vapor),
    };
    return Semantics(
      button: true,
      label: '${conversation.title}, ${conversation.preview}',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: LoopRadius.medium,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              children: <Widget>[
                Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    ChatAvatar(
                      label: conversation.title,
                      colorSeed: conversation.accentSeed,
                      icon: icon,
                      online: conversation.kind == ConversationKind.direct,
                    ),
                    if (conversation.kind == ConversationKind.voice)
                      Positioned(
                        right: -4,
                        bottom: -3,
                        child: Container(
                          width: 19,
                          height: 19,
                          decoration: BoxDecoration(
                            color: LoopColors.basalt,
                            shape: BoxShape.circle,
                            border: Border.all(color: LoopColors.chat),
                          ),
                          child: const Icon(
                            Icons.mic_rounded,
                            size: 11,
                            color: LoopColors.chat,
                          ),
                        ),
                      ),
                  ],
                ),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              conversation.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                          ),
                          Text(
                            conversation.timeLabel,
                            style: Theme.of(context).textTheme.labelMedium
                                ?.copyWith(
                                  color:
                                      conversation.kind ==
                                          ConversationKind.voice
                                      ? LoopColors.chat
                                      : LoopColors.vapor,
                                ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 5),
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              conversation.preview,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ),
                          if (conversation.muted)
                            const Padding(
                              padding: EdgeInsets.only(left: 8),
                              child: Icon(
                                Icons.notifications_off_outlined,
                                size: 15,
                                color: LoopColors.vapor,
                              ),
                            ),
                          if (conversation.unreadCount > 0)
                            Container(
                              constraints: const BoxConstraints(minWidth: 22),
                              margin: const EdgeInsets.only(left: 8),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 3,
                              ),
                              decoration: BoxDecoration(
                                color: tone,
                                borderRadius: LoopRadius.pill,
                              ),
                              child: Text(
                                '${conversation.unreadCount}',
                                textAlign: TextAlign.center,
                                style: Theme.of(context).textTheme.labelMedium
                                    ?.copyWith(
                                      color: LoopColors.abyss,
                                      fontSize: 10,
                                    ),
                              ),
                            ),
                        ],
                      ),
                      if (conversation.memberLabel != null) ...<Widget>[
                        const SizedBox(height: 5),
                        Text(
                          conversation.memberLabel!,
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: tone.withValues(alpha: 0.9)),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class InlineVoiceRoomCard extends ConsumerWidget {
  const InlineVoiceRoomCard({super.key, this.room = ChatContent.voiceRoom});

  final VoiceRoomSummary room;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(voiceSessionControllerProvider);
    final active = session.room?.id == room.id && session.showsMiniBar;
    return LoopCard(
      accent: true,
      tone: LoopTone.conversation,
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.fromLTRB(16, 15, 16, 12),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: <Color>[
                  LoopColors.chat.withValues(alpha: 0.13),
                  LoopColors.basalt.withValues(alpha: 0),
                ],
              ),
            ),
            child: Row(
              children: <Widget>[
                const VoicePulseMark(size: 48),
                const SizedBox(width: 13),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          const LoopStatusPill(
                            label: 'VOICE',
                            tone: LoopTone.conversation,
                            icon: Icons.graphic_eq_rounded,
                          ),
                          if (active) ...<Widget>[
                            const SizedBox(width: 7),
                            VoicePhasePill(phase: session.phase),
                          ],
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        room.title,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        room.topic,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 15),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: 82,
                  height: 32,
                  child: Stack(
                    children: room.participants
                        .take(3)
                        .toList()
                        .asMap()
                        .entries
                        .map((entry) {
                          return Positioned(
                            left: entry.key * 24,
                            child: Container(
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                border: Border.all(
                                  color: LoopColors.basalt,
                                  width: 2,
                                ),
                              ),
                              child: ChatAvatar(
                                label: entry.value.alias,
                                size: 32,
                                colorSeed: entry.value.colorSeed,
                              ),
                            ),
                          );
                        })
                        .toList(growable: false),
                  ),
                ),
                Expanded(
                  child: Text(
                    '${room.speakerCount} speaking · ${room.listenerCount} listening',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ),
                FilledButton.icon(
                  onPressed: () async {
                    if (!active) {
                      await ref
                          .read(voiceSessionControllerProvider.notifier)
                          .join(room);
                    }
                    if (context.mounted) unawaited(context.push('/chat/voice'));
                  },
                  icon: Icon(
                    active ? Icons.open_in_full_rounded : Icons.mic_off_rounded,
                    size: 17,
                  ),
                  label: Text(active ? 'Open' : 'Join muted'),
                  style: FilledButton.styleFrom(
                    backgroundColor: LoopColors.chat,
                    foregroundColor: LoopColors.abyss,
                    minimumSize: const Size(48, 44),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class VoicePulseMark extends StatelessWidget {
  const VoicePulseMark({super.key, this.size = 56, this.active = true});

  final double size;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: active ? 'Voice activity' : 'Voice room',
      child: SizedBox.square(
        dimension: size,
        child: CustomPaint(
          painter: _VoicePulsePainter(
            color: active ? LoopColors.chat : LoopColors.vapor,
          ),
          child: Center(
            child: Icon(
              Icons.graphic_eq_rounded,
              size: size * 0.39,
              color: active ? LoopColors.chat : LoopColors.vapor,
            ),
          ),
        ),
      ),
    );
  }
}

class _VoicePulsePainter extends CustomPainter {
  const _VoicePulsePainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2;
    canvas.drawCircle(
      center,
      radius - 1,
      Paint()
        ..color = color.withValues(alpha: 0.1)
        ..style = PaintingStyle.fill,
    );
    canvas.drawCircle(
      center,
      radius - 2,
      Paint()
        ..color = color.withValues(alpha: 0.52)
        ..strokeWidth = 1.5
        ..style = PaintingStyle.stroke,
    );
    const bars = <double>[0.3, 0.62, 0.42, 0.82, 0.54, 0.7, 0.36, 0.58];
    final paint = Paint()
      ..color = color.withValues(alpha: 0.46)
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round;
    for (var index = 0; index < bars.length; index++) {
      final angle = (math.pi * 2 * index / bars.length) - math.pi / 2;
      final inner = radius - 7;
      final outer = inner + 3 + bars[index] * 4;
      canvas.drawLine(
        center + Offset(math.cos(angle) * inner, math.sin(angle) * inner),
        center + Offset(math.cos(angle) * outer, math.sin(angle) * outer),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _VoicePulsePainter oldDelegate) {
    return oldDelegate.color != color;
  }
}

class VoicePhasePill extends StatelessWidget {
  const VoicePhasePill({required this.phase, super.key});

  final VoiceConnectionPhase phase;

  @override
  Widget build(BuildContext context) {
    final (label, tone, icon) = switch (phase) {
      VoiceConnectionPhase.idle => (
        'Ready',
        LoopTone.neutral,
        Icons.circle_outlined,
      ),
      VoiceConnectionPhase.joining => (
        'Joining',
        LoopTone.warning,
        Icons.sync_rounded,
      ),
      VoiceConnectionPhase.joined => (
        'Joined',
        LoopTone.positive,
        Icons.check_circle_outline,
      ),
      VoiceConnectionPhase.reconnecting => (
        'Reconnecting',
        LoopTone.warning,
        Icons.sync_problem_rounded,
      ),
      VoiceConnectionPhase.error => (
        'Connection issue',
        LoopTone.danger,
        Icons.error_outline,
      ),
    };
    return LoopStatusPill(label: label, tone: tone, icon: icon);
  }
}

class ChatMessageTile extends StatelessWidget {
  const ChatMessageTile({required this.message, super.key, this.colorSeed = 0});

  final ConversationMessage message;
  final int colorSeed;

  @override
  Widget build(BuildContext context) {
    final messageContent = switch (message.kind) {
      MessageKind.token => const TokenMessageCard(),
      MessageKind.assetSnapshot => const AssetSnapshotMessageCard(),
      MessageKind.system => _MessageBubble(message: message),
      MessageKind.text => _MessageBubble(message: message),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        mainAxisAlignment: message.isMine
            ? MainAxisAlignment.end
            : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (!message.isMine) ...<Widget>[
            ChatAvatar(
              label: message.senderAlias,
              size: 34,
              colorSeed: colorSeed,
            ),
            const SizedBox(width: 10),
          ],
          Flexible(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                crossAxisAlignment: message.isMine
                    ? CrossAxisAlignment.end
                    : CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      if (message.isPinned) ...<Widget>[
                        const Icon(
                          Icons.push_pin_outlined,
                          size: 12,
                          color: LoopColors.chat,
                        ),
                        const SizedBox(width: 4),
                      ],
                      Text(
                        message.isMine ? 'You' : message.senderAlias,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: message.isMine
                                  ? LoopColors.mint
                                  : LoopColors.chalk,
                            ),
                      ),
                      const SizedBox(width: 7),
                      Text(
                        message.timeLabel,
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                    ],
                  ),
                  if (message.replyLabel != null) ...<Widget>[
                    const SizedBox(height: 6),
                    Text(
                      message.replyLabel!,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: LoopColors.market,
                      ),
                    ),
                  ],
                  const SizedBox(height: 7),
                  messageContent,
                  if (message.reactions.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 7),
                    Wrap(
                      spacing: 6,
                      children: message.reactions.entries
                          .map((entry) {
                            return Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 5,
                              ),
                              decoration: BoxDecoration(
                                color: LoopColors.elevated,
                                border: Border.all(color: LoopColors.line),
                                borderRadius: LoopRadius.pill,
                              ),
                              child: Text(
                                '${entry.key} ${entry.value}',
                                style: Theme.of(context).textTheme.labelMedium,
                              ),
                            );
                          })
                          .toList(growable: false),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});

  final ConversationMessage message;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: message.isMine
            ? LoopColors.mint.withValues(alpha: 0.12)
            : LoopColors.elevated,
        border: Border.all(
          color: message.isMine
              ? LoopColors.mint.withValues(alpha: 0.25)
              : LoopColors.line,
        ),
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(15),
          topRight: const Radius.circular(15),
          bottomLeft: Radius.circular(message.isMine ? 15 : 4),
          bottomRight: Radius.circular(message.isMine ? 4 : 15),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Text(
          message.text,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontSize: 14),
        ),
      ),
    );
  }
}

class TokenMessageCard extends StatelessWidget {
  const TokenMessageCard({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      tone: LoopTone.warning,
      accent: true,
      padding: const EdgeInsets.all(15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const LoopAssetMark(
                symbol: 'GLYPH',
                size: 42,
                color: LoopColors.warning,
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'GLYPH / USDC',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'Snapshot at share time · 14:07',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(r'$0.0842', style: context.dataStyle),
                  const SizedBox(height: 3),
                  Text(
                    '+8.4% 24h',
                    style: Theme.of(
                      context,
                    ).textTheme.labelMedium?.copyWith(color: LoopColors.mint),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: const <Widget>[
              LoopStatusPill(
                label: 'LP unlocks in 3 days',
                tone: LoopTone.warning,
                icon: Icons.lock_clock_outlined,
              ),
              LoopStatusPill(
                label: 'Top holders 61%',
                tone: LoopTone.warning,
                icon: Icons.pie_chart_outline_rounded,
              ),
              LoopStatusPill(
                label: 'Ownership renounced',
                tone: LoopTone.neutral,
                icon: Icons.verified_user_outlined,
              ),
            ],
          ),
          const SizedBox(height: 13),
          Text(
            'Review the liquidity and holder facts before taking any action.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 13),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => showTokenFactsSheet(context),
                  icon: const Icon(Icons.fact_check_outlined, size: 17),
                  label: const Text('View facts'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 12,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () =>
                      _showNotice(context, 'GLYPH added to your watchlist.'),
                  icon: const Icon(Icons.bookmark_add_outlined, size: 17),
                  label: const Text('Watch'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 12,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class AssetSnapshotMessageCard extends StatelessWidget {
  const AssetSnapshotMessageCard({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      tone: LoopTone.market,
      accent: true,
      padding: const EdgeInsets.all(15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const LoopAssetMark(symbol: 'ETH'),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'ETH position snapshot',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'Shared at 14:12',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              const LoopStatusPill(
                label: 'LONG',
                tone: LoopTone.positive,
                icon: Icons.north_east_rounded,
              ),
            ],
          ),
          const SizedBox(height: 15),
          const Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(label: 'Entry', value: r'$3,428'),
              ),
              Expanded(
                child: LoopMetric(label: 'Size', value: '0.72 ETH'),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'At share',
                  value: '+3.8%',
                  tone: LoopTone.positive,
                ),
              ),
            ],
          ),
          const SizedBox(height: 15),
          const LoopMiniChart(
            points: <double>[42, 43, 42.4, 44, 45.8, 45.1, 47.3, 48.2],
            color: LoopColors.market,
            height: 42,
            semanticLabel: 'ETH position trend at the time it was shared',
          ),
          const SizedBox(height: 13),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  onPressed: () => _showNotice(
                    context,
                    'Opening the market does not copy this position.',
                  ),
                  child: const Text('View market'),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: OutlinedButton(
                  onPressed: () =>
                      _showNotice(context, 'Setup saved for review.'),
                  child: const Text('Save setup'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

Future<void> showTokenFactsSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'GLYPH contract facts',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 7),
              Text(
                'Facts captured with the shared snapshot. Check current data before acting.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 18),
              const LoopCard(
                padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Column(
                  children: <Widget>[
                    LoopKeyValueRow(
                      label: 'Liquidity lock',
                      value: 'Unlocks in 3 days',
                      tone: LoopTone.warning,
                    ),
                    LoopKeyValueRow(
                      label: 'Top 10 holders',
                      value: '61%',
                      tone: LoopTone.warning,
                    ),
                    LoopKeyValueRow(label: 'Owner control', value: 'Renounced'),
                    LoopKeyValueRow(
                      label: 'Transfer restrictions',
                      value: 'None found',
                    ),
                    LoopKeyValueRow(
                      label: 'Checked',
                      value: '14:06 UTC',
                      last: true,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.of(sheetContext).pop(),
                  child: const Text('Done'),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class ChatComposer extends StatefulWidget {
  const ChatComposer({
    required this.onSend,
    super.key,
    this.hintText = 'Message',
    this.enabled = true,
  });

  final Future<void> Function(String text) onSend;
  final String hintText;
  final bool enabled;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _controller = TextEditingController();
  var _sending = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending || !widget.enabled) return;
    setState(() => _sending = true);
    try {
      await widget.onSend(text);
      _controller.clear();
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return LoopActionDock(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          IconButton(
            onPressed: widget.enabled
                ? () =>
                      _showNotice(context, 'Attachments are not available yet.')
                : null,
            tooltip: 'Add attachment',
            icon: const Icon(Icons.add_circle_outline_rounded),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: TextField(
              controller: _controller,
              enabled: widget.enabled,
              minLines: 1,
              maxLines: 5,
              textCapitalization: TextCapitalization.sentences,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(
                hintText: widget.enabled
                    ? widget.hintText
                    : 'Messages are unavailable',
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
              ),
            ),
          ),
          const SizedBox(width: 7),
          IconButton.filled(
            onPressed: widget.enabled && !_sending ? _send : null,
            tooltip: 'Send message',
            icon: _sending
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.arrow_upward_rounded),
          ),
        ],
      ),
    );
  }
}

class ChatMiniVoiceBar extends ConsumerWidget {
  const ChatMiniVoiceBar({super.key, this.onOpen});

  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(voiceSessionControllerProvider);
    final room = session.room;
    if (!session.showsMiniBar || room == null) return const SizedBox.shrink();
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Material(
        color: LoopColors.elevated,
        elevation: 12,
        shadowColor: Colors.black.withValues(alpha: 0.5),
        shape: const RoundedRectangleBorder(
          borderRadius: LoopRadius.medium,
          side: BorderSide(color: LoopColors.line),
        ),
        child: InkWell(
          onTap: onOpen ?? () => context.push('/chat/voice'),
          borderRadius: LoopRadius.medium,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 7, 8),
            child: Row(
              children: <Widget>[
                VoicePulseMark(
                  size: 38,
                  active: session.phase == VoiceConnectionPhase.joined,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        room.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _phaseDescription(session),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(
                              color: session.phase == VoiceConnectionPhase.error
                                  ? LoopColors.danger
                                  : LoopColors.chat,
                            ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: session.phase == VoiceConnectionPhase.joined
                      ? () => ref
                            .read(voiceSessionControllerProvider.notifier)
                            .toggleMicrophone()
                      : null,
                  tooltip: session.microphoneMuted
                      ? 'Unmute microphone'
                      : 'Mute microphone',
                  icon: Icon(
                    session.microphoneMuted
                        ? Icons.mic_off_rounded
                        : Icons.mic_rounded,
                    color: session.microphoneMuted
                        ? LoopColors.vapor
                        : LoopColors.mint,
                  ),
                ),
                IconButton(
                  onPressed: () =>
                      ref.read(voiceSessionControllerProvider.notifier).leave(),
                  tooltip: 'Leave voice room',
                  icon: const Icon(
                    Icons.call_end_rounded,
                    color: LoopColors.danger,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _phaseDescription(VoiceSessionState session) =>
      switch (session.phase) {
        VoiceConnectionPhase.idle => 'Ready',
        VoiceConnectionPhase.joining => 'Joining with microphone muted',
        VoiceConnectionPhase.joined =>
          session.microphoneMuted
              ? 'Listening · microphone muted'
              : 'Microphone on',
        VoiceConnectionPhase.reconnecting => 'Reconnecting · microphone muted',
        VoiceConnectionPhase.error => 'Connection interrupted · tap to retry',
      };
}

void _showNotice(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
