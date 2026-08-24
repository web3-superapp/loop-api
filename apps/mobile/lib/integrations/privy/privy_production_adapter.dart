import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/integrations/privy/wallet_signing_gateway.dart';

final class PrivyProductionAdapter implements WalletSigningGateway {
  const PrivyProductionAdapter({
    required this.appId,
    required this.appClientId,
  });

  final String appId;
  final String appClientId;

  @override
  WalletGatewayAvailability get availability {
    if (appId.trim().isEmpty || appClientId.trim().isEmpty) {
      return WalletGatewayAvailability.unavailable;
    }
    return WalletGatewayAvailability.available;
  }

  @override
  String get label => 'Privy';

  @override
  Future<WalletHandoffResult> handoff(
    SigningIntent intent, {
    required DateTime now,
  }) async {
    if (availability == WalletGatewayAvailability.unavailable) {
      return const WalletHandoffResult(
        accepted: false,
        code: 'privy_credentials_missing',
      );
    }
    final validation = intent.validateAt(now);
    if (validation != null) {
      return WalletHandoffResult(accepted: false, code: validation);
    }
    return const WalletHandoffResult(
      accepted: false,
      code: 'privy_handoff_not_configured',
    );
  }
}
