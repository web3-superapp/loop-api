import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/market/market_models.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

/// C5 — Holder concentration and labelled wallet groups.
class HolderDistributionScreen extends StatelessWidget {
  const HolderDistributionScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = MarketSnapshotState.preview,
  });

  final String symbol;
  final MarketSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final asset = MarketPreviewData.asset(symbol);
    final canShowData = snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C5 · ${asset.symbol} ownership',
      title: 'Holder distribution',
      subtitle:
          'See concentration and known wallet groups without turning incomplete labels into conclusions.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/market/trades', extra: asset.symbol),
          tooltip: 'Open trading activity',
          icon: const Icon(Icons.swap_vert_rounded),
        ),
      ],
      children: <Widget>[
        _MarketPreviewBanner(state: snapshotState),
        if (!canShowData) ...<Widget>[
          const SizedBox(height: 18),
          _MarketSecondaryState(state: snapshotState, subject: 'holder data'),
        ] else ...<Widget>[
          const SizedBox(height: 20),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final compact = constraints.maxWidth < 330;
                final chart = const _DistributionRing();
                final summary = Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Top 100 overview',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 13),
                    const _DistributionLegend(
                      color: LoopColors.market,
                      label: 'Top 10 wallets',
                      value: '37.4%',
                    ),
                    const SizedBox(height: 9),
                    const _DistributionLegend(
                      color: LoopColors.mint,
                      label: 'Wallets 11–100',
                      value: '28.1%',
                    ),
                    const SizedBox(height: 9),
                    const _DistributionLegend(
                      color: LoopColors.vapor,
                      label: 'Other holders',
                      value: '34.5%',
                    ),
                  ],
                );
                if (compact) {
                  return Column(
                    children: <Widget>[
                      chart,
                      const SizedBox(height: 18),
                      summary,
                    ],
                  );
                }
                return Row(
                  children: <Widget>[
                    chart,
                    const SizedBox(width: 22),
                    Expanded(child: summary),
                  ],
                );
              },
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'Sample data · labels may be incomplete · updated 08:42 UTC',
            style: Theme.of(context).textTheme.labelMedium,
          ),
          const LoopSectionLabel('Known wallet groups'),
          const _HolderGroupCard(
            icon: Icons.account_balance_outlined,
            title: 'Exchange-labelled wallets',
            detail: '6 wallets · 18.2% of sampled supply',
            color: LoopColors.market,
          ),
          const SizedBox(height: 10),
          const _HolderGroupCard(
            icon: Icons.groups_2_outlined,
            title: 'Related wallet cluster',
            detail: '12 wallets · 7.8% · relationship not verified',
            color: LoopColors.warning,
          ),
          const SizedBox(height: 10),
          const _HolderGroupCard(
            icon: Icons.help_outline_rounded,
            title: 'Unlabelled large wallets',
            detail: '9 wallets · 11.4% · owner unknown',
            color: LoopColors.vapor,
          ),
          const LoopSectionLabel('Largest sampled wallets'),
          const LoopCard(
            child: Column(
              children: <Widget>[
                _HolderRow(
                  rank: '01',
                  address: '0x71…E20A',
                  share: '8.42%',
                  label: 'Exchange',
                ),
                _HolderRow(
                  rank: '02',
                  address: '0xA8…19F2',
                  share: '6.18%',
                  label: 'Unlabelled',
                ),
                _HolderRow(
                  rank: '03',
                  address: '0x34…C810',
                  share: '4.77%',
                  label: 'Treasury',
                ),
                _HolderRow(
                  rank: '04',
                  address: '0xF2…08B1',
                  share: '3.26%',
                  label: 'Unlabelled',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const LoopStateCard(
            title: 'Concentration is a fact, not a verdict',
            message:
                'Wallet labels can be missing or wrong. Review transfers and ownership controls before acting.',
            icon: Icons.info_outline_rounded,
            tone: LoopTone.warning,
          ),
        ],
      ],
    );
  }
}

