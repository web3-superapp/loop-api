import 'package:flutter/material.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/chat/widgets/chat_components.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class TokenCardPreviewPage extends StatelessWidget {
  const TokenCardPreviewPage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'Shared in chat',
      title: 'Token context',
      subtitle:
          'A token mention keeps its price snapshot and contract facts together.',
      children: <Widget>[
        const LoopContextRail(stage: LoopStage.discuss),
        const SizedBox(height: 20),
        const TokenMessageCard(),
        const LoopSectionLabel('Reading the card'),
        const LoopCard(
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Price', value: 'Captured when shared'),
              LoopKeyValueRow(label: 'Contract facts', value: 'Time-stamped'),
              LoopKeyValueRow(
                label: 'Critical conditions',
                value: 'Action limited',
                tone: LoopTone.warning,
              ),
              LoopKeyValueRow(
                label: 'Next step',
                value: 'Review or watch',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'Shared context is not a recommendation',
          message:
              'Prices and contract conditions can change after a message is sent. Check current facts before acting.',
          icon: Icons.schedule_rounded,
          tone: LoopTone.conversation,
        ),
      ],
    );
  }
}

class ContractFactsPreviewPage extends StatelessWidget {
  const ContractFactsPreviewPage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'GLYPH / USDC',
      title: 'Contract facts',
      subtitle:
          'Preview facts · observed at 14:06 UTC · shared from Glyph Hunters',
      children: <Widget>[
        const LoopStatusPill(
          label: 'PREVIEW DATA',
          tone: LoopTone.conversation,
          icon: Icons.visibility_outlined,
        ),
        const SizedBox(height: 14),
        LoopCard(
          accent: true,
          tone: LoopTone.warning,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const LoopAssetMark(
                symbol: 'GLYPH',
                size: 48,
                color: LoopColors.warning,
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Review before acting',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 5),
                    Text(
                      'A near-term liquidity unlock and concentrated ownership need closer review.',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Ownership and liquidity'),
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
                last: true,
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Contract'),
        LoopCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '0x71e4…9a2c',
                style: context.dataStyle.copyWith(
                  color: LoopColors.chalk,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 7),
              Text(
                'Ethereum · verified source code',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 14),
              Row(
                children: <Widget>[
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () =>
                          _showNotice(context, 'Contract address copied.'),
                      icon: const Icon(Icons.copy_rounded, size: 17),
                      label: const Text('Copy address'),
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _showNotice(
                        context,
                        'Explorer links open outside LOOP.',
                      ),
                      icon: const Icon(Icons.open_in_new_rounded, size: 17),
                      label: const Text('Explorer'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
            onPressed: () =>
                _showNotice(context, 'GLYPH added to your watchlist.'),
            icon: const Icon(Icons.bookmark_add_outlined),
            label: const Text('Add to watchlist'),
          ),
        ),
      ],
    );
  }
}

class AssetMessagePreviewPage extends StatelessWidget {
  const AssetMessagePreviewPage({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'Shared in chat',
      title: 'Position snapshot',
      subtitle: 'A compact view of a position at the moment someone shares it.',
      children: <Widget>[
        const LoopContextRail(stage: LoopStage.discuss),
        const SizedBox(height: 20),
        const AssetSnapshotMessageCard(),
        const LoopSectionLabel('Snapshot boundaries'),
        const LoopStateCard(
          title: 'The position does not update after sharing',
          message:
              'Entry, size, and return reflect the time on the card. Opening the market does not copy the position.',
          icon: Icons.camera_alt_outlined,
          tone: LoopTone.market,
        ),
        const SizedBox(height: 12),
        const LoopCard(
          padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Direction', value: 'Long'),
              LoopKeyValueRow(label: 'Entry', value: r'$3,428'),
              LoopKeyValueRow(label: 'Size', value: '0.72 ETH'),
              LoopKeyValueRow(
                label: 'Return when shared',
                value: '+3.8%',
                tone: LoopTone.positive,
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

void _showNotice(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
