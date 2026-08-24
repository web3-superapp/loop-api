import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:loop_mobile/app.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_fixture_adapter.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_trading_gateway.dart';
import 'package:loop_mobile/integrations/privy/privy_fixture_adapter.dart';
import 'package:loop_mobile/integrations/privy/privy_provider.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    ProviderScope(
      overrides: [
        hyperliquidTradingGatewayProvider.overrideWithValue(
          const HyperliquidFixtureAdapter(),
        ),
        walletSigningGatewayProvider.overrideWithValue(
          const PrivyFixtureAdapter(),
        ),
      ],
      child: const LoopApp(),
    ),
  );
}
