import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/market/market_widgets.dart';
import 'package:loop_mobile/features/perp/perp_models.dart';
import 'package:loop_mobile/features/perp/perp_widgets.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_trading_gateway.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

/// D1 — Hyperliquid Core market list.
class PerpMarketScreen extends StatelessWidget {
  const PerpMarketScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D1 · Hyperliquid Core',
      title: 'Perpetual markets',
      subtitle:
          'BTC, ETH, and SOL only. Perpetuals live inside Market, never as a bottom tab.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/perp/risk'),
          tooltip: 'Read leverage and risk notice',
          icon: const Icon(Icons.shield_outlined),
        ),
      ],
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: LoopContextRail(stage: LoopStage.execute),
        ),
        const SizedBox(height: 14),
        PerpSnapshotBanner(state: snapshotState),
        const SizedBox(height: 18),
        const PerpModeControl(),
        const SizedBox(height: 16),
        const PerpQuickRoutes(),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const LoopSectionLabel(
            'Core allowlist',
            trailing: LoopStatusPill(
              label: '3 markets',
              tone: LoopTone.positive,
            ),
          ),
          for (
            var index = 0;
            index < PerpPreviewData.markets.length;
            index++
          ) ...<Widget>[
            PerpMarketRow(
              market: PerpPreviewData.markets[index],
              onTap: () => context.push(
                '/perp/trade',
                extra: PerpPreviewData.markets[index].symbol,
              ),
            ),
            if (index != PerpPreviewData.markets.length - 1)
              const SizedBox(height: 10),
          ],
          const LoopSectionLabel('Product boundary'),
          const LoopStateCard(
            title: 'HIP-3 is disabled',
            message:
                'Builder-deployed and non-core markets are not listed, searched, signed, or routed in this build.',
            icon: Icons.block_rounded,
            tone: LoopTone.warning,
          ),
        ],
      ],
    );
  }
}

/// D2 — Read-only trade construction preview.
class PerpTradeScreen extends ConsumerStatefulWidget {
  const PerpTradeScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = PerpSnapshotState.preview,
  });

  final String symbol;
  final PerpSnapshotState snapshotState;

  @override
  ConsumerState<PerpTradeScreen> createState() => _PerpTradeScreenState();
}

class _PerpTradeScreenState extends ConsumerState<PerpTradeScreen> {
  final String _direction = 'Long';
  final String _orderType = 'Market';
  bool _preparing = false;

