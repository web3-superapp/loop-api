import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/navigation/surface_catalog.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/account/account_screens.dart';
import 'package:loop_mobile/features/catalog/catalog_surface_screen.dart';
import 'package:loop_mobile/features/chat/chat.dart';
import 'package:loop_mobile/features/home/home_screens.dart';
import 'package:loop_mobile/features/launchpad/launchpad_screen.dart';
import 'package:loop_mobile/features/market/market.dart';
import 'package:loop_mobile/features/perp/perp.dart';
import 'package:loop_mobile/features/profile/profile_screens.dart';
import 'package:loop_mobile/features/review/signing_review_surface.dart';
import 'package:loop_mobile/features/shell/loop_shell.dart';
import 'package:loop_mobile/features/system/system_surfaces.dart';
import 'package:loop_mobile/features/wallet/wallet_screens.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class LoopApp extends StatefulWidget {
  const LoopApp({super.key});

  @override
  State<LoopApp> createState() => _LoopAppState();
}

class _LoopAppState extends State<LoopApp> {
  late final GoRouter router = _buildRouter();

  @override
  void dispose() {
    router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'LOOP',
      debugShowCheckedModeBanner: false,
      theme: LoopTheme.dark,
      darkTheme: LoopTheme.dark,
      themeMode: ThemeMode.dark,
      routerConfig: router,
    );
  }
}