class _DistributionRing extends StatelessWidget {
  const _DistributionRing();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'Sample holder distribution. Top ten wallets hold 37.4 percent.',
      child: SizedBox.square(
        dimension: 142,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            const Positioned.fill(
              child: CustomPaint(painter: _DistributionPainter()),
            ),
            Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text('37.4%', style: context.dataStyle.copyWith(fontSize: 20)),
                Text('TOP 10', style: Theme.of(context).textTheme.labelMedium),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _DistributionPainter extends CustomPainter {
  const _DistributionPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 15
      ..strokeCap = StrokeCap.butt;
    const gap = 0.035;
    var start = -math.pi / 2;
    for (final segment in const <(double, Color)>[
      (0.374, LoopColors.market),
      (0.281, LoopColors.mint),
      (0.345, LoopColors.vapor),
    ]) {
      final sweep = math.pi * 2 * segment.$1;
      paint.color = segment.$2;
      canvas.drawArc(
        rect.deflate(12),
        start + gap,
        sweep - gap * 2,
        false,
        paint,
      );
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DistributionPainter oldDelegate) => false;
}

class _DistributionLegend extends StatelessWidget {
  const _DistributionLegend({
    required this.color,
    required this.label,
    required this.value,
  });

  final Color color;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(shape: BoxShape.circle, color: color),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
        ),
        Text(value, style: context.dataStyle.copyWith(fontSize: 12)),
      ],
    );
  }
}

class _HolderGroupCard extends StatelessWidget {
  const _HolderGroupCard({
    required this.icon,
    required this.title,
    required this.detail,
    required this.color,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Row(
        children: <Widget>[
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: LoopRadius.small,
            ),
            child: Icon(icon, color: color, size: 21),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(detail, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HolderRow extends StatelessWidget {
  const _HolderRow({
    required this.rank,
    required this.address,
    required this.share,
    required this.label,
    this.last = false,
  });

  final String rank;
  final String address;
  final String share;
  final String label;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 30,
            child: Text(
              rank,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(address, style: context.dataStyle.copyWith(fontSize: 12)),
                const SizedBox(height: 3),
                Text(label, style: Theme.of(context).textTheme.labelMedium),
              ],
            ),
          ),
          Text(share, style: context.dataStyle),
        ],
      ),
    );
  }
}

/// C6 — Read-only recent trading activity.
class TradingActivityScreen extends StatefulWidget {
  const TradingActivityScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = MarketSnapshotState.preview,
  });

  final String symbol;
  final MarketSnapshotState snapshotState;

  @override
  State<TradingActivityScreen> createState() => _TradingActivityScreenState();
}

class _TradingActivityScreenState extends State<TradingActivityScreen> {
  String _filter = 'All';

