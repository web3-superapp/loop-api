import 'package:flutter/material.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';

/// Explicit provider projection states used by every Market preview surface.
///
/// Only [preview] is allowed to render fixture facts. All other states hide
/// prices and provider-derived values so stale data cannot look actionable.
enum MarketSnapshotState {
  preview,
  loading,
  offline,
  stale,
  empty,
  regionBlocked,
}

@immutable
final class MarketAssetPreview {
  const MarketAssetPreview({
    required this.symbol,
    required this.name,
    required this.pair,
    required this.price,
    required this.change,
    required this.volume,
    required this.points,
    required this.color,
  });

  final String symbol;
  final String name;
  final String pair;
  final String price;
  final String change;
  final String volume;
  final List<double> points;
  final Color color;

  bool get isPositive => !change.startsWith('-');
}

abstract final class MarketPreviewData {
  static const String sourceLabel = 'LOOP preview · live feed not connected';
  static const String observedLabel = 'Snapshot 08:42 UTC · 24 Aug';

  static const List<MarketAssetPreview> coreAssets = <MarketAssetPreview>[
    MarketAssetPreview(
      symbol: 'BTC',
      name: 'Bitcoin',
      pair: 'BTC / USDC',
      price: '\$116,420.80',
      change: '+2.84%',
      volume: '\$2.18B',
      points: <double>[47, 48, 46, 51, 50, 54, 57, 55, 60, 63, 61, 66],
      color: LoopColors.chat,
    ),
    MarketAssetPreview(
      symbol: 'ETH',
      name: 'Ethereum',
      pair: 'ETH / USDC',
      price: '\$4,638.24',
      change: '+1.62%',
      volume: '\$1.06B',
      points: <double>[41, 43, 42, 45, 44, 48, 47, 51, 52, 50, 54, 56],
      color: LoopColors.market,
    ),
    MarketAssetPreview(
      symbol: 'SOL',
      name: 'Solana',
      pair: 'SOL / USDC',
      price: '\$218.74',
      change: '-0.48%',
      volume: '\$728.4M',
      points: <double>[59, 58, 60, 57, 56, 55, 57, 54, 53, 55, 52, 51],
      color: LoopColors.mint,
    ),
  ];

  static MarketAssetPreview asset(String symbol) {
    return coreAssets.firstWhere(
      (asset) => asset.symbol == symbol.toUpperCase(),
      orElse: () => coreAssets[1],
    );
  }
}

@immutable
final class CandlePreview {
  const CandlePreview({
    required this.open,
    required this.high,
    required this.low,
    required this.close,
  });

  final double open;
  final double high;
  final double low;
  final double close;

  bool get isUp => close >= open;
}

abstract final class CandlePreviewData {
  static const List<CandlePreview> candles = <CandlePreview>[
    CandlePreview(open: 42, high: 51, low: 39, close: 48),
    CandlePreview(open: 48, high: 54, low: 44, close: 46),
    CandlePreview(open: 46, high: 58, low: 45, close: 56),
    CandlePreview(open: 56, high: 61, low: 51, close: 53),
    CandlePreview(open: 53, high: 65, low: 52, close: 62),
    CandlePreview(open: 62, high: 68, low: 57, close: 59),
    CandlePreview(open: 59, high: 73, low: 58, close: 70),
    CandlePreview(open: 70, high: 76, low: 64, close: 67),
    CandlePreview(open: 67, high: 80, low: 66, close: 77),
    CandlePreview(open: 77, high: 82, low: 69, close: 72),
    CandlePreview(open: 72, high: 86, low: 71, close: 83),
    CandlePreview(open: 83, high: 89, low: 77, close: 80),
    CandlePreview(open: 80, high: 93, low: 78, close: 90),
    CandlePreview(open: 90, high: 96, low: 84, close: 87),
    CandlePreview(open: 87, high: 99, low: 86, close: 96),
    CandlePreview(open: 96, high: 101, low: 89, close: 92),
    CandlePreview(open: 92, high: 105, low: 91, close: 102),
    CandlePreview(open: 102, high: 108, low: 96, close: 104),
  ];
}