GoRouter _buildRouter() {
  return GoRouter(
    initialLocation: '/home',
    routes: <RouteBase>[
      GoRoute(path: '/', redirect: (context, state) => '/home'),
      ShellRoute(
        builder: (context, state, child) =>
            LoopShell(location: state.uri.path, child: child),
        routes: <RouteBase>[
          GoRoute(
            path: '/home',
            builder: (context, state) => const HomeScreen(),
          ),
          GoRoute(
            path: '/market',
            builder: (context, state) => const MarketScreen(),
          ),
          GoRoute(
            path: '/launchpad',
            builder: (context, state) => const LaunchpadScreen(),
          ),
          GoRoute(
            path: '/chat',
            builder: (context, state) => const ChatInboxPage(),
          ),
          GoRoute(
            path: '/wallet',
            builder: (context, state) => const WalletScreen(),
          ),
          GoRoute(
            path: '/profile',
            builder: (context, state) => _profileScreen(context, 'profile'),
          ),
        ],
      ),
      ..._accountRoutes,
      GoRoute(
        path: '/home/net-worth',
        builder: (context, state) => const NetWorthScreen(),
      ),
      GoRoute(
        path: '/notifications',
        builder: (context, state) => const NotificationsScreen(),
      ),
      GoRoute(
        path: '/search',
        builder: (context, state) => const GlobalSearchScreen(),
      ),
      GoRoute(
        path: '/home/security',
        builder: (context, state) => const SecurityActivityScreen(),
      ),
      GoRoute(
        path: '/market/token',
        builder: (context, state) => TokenDetailScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/market/chart',
        builder: (context, state) => FullChartScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/market/new',
        builder: (context, state) => const NewPairsScreen(),
      ),
      GoRoute(
        path: '/market/holders',
        builder: (context, state) => HolderDistributionScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/market/trades',
        builder: (context, state) => TradingActivityScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/market/watchlist',
        builder: (context, state) => const WatchlistEditorScreen(),
      ),
      GoRoute(
        path: '/market/alerts',
        builder: (context, state) => PriceAlertsScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/market/smart-money',
        builder: (context, state) => const SmartMoneyScreen(),
      ),
      GoRoute(
        path: '/perp',
        builder: (context, state) => const PerpMarketScreen(),
      ),
      GoRoute(
        path: '/perp/trade',
        builder: (context, state) => PerpTradeScreen(
          symbol: state.extra is String ? state.extra! as String : 'ETH',
        ),
      ),
      GoRoute(
        path: '/perp/confirm',
        builder: (context, state) => PerpConfirmScreen(
          intent: state.extra is SigningIntent
              ? state.extra! as SigningIntent
              : null,
        ),
      ),
      GoRoute(
        path: '/perp/positions',
        builder: (context, state) => const PerpPositionsScreen(),
      ),
      GoRoute(
        path: '/perp/position',
        builder: (context, state) => const PerpPositionScreen(),
      ),
      GoRoute(
        path: '/perp/orders',
        builder: (context, state) => const PerpOrdersScreen(),
      ),
      GoRoute(
        path: '/perp/history',
        builder: (context, state) => const PerpHistoryScreen(),
      ),
      GoRoute(
        path: '/perp/account',
        builder: (context, state) => const PerpAccountScreen(),
      ),
      GoRoute(
        path: '/perp/transfer',
        builder: (context, state) => const PerpTransferScreen(),
      ),
      GoRoute(
        path: '/perp/deposit',
        builder: (context, state) => const PerpDepositScreen(),
      ),
      GoRoute(
        path: '/perp/funding',
        builder: (context, state) => const PerpFundingScreen(),
      ),
      GoRoute(
        path: '/perp/risk',
        builder: (context, state) => const PerpRiskScreen(),
      ),
      GoRoute(
        path: '/chat/group',
        builder: (context, state) => const GroupChatPage(),
      ),
      GoRoute(
        path: '/chat/dm',
        builder: (context, state) => const DirectMessagePage(),
      ),
      GoRoute(
        path: '/chat/voice',
        builder: (context, state) => const VoiceRoomPage(),
      ),
      GoRoute(
        path: '/chat/voice/full',
        builder: (context, state) => const VoiceRoomPage(),
      ),
      GoRoute(
        path: '/chat/group-info',
        builder: (context, state) => const GroupInfoPage(),
      ),
      GoRoute(
        path: '/chat/requests',
        builder: (context, state) => const MessageRequestsPage(),
      ),
      GoRoute(
        path: '/chat/search',
        builder: (context, state) => const MessageSearchPage(),
      ),
      GoRoute(
        path: '/chat/meeting',
        builder: (context, state) => const MeetingPlaceholderPage(),
      ),
      GoRoute(
        path: '/preview/token-card',
        builder: (context, state) => const TokenCardPreviewPage(),
      ),
      GoRoute(
        path: '/preview/contract-facts',
        builder: (context, state) => const ContractFactsPreviewPage(),
      ),
      GoRoute(
        path: '/preview/asset-message',
        builder: (context, state) => const AssetMessagePreviewPage(),
      ),
      GoRoute(
        path: '/wallet/asset',
        builder: (context, state) => const AssetDetailScreen(),
      ),
      GoRoute(
        path: '/wallet/send',
        builder: (context, state) => const SendAssetScreen(),
      ),
      GoRoute(
        path: '/wallet/send/to',
        builder: (context, state) => const SendRecipientScreen(),
      ),
      GoRoute(
        path: '/wallet/send/confirm',
        builder: (context, state) => const SendConfirmScreen(),
      ),
      GoRoute(
        path: '/wallet/receive',
        builder: (context, state) => const ReceiveScreen(),
      ),
      GoRoute(
        path: '/wallet/swap',
        builder: (context, state) => const SwapScreen(),
      ),
      GoRoute(
        path: '/wallet/swap/route',
        builder: (context, state) => const SwapRouteScreen(),
      ),
      GoRoute(
        path: '/wallet/bridge',
        builder: (context, state) => const BridgeScreen(),
      ),
      GoRoute(
        path: '/wallet/bridge/status',
        builder: (context, state) => const BridgeStatusScreen(),
      ),
      GoRoute(
        path: '/wallet/transaction',
        builder: (context, state) => const TransactionResultScreen(),
      ),
      GoRoute(
        path: '/wallet/history',
        builder: (context, state) => const TransactionHistoryScreen(),
      ),
      GoRoute(
        path: '/wallet/manage',
        builder: (context, state) => const WalletManagerScreen(),
      ),
      GoRoute(
        path: '/wallet/dapp',
        builder: (context, state) => const DappBrowserScreen(),
      ),
      GoRoute(
        path: '/preview/approval',
        builder: (context, state) => const ApprovalInterceptScreen(),
      ),
      GoRoute(
        path: '/wallet/approvals',
        builder: (context, state) => const ApprovalsScreen(),
      ),
      GoRoute(
        path: '/wallet/dapps',
        builder: (context, state) => const DappListScreen(),
      ),
      GoRoute(
        path: '/wallet/networks',
        builder: (context, state) => const NetworksScreen(),
      ),
      GoRoute(
        path: '/wallet/protection',
        builder: (context, state) => const ProtectionScreen(),
      ),
      GoRoute(
        path: '/preview/signing-review',
        builder: (context, state) => SigningReviewPage(
          intent: state.extra is SigningIntent
              ? state.extra! as SigningIntent
              : _previewIntent(),
        ),
      ),
      ..._profileRoutes,
      ..._systemRoutes,
      GoRoute(
        path: '/inventory',
        builder: (context, state) => const UiInventoryScreen(),
      ),
      ..._catalogRoutes,
    ],
    errorBuilder: (context, state) =>
        UnknownRouteScreen(location: state.uri.toString()),
  );
}