  @override
  Widget build(BuildContext context) {
    final asset = MarketPreviewData.asset(widget.symbol);
    final canShowData = widget.snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C6 · ${asset.symbol} activity',
      title: 'Trading activity',
      subtitle:
          'A sample stream of recent buys and sells, with larger trades called out plainly.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/market/holders', extra: asset.symbol),
          tooltip: 'Open holder distribution',
          icon: const Icon(Icons.donut_large_rounded),
        ),
      ],
      children: <Widget>[
        _MarketPreviewBanner(state: widget.snapshotState),
        if (!canShowData) ...<Widget>[
          const SizedBox(height: 18),
          _MarketSecondaryState(
            state: widget.snapshotState,
            subject: 'trading activity',
          ),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            child: const Row(
              children: <Widget>[
                Expanded(
                  child: LoopMetric(label: 'Sample volume', value: '\$4.82M'),
                ),
                Expanded(
                  child: LoopMetric(
                    label: 'Buy share',
                    value: '54.8%',
                    tone: LoopTone.positive,
                  ),
                ),
                Expanded(
                  child: LoopMetric(label: 'Large trades', value: '7'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children:
                  <String>['All', 'Buys', 'Sells', 'Large', 'Tracked wallets']
                      .map(
                        (filter) => Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: ChoiceChip(
                            label: Text(filter),
                            selected: _filter == filter,
                            onSelected: (_) => setState(() => _filter = filter),
                          ),
                        ),
                      )
                      .toList(growable: false),
            ),
          ),
          LoopSectionLabel(
            'Recent sample',
            trailing: Text(
              _filter,
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ),
          const LoopCard(
            child: Column(
              children: <Widget>[
                _TradeRow(
                  time: '08:42:12',
                  side: 'BUY',
                  price: '4,638.20',
                  size: '42.8 ETH',
                  value: '\$198.5K',
                  note: 'Large trade',
                ),
                _TradeRow(
                  time: '08:41:58',
                  side: 'SELL',
                  price: '4,637.80',
                  size: '3.12 ETH',
                  value: '\$14.4K',
                ),
                _TradeRow(
                  time: '08:41:34',
                  side: 'BUY',
                  price: '4,636.90',
                  size: '18.4 ETH',
                  value: '\$85.3K',
                  note: 'Tracked wallet',
                ),
                _TradeRow(
                  time: '08:40:51',
                  side: 'SELL',
                  price: '4,635.10',
                  size: '7.06 ETH',
                  value: '\$32.7K',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const LoopStateCard(
            title: 'Recent activity is not direction',
            message:
                'A labelled wallet or large trade can buy, sell, hedge, or transfer for many reasons.',
            icon: Icons.info_outline_rounded,
            tone: LoopTone.warning,
          ),
        ],
      ],
    );
  }
}

class _TradeRow extends StatelessWidget {
  const _TradeRow({
    required this.time,
    required this.side,
    required this.price,
    required this.size,
    required this.value,
    this.note,
    this.last = false,
  });

  final String time;
  final String side;
  final String price;
  final String size;
  final String value;
  final String? note;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final isBuy = side == 'BUY';
    final color = isBuy ? LoopColors.mint : LoopColors.danger;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 58,
            child: Text(
              time,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
            ),
          ),
          Container(
            width: 4,
            height: 34,
            decoration: BoxDecoration(
              color: color,
              borderRadius: LoopRadius.pill,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      side,
                      style: Theme.of(
                        context,
                      ).textTheme.labelMedium?.copyWith(color: color),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      price,
                      style: context.dataStyle.copyWith(fontSize: 12),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  '$size · $value',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ],
            ),
          ),
          if (note != null)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 92),
              child: Text(
                note!,
                textAlign: TextAlign.right,
                style: Theme.of(
                  context,
                ).textTheme.labelMedium?.copyWith(color: LoopColors.chat),
              ),
            ),
        ],
      ),
    );
  }
}

/// C7 — Read-only watchlist organization preview.
class WatchlistEditorScreen extends StatelessWidget {
  const WatchlistEditorScreen({
    super.key,
    this.snapshotState = MarketSnapshotState.preview,
  });

  final MarketSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final canShowData = snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C7 · Personal list',
      title: 'Watchlist',
      subtitle:
          'Review grouping and order. Saving, removing, and bulk import stay unavailable in this preview.',
      actions: <Widget>[
        IconButton(
          onPressed: null,
          tooltip: 'Adding assets is unavailable in preview',
          icon: const Icon(Icons.add_rounded),
        ),
      ],
      children: <Widget>[
        _MarketPreviewBanner(state: snapshotState),
        if (!canShowData) ...<Widget>[
          const SizedBox(height: 18),
          _MarketSecondaryState(state: snapshotState, subject: 'watchlist'),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          Row(
            children: <Widget>[
              const LoopStatusPill(label: '3 ASSETS', tone: LoopTone.market),
              const Spacer(),
              Text(
                'Drag order locked',
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ],
          ),
          const LoopSectionLabel('Core'),
          for (
            var index = 0;
            index < MarketPreviewData.coreAssets.length;
            index++
          ) ...<Widget>[
            _WatchlistRow(
              asset: MarketPreviewData.coreAssets[index],
              index: index + 1,
            ),
            if (index != MarketPreviewData.coreAssets.length - 1)
              const SizedBox(height: 9),
          ],
          const LoopSectionLabel('List controls'),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: null,
                  icon: const Icon(Icons.create_new_folder_outlined),
                  label: const Text('New group'),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: null,
                  icon: const Icon(Icons.upload_file_outlined),
                  label: const Text('Bulk import'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.lock_outline_rounded),
            label: const Text('Save order unavailable'),
          ),
          const SizedBox(height: 12),
          const LoopStateCard(
            title: 'Changes are not saved',
            message:
                'This sample watchlist does not update your account or notifications.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.warning,
          ),
        ],
      ],
    );
  }
}

