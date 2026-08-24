import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/market/market_models.dart';
import 'package:loop_mobile/features/market/market_widgets.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class MarketScreen extends StatefulWidget {
  const MarketScreen({
    super.key,
    this.snapshotState = MarketSnapshotState.preview,
  });

  final MarketSnapshotState snapshotState;

  @override
  State<MarketScreen> createState() => _MarketScreenState();
}

class _MarketScreenState extends State<MarketScreen> {
  String _spotFilter = 'Trending';

  @override
  Widget build(BuildContext context) {
    final hasFacts = widget.snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C1 · Discover',
      title: 'Market pulse',
      subtitle:
          'Core assets first. Every value below is a labelled, read-only preview.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/market/watchlist'),
          tooltip: 'Manage watchlist preview',
          icon: const Icon(Icons.star_outline_rounded),
        ),
        IconButton(
          onPressed: () => context.push('/market/new'),
          tooltip: 'Open new pair discovery',
          icon: const Icon(Icons.radar_rounded),
        ),
      ],
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: LoopContextRail(stage: LoopStage.discover),
        ),
        const SizedBox(height: 14),
        MarketSnapshotBanner(state: widget.snapshotState),
        const SizedBox(height: 18),
        _MarketModeControl(onPerpetualSelected: () => context.push('/perp')),
        const SizedBox(height: 16),
        TextField(
          enabled: false,
          decoration: const InputDecoration(
            hintText: 'Search BTC, ETH, or SOL',
            prefixIcon: Icon(Icons.search_rounded),
            suffixIcon: Icon(Icons.lock_outline_rounded, size: 18),
          ),
        ),
        const SizedBox(height: 15),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children:
                <String>['Watchlist', 'Trending', 'New', 'DeFi', 'Smart money']
                    .map(
                      (filter) => Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(filter),
                          selected: _spotFilter == filter,
                          onSelected: (_) {
                            final route = switch (filter) {
                              'Watchlist' => '/market/watchlist',
                              'New' => '/market/new',
                              'Smart money' => '/market/smart-money',
                              _ => null,
                            };
                            if (route != null) {
                              context.push(route);
                              return;
                            }
                            setState(() => _spotFilter = filter);
                          },
                        ),
                      ),
                    )
                    .toList(growable: false),
          ),
        ),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 20),
          MarketStatePanel(
            state: widget.snapshotState,
            onRetry: () => setState(() {}),
          ),
        ] else ...<Widget>[
          const LoopSectionLabel('Core spot snapshot'),
          _MarketLedgerHeader(filter: _spotFilter),
          const SizedBox(height: 10),
          for (
            var index = 0;
            index < MarketPreviewData.coreAssets.length;
            index++
          ) ...<Widget>[
            MarketAssetRow(
              rank: index + 1,
              asset: MarketPreviewData.coreAssets[index],
              onTap: () => context.push(
                '/market/token',
                extra: MarketPreviewData.coreAssets[index].symbol,
              ),
            ),
            if (index != MarketPreviewData.coreAssets.length - 1)
              const SizedBox(height: 10),
          ],
          const LoopSectionLabel('Discovery boundary'),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            onTap: () => context.push('/market/new'),
            semanticLabel: 'Open read-only new pair discovery',
            child: Row(
              children: <Widget>[
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: LoopColors.market.withValues(alpha: 0.1),
                    borderRadius: LoopRadius.small,
                  ),
                  child: const Icon(
                    Icons.radar_rounded,
                    color: LoopColors.market,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'New pair discovery',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Preview pool age, liquidity, and sourced contract facts. Non-core results stay hidden.',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.arrow_forward_rounded,
                  color: LoopColors.market,
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _MarketModeControl extends StatelessWidget {
  const _MarketModeControl({required this.onPerpetualSelected});

  final VoidCallback onPerpetualSelected;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Market type. Spot selected.',
      child: Container(
        padding: const EdgeInsets.all(5),
        decoration: BoxDecoration(
          color: LoopColors.basalt,
          borderRadius: LoopRadius.medium,
          border: Border.all(color: LoopColors.line),
        ),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Container(
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: LoopColors.market.withValues(alpha: 0.12),
                  borderRadius: LoopRadius.small,
                  border: Border.all(
                    color: LoopColors.market.withValues(alpha: 0.28),
                  ),
                ),
                child: Text(
                  'Spot',
                  style: Theme.of(
                    context,
                  ).textTheme.labelLarge?.copyWith(color: LoopColors.market),
                ),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: TextButton.icon(
                onPressed: onPerpetualSelected,
                icon: const Icon(Icons.swap_vert_rounded, size: 18),
                label: const Text('Perpetual'),
                style: TextButton.styleFrom(
                  foregroundColor: LoopColors.vapor,
                  minimumSize: const Size(48, 44),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MarketLedgerHeader extends StatelessWidget {
  const _MarketLedgerHeader({required this.filter});

  final String filter;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            '$filter · 3 allowlisted assets',
            style: Theme.of(context).textTheme.labelMedium,
          ),
        ),
        Text(
          'PRICE / 24H',
          style: Theme.of(
            context,
          ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
        ),
      ],
    );
  }
}

class TokenDetailScreen extends StatelessWidget {
  const TokenDetailScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = MarketSnapshotState.preview,
  });

  final String symbol;
  final MarketSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final asset = MarketPreviewData.asset(symbol);
    final hasFacts = snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C2 · ${asset.pair}',
      title: asset.name,
      subtitle:
          'Price, chart, and contract facts remain sourced and non-actionable in preview.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/market/watchlist'),
          tooltip: 'Open watchlist preview',
          icon: const Icon(Icons.star_border_rounded),
        ),
        IconButton(
          onPressed: () => context.push('/market/alerts', extra: asset.symbol),
          tooltip: 'Open price alert preview',
          icon: const Icon(Icons.notifications_none_rounded),
        ),
      ],
      children: <Widget>[
        MarketSnapshotBanner(state: snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 20),
          MarketStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 22),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              LoopAssetMark(symbol: asset.symbol, size: 52),
              const SizedBox(width: 15),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      asset.price,
                      style: Theme.of(context).textTheme.displayMedium,
                    ),
                    const SizedBox(height: 5),
                    Row(
                      children: <Widget>[
                        LoopStatusPill(
                          label: '${asset.change} · simulated 24h',
                          tone: asset.isPositive
                              ? LoopTone.positive
                              : LoopTone.danger,
                          icon: asset.isPositive
                              ? Icons.north_east_rounded
                              : Icons.south_east_rounded,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 21),
          LoopCard(
            padding: const EdgeInsets.fromLTRB(12, 16, 12, 12),
            child: Column(
              children: <Widget>[
                const MarketCandleChart(height: 210),
                const SizedBox(height: 12),
                Row(
                  children: <Widget>[
                    const LoopStatusPill(label: '4H', tone: LoopTone.market),
                    const SizedBox(width: 8),
                    Text(
                      'Preview candles · not live data',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const Spacer(),
                    IconButton(
                      onPressed: () =>
                          context.push('/market/chart', extra: asset.symbol),
                      tooltip: 'Open full-screen chart',
                      icon: const Icon(Icons.open_in_full_rounded),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Market ledger'),
          LoopCard(
            child: Row(
              children: <Widget>[
                Expanded(
                  child: LoopMetric(label: '24h volume', value: asset.volume),
                ),
                const Expanded(
                  child: LoopMetric(
                    label: 'Market cap',
                    value: '—',
                    detail: 'Provider missing',
                  ),
                ),
                const Expanded(
                  child: LoopMetric(
                    label: 'Liquidity',
                    value: '—',
                    detail: 'Provider missing',
                  ),
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Contract facts'),
          LoopCard(
            child: Column(
              children: const <Widget>[
                _SourcedFact(
                  title: 'Asset identity',
                  value: 'Core allowlist preview',
                  source: 'LOOP preview · observed 08:42 UTC',
                  tone: LoopTone.market,
                ),
                _SourcedFact(
                  title: 'Ownership controls',
                  value: '—',
                  source: 'Not checked · never treated as safe',
                  tone: LoopTone.warning,
                ),
                _SourcedFact(
                  title: 'Liquidity lock',
                  value: '—',
                  source: 'Provider result unavailable',
                  tone: LoopTone.neutral,
                  last: true,
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Community signal'),
          LoopCard(
            tone: LoopTone.conversation,
            accent: true,
            child: Row(
              children: <Widget>[
                const Icon(Icons.forum_outlined, color: LoopColors.chat),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'Discussion preview',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'No connected Agora conversation count. Community activity is unavailable.',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Explore market structure'),
          Row(
            children: <Widget>[
              Expanded(
                child: _MarketDetailRoute(
                  icon: Icons.donut_large_rounded,
                  label: 'Holders',
                  onTap: () =>
                      context.push('/market/holders', extra: asset.symbol),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _MarketDetailRoute(
                  icon: Icons.swap_vert_rounded,
                  label: 'Trades',
                  onTap: () =>
                      context.push('/market/trades', extra: asset.symbol),
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () =>
                      context.push('/market/chart', extra: asset.symbol),
                  icon: const Icon(Icons.candlestick_chart_rounded),
                  label: const Text('Full chart'),
                ),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: FilledButton(
                  onPressed: null,
                  child: Text('Buy unavailable'),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

class _MarketDetailRoute extends StatelessWidget {
  const _MarketDetailRoute({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 18),
      label: Text(label),
    );
  }
}

class _SourcedFact extends StatelessWidget {
  const _SourcedFact({
    required this.title,
    required this.value,
    required this.source,
    required this.tone,
    this.last = false,
  });

  final String title;
  final String value;
  final String source;
  final LoopTone tone;
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
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(Icons.circle, size: 7, color: loopToneColor(tone)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: 4),
                Text(value, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(source, style: Theme.of(context).textTheme.labelMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class FullChartScreen extends StatefulWidget {
  const FullChartScreen({
    super.key,
    this.symbol = 'ETH',
    this.snapshotState = MarketSnapshotState.preview,
  });

  final String symbol;
  final MarketSnapshotState snapshotState;

  @override
  State<FullChartScreen> createState() => _FullChartScreenState();
}

class _FullChartScreenState extends State<FullChartScreen> {
  String _period = '4H';
  String _indicator = 'MA';

  @override
  Widget build(BuildContext context) {
    final asset = MarketPreviewData.asset(widget.symbol);
    final hasFacts = widget.snapshotState == MarketSnapshotState.preview;
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          onPressed: () => context.pop(),
          tooltip: 'Back',
          icon: const Icon(Icons.close_rounded),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              '${asset.symbol} / USDC',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              'C3 · chart preview',
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ],
        ),
        actions: <Widget>[
          IconButton(
            onPressed: null,
            tooltip: 'Drawing tools are disabled in preview',
            icon: const Icon(Icons.draw_outlined),
          ),
        ],
      ),
      body: SafeArea(
        child: DecoratedBox(
          decoration: const BoxDecoration(color: LoopColors.abyss),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                MarketSnapshotBanner(
                  state: widget.snapshotState,
                  compact: true,
                ),
                const SizedBox(height: 12),
                Row(
                  children: <Widget>[
                    Text(
                      hasFacts ? asset.price : '—',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(width: 10),
                    if (hasFacts)
                      LoopStatusPill(
                        label: asset.change,
                        tone: asset.isPositive
                            ? LoopTone.positive
                            : LoopTone.danger,
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                SizedBox(
                  height: 43,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: <Widget>[
                      for (final period in <String>[
                        '15M',
                        '1H',
                        '4H',
                        '1D',
                        '1W',
                      ])
                        Padding(
                          padding: const EdgeInsets.only(right: 7),
                          child: ChoiceChip(
                            label: Text(period),
                            selected: period == _period,
                            onSelected: hasFacts
                                ? (_) => setState(() => _period = period)
                                : null,
                          ),
                        ),
                      const SizedBox(width: 7),
                      for (final indicator in <String>['MA', 'MACD', 'RSI'])
                        Padding(
                          padding: const EdgeInsets.only(right: 7),
                          child: FilterChip(
                            label: Text(indicator),
                            selected: indicator == _indicator,
                            onSelected: hasFacts
                                ? (_) => setState(() => _indicator = indicator)
                                : null,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: hasFacts
                      ? LoopCard(
                          padding: const EdgeInsets.fromLTRB(10, 18, 8, 8),
                          child: LayoutBuilder(
                            builder: (context, constraints) {
                              return MarketCandleChart(
                                height: constraints.maxHeight,
                                semanticLabel:
                                    '${asset.symbol} $_period chart with $_indicator, simulated preview',
                              );
                            },
                          ),
                        )
                      : Center(
                          child: MarketStatePanel(state: widget.snapshotState),
                        ),
                ),
                const SizedBox(height: 9),
                Text(
                  'Simulated candles · no live history · pinch, drawing, and execution disabled',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.labelMedium,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class NewPairsScreen extends StatelessWidget {
  const NewPairsScreen({
    super.key,
    this.snapshotState = MarketSnapshotState.preview,
  });

  final MarketSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == MarketSnapshotState.preview;
    return LoopPage(
      eyebrow: 'C10 · Discovery feed',
      title: 'New pairs',
      subtitle:
          'A factual, source-labelled preview. High-risk and non-core candidates remain folded away.',
      children: <Widget>[
        MarketSnapshotBanner(state: snapshotState),
        const SizedBox(height: 16),
        const LoopStateCard(
          title: 'Core-only preview',
          message:
              'This build shows BTC, ETH, and SOL pairs only. No score implies safety, and missing facts render as —.',
          icon: Icons.filter_alt_outlined,
          tone: LoopTone.market,
        ),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 16),
          MarketStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const LoopSectionLabel('Recently observed'),
          for (
            var index = 0;
            index < MarketPreviewData.coreAssets.length;
            index++
          ) ...<Widget>[
            _NewPairCard(
              asset: MarketPreviewData.coreAssets[index],
              age: const <String>['18 min', '42 min', '1 hr'][index],
              venue: const <String>[
                'Core spot',
                'Core spot',
                'Core spot',
              ][index],
              onTap: () => context.push(
                '/market/token',
                extra: MarketPreviewData.coreAssets[index].symbol,
              ),
            ),
            if (index != MarketPreviewData.coreAssets.length - 1)
              const SizedBox(height: 11),
          ],
          const LoopSectionLabel('Folded candidates'),
          const LoopStateCard(
            title: 'Non-core results hidden',
            message:
                '3 preview candidates are withheld because identity, liquidity, or ownership facts are unavailable.',
            icon: Icons.visibility_off_outlined,
            tone: LoopTone.warning,
          ),
        ],
      ],
    );
  }
}

class _NewPairCard extends StatelessWidget {
  const _NewPairCard({
    required this.asset,
    required this.age,
    required this.venue,
    required this.onTap,
  });

  final MarketAssetPreview asset;
  final String age;
  final String venue;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      semanticLabel: 'Open ${asset.symbol} pair facts',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: asset.symbol),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      asset.pair,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '$venue · observed $age ago',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              const LoopStatusPill(label: 'PREVIEW', tone: LoopTone.market),
            ],
          ),
          const SizedBox(height: 14),
          const Divider(),
          const SizedBox(height: 12),
          const Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(
                  label: 'Liquidity',
                  value: '—',
                  detail: 'Not connected',
                ),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'Pool age',
                  value: '—',
                  detail: 'Preview only',
                ),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'Ownership',
                  value: '—',
                  detail: 'Not checked',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