final List<RouteBase> _accountRoutes =
    <(String, String)>[
          ('/splash', 'splash'),
          ('/onboarding', 'onboarding'),
          ('/auth', 'auth'),
          ('/auth/otp', 'auth-otp'),
          ('/auth/wallet', 'auth-wallet'),
          ('/auth/wallet/create', 'wallet-create'),
          ('/auth/wallet/backup', 'wallet-backup'),
          ('/auth/wallet/seed', 'seed-show'),
          ('/auth/wallet/seed/verify', 'seed-verify'),
          ('/auth/wallet/import', 'wallet-import'),
          ('/auth/security', 'security-setup'),
          ('/auth/profile', 'profile-setup'),
        ]
        .map((item) {
          return GoRoute(
            path: item.$1,
            builder: (context, state) => AccountSurfaceScreen.fromId(
              item.$2,
              onNavigate: (destination) =>
                  context.go(_accountPath(destination)),
            ),
          );
        })
        .toList(growable: false);

final List<RouteBase> _profileRoutes =
    <(String, String)>[
          ('/profile/edit', 'profile-edit'),
          ('/profile/privacy', 'privacy'),
          ('/profile/copy', 'copytrade-perms'),
          ('/profile/security', 'security'),
          ('/profile/devices', 'devices'),
          ('/profile/recovery', 'seed-backup'),
          ('/profile/social-recovery', 'social-recovery'),
          ('/profile/notifications', 'notif-settings'),
          ('/profile/connections', 'connections'),
          ('/profile/blocked', 'blocklist'),
          ('/profile/settings', 'settings'),
          ('/profile/about', 'about'),
          ('/profile/help', 'support'),
          ('/profile/rewards', 'mining'),
          ('/profile/referral', 'referral'),
        ]
        .map((item) {
          return GoRoute(
            path: item.$1,
            builder: (context, state) => _profileScreen(context, item.$2),
          );
        })
        .toList(growable: false);

final List<RouteBase> _systemRoutes =
    <(String, String)>[
          ('/system/offline', 'offline'),
          ('/system/error', 'server-error'),
          ('/system/update', 'force-update'),
          ('/system/maintenance', 'maintenance'),
          ('/system/region', 'region-restricted'),
          ('/system/permission', 'permission'),
          ('/preview/toast', 'toast'),
          ('/preview/loading', 'loading'),
        ]
        .map((item) {
          return GoRoute(
            path: item.$1,
            builder: (context, state) => SystemSurfaceScreen.fromId(
              item.$2,
              onRetry: () => context.go('/home'),
              onSecondaryAction: () => context.go('/home'),
              onPrimaryAction: () => ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text(
                    'This action requires the production app host.',
                  ),
                ),
              ),
            ),
          );
        })
        .toList(growable: false);

Widget _profileScreen(BuildContext context, String id) {
  return ProfileSurfaceScreen.fromId(
    id,
    onNavigate: (destination) => context.push(_profilePath(destination)),
  );
}

String _accountPath(String id) => switch (id) {
  'splash' => '/splash',
  'onboarding' => '/onboarding',
  'auth' => '/auth',
  'auth-otp' => '/auth/otp',
  'auth-wallet' => '/auth/wallet',
  'wallet-create' => '/auth/wallet/create',
  'wallet-backup' => '/auth/wallet/backup',
  'seed-show' => '/auth/wallet/seed',
  'seed-verify' => '/auth/wallet/seed/verify',
  'wallet-import' => '/auth/wallet/import',
  'security-setup' => '/auth/security',
  'profile-setup' => '/auth/profile',
  'home' => '/home',
  _ => '/auth',
};

String _profilePath(String id) => switch (id) {
  'profile' => '/profile',
  'profile-edit' => '/profile/edit',
  'privacy' => '/profile/privacy',
  'copytrade-perms' => '/profile/copy',
  'security' => '/profile/security',
  'devices' => '/profile/devices',
  'seed-backup' => '/profile/recovery',
  'social-recovery' => '/profile/social-recovery',
  'notif-settings' => '/profile/notifications',
  'connections' => '/profile/connections',
  'blocklist' => '/profile/blocked',
  'settings' => '/profile/settings',
  'about' => '/profile/about',
  'support' => '/profile/help',
  'mining' => '/profile/rewards',
  'referral' => '/profile/referral',
  _ => '/profile',
};

