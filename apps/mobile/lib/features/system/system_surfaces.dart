import 'package:flutter/material.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

enum LoopConnectivityScope {
  fullyOffline,
  marketDataUnavailable,
  tradingServiceUnavailable,
}

enum LoopPermissionKind { camera, notifications, biometrics }

enum LoopNoticeKind { success, warning, error }

enum LoopSkeletonKind { list, detail, chart }

typedef SystemAction = void Function();

/// Single routing surface for global system UI I1-I8.
class SystemSurfaceScreen extends StatelessWidget {
  const SystemSurfaceScreen.fromId(
    this.surfaceId, {
    super.key,
    this.onRetry,
    this.onPrimaryAction,
    this.onSecondaryAction,
    this.connectivityScope = LoopConnectivityScope.fullyOffline,
    this.permissionKind = LoopPermissionKind.camera,
    this.permissionDenied = false,
    this.supportCode = 'L-2048',
    this.maintenanceWindow = '01:00–01:30 UTC',
    this.restrictedFeatures = const <String>[
      'Perpetual trading',
      'Deposits and withdrawals',
    ],
  });

  static const supportedIds = <String>{
    'offline',
    'server-error',
    'force-update',
    'maintenance',
    'region-restricted',
    'permission',
    'toast',
    'loading',
  };

  final String surfaceId;
  final SystemAction? onRetry;
  final SystemAction? onPrimaryAction;
  final SystemAction? onSecondaryAction;
  final LoopConnectivityScope connectivityScope;
  final LoopPermissionKind permissionKind;
  final bool permissionDenied;
  final String supportCode;
  final String maintenanceWindow;
  final List<String> restrictedFeatures;

  String get _id => surfaceId.replaceFirst('#', '').toLowerCase();

  @override
  Widget build(BuildContext context) {
    return switch (_id) {
      'offline' => _ConnectivityScreen(
        scope: connectivityScope,
        onRetry: onRetry,
        onContinue: onSecondaryAction,
      ),
      'server-error' => _ServerErrorScreen(
        supportCode: supportCode,
        onRetry: onRetry,
        onSupport: onSecondaryAction,
      ),
      'force-update' => _ForceUpdateScreen(onUpdate: onPrimaryAction),
      'maintenance' => _MaintenanceScreen(
        window: maintenanceWindow,
        onRetry: onRetry,
        onStatus: onSecondaryAction,
      ),
      'region-restricted' => _RegionRestrictedScreen(
        features: restrictedFeatures,
        onContinue: onSecondaryAction,
      ),
      'permission' => _PermissionScreen(
        kind: permissionKind,
        denied: permissionDenied,
        onContinue: onPrimaryAction,
        onNotNow: onSecondaryAction,
      ),
      'toast' => const _NoticeGallery(),
      'loading' => const _SkeletonGallery(),
      _ => const _UnknownSystemScreen(),
    };
  }
}

/// Compact app-wide connectivity banner for I1.
class LoopConnectivityBanner extends StatelessWidget {
  const LoopConnectivityBanner({required this.scope, super.key, this.onRetry});

