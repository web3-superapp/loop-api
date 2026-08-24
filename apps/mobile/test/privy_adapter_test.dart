import 'package:flutter_test/flutter_test.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/integrations/privy/privy_fixture_adapter.dart';
import 'package:loop_mobile/integrations/privy/privy_production_adapter.dart';
import 'package:loop_mobile/integrations/privy/wallet_signing_gateway.dart';

void main() {
  final now = DateTime.utc(2026, 8, 24, 8);
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

  test('production Privy adapter fails closed without credentials', () async {
    final adapter = PrivyProductionAdapter(appId: '', appClientId: '');

    expect(adapter.availability, WalletGatewayAvailability.unavailable);
    final result = await adapter.handoff(intent, now: now);
    expect(result.accepted, isFalse);
    expect(result.code, 'privy_credentials_missing');
  });

  test(
    'fixture adapter is explicitly read-only and never claims signing',
    () async {
      const adapter = PrivyFixtureAdapter();

      expect(adapter.availability, WalletGatewayAvailability.fixtureReadOnly);
      expect(adapter.label, contains('preview'));
      expect(adapter.label, contains('signing unavailable'));
      final result = await adapter.handoff(intent, now: now);
      expect(result.accepted, isFalse);
      expect(result.code, 'fixture_read_only');
    },
  );
}