abstract final class LoopRouteRegistry {
  static const Set<String> customSurfacePaths = <String>{
    '/splash',
    '/onboarding',
    '/auth',
    '/auth/otp',
    '/auth/wallet',
    '/auth/wallet/create',
    '/auth/wallet/backup',
    '/auth/wallet/seed',
    '/auth/wallet/seed/verify',
    '/auth/wallet/import',
    '/auth/security',
    '/auth/profile',
    '/home',
    '/home/net-worth',
    '/notifications',
    '/search',
    '/home/security',
    '/market',
    '/market/token',
    '/market/chart',
    '/market/new',
    '/market/holders',
    '/market/trades',
    '/market/watchlist',
    '/market/alerts',
    '/market/smart-money',
    '/perp',
    '/perp/trade',
    '/perp/confirm',
    '/perp/positions',
    '/perp/position',
    '/perp/orders',
    '/perp/history',
    '/perp/account',
    '/perp/transfer',
    '/perp/deposit',
    '/perp/funding',
    '/perp/risk',
    '/chat',
    '/chat/group',
    '/chat/voice',
    '/chat/dm',
    '/chat/group-info',
    '/chat/voice/full',
    '/chat/requests',
    '/chat/search',
    '/chat/meeting',
    '/preview/token-card',
    '/preview/contract-facts',
    '/preview/asset-message',
    '/wallet',
    '/wallet/asset',
    '/wallet/send',
    '/wallet/send/to',
    '/wallet/send/confirm',
    '/wallet/receive',
    '/wallet/swap',
    '/wallet/swap/route',
    '/wallet/bridge',
    '/wallet/bridge/status',
    '/preview/signing-review',
    '/wallet/transaction',
    '/wallet/history',
    '/wallet/manage',
    '/wallet/dapp',
    '/preview/approval',
    '/wallet/approvals',
    '/wallet/dapps',
    '/wallet/networks',
    '/wallet/protection',
    '/launchpad',
    '/profile',
    '/profile/edit',
    '/profile/privacy',
    '/profile/copy',
    '/profile/security',
    '/profile/devices',
    '/profile/recovery',
    '/profile/social-recovery',
    '/profile/notifications',
    '/profile/connections',
    '/profile/blocked',
    '/profile/settings',
    '/profile/about',
    '/profile/help',
    '/profile/rewards',
    '/profile/referral',
    '/system/offline',
    '/system/error',
    '/system/update',
    '/system/maintenance',
    '/system/region',
    '/system/permission',
    '/preview/toast',
    '/preview/loading',
  };
}

final List<RouteBase> _catalogRoutes = SurfaceCatalog.all
    .where(
      (surface) => !LoopRouteRegistry.customSurfacePaths.contains(surface.path),
    )
    .map(
      (surface) => GoRoute(
        path: surface.path,
        builder: (context, state) => CatalogSurfaceScreen(surface: surface),
      ),
    )
    .toList(growable: false);

SigningIntent _previewIntent() {
  final now = DateTime.now().toUtc();
  return SigningIntent.transfer(
    revision: 'preview_transfer_0001',
    asset: 'ETH',
    amount: '0.25 ETH',
    recipient: '0xA1c0F6B39D3b9B0C5e7A8426CF52AaFB1fA888C2',
    network: 'Ethereum',
    fee: '0.00042 ETH',
    observedAt: now,
    expiresAt: now.add(const Duration(minutes: 5)),
  );
}

class UnknownRouteScreen extends StatelessWidget {
  const UnknownRouteScreen({required this.location, super.key});

  final String location;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Route not found',
      eyebrow: '404',
      subtitle: location,
      children: <Widget>[
        LoopStateCard(
          title: 'This surface is not in the product map',
          message: 'Return home or inspect the full UI inventory.',
          icon: Icons.route_outlined,
          tone: LoopTone.warning,
          action: Wrap(
            spacing: 10,
            children: <Widget>[
              FilledButton(
                onPressed: () => context.go('/home'),
                child: const Text('Go home'),
              ),
              OutlinedButton(
                onPressed: () => context.go('/inventory'),
                child: const Text('UI inventory'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
