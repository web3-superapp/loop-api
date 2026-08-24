import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:loop_mobile/integrations/privy/privy_production_adapter.dart';
import 'package:loop_mobile/integrations/privy/wallet_signing_gateway.dart';

final walletSigningGatewayProvider = Provider<WalletSigningGateway>(
  (ref) => const PrivyProductionAdapter(
    appId: String.fromEnvironment('PRIVY_APP_ID'),
    appClientId: String.fromEnvironment('PRIVY_APP_CLIENT_ID'),
  ),
);