class _WatchlistRow extends StatelessWidget {
  const _WatchlistRow({required this.asset, required this.index});

  final MarketAssetPreview asset;
  final int index;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Row(
        children: <Widget>[
          Text(
            index.toString().padLeft(2, '0'),
            style: Theme.of(context).textTheme.labelMedium,
          ),
          const SizedBox(width: 9),
          const Icon(Icons.drag_indicator_rounded, color: LoopColors.vapor),
          const SizedBox(width: 9),
          LoopAssetMark(symbol: asset.symbol, size: 38),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  asset.symbol,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 3),
                Text(
                  asset.name,
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text(
                asset.price,
                style: context.dataStyle.copyWith(fontSize: 12),
              ),
              const SizedBox(height: 4),
              Text(
                asset.change,
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ],
          ),
          IconButton(
            onPressed: null,
            tooltip: 'Removing is unavailable in preview',
            icon: const Icon(Icons.remove_circle_outline_rounded, size: 19),
          ),
        ],
      ),
    );
  }
}

/// C9 — Read-only alert list and notification state.
class PriceAlertsScreen extends StatelessWidget {
  const PriceAlertsScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = MarketSnapshotState.preview,
  });

  final String symbol;
  final MarketSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final asset = MarketPreviewData.asset(symbol);
    final canShowData = snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C9 · Notifications',
      title: 'Price alerts',
      subtitle:
          'Review how thresholds and trigger history will read. Alert changes remain off.',
      actions: <Widget>[
        IconButton(
          onPressed: null,
          tooltip: 'Creating alerts is unavailable in preview',
          icon: const Icon(Icons.add_alert_outlined),
        ),
      ],
      children: <Widget>[
        _MarketPreviewBanner(state: snapshotState),
        if (!canShowData) ...<Widget>[
          const SizedBox(height: 18),
          _MarketSecondaryState(state: snapshotState, subject: 'price alerts'),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          const LoopStateCard(
            title: 'Notifications are off',
            message:
                'Allow notifications in system settings before expecting price or liquidation reminders.',
            icon: Icons.notifications_off_outlined,
            tone: LoopTone.warning,
          ),
          const LoopSectionLabel(
            'Alert examples',
            trailing: LoopStatusPill(
              label: '2 READ-ONLY',
              tone: LoopTone.market,
            ),
          ),
          _AlertCard(
            symbol: asset.symbol,
            condition: 'Price rises above',
            target: asset.symbol == 'ETH' ? '\$4,800.00' : asset.price,
            repeat: 'Once',
          ),
          const SizedBox(height: 10),
          _AlertCard(
            symbol: 'BTC',
            condition: '24h move exceeds',
            target: '±5.00%',
            repeat: 'Every 24 hours',
          ),
          const LoopSectionLabel('Trigger history'),
          const LoopCard(
            child: Column(
              children: <Widget>[
                _AlertHistoryRow(
                  symbol: 'SOL',
                  detail: 'Crossed \$220.00',
                  time: '23 Aug · 18:20',
                ),
                _AlertHistoryRow(
                  symbol: 'ETH',
                  detail: 'Moved +4.0% in 24h',
                  time: '21 Aug · 09:11',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.lock_outline_rounded),
            label: const Text('Create alert unavailable'),
          ),
        ],
      ],
    );
  }
}

class _AlertCard extends StatelessWidget {
  const _AlertCard({
    required this.symbol,
    required this.condition,
    required this.target,
    required this.repeat,
  });

  final String symbol;
  final String condition;
  final String target;
  final String repeat;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: symbol, size: 38),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      symbol,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      condition,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              Text(target, style: context.dataStyle),
            ],
          ),
          const SizedBox(height: 13),
          const Divider(),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  repeat,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
              Switch(value: false, onChanged: null),
              IconButton(
                onPressed: null,
                tooltip: 'Alert editing is unavailable in preview',
                icon: const Icon(Icons.more_horiz_rounded),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AlertHistoryRow extends StatelessWidget {
  const _AlertHistoryRow({
    required this.symbol,
    required this.detail,
    required this.time,
    this.last = false,
  });

  final String symbol;
  final String detail;
  final String time;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        children: <Widget>[
          LoopAssetMark(symbol: symbol, size: 34),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(detail, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(time, style: Theme.of(context).textTheme.labelMedium),
              ],
            ),
          ),
          const LoopStatusPill(label: 'SAMPLE', tone: LoopTone.neutral),
        ],
      ),
    );
  }
}