  final LoopConnectivityScope scope;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final content = _connectivityContent(scope);
    return Material(
      color: content.color.withValues(alpha: 0.12),
      child: SafeArea(
        bottom: false,
        child: Semantics(
          liveRegion: true,
          label: '${content.title}. ${content.message}',
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: content.color.withValues(alpha: 0.32),
                ),
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(content.icon, color: content.color, size: 19),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    content.banner,
                    style: Theme.of(
                      context,
                    ).textTheme.labelLarge?.copyWith(color: content.color),
                  ),
                ),
                if (onRetry != null)
                  TextButton(onPressed: onRetry, child: const Text('Retry')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// I7 success/warning/error notice. Suitable for Overlay or Snackbar hosts.
class LoopGlobalNotice extends StatelessWidget {
  const LoopGlobalNotice({
    required this.kind,
    required this.message,
    super.key,
    this.actionLabel,
    this.onAction,
    this.onDismiss,
  });

  final LoopNoticeKind kind;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final (color, icon, label) = switch (kind) {
      LoopNoticeKind.success => (
        LoopColors.mint,
        Icons.check_circle_outline_rounded,
        'Success',
      ),
      LoopNoticeKind.warning => (
        LoopColors.warning,
        Icons.warning_amber_rounded,
        'Warning',
      ),
      LoopNoticeKind.error => (
        LoopColors.danger,
        Icons.error_outline_rounded,
        'Error',
      ),
    };
    return Semantics(
      liveRegion: true,
      label: '$label. $message',
      child: Material(
        color: LoopColors.basalt,
        borderRadius: LoopRadius.medium,
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
          decoration: BoxDecoration(
            borderRadius: LoopRadius.medium,
            border: Border.all(color: color.withValues(alpha: 0.38)),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: LoopColors.abyss.withValues(alpha: 0.38),
                blurRadius: 22,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            children: <Widget>[
              Icon(icon, color: color, size: 21),
              const SizedBox(width: 11),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
              ),
              if (actionLabel != null && onAction != null)
                TextButton(onPressed: onAction, child: Text(actionLabel!)),
              if (onDismiss != null)
                IconButton(
                  tooltip: 'Dismiss',
                  onPressed: onDismiss,
                  icon: const Icon(Icons.close_rounded, size: 19),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// I8 reusable skeleton. It intentionally does not shimmer, so reduced-motion
/// users and ordinary users receive the same calm loading state.
class LoopSkeletonView extends StatelessWidget {
  const LoopSkeletonView({required this.kind, super.key, this.itemCount = 4});

  final LoopSkeletonKind kind;
  final int itemCount;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading content',
      child: ExcludeSemantics(
        child: switch (kind) {
          LoopSkeletonKind.list => _ListSkeleton(itemCount: itemCount),
          LoopSkeletonKind.detail => const _DetailSkeleton(),
          LoopSkeletonKind.chart => const _ChartSkeleton(),
        },
      ),
    );
  }
}

Future<void> showLoopForceUpdateDialog(
  BuildContext context, {
  required VoidCallback onUpdate,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (context) => PopScope(
      canPop: false,
      child: AlertDialog(
        icon: const Icon(
          Icons.system_update_alt_rounded,
          color: LoopColors.mint,
          size: 34,
        ),
        title: const Text('Update LOOP to continue'),
        content: const Text(
          'This version can no longer protect account and trading flows correctly. Install the latest version before using the app.',
        ),
        actions: <Widget>[
          FilledButton(onPressed: onUpdate, child: const Text('Update now')),
        ],
      ),
    ),
  );
}

class _ConnectivityScreen extends StatelessWidget {
  const _ConnectivityScreen({
    required this.scope,
    required this.onRetry,
    required this.onContinue,
  });

  final LoopConnectivityScope scope;
  final VoidCallback? onRetry;
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    final content = _connectivityContent(scope);
    final fullyOffline = scope == LoopConnectivityScope.fullyOffline;
    return _SystemStateScaffold(
      eyebrow: fullyOffline ? 'NO CONNECTION' : 'SERVICE INTERRUPTED',
      title: content.title,
      message: content.message,
      icon: content.icon,
      tone: content.color,
      primaryLabel: 'Try again',
      onPrimary: onRetry,
      secondaryLabel: fullyOffline
          ? 'Use downloaded content'
          : 'Continue with available features',
      onSecondary: onContinue,
      detail: fullyOffline
          ? 'Live prices, messages, balances, and orders may be out of date while you’re offline.'
          : 'Other parts of LOOP remain available. Affected actions stay disabled until the service recovers.',
    );
  }
}

class _ServerErrorScreen extends StatelessWidget {
  const _ServerErrorScreen({
    required this.supportCode,
    required this.onRetry,
    required this.onSupport,
  });

  final String supportCode;
  final VoidCallback? onRetry;
  final VoidCallback? onSupport;

  @override
  Widget build(BuildContext context) {
    return _SystemStateScaffold(
      eyebrow: 'SERVICE ERROR',
      title: 'LOOP couldn’t finish that',
      message:
          'Your request did not complete. No account or wallet change should be assumed until the latest status is confirmed.',
      icon: Icons.cloud_off_outlined,
      tone: LoopColors.danger,
      primaryLabel: 'Try again',
      onPrimary: onRetry,
      secondaryLabel: 'Contact support',
      onSecondary: onSupport,
      detail: 'Support code · $supportCode',
    );
  }
}

class _ForceUpdateScreen extends StatelessWidget {
  const _ForceUpdateScreen({required this.onUpdate});

  final VoidCallback? onUpdate;

  @override
  Widget build(BuildContext context) {
    return _SystemStateScaffold(
      eyebrow: 'UPDATE REQUIRED',
      title: 'Update LOOP to continue',
      message:
          'This version can no longer protect account and trading flows correctly.',
      icon: Icons.system_update_alt_rounded,
      tone: LoopColors.mint,
      primaryLabel: 'Update now',
      onPrimary: onUpdate,
      detail:
          'Install the latest version before returning to LOOP. This update cannot be skipped.',
      blocking: true,
    );
  }
}

class _MaintenanceScreen extends StatelessWidget {
  const _MaintenanceScreen({
    required this.window,
    required this.onRetry,
    required this.onStatus,
  });

  final String window;
  final VoidCallback? onRetry;
  final VoidCallback? onStatus;

  @override
  Widget build(BuildContext context) {
    return _SystemStateScaffold(
      eyebrow: 'SCHEDULED MAINTENANCE',
      title: 'LOOP is taking a short pause',
      message:
          'Account, wallet, trading, and chat actions are temporarily unavailable while maintenance completes.',
      icon: Icons.construction_rounded,
      tone: LoopColors.warning,
      primaryLabel: 'Check again',
      onPrimary: onRetry,
      secondaryLabel: 'View service status',
      onSecondary: onStatus,
      detail: 'Maintenance window · $window',
    );
  }
}

class _RegionRestrictedScreen extends StatelessWidget {
  const _RegionRestrictedScreen({
    required this.features,
    required this.onContinue,
  });

  final List<String> features;
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'FEATURE AVAILABILITY',
      title: 'Some features aren’t available here',
      subtitle:
          'Availability is based on the location and account information currently on record.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: onContinue,
            child: const Text('Continue to LOOP'),
          ),
        ),
      ),
      children: <Widget>[
        const Center(
          child: _SystemGlyph(
            icon: Icons.public_off_outlined,
            color: LoopColors.warning,
          ),
        ),
        const SizedBox(height: 28),
        LoopCard(
          accent: true,
          tone: LoopTone.warning,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Unavailable features',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              for (final feature in features)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    children: <Widget>[
                      const Icon(
                        Icons.block_rounded,
                        color: LoopColors.warning,
                        size: 18,
                      ),
                      const SizedBox(width: 10),
                      Expanded(child: Text(feature)),
                    ],
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'What still works',
          message:
              'You can review supported markets, use eligible wallet views, and continue permitted conversations.',
          icon: Icons.check_circle_outline_rounded,
          tone: LoopTone.positive,
        ),
        const SizedBox(height: 16),
        TextButton.icon(
          onPressed: null,
          icon: const Icon(Icons.help_outline_rounded),
          label: const Text('Read availability policy'),
        ),
      ],
    );
  }
}

