import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/integrations/privy/wallet_signing_gateway.dart';

final class PrivyFixtureAdapter implements WalletSigningGateway {
  const PrivyFixtureAdapter();

  @override
  WalletGatewayAvailability get availability =>
      WalletGatewayAvailability.fixtureReadOnly;

  @override
  String get label => 'Privy preview · signing unavailable';

  @override
  Future<WalletHandoffResult> handoff(
    SigningIntent intent, {
    required DateTime now,
  }) async {
    return const WalletHandoffResult(
      accepted: false,
      code: 'fixture_read_only',
    );
  }
}