/// C11 — Followed-wallet activity without investment recommendations.
class SmartMoneyScreen extends StatefulWidget {
  const SmartMoneyScreen({
    super.key,
    this.snapshotState = MarketSnapshotState.preview,
  });

  final MarketSnapshotState snapshotState;

  @override
  State<SmartMoneyScreen> createState() => _SmartMoneyScreenState();
}

class _SmartMoneyScreenState extends State<SmartMoneyScreen> {
  String _filter = 'All activity';

  @override
  Widget build(BuildContext context) {
    final canShowData = widget.snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C11 · Followed wallets',
      title: 'Wallet activity',
      subtitle:
          'Track public wallet movements as facts. A profitable history does not make the next move reliable.',
      actions: <Widget>[
        IconButton(
          onPressed: null,
          tooltip: 'Following wallets is unavailable in preview',
          icon: const Icon(Icons.person_add_alt_1_outlined),
        ),
      ],
      children: <Widget>[
        _MarketPreviewBanner(state: widget.snapshotState),
        if (!canShowData) ...<Widget>[
          const SizedBox(height: 18),
          _MarketSecondaryState(
            state: widget.snapshotState,
            subject: 'wallet activity',
          ),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          const LoopStateCard(
            title: 'Public activity, incomplete context',
            message:
                'Wallet transfers can be hedges, custody moves, or internal routing. Nothing here is a recommendation.',
            icon: Icons.visibility_outlined,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 16),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: <String>['All activity', 'Buys', 'Sells', 'Transfers']
                  .map(
                    (filter) => Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(filter),
                        selected: _filter == filter,
                        onSelected: (_) => setState(() => _filter = filter),
                      ),
                    ),
                  )
                  .toList(growable: false),
            ),
          ),
          LoopSectionLabel(
            'Recent sample',
            trailing: Text(
              _filter,
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ),
          _WalletActivityCard(
            alias: 'Atlas 07',
            address: '0x71…E20A',
            action: 'Bought 18.4 ETH',
            detail: '\$85.3K · average \$4,636.90',
            time: '2 min ago',
            symbol: 'ETH',
            tone: LoopTone.positive,
            onOpen: () => context.push('/market/token', extra: 'ETH'),
          ),
          const SizedBox(height: 10),
          _WalletActivityCard(
            alias: 'Northstar',
            address: '0xA8…19F2',
            action: 'Sent 42.0 BTC',
            detail: 'Destination label unavailable',
            time: '18 min ago',
            symbol: 'BTC',
            tone: LoopTone.warning,
            onOpen: () => context.push('/market/token', extra: 'BTC'),
          ),
          const SizedBox(height: 10),
          _WalletActivityCard(
            alias: 'Cedar 12',
            address: '0x34…C810',
            action: 'Sold 820 SOL',
            detail: '\$179.2K · average \$218.54',
            time: '41 min ago',
            symbol: 'SOL',
            tone: LoopTone.danger,
            onOpen: () => context.push('/market/token', extra: 'SOL'),
          ),
          const LoopSectionLabel('Following'),
          const LoopCard(
            child: Row(
              children: <Widget>[
                Expanded(
                  child: LoopMetric(label: 'Wallets', value: '3 sample'),
                ),
                Expanded(
                  child: LoopMetric(label: 'Alerts', value: 'Off'),
                ),
                Expanded(
                  child: LoopMetric(
                    label: 'Labels checked',
                    value: '08:42 UTC',
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.lock_outline_rounded),
            label: const Text('Follow wallet unavailable'),
          ),
        ],
      ],
    );
  }
}

class _WalletActivityCard extends StatelessWidget {
  const _WalletActivityCard({
    required this.alias,
    required this.address,
    required this.action,
    required this.detail,
    required this.time,
    required this.symbol,
    required this.tone,
    required this.onOpen,
  });

