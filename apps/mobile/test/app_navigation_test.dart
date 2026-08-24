import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:loop_mobile/app.dart';
import 'package:loop_mobile/features/review/signing_review_surface.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_fixture_adapter.dart';
import 'package:loop_mobile/integrations/hyperliquid/hyperliquid_trading_gateway.dart';

void main() {
  testWidgets('navigates the six primary destinations with one shell', (
    tester,
  ) async {
    await tester.pumpWidget(const ProviderScope(child: LoopApp()));
    await tester.pumpAndSettle();

    expect(find.text('Home overview'), findsOneWidget);
    for (final destination in <String>[
      'Market',
      'Launch',
      'Chat',
      'Wallet',
      'Profile',
      'Home',
    ]) {
      await tester.tap(find.widgetWithText(NavigationDestination, destination));
      await tester.pumpAndSettle();
    }
    expect(find.text('Home overview'), findsOneWidget);
  });

  testWidgets('fixture Perp order opens exactly one shared F11 surface', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          hyperliquidTradingGatewayProvider.overrideWithValue(
            const HyperliquidFixtureAdapter(),
          ),
        ],
        child: const LoopApp(),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(NavigationDestination, 'Market'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Perpetual'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('ETH-PERP'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ETH-PERP'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review preview order'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue to Privy review'));
    await tester.pumpAndSettle();

    expect(find.byType(SigningReviewSurface), findsOneWidget);
    expect(find.text('Privy signing review'), findsOneWidget);
    expect(find.text('1.25'), findsOneWidget);
    expect(find.text('20×'), findsOneWidget);
  });
}
