import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';

abstract interface class HyperliquidTradingGateway {
  String get statusLabel;

  Future<SigningIntent> prepareFixtureOrder();
}

final hyperliquidTradingGatewayProvider = Provider<HyperliquidTradingGateway>(
  (ref) => throw StateError(
    'Hyperliquid production credentials are not configured. Override the '
    'gateway with an explicit fixture for UI previews.',
  ),
);
