import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/market/market_models.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class MarketSnapshotBanner extends StatelessWidget {
  const MarketSnapshotBanner({
    required this.state,
    super.key,
    this.compact = false,
  });

  final MarketSnapshotState state;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final descriptor = switch (state) {
      MarketSnapshotState.preview => (
        'PREVIEW · READ-ONLY',
        MarketPreviewData.observedLabel,
        LoopTone.market,
        Icons.visibility_outlined,
      ),
      MarketSnapshotState.loading => (
        'LOADING PROVIDER DATA',
        'No market facts are displayed yet',
        LoopTone.neutral,
        Icons.sync_rounded,
      ),
      MarketSnapshotState.offline => (
        'OFFLINE · READ-ONLY',
        'Reconnect before relying on prices',
        LoopTone.warning,
        Icons.cloud_off_outlined,
      ),
      MarketSnapshotState.stale => (
        'STALE SNAPSHOT HIDDEN',
        'Refresh required · provider values cleared',
        LoopTone.warning,
        Icons.history_toggle_off_rounded,
      ),
      MarketSnapshotState.empty => (
        'NO PROVIDER RESULTS',
        'Try another view when the feed returns',
        LoopTone.neutral,
        Icons.inbox_outlined,
      ),
      MarketSnapshotState.regionBlocked => (
        'UNAVAILABLE IN THIS REGION',
        'Market actions and facts are disabled',
        LoopTone.danger,
        Icons.public_off_outlined,
      ),
    };
    final color = loopToneColor(descriptor.$3);
    return Semantics(
      liveRegion: state != MarketSnapshotState.preview,
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
                      letterSpacing: 0.85,
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
            if (state == MarketSnapshotState.preview)
              Text(
                'DEMO DATA',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: LoopColors.vapor,
                  fontFamily: 'monospace',
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class MarketStatePanel extends StatelessWidget {
  const MarketStatePanel({required this.state, super.key, this.onRetry});

  final MarketSnapshotState state;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    if (state == MarketSnapshotState.preview) return const SizedBox.shrink();
    if (state == MarketSnapshotState.loading) {
      return const _MarketLoadingSkeleton();
    }
    final descriptor = switch (state) {
      MarketSnapshotState.offline => (
        'Market feed is offline',
        'Prices and trading controls stay hidden until a current provider snapshot is available.',
        Icons.cloud_off_outlined,
        LoopTone.warning,
      ),
      MarketSnapshotState.stale => (
        'Snapshot expired',
        'LOOP cleared the old prices. Refresh to request a current, correlated snapshot.',
        Icons.history_toggle_off_rounded,
        LoopTone.warning,
      ),
      MarketSnapshotState.empty => (
        'Nothing in this view',
        'No allowlisted results were returned. Change the filter or try again later.',
        Icons.inbox_outlined,
        LoopTone.neutral,
      ),
      MarketSnapshotState.regionBlocked => (
        'Market unavailable here',
        'Regional eligibility could not be confirmed, so LOOP has disabled market facts and actions.',
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
      action: onRetry != null && state != MarketSnapshotState.regionBlocked
          ? OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded),
              label: const Text('Retry preview'),
            )
          : null,
    );
  }
}

class _MarketLoadingSkeleton extends StatelessWidget {
  const _MarketLoadingSkeleton();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      label: 'Loading market preview',
      child: Column(
        children: List<Widget>.generate(
          3,
          (index) => Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Container(
              height: 92,
              decoration: BoxDecoration(
                color: LoopColors.basalt,
                borderRadius: LoopRadius.medium,
                border: Border.all(color: LoopColors.line),
              ),
              padding: const EdgeInsets.all(16),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 42,
                    height: 42,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: LoopColors.elevated,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Container(
                          height: 12,
                          width: 92,
                          color: LoopColors.elevated,
                        ),
                        const SizedBox(height: 12),
                        Container(height: 10, color: LoopColors.elevated),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class MarketCandleChart extends StatelessWidget {
  const MarketCandleChart({
    super.key,
    this.height = 220,
    this.showAxis = true,
    this.semanticLabel = 'Simulated candlestick chart, read-only preview',
  });

  final double height;
  final bool showAxis;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: semanticLabel,
      child: SizedBox(
        width: double.infinity,
        height: height,
        child: CustomPaint(
          painter: _CandlePainter(
            candles: CandlePreviewData.candles,
            showAxis: showAxis,
          ),
        ),
      ),
    );
  }
}

class _CandlePainter extends CustomPainter {
  const _CandlePainter({required this.candles, required this.showAxis});

  final List<CandlePreview> candles;
  final bool showAxis;

  @override
  void paint(Canvas canvas, Size size) {
    if (candles.isEmpty) return;
    final plotRight = showAxis ? size.width - 45 : size.width;
    final gridPaint = Paint()
      ..color = LoopColors.line.withValues(alpha: 0.7)
      ..strokeWidth = 1;
    for (var index = 0; index <= 4; index++) {
      final y = size.height * index / 4;
      canvas.drawLine(
        Offset.zero.translate(0, y),
        Offset(plotRight, y),
        gridPaint,
      );
    }
    for (var index = 0; index <= 5; index++) {
      final x = plotRight * index / 5;
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), gridPaint);
    }

    final low = candles.map((candle) => candle.low).reduce(math.min);
    final high = candles.map((candle) => candle.high).reduce(math.max);
    final span = math.max(high - low, 1);
    double yFor(double value) =>
        size.height - ((value - low) / span * (size.height - 16)) - 8;

    final slot = plotRight / candles.length;
    final bodyWidth = math.max(3.0, slot * 0.48);
    for (var index = 0; index < candles.length; index++) {
      final candle = candles[index];
      final color = candle.isUp ? LoopColors.mint : LoopColors.danger;
      final x = slot * index + slot / 2;
      canvas.drawLine(
        Offset(x, yFor(candle.high)),
        Offset(x, yFor(candle.low)),
        Paint()
          ..color = color
          ..strokeWidth = 1.25,
      );
      final top = math.min(yFor(candle.open), yFor(candle.close));
      final bottom = math.max(yFor(candle.open), yFor(candle.close));
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTRB(
            x - bodyWidth / 2,
            top,
            x + bodyWidth / 2,
            math.max(bottom, top + 2),
          ),
          const Radius.circular(1.5),
        ),
        Paint()..color = color,
      );
    }

    if (showAxis) {
      final painter = TextPainter(textDirection: TextDirection.ltr);
      for (var index = 0; index <= 4; index++) {
        final value = high - ((high - low) * index / 4);
        painter.text = TextSpan(
          text: value.toStringAsFixed(0),
          style: const TextStyle(
            color: LoopColors.vapor,
            fontSize: 9,
            fontFamily: 'monospace',
          ),
        );
        painter.layout();
        painter.paint(
          canvas,
          Offset(plotRight + 7, size.height * index / 4 - 5),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _CandlePainter oldDelegate) {
    return oldDelegate.candles != candles || oldDelegate.showAxis != showAxis;
  }
}

class MarketAssetRow extends StatelessWidget {
  const MarketAssetRow({
    required this.asset,
    required this.onTap,
    super.key,
    this.rank,
  });

  final MarketAssetPreview asset;
  final VoidCallback onTap;
  final int? rank;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      semanticLabel: 'Open ${asset.name} preview details',
      child: Row(
        children: <Widget>[
          if (rank != null) ...<Widget>[
            SizedBox(
              width: 22,
              child: Text(
                rank.toString().padLeft(2, '0'),
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  fontFamily: 'monospace',
                  color: LoopColors.line,
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          LoopAssetMark(symbol: asset.symbol),
          const SizedBox(width: 13),
          Expanded(
            flex: 6,
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
          Expanded(
            flex: 4,
            child: LoopMiniChart(
              points: asset.points,
              color: asset.isPositive ? LoopColors.mint : LoopColors.danger,
              height: 34,
              semanticLabel: '${asset.symbol} simulated 24 hour trend',
            ),
          ),
          const SizedBox(width: 13),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text(asset.price, style: context.dataStyle),
              const SizedBox(height: 5),
              Text(
                asset.change,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: asset.isPositive ? LoopColors.mint : LoopColors.danger,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
