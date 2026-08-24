import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/perp/perp_models.dart';
import 'package:loop_mobile/features/perp/perp_widgets.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

/// D4 — Current position projection.
class PerpPositionsScreen extends StatelessWidget {
  const PerpPositionsScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D4 · Provider positions',
      title: 'Positions',
      subtitle:
          'PnL and liquidation values render only from a fresh, correlated Hyperliquid snapshot.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/perp/orders'),
          tooltip: 'Open orders',
          icon: const Icon(Icons.receipt_long_outlined),
        ),
      ],
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        const SizedBox(height: 15),
        const PerpQuickRoutes(),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const LoopSectionLabel(
            'Open positions',
            trailing: LoopStatusPill(
              label: '1 preview',
              tone: LoopTone.positive,
            ),
          ),
          _PositionCard(
            position: PerpPreviewData.ethPosition,
            onTap: () => context.push('/perp/position'),
          ),
          const LoopSectionLabel('Portfolio risk'),
          LoopCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      'Margin usage',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const Spacer(),
                    Text(
                      '32.4%',
                      style: context.dataStyle.copyWith(
                        color: LoopColors.warning,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: LoopRadius.pill,
                  child: const LinearProgressIndicator(
                    value: 0.324,
                    minHeight: 8,
                    color: LoopColors.warning,
                    backgroundColor: LoopColors.elevated,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  'Simulated portfolio ratio · not a live liquidation warning',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'Close and reduce actions are disabled. Open the position to inspect management controls and their execution boundary.',
          ),
        ],
      ],
    );
  }
}

class _PositionCard extends StatelessWidget {
  const _PositionCard({required this.position, required this.onTap});

  final PerpPositionPreview position;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.positive,
      onTap: onTap,
      semanticLabel: 'Open ${position.symbol} preview position details',
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: position.symbol),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '${position.symbol}-PERP',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${position.side} · ${position.leverage} · isolated',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(
                    position.pnl,
                    style: context.dataStyle.copyWith(color: LoopColors.mint),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '+17.28% preview',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 15),
          Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(label: 'Size', value: position.size),
              ),
              Expanded(
                child: LoopMetric(label: 'Entry', value: position.entry),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'Liq. estimate',
                  value: position.liquidation,
                ),
              ),
            ],
          ),
          const SizedBox(height: 13),
          const Divider(),
          const SizedBox(height: 11),
          Row(
            children: <Widget>[
              Text(
                'View management preview',
                style: Theme.of(context).textTheme.labelLarge,
              ),
              const Spacer(),
              const Icon(Icons.arrow_forward_rounded, size: 19),
            ],
          ),
        ],
      ),
    );
  }
}

/// D5 — Position detail and disabled management actions.
class PerpPositionScreen extends StatelessWidget {
  const PerpPositionScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    const position = PerpPreviewData.ethPosition;
    return LoopPage(
      eyebrow: 'D5 · ${position.id}',
      title: '${position.symbol} position',
      subtitle:
          'Inspect liquidation and margin facts without exposing a production mutation path.',
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 20),
          LoopCard(
            accent: true,
            tone: LoopTone.positive,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const LoopAssetMark(symbol: 'ETH', size: 48),
                    const SizedBox(width: 13),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            'ETH-PERP',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Long · isolated · preview',
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ],
                      ),
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: <Widget>[
                        Text(
                          position.pnl,
                          style: context.dataStyle.copyWith(
                            color: LoopColors.mint,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Unrealized',
                          style: Theme.of(context).textTheme.labelMedium,
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                const LoopKeyValueRow(
                  label: 'Position size',
                  value: '1.25 ETH',
                ),
                const LoopKeyValueRow(label: 'Entry price', value: '4,580.20'),
                const LoopKeyValueRow(label: 'Mark price', value: '4,630.50'),
                const LoopKeyValueRow(label: 'Leverage', value: '20×'),
                const LoopKeyValueRow(label: 'Margin', value: '289.41 USDC'),
                const LoopKeyValueRow(
                  label: 'Liquidation estimate',
                  value: '4,410.00',
                  tone: LoopTone.warning,
                  last: true,
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Liquidation distance'),
          LoopCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(
                      '4.76% preview',
                      style: context.dataStyle.copyWith(
                        color: LoopColors.warning,
                      ),
                    ),
                    const Spacer(),
                    const LoopStatusPill(
                      label: 'RECALCULATION REQUIRED',
                      tone: LoopTone.warning,
                    ),
                  ],
                ),
                const SizedBox(height: 13),
                ClipRRect(
                  borderRadius: LoopRadius.pill,
                  child: const LinearProgressIndicator(
                    value: 0.476,
                    minHeight: 9,
                    color: LoopColors.warning,
                    backgroundColor: LoopColors.elevated,
                  ),
                ),
                const SizedBox(height: 11),
                Text(
                  'Display-only preview. Live use requires a fresh market calculation and independent verification.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Management controls'),
          const Row(
            children: <Widget>[
              Expanded(
                child: _DisabledPositionAction(
                  icon: Icons.tune_rounded,
                  label: 'Leverage',
                ),
              ),
              SizedBox(width: 9),
              Expanded(
                child: _DisabledPositionAction(
                  icon: Icons.add_card_rounded,
                  label: 'Margin',
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          const Row(
            children: <Widget>[
              Expanded(
                child: _DisabledPositionAction(
                  icon: Icons.flag_outlined,
                  label: 'TP / SL',
                ),
              ),
              SizedBox(width: 9),
              Expanded(
                child: _DisabledPositionAction(
                  icon: Icons.call_split_rounded,
                  label: 'Partial close',
                ),
              ),
            ],
          ),
          const SizedBox(height: 9),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.close_rounded),
            label: const Text('Close position unavailable'),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'TP/SL, leverage, margin, partial close, and full close are visible for product review but have no executable handler.',
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => context.push('/perp/funding'),
            icon: const Icon(Icons.timeline_rounded),
            label: const Text('Inspect funding history'),
          ),
        ],
      ],
    );
  }
}

