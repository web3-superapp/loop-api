import 'package:loop_mobile/core/intent/signing_intent.dart';

enum WalletGatewayAvailability { available, unavailable, fixtureReadOnly }

final class WalletHandoffResult {
  const WalletHandoffResult({required this.accepted, required this.code});

  final bool accepted;
  final String code;
}

abstract interface class WalletSigningGateway {
  WalletGatewayAvailability get availability;

  String get label;

  Future<WalletHandoffResult> handoff(
    SigningIntent intent, {
    required DateTime now,
  });
}
