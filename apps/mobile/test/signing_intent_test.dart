import 'package:flutter_test/flutter_test.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';

void main() {
  group('SigningIntent', () {
    final now = DateTime.utc(2026, 8, 24, 8);

    test('accepts one canonical Core perp intent', () {
      final intent = SigningIntent.perpOrder(
        revision: 'intent_core_eth_0001',
        market: 'ETH',
        direction: OrderDirection.buy,
        orderType: PerpOrderType.market,
        size: '1.25',
        leverage: 20,
        price: '4630.50',
        margin: '289.41 USDC',
        fee: '2.89 USDC',
        builderFee: '0 USDC',
        liquidationEstimate: '4410.00',
        observedAt: now,
        expiresAt: now.add(const Duration(seconds: 15)),
      );

      expect(intent.validateAt(now), isNull);
      expect(intent.authority, SigningAuthority.privy);
      expect(intent.provider, IntentProvider.hyperliquidCore);
      expect(
        intent.fields.map((field) => field.label),
        containsAll(<String>[
          'Direction',
          'Order type',
          'Price',
          'Size',
          'Leverage',
          'Margin',
          'Fee',
          'Builder fee',
          'Liquidation estimate',
        ]),
      );
    });

    test('rejects stale, HIP-3-shaped, or builder-fee intents', () {
      SigningIntent candidate({
        String market = 'ETH',
        String builderFee = '0 USDC',
        DateTime? expiresAt,
      }) => SigningIntent.perpOrder(
        revision: 'intent_core_eth_0001',
        market: market,
        direction: OrderDirection.buy,
        orderType: PerpOrderType.market,
        size: '1.25',
        leverage: 20,
        price: '4630.50',
        margin: '289.41 USDC',
        fee: '2.89 USDC',
        builderFee: builderFee,
        liquidationEstimate: '4410.00',
        observedAt: now,
        expiresAt: expiresAt ?? now.add(const Duration(seconds: 15)),
      );

      expect(candidate(market: 'xyz:HIP3').validateAt(now), 'market_not_core');
      expect(
        candidate(builderFee: '1 USDC').validateAt(now),
        'builder_fee_forbidden',
      );
      expect(candidate(expiresAt: now).validateAt(now), 'intent_stale');
    });
  });
}