  Future<void> _preparePreview() async {
    if (_preparing || widget.snapshotState != PerpSnapshotState.preview) return;
    setState(() => _preparing = true);
    try {
      final gateway = ref.read(hyperliquidTradingGatewayProvider);
      final intent = widget.symbol.toUpperCase() == 'ETH'
          ? await gateway.prepareFixtureOrder()
          : PerpPreviewData.previewOrderIntent(symbol: widget.symbol);
      if (!mounted) return;
      unawaited(context.push('/perp/confirm', extra: intent));
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Hyperliquid preview gateway is unavailable. No order intent was created.',
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _preparing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final market = PerpPreviewData.market(widget.symbol);
    final hasFacts = widget.snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D2 · ${market.symbol}-PERP',
      title: 'Build an order',
      subtitle:
          'Simulate the order shape before entering the single Privy review boundary.',
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 172),
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/perp/orders'),
          tooltip: 'Open orders',
          icon: const Icon(Icons.receipt_long_outlined),
        ),
        IconButton(
          onPressed: () => context.push('/perp/account'),
          tooltip: 'Open margin account',
          icon: const Icon(Icons.account_balance_wallet_outlined),
        ),
      ],
      bottom: LoopActionDock(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Icon(
                  Icons.lock_outline_rounded,
                  size: 16,
                  color: LoopColors.warning,
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    'Preview creates an intent; it cannot submit an order.',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: hasFacts && !_preparing ? _preparePreview : null,
              icon: _preparing
                  ? const SizedBox.square(
                      dimension: 17,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.fact_check_outlined),
              label: Text(
                _preparing ? 'Preparing preview…' : 'Review preview order',
              ),
            ),
          ],
        ),
      ),
      children: <Widget>[
        PerpSnapshotBanner(state: widget.snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: widget.snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: market.symbol, size: 48),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '${market.symbol}-PERP',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'Core allowlist · mark price',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(
                    market.markPrice,
                    style: context.dataStyle.copyWith(fontSize: 18),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    market.change,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: market.isPositive
                          ? LoopColors.mint
                          : LoopColors.danger,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 18),
          LoopCard(
            padding: const EdgeInsets.fromLTRB(12, 15, 12, 12),
            child: Column(
              children: <Widget>[
                const MarketCandleChart(height: 180),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    const LoopStatusPill(label: '4H', tone: LoopTone.market),
                    const SizedBox(width: 8),
                    Text(
                      'Simulated candles',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const Spacer(),
                    IconButton(
                      onPressed: () =>
                          context.push('/market/chart', extra: market.symbol),
                      tooltip: 'Open full-screen chart preview',
                      icon: const Icon(Icons.open_in_full_rounded),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Order book preview'),
          _OrderBookPreview(markPrice: market.markPrice),
          const LoopSectionLabel('Order shape'),
          LoopCard(
            accent: true,
            tone: _direction == 'Long' ? LoopTone.positive : LoopTone.danger,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SegmentedButton<String>(
                  segments: const <ButtonSegment<String>>[
                    ButtonSegment<String>(
                      value: 'Long',
                      label: Text('Long'),
                      icon: Icon(Icons.north_east_rounded),
                    ),
                    ButtonSegment<String>(
                      value: 'Short',
                      label: Text('Short'),
                      icon: Icon(Icons.south_east_rounded),
                    ),
                  ],
                  selected: <String>{_direction},
                  onSelectionChanged: null,
                ),
                const SizedBox(height: 12),
                SegmentedButton<String>(
                  segments: const <ButtonSegment<String>>[
                    ButtonSegment<String>(
                      value: 'Market',
                      label: Text('Market'),
                    ),
                    ButtonSegment<String>(value: 'Limit', label: Text('Limit')),
                  ],
                  selected: <String>{_orderType},
                  onSelectionChanged: null,
                ),
                const SizedBox(height: 14),
                TextFormField(
                  readOnly: true,
                  initialValue: market.symbol == 'ETH' ? '1.25' : '—',
                  decoration: InputDecoration(
                    labelText: 'Size',
                    suffixText: market.symbol,
                  ),
                ),
                const SizedBox(height: 11),
                TextFormField(
                  readOnly: true,
                  initialValue: '20×',
                  decoration: const InputDecoration(
                    labelText: 'Leverage',
                    suffixIcon: Icon(Icons.lock_outline_rounded, size: 18),
                  ),
                ),
                const SizedBox(height: 13),
                const Row(
                  children: <Widget>[
                    Expanded(
                      child: LoopMetric(label: 'Margin', value: '289.41 USDC'),
                    ),
                    Expanded(
                      child: LoopMetric(label: 'Est. fee', value: '2.89 USDC'),
                    ),
                    Expanded(
                      child: LoopMetric(label: 'Est. liq.', value: '4,410.00'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'TP/SL execution, builder fees, HIP-3, and production submission are disabled. Preview intent uses a 0 USDC builder fee.',
          ),
        ],
      ],
    );
  }
}

class _OrderBookPreview extends StatelessWidget {
  const _OrderBookPreview({required this.markPrice});

  final String markPrice;

  @override
  Widget build(BuildContext context) {
    const asks = <(String, String)>[
      ('4,634.10', '7.42'),
      ('4,633.40', '5.18'),
      ('4,631.80', '10.06'),
    ];
    const bids = <(String, String)>[
      ('4,629.80', '8.04'),
      ('4,628.20', '4.90'),
      ('4,626.70', '11.21'),
    ];
    return LoopCard(
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  'PRICE',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ),
              Text('SIZE', style: Theme.of(context).textTheme.labelMedium),
            ],
          ),
          const SizedBox(height: 9),
          for (final row in asks)
            _BookRow(price: row.$1, size: row.$2, ask: true),
          Container(
            margin: const EdgeInsets.symmetric(vertical: 7),
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: const BoxDecoration(
              border: Border.symmetric(
                horizontal: BorderSide(color: LoopColors.line),
              ),
            ),
            child: Row(
              children: <Widget>[
                const Icon(
                  Icons.swap_vert_rounded,
                  size: 17,
                  color: LoopColors.mint,
                ),
                const SizedBox(width: 8),
                Text(
                  markPrice,
                  style: context.dataStyle.copyWith(color: LoopColors.mint),
                ),
                const Spacer(),
                Text(
                  'MARK · PREVIEW',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ],
            ),
          ),
          for (final row in bids)
            _BookRow(price: row.$1, size: row.$2, ask: false),
        ],
      ),
    );
  }
}

class _BookRow extends StatelessWidget {
  const _BookRow({required this.price, required this.size, required this.ask});

  final String price;
  final String size;
  final bool ask;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              price,
              style: context.dataStyle.copyWith(
                color: ask ? LoopColors.danger : LoopColors.mint,
                fontSize: 12,
              ),
            ),
          ),
          Text(size, style: context.dataStyle.copyWith(fontSize: 12)),
        ],
      ),
    );
  }
}

