import 'package:flutter/material.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';

/// Hyperliquid projection states. Only [preview] may expose fixture facts.
enum PerpSnapshotState {
  preview,
  loading,
  offline,
  stale,
  empty,
  regionBlocked,
}

@immutable
final class PerpMarketPreview {
  const PerpMarketPreview({
    required this.symbol,
    required this.markPrice,
    required this.change,
    required this.funding,
    required this.openInterest,
    required this.volume,
    required this.points,
    required this.color,
  });

  final String symbol;
  final String markPrice;
  final String change;
  final String funding;
  final String openInterest;
  final String volume;
  final List<double> points;
  final Color color;

  bool get isPositive => !change.startsWith('-');
}

@immutable
final class PerpPositionPreview {
  const PerpPositionPreview({
    required this.id,
    required this.symbol,
    required this.side,
    required this.size,
    required this.entry,
    required this.mark,
    required this.pnl,
    required this.leverage,
    required this.liquidation,
    required this.margin,
  });

  final String id;
  final String symbol;
  final String side;
  final String size;
  final String entry;
  final String mark;
  final String pnl;
  final String leverage;
  final String liquidation;
  final String margin;
}

abstract final class PerpPreviewData {
  static const String sourceLabel = 'Hyperliquid preview · read-only';
  static const String observedLabel = 'Captured 08:42 UTC · 24 Aug';

  static const List<PerpMarketPreview> markets = <PerpMarketPreview>[
    PerpMarketPreview(
      symbol: 'BTC',
      markPrice: '116,418.2',
      change: '+2.81%',
      funding: '0.0100%',
      openInterest: '\$4.82B',
      volume: '\$8.16B',
      points: <double>[45, 47, 46, 50, 52, 51, 56, 58, 57, 62, 61, 65],
      color: LoopColors.chat,
    ),
    PerpMarketPreview(
      symbol: 'ETH',
      markPrice: '4,630.50',
      change: '+1.58%',
      funding: '0.0082%',
      openInterest: '\$2.36B',
      volume: '\$3.90B',
      points: <double>[40, 42, 41, 44, 46, 45, 49, 50, 48, 53, 52, 55],
      color: LoopColors.market,
    ),
    PerpMarketPreview(
      symbol: 'SOL',
      markPrice: '218.68',
      change: '-0.52%',
      funding: '-0.0021%',
      openInterest: '\$812.4M',
      volume: '\$1.44B',
      points: <double>[58, 59, 57, 56, 58, 55, 54, 56, 53, 52, 54, 51],
      color: LoopColors.mint,
    ),
  ];

  static const PerpPositionPreview ethPosition = PerpPositionPreview(
    id: 'fixture-position-eth-001',
    symbol: 'ETH',
    side: 'Long',
    size: '1.25 ETH',
    entry: '4,580.20',
    mark: '4,630.50',
    pnl: '+62.88 USDC',
    leverage: '20×',
    liquidation: '4,410.00',
    margin: '289.41 USDC',
  );

  static PerpMarketPreview market(String symbol) {
    return markets.firstWhere(
      (market) => market.symbol == symbol.toUpperCase(),
      orElse: () => markets[1],
    );
  }

  static SigningIntent previewOrderIntent({String symbol = 'ETH'}) {
    final market = PerpPreviewData.market(symbol);
    final now = DateTime.now().toUtc();
    return SigningIntent.perpOrder(
      revision:
          'preview-${market.symbol.toLowerCase()}-${now.microsecondsSinceEpoch}',
      market: market.symbol,
      direction: OrderDirection.buy,
      orderType: PerpOrderType.market,
      size: market.symbol == 'BTC'
          ? '0.05'
          : market.symbol == 'SOL'
          ? '25'
          : '1.25',
      leverage: 20,
      price: market.markPrice,
      margin: '289.41 USDC',
      fee: '2.89 USDC',
      builderFee: '0 USDC',
      liquidationEstimate: market.symbol == 'BTC'
          ? '110,590.00'
          : market.symbol == 'SOL'
          ? '207.70'
          : '4,410.00',
      observedAt: now,
      expiresAt: now.add(const Duration(minutes: 2)),
    );
  }
}