class _DisabledPositionAction extends StatelessWidget {
  const _DisabledPositionAction({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: null,
      icon: Icon(icon, size: 18),
      label: Text(label),
    );
  }
}

/// D6 — Current order and conditional order projection.
class PerpOrdersScreen extends StatelessWidget {
  const PerpOrdersScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D6 · Provider orders',
      title: 'Open orders',
      subtitle:
          'Order controls are intentionally inert until production mutation gates are complete.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/perp/history'),
          tooltip: 'Open fill history',
          icon: const Icon(Icons.history_rounded),
        ),
      ],
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        const SizedBox(height: 15),
        const PerpQuickRoutes(),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const LoopSectionLabel(
            'Current orders',
            trailing: LoopStatusPill(
              label: '2 previews',
              tone: LoopTone.market,
            ),
          ),
          const _OrderCard(
            symbol: 'BTC',
            side: 'Buy / Long',
            kind: 'Limit',
            price: '114,800.00',
            size: '0.05 BTC',
            filled: '0%',
          ),
          const SizedBox(height: 10),
          const _OrderCard(
            symbol: 'SOL',
            side: 'Sell / Short',
            kind: 'Limit',
            price: '225.40',
            size: '25 SOL',
            filled: '0%',
          ),
          const LoopSectionLabel('Conditional orders'),
          const LoopStateCard(
            title: 'TP/SL execution disabled',
            message:
                'No trigger orders are created, edited, or inferred in preview. This section remains empty by design.',
            icon: Icons.flag_outlined,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'Cancel and modify buttons are disabled. Preview order IDs cannot be submitted.',
          ),
        ],
      ],
    );
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.symbol,
    required this.side,
    required this.kind,
    required this.price,
    required this.size,
    required this.filled,
  });

  final String symbol;
  final String side;
  final String kind;
  final String price;
  final String size;
  final String filled;

  @override
  Widget build(BuildContext context) {
    final isLong = side.contains('Long');
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
                      '$symbol-PERP',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '$kind · preview',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              LoopStatusPill(
                label: side.toUpperCase(),
                tone: isLong ? LoopTone.positive : LoopTone.danger,
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(label: 'Price', value: price),
              ),
              Expanded(
                child: LoopMetric(label: 'Size', value: size),
              ),
              Expanded(
                child: LoopMetric(label: 'Filled', value: filled),
              ),
            ],
          ),
          const SizedBox(height: 13),
          const Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(onPressed: null, child: Text('Modify')),
              ),
              SizedBox(width: 9),
              Expanded(
                child: OutlinedButton(onPressed: null, child: Text('Cancel')),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// D7 — Fill and funding event history.
class PerpHistoryScreen extends StatelessWidget {
  const PerpHistoryScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D7 · Provider history',
      title: 'Trade history',
      subtitle:
          'Preview fills and funding events demonstrate structure only; exports remain disabled.',
      actions: <Widget>[
        IconButton(
          onPressed: null,
          tooltip: 'Export is disabled in preview',
          icon: const Icon(Icons.file_download_outlined),
        ),
      ],
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 16),
          const _HistorySummary(),
          const LoopSectionLabel('24 Aug · preview events'),
          const _HistoryEvent(
            time: '08:31:14',
            symbol: 'ETH',
            title: 'Opened long',
            detail: '1.25 ETH @ 4,580.20 · Market',
            amount: '-2.89 USDC fee',
            tone: LoopTone.positive,
          ),
          const _HistoryEvent(
            time: '08:00:00',
            symbol: 'BTC',
            title: 'Funding settled',
            detail: '0.0100% · preview data',
            amount: '-0.84 USDC',
            tone: LoopTone.warning,
          ),
          const _HistoryEvent(
            time: '07:42:08',
            symbol: 'SOL',
            title: 'Closed short',
            detail: '12 SOL @ 218.40 · Reduce only',
            amount: '+18.26 USDC PnL',
            tone: LoopTone.positive,
            last: true,
          ),
          const SizedBox(height: 14),
          OutlinedButton.icon(
            onPressed: () => context.push('/perp/funding'),
            icon: const Icon(Icons.timeline_rounded),
            label: const Text('Open funding details'),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'History rows are preview records, not account statements. Production export and tax reporting are unavailable.',
          ),
        ],
      ],
    );
  }
}

class _HistorySummary extends StatelessWidget {
  const _HistorySummary();

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.market,
      child: const Row(
        children: <Widget>[
          Expanded(
            child: LoopMetric(
              label: 'Realized PnL',
              value: '+18.26 USDC',
              tone: LoopTone.positive,
            ),
          ),
          Expanded(
            child: LoopMetric(label: 'Fees', value: '3.73 USDC'),
          ),
          Expanded(
            child: LoopMetric(label: 'Events', value: '3 preview'),
          ),
        ],
      ),
    );
  }
}

class _HistoryEvent extends StatelessWidget {
  const _HistoryEvent({
    required this.time,
    required this.symbol,
    required this.title,
    required this.detail,
    required this.amount,
    required this.tone,
    this.last = false,
  });

  final String time;
  final String symbol;
  final String title;
  final String detail;
  final String amount;
  final LoopTone tone;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 15),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 64,
            child: Text(
              time,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
            ),
          ),
          LoopAssetMark(symbol: symbol, size: 34),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(detail, style: Theme.of(context).textTheme.labelMedium),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            amount,
            textAlign: TextAlign.right,
            style: context.dataStyle.copyWith(
              color: loopToneColor(tone),
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}