/// D3 — Exact, immutable preview before the shared signing review.
class PerpConfirmScreen extends StatefulWidget {
  const PerpConfirmScreen({
    super.key,
    this.intent,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final SigningIntent? intent;
  final PerpSnapshotState snapshotState;

  @override
  State<PerpConfirmScreen> createState() => _PerpConfirmScreenState();
}

class _PerpConfirmScreenState extends State<PerpConfirmScreen> {
  late final SigningIntent _intent;

  @override
  void initState() {
    super.initState();
    _intent = widget.intent ?? PerpPreviewData.previewOrderIntent();
  }

  @override
  Widget build(BuildContext context) {
    final hasFacts = widget.snapshotState == PerpSnapshotState.preview;
    final validationError = _intent.validateAt(DateTime.now().toUtc());
    return LoopPage(
      eyebrow: 'D3 · Immutable intent',
      title: 'Confirm order preview',
      subtitle:
          'Review every critical field. LOOP will not infer, refresh, or silently replace this intent.',
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 176),
      bottom: LoopActionDock(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (validationError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 9),
                child: Text(
                  'Intent blocked: $validationError',
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: LoopColors.danger),
                ),
              ),
            FilledButton.icon(
              onPressed: hasFacts && validationError == null
                  ? () =>
                        context.push('/preview/signing-review', extra: _intent)
                  : null,
              icon: const Icon(Icons.lock_outline_rounded),
              label: const Text('Continue to Privy review'),
            ),
            const SizedBox(height: 7),
            Text(
              'Shared review only · production submission remains disabled',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ],
        ),
      ),
      children: <Widget>[
        PerpSnapshotBanner(state: widget.snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: widget.snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              const LoopStatusPill(
                label: 'PRIVY AUTHORITY',
                tone: LoopTone.positive,
                icon: Icons.verified_user_outlined,
              ),
              const LoopStatusPill(
                label: 'NO SUBMISSION',
                tone: LoopTone.warning,
                icon: Icons.lock_outline_rounded,
              ),
              Text(
                _intent.revision.split('-').take(2).join('-'),
                style: Theme.of(
                  context,
                ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
              ),
            ],
          ),
          const LoopSectionLabel('Frozen order fields'),
          LoopCard(
            accent: true,
            tone: LoopTone.positive,
            child: Column(
              children: <Widget>[
                for (var index = 0; index < _intent.fields.length; index++)
                  LoopKeyValueRow(
                    label: _intent.fields[index].label,
                    value: _intent.fields[index].value,
                    tone: _intent.fields[index].label == 'Builder fee'
                        ? LoopTone.warning
                        : LoopTone.neutral,
                    last: index == _intent.fields.length - 1,
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const LoopStateCard(
            title: 'Builder fee disabled',
            message:
                'This intent is accepted only when builder fee equals exactly 0 USDC. No builder code is attached.',
            icon: Icons.money_off_csred_outlined,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 12),
          LoopCard(
            onTap: () => context.push('/perp/risk'),
            semanticLabel: 'Open leverage and risk notice',
            child: Row(
              children: <Widget>[
                const Icon(Icons.shield_outlined, color: LoopColors.warning),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'Risk acknowledgement',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Read liquidation, leverage, and funding rules before a production flow is enabled.',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.arrow_forward_rounded),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(),
        ],
      ],
    );
  }
}