  final String alias;
  final String address;
  final String action;
  final String detail;
  final String time;
  final String symbol;
  final LoopTone tone;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: tone,
      onTap: onOpen,
      semanticLabel: 'Open $symbol after reviewing $alias activity',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: loopToneColor(tone).withValues(alpha: 0.1),
                  shape: BoxShape.circle,
                ),
                child: Text(
                  alias.characters.first,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(alias, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 3),
                    Text(
                      address,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                ),
              ),
              Text(time, style: Theme.of(context).textTheme.labelMedium),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: symbol, size: 36),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      action,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(detail, style: Theme.of(context).textTheme.bodyMedium),
                  ],
                ),
              ),
              const Icon(Icons.arrow_forward_rounded, size: 19),
            ],
          ),
        ],
      ),
    );
  }
}

class _MarketPreviewBanner extends StatelessWidget {
  const _MarketPreviewBanner({required this.state});

  final MarketSnapshotState state;

  @override
  Widget build(BuildContext context) {
    final descriptor = switch (state) {
      MarketSnapshotState.preview => (
        'SAMPLE DATA · READ-ONLY',
        'Updated 08:42 UTC · actions are off',
        LoopTone.market,
        Icons.visibility_outlined,
      ),
      MarketSnapshotState.loading => (
        'LOADING',
        'Waiting for current market information',
        LoopTone.neutral,
        Icons.sync_rounded,
      ),
      MarketSnapshotState.offline => (
        'OFFLINE',
        'Values stay hidden while there is no connection',
        LoopTone.warning,
        Icons.cloud_off_outlined,
      ),
      MarketSnapshotState.stale => (
        'UPDATE NEEDED',
        'Old values were cleared',
        LoopTone.warning,
        Icons.history_toggle_off_rounded,
      ),
      MarketSnapshotState.empty => (
        'NOTHING HERE YET',
        'No matching information is available',
        LoopTone.neutral,
        Icons.inbox_outlined,
      ),
      MarketSnapshotState.regionBlocked => (
        'UNAVAILABLE IN THIS REGION',
        'Market information and actions are off',
        LoopTone.danger,
        Icons.public_off_outlined,
      ),
    };
    final color = loopToneColor(descriptor.$3);
    return Semantics(
      liveRegion: state != MarketSnapshotState.preview,
      label: '${descriptor.$1}. ${descriptor.$2}',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.075),
          borderRadius: LoopRadius.small,
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: <Widget>[
            Icon(descriptor.$4, size: 17, color: color),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    descriptor.$1,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: color,
                      letterSpacing: 0.75,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    descriptor.$2,
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MarketSecondaryState extends StatelessWidget {
  const _MarketSecondaryState({required this.state, required this.subject});

  final MarketSnapshotState state;
  final String subject;

  @override
  Widget build(BuildContext context) {
    if (state == MarketSnapshotState.loading) {
      return LoopStateCard(
        title: 'Loading $subject',
        message: 'Current information will appear here when it is ready.',
        icon: Icons.sync_rounded,
      );
    }
    final descriptor = switch (state) {
      MarketSnapshotState.offline => (
        'No connection',
        'Reconnect to view current $subject. Old values are not shown.',
        Icons.cloud_off_outlined,
        LoopTone.warning,
      ),
      MarketSnapshotState.stale => (
        'Information needs an update',
        'The previous $subject is too old to display. Refresh before relying on it.',
        Icons.history_toggle_off_rounded,
        LoopTone.warning,
      ),
      MarketSnapshotState.empty => (
        'Nothing here yet',
        'There is no $subject for this view. Try another asset or return later.',
        Icons.inbox_outlined,
        LoopTone.neutral,
      ),
      MarketSnapshotState.regionBlocked => (
        'Unavailable in this region',
        '$subject and related actions are not available from your location.',
        Icons.public_off_outlined,
        LoopTone.danger,
      ),
      _ => (
        'Read-only sample',
        'No account changes can be made here.',
        Icons.visibility_outlined,
        LoopTone.market,
      ),
    };
    return LoopStateCard(
      title: descriptor.$1,
      message: descriptor.$2,
      icon: descriptor.$3,
      tone: descriptor.$4,
    );
  }
}