class _PermissionScreen extends StatelessWidget {
  const _PermissionScreen({
    required this.kind,
    required this.denied,
    required this.onContinue,
    required this.onNotNow,
  });

  final LoopPermissionKind kind;
  final bool denied;
  final VoidCallback? onContinue;
  final VoidCallback? onNotNow;

  @override
  Widget build(BuildContext context) {
    final content = _permissionContent(kind);
    return LoopPage(
      eyebrow: denied ? 'PERMISSION OFF' : 'BEFORE YOU CONTINUE',
      title: denied ? '${content.shortName} access is off' : content.title,
      subtitle: denied ? content.deniedMessage : content.message,
      bottom: LoopActionDock(
        child: Row(
          children: <Widget>[
            Expanded(
              child: OutlinedButton(
                onPressed: onNotNow,
                child: const Text('Not now'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                onPressed: onContinue,
                child: Text(denied ? 'Open settings' : 'Continue'),
              ),
            ),
          ],
        ),
      ),
      children: <Widget>[
        Center(
          child: _SystemGlyph(icon: content.icon, color: content.color),
        ),
        const SizedBox(height: 28),
        LoopCard(
          child: Column(
            children: <Widget>[
              _PermissionFact(icon: Icons.check_rounded, text: content.usedFor),
              const _PermissionFact(
                icon: Icons.close_rounded,
                text:
                    'LOOP will not use this permission for unrelated activity.',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _NoticeGallery extends StatelessWidget {
  const _NoticeGallery();

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      eyebrow: 'GLOBAL NOTICES',
      title: 'Short, specific feedback',
      subtitle:
          'Notices state exactly what happened and preserve a clear next action.',
      children: <Widget>[
        LoopGlobalNotice(
          kind: LoopNoticeKind.success,
          message: 'Notification preferences saved.',
        ),
        SizedBox(height: 12),
        LoopGlobalNotice(
          kind: LoopNoticeKind.warning,
          message: 'Market prices may be delayed.',
        ),
        SizedBox(height: 12),
        LoopGlobalNotice(
          kind: LoopNoticeKind.error,
          message: 'The order status could not be confirmed.',
        ),
      ],
    );
  }
}

class _SkeletonGallery extends StatelessWidget {
  const _SkeletonGallery();

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      eyebrow: 'LOADING',
      title: 'Content is on the way',
      subtitle:
          'Skeletons preserve the shape of each surface without implying that data has loaded.',
      children: <Widget>[
        LoopSectionLabel('List'),
        LoopSkeletonView(kind: LoopSkeletonKind.list, itemCount: 3),
        LoopSectionLabel('Detail'),
        LoopSkeletonView(kind: LoopSkeletonKind.detail),
        LoopSectionLabel('Chart'),
        LoopSkeletonView(kind: LoopSkeletonKind.chart),
      ],
    );
  }
}

class _UnknownSystemScreen extends StatelessWidget {
  const _UnknownSystemScreen();

  @override
  Widget build(BuildContext context) {
    return const _SystemStateScaffold(
      eyebrow: 'SYSTEM',
      title: 'This page is unavailable',
      message: 'LOOP could not identify the requested system page.',
      icon: Icons.route_outlined,
      tone: LoopColors.vapor,
      detail: 'Return to the previous screen and try again.',
    );
  }
}

class _SystemStateScaffold extends StatelessWidget {
  const _SystemStateScaffold({
    required this.eyebrow,
    required this.title,
    required this.message,
    required this.icon,
    required this.tone,
    required this.detail,
    this.primaryLabel,
    this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
    this.blocking = false,
  });

  final String eyebrow;
  final String title;
  final String message;
  final IconData icon;
  final Color tone;
  final String detail;
  final String? primaryLabel;
  final VoidCallback? onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;
  final bool blocking;

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !blocking,
      child: Scaffold(
        body: Stack(
          children: <Widget>[
            const Positioned.fill(child: LoopBackdrop()),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 26, 24, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      eyebrow,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        color: tone,
                        letterSpacing: 1.4,
                      ),
                    ),
                    const Spacer(),
                    Center(
                      child: _SystemGlyph(icon: icon, color: tone),
                    ),
                    const SizedBox(height: 38),
                    Text(
                      title,
                      style: Theme.of(context).textTheme.displayMedium,
                    ),
                    const SizedBox(height: 13),
                    Text(
                      message,
                      style: Theme.of(
                        context,
                      ).textTheme.bodyLarge?.copyWith(color: LoopColors.vapor),
                    ),
                    const SizedBox(height: 20),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: const BoxDecoration(
                        color: LoopColors.basalt,
                        borderRadius: LoopRadius.medium,
                        border: Border.fromBorderSide(
                          BorderSide(color: LoopColors.line),
                        ),
                      ),
                      child: Text(
                        detail,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                    const Spacer(),
                    if (primaryLabel != null)
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: onPrimary,
                          child: Text(primaryLabel!),
                        ),
                      ),
                    if (secondaryLabel != null) ...<Widget>[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: TextButton(
                          onPressed: onSecondary,
                          child: Text(secondaryLabel!),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SystemGlyph extends StatelessWidget {
  const _SystemGlyph({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      child: SizedBox.square(
        dimension: 168,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            Container(
              width: 168,
              height: 168,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: color.withValues(alpha: 0.16)),
              ),
            ),
            Container(
              width: 116,
              height: 116,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: color.withValues(alpha: 0.08),
                border: Border.all(color: color.withValues(alpha: 0.38)),
              ),
            ),
            Icon(icon, size: 46, color: color),
            Positioned(top: 9, child: _GlyphNode(color: color)),
            Positioned(
              left: 17,
              bottom: 28,
              child: _GlyphNode(color: color.withValues(alpha: 0.7)),
            ),
            Positioned(
              right: 17,
              bottom: 28,
              child: _GlyphNode(color: color.withValues(alpha: 0.42)),
            ),
          ],
        ),
      ),
    );
  }
}

class _GlyphNode extends StatelessWidget {
  const _GlyphNode({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 13,
      height: 13,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: LoopColors.abyss,
        border: Border.all(color: color, width: 2),
      ),
    );
  }
}

class _PermissionFact extends StatelessWidget {
  const _PermissionFact({
    required this.icon,
    required this.text,
    this.last = false,
  });

  final IconData icon;
  final String text;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(
            icon,
            color: icon == Icons.check_rounded
                ? LoopColors.mint
                : LoopColors.vapor,
            size: 19,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

class _ListSkeleton extends StatelessWidget {
  const _ListSkeleton({required this.itemCount});

  final int itemCount;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: List<Widget>.generate(
        itemCount,
        (index) => Padding(
          padding: EdgeInsets.only(bottom: index == itemCount - 1 ? 0 : 10),
          child: const LoopCard(
            child: Row(
              children: <Widget>[
                _SkeletonBlock(width: 42, height: 42, circular: true),
                SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      _SkeletonBlock(width: 132, height: 12),
                      SizedBox(height: 9),
                      _SkeletonBlock(width: 204, height: 9),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DetailSkeleton extends StatelessWidget {
  const _DetailSkeleton();

  @override
  Widget build(BuildContext context) {
    return const LoopCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              _SkeletonBlock(width: 54, height: 54, circular: true),
              SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _SkeletonBlock(width: 146, height: 15),
                    SizedBox(height: 10),
                    _SkeletonBlock(width: 92, height: 10),
                  ],
                ),
              ),
            ],
          ),
          SizedBox(height: 24),
          _SkeletonBlock(width: double.infinity, height: 12),
          SizedBox(height: 10),
          _SkeletonBlock(width: 244, height: 12),
          SizedBox(height: 10),
          _SkeletonBlock(width: 184, height: 12),
        ],
      ),
    );
  }
}

class _ChartSkeleton extends StatelessWidget {
  const _ChartSkeleton();

  @override
  Widget build(BuildContext context) {
    return const LoopCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _SkeletonBlock(width: 118, height: 12),
          SizedBox(height: 12),
          _SkeletonBlock(width: 176, height: 26),
          SizedBox(height: 22),
          SizedBox(
            height: 112,
            child: Stack(
              children: <Widget>[
                Positioned.fill(child: _SkeletonGrid()),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 20,
                  child: _SkeletonBlock(width: double.infinity, height: 3),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SkeletonBlock extends StatelessWidget {
  const _SkeletonBlock({
    required this.width,
    required this.height,
    this.circular = false,
  });

  final double width;
  final double height;
  final bool circular;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: LoopColors.elevated,
        borderRadius: circular ? LoopRadius.pill : LoopRadius.small,
      ),
    );
  }
}

class _SkeletonGrid extends StatelessWidget {
  const _SkeletonGrid();

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: List<Widget>.generate(
        4,
        (_) =>
            Container(height: 1, color: LoopColors.line.withValues(alpha: 0.7)),
      ),
    );
  }
}

({String title, String message, String banner, IconData icon, Color color})
_connectivityContent(LoopConnectivityScope scope) {
  return switch (scope) {
    LoopConnectivityScope.fullyOffline => (
      title: 'You’re offline',
      message:
          'Reconnect to refresh account, market, chat, and wallet information.',
      banner: 'Offline · live information is paused',
      icon: Icons.wifi_off_rounded,
      color: LoopColors.warning,
    ),
    LoopConnectivityScope.marketDataUnavailable => (
      title: 'Market data is unavailable',
      message:
          'Live prices and charts cannot refresh. Trading actions that depend on current prices remain disabled.',
      banner: 'Market data unavailable · prices may be stale',
      icon: Icons.query_stats_rounded,
      color: LoopColors.market,
    ),
    LoopConnectivityScope.tradingServiceUnavailable => (
      title: 'Trading is temporarily unavailable',
      message:
          'Orders and account changes cannot be submitted. Market browsing and chat may still work.',
      banner: 'Trading service interrupted · actions paused',
      icon: Icons.sync_problem_rounded,
      color: LoopColors.danger,
    ),
  };
}

({
  String shortName,
  String title,
  String message,
  String deniedMessage,
  String usedFor,
  IconData icon,
  Color color,
})
_permissionContent(LoopPermissionKind kind) {
  return switch (kind) {
    LoopPermissionKind.camera => (
      shortName: 'Camera',
      title: 'Use the camera to scan',
      message: 'LOOP needs camera access only while you scan a QR code.',
      deniedMessage:
          'Scanning stays unavailable until camera access is enabled in device settings.',
      usedFor: 'Used to read a QR code while the scanner is open.',
      icon: Icons.qr_code_scanner_rounded,
      color: LoopColors.market,
    ),
    LoopPermissionKind.notifications => (
      shortName: 'Notification',
      title: 'Receive time-sensitive alerts',
      message:
          'Allow notifications for fills, liquidation risk, security events, and selected community activity.',
      deniedMessage:
          'Alerts cannot reach you while LOOP is closed until notifications are enabled in device settings.',
      usedFor: 'Used for the categories you enable in Notification settings.',
      icon: Icons.notifications_active_outlined,
      color: LoopColors.chat,
    ),
    LoopPermissionKind.biometrics => (
      shortName: 'Biometric',
      title: 'Confirm sensitive actions locally',
      message:
          'Use device biometrics for app lock, recovery, and other protected account changes.',
      deniedMessage:
          'Biometric confirmation is unavailable. Use another configured account check or enable it in settings.',
      usedFor:
          'The device returns only whether the check succeeded. Biometric data stays on the device.',
      icon: Icons.fingerprint_rounded,
      color: LoopColors.mint,
    ),
  };
}
