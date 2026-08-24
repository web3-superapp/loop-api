import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/perp/perp_models.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class PerpSnapshotBanner extends StatelessWidget {
  const PerpSnapshotBanner({
    required this.state,
    super.key,
    this.compact = false,
  });

  final PerpSnapshotState state;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final descriptor = switch (state) {
      PerpSnapshotState.preview => (
        'HYPERLIQUID PREVIEW · READ-ONLY',
        PerpPreviewData.observedLabel,
        LoopTone.positive,
        Icons.visibility_outlined,
      ),
      PerpSnapshotState.loading => (
        'LOADING CORRELATED SNAPSHOT',
        'Provider facts remain hidden',
        LoopTone.neutral,
        Icons.sync_rounded,
      ),
      PerpSnapshotState.offline => (
        'MARKET FEED OFFLINE',
        'Orders and stale PnL are disabled',
        LoopTone.warning,
        Icons.cloud_off_outlined,
      ),
      PerpSnapshotState.stale => (
        'SNAPSHOT EXPIRED · VALUES CLEARED',
        'Request a fresh provider snapshot',
        LoopTone.warning,
        Icons.history_toggle_off_rounded,
      ),
      PerpSnapshotState.empty => (
        'NO PROVIDER RECORDS',
        'No allowlisted Hyperliquid records returned',
        LoopTone.neutral,
        Icons.inbox_outlined,
      ),
      PerpSnapshotState.regionBlocked => (
        'REGION NOT ELIGIBLE',
        'Perpetual market data and actions are blocked',
        LoopTone.danger,
        Icons.public_off_outlined,
      ),
    };
    final color = loopToneColor(descriptor.$3);
    return Semantics(
      liveRegion: state != PerpSnapshotState.preview,
      label: '${descriptor.$1}. ${descriptor.$2}',
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 11 : 14,
          vertical: compact ? 9 : 11,
        ),
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
                      letterSpacing: 0.78,
                    ),
                  ),
                  if (!compact) ...<Widget>[
                    const SizedBox(height: 3),
                    Text(
                      descriptor.$2,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ],
              ),
            ),
            if (state == PerpSnapshotState.preview)
              Text(
                'NO SUBMISSION',
                style: Theme.of(
                  context,
                ).textTheme.labelMedium?.copyWith(fontFamily: 'monospace'),
              ),
          ],
        ),
      ),
    );
  }
}

class PerpStatePanel extends StatelessWidget {
  const PerpStatePanel({required this.state, super.key, this.onRetry});

  final PerpSnapshotState state;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    if (state == PerpSnapshotState.preview) return const SizedBox.shrink();
    if (state == PerpSnapshotState.loading) {
      return const _PerpLoadingPanel();
    }
    final descriptor = switch (state) {
      PerpSnapshotState.offline => (
        'Hyperliquid feed is offline',
        'LOOP cleared mark price, PnL, positions, and order controls until reconnection.',
        Icons.cloud_off_outlined,
        LoopTone.warning,
      ),
      PerpSnapshotState.stale => (
        'Provider snapshot expired',
        'Old values were removed rather than shown as current. Request a fresh snapshot to continue.',
        Icons.history_toggle_off_rounded,
        LoopTone.warning,
      ),
      PerpSnapshotState.empty => (
        'No Hyperliquid records',
        'This preview returned no positions, orders, fills, or allowlisted markets for the selected view.',
        Icons.inbox_outlined,
        LoopTone.neutral,
      ),
      PerpSnapshotState.regionBlocked => (
        'Perpetuals unavailable here',
        'Regional eligibility could not be confirmed. LOOP blocks provider facts and all trading actions.',
        Icons.public_off_outlined,
        LoopTone.danger,
      ),
      _ => throw StateError('State is handled before the switch.'),
    };
    return LoopStateCard(
      title: descriptor.$1,
      message: descriptor.$2,
      icon: descriptor.$3,
      tone: descriptor.$4,
      action: onRetry != null && state != PerpSnapshotState.regionBlocked
          ? OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Retry preview'),
            )
          : null,
    );
  }
}

class _PerpLoadingPanel extends StatelessWidget {
  const _PerpLoadingPanel();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: 'Loading Hyperliquid preview',
      child: LoopCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
                Text(
                  'Correlating provider snapshot',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ],
            ),
            const SizedBox(height: 13),
            Text(
              'Prices, PnL, and order controls appear only after schema, request identity, and freshness checks pass.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}

class PerpModeControl extends StatelessWidget {
  const PerpModeControl({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(5),
      decoration: BoxDecoration(
        color: LoopColors.basalt,
        borderRadius: LoopRadius.medium,
        border: Border.all(color: LoopColors.line),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextButton.icon(
              onPressed: () => context.go('/market'),
              icon: const Icon(Icons.currency_exchange_rounded, size: 18),
              label: const Text('Spot'),
              style: TextButton.styleFrom(
                foregroundColor: LoopColors.vapor,
                minimumSize: const Size(48, 44),
              ),
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Container(
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: LoopColors.mint.withValues(alpha: 0.11),
                borderRadius: LoopRadius.small,
                border: Border.all(
                  color: LoopColors.mint.withValues(alpha: 0.3),
                ),
              ),
              child: Text(
                'Perpetual',
                style: Theme.of(
                  context,
                ).textTheme.labelLarge?.copyWith(color: LoopColors.mint),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class PerpQuickRoutes extends StatelessWidget {
  const PerpQuickRoutes({super.key});

  @override
  Widget build(BuildContext context) {
    const routes = <(String, String, IconData)>[
      ('Positions', '/perp/positions', Icons.layers_outlined),
      ('Orders', '/perp/orders', Icons.list_alt_rounded),
      ('History', '/perp/history', Icons.history_rounded),
      ('Account', '/perp/account', Icons.account_balance_wallet_outlined),
    ];
    return SizedBox(
      height: 78,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: routes.length,
        separatorBuilder: (_, _) => const SizedBox(width: 9),
        itemBuilder: (context, index) {
          final route = routes[index];
          return SizedBox(
            width: 92,
            child: OutlinedButton(
              onPressed: () => context.push(route.$2),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  Icon(route.$3, size: 19),
                  const SizedBox(height: 7),
                  Text(
                    route.$1,
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class PerpMarketRow extends StatelessWidget {
  const PerpMarketRow({required this.market, required this.onTap, super.key});

  final PerpMarketPreview market;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      semanticLabel: 'Open ${market.symbol} perpetual preview',
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              LoopAssetMark(symbol: market.symbol),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '${market.symbol}-PERP',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'Hyperliquid Core',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: <Widget>[
                  Text(market.markPrice, style: context.dataStyle),
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
          const SizedBox(height: 15),
          Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(label: 'Funding / 8h', value: market.funding),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'Open interest',
                  value: market.openInterest,
                ),
              ),
              Expanded(
                child: LoopMetric(label: '24h volume', value: market.volume),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class PerpReadOnlyNotice extends StatelessWidget {
  const PerpReadOnlyNotice({super.key, this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    return LoopStateCard(
      title: 'Execution locked',
      message:
          message ??
          'Production credentials, regional eligibility, and Privy signing are not connected. This route cannot submit.',
      icon: Icons.lock_outline_rounded,
      tone: LoopTone.warning,
    );
  }
}
