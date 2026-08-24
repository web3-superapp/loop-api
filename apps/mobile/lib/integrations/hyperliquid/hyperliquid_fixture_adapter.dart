import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_trading_gateway.dart';

final class HyperliquidFixtureAdapter implements HyperliquidTradingGateway {
  const HyperliquidFixtureAdapter();

  @override
  String get statusLabel => 'Hyperliquid preview · read-only';

  @override
  Future<SigningIntent> prepareFixtureOrder() async {
    final now = DateTime.now().toUtc();
    return SigningIntent.perpOrder(
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
  }
}
