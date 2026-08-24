import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

/// Capabilities confirmed by the Privy integration at runtime.
///
/// The default is deliberately fail-closed. Recovery words, private-key import,
/// and embedded-wallet creation must never become available because a screen was
/// merely routed to.
@immutable
class PrivyWalletCapabilities {
  const PrivyWalletCapabilities({
    this.canCreateEmbeddedWallet = false,
    this.canConnectExternalWallet = false,
    this.canUsePasskey = false,
    this.canUseBiometrics = false,
    this.canUseCloudRecovery = false,
    this.canUseSocialRecovery = false,
    this.canRevealRecoveryPhrase = false,
    this.canVerifyRecoveryPhrase = false,
    this.canImportRecoveryPhrase = false,
    this.canImportPrivateKey = false,
    this.canImportWatchOnly = true,
    this.secureScreenProtectionActive = false,
  });

  const PrivyWalletCapabilities.unavailable() : this();

  final bool canCreateEmbeddedWallet;
  final bool canConnectExternalWallet;
  final bool canUsePasskey;
  final bool canUseBiometrics;
  final bool canUseCloudRecovery;
  final bool canUseSocialRecovery;
  final bool canRevealRecoveryPhrase;
  final bool canVerifyRecoveryPhrase;
  final bool canImportRecoveryPhrase;
  final bool canImportPrivateKey;
  final bool canImportWatchOnly;
  final bool secureScreenProtectionActive;
}

typedef AccountNavigation = void Function(String destination);

/// Single routing surface for the complete A1-A12 account journey.
class AccountSurfaceScreen extends StatelessWidget {
  const AccountSurfaceScreen.fromId(
    this.surfaceId, {
    super.key,
    this.capabilities = const PrivyWalletCapabilities.unavailable(),
    this.onNavigate,
    this.onPrimaryAction,
    this.versionLabel = 'Version 0.1.0',
    this.maskedDestination = 'm•••@example.com',
    this.recoveryWords,
  });

  static const supportedIds = <String>{
    'splash',
    'onboarding',
    'auth',
    'auth-otp',
    'auth-wallet',
    'wallet-create',
    'wallet-backup',
    'seed-show',
    'seed-verify',
    'wallet-import',
    'security-setup',
    'profile-setup',
  };

  final String surfaceId;
  final PrivyWalletCapabilities capabilities;
  final AccountNavigation? onNavigate;
  final VoidCallback? onPrimaryAction;
  final String versionLabel;
  final String maskedDestination;

  /// Supplied only after the secure wallet boundary authorizes a reveal.
  /// No recovery material is bundled in this UI layer.
  final List<String>? recoveryWords;

  String get _id => surfaceId.replaceFirst('#', '').toLowerCase();

  void _navigate(BuildContext context, String destination) {
    if (onNavigate != null) {
      onNavigate!(destination);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Continue to ${_friendlyDestination(destination)}'),
      ),
    );
  }

  static String _friendlyDestination(String value) => switch (value) {
    'auth' => 'sign in',
    'auth-otp' => 'verification',
    'auth-wallet' => 'wallet connection',
    'wallet-create' => 'wallet setup',
    'wallet-backup' => 'recovery setup',
    'seed-show' => 'recovery phrase',
    'seed-verify' => 'phrase check',
    'security-setup' => 'security setup',
    'profile-setup' => 'profile setup',
    'home' => 'home',
    _ => 'the next step',
  };

  @override
  Widget build(BuildContext context) {
    return switch (_id) {
      'splash' => _SplashScreen(
        versionLabel: versionLabel,
        onContinue: () => _navigate(context, 'onboarding'),
      ),
      'onboarding' => _OnboardingScreen(
        onComplete: () => _navigate(context, 'auth'),
      ),
      'auth' => _AuthScreen(
        capabilities: capabilities,
        onNavigate: (destination) => _navigate(context, destination),
      ),
      'auth-otp' => _OtpScreen(
        destination: maskedDestination,
        onVerified:
            onPrimaryAction ?? () => _navigate(context, 'wallet-create'),
      ),
      'auth-wallet' => _ExternalWalletScreen(
        capabilityAvailable: capabilities.canConnectExternalWallet,
        onConnected:
            onPrimaryAction ?? () => _navigate(context, 'profile-setup'),
      ),
      'wallet-create' => _WalletCreateScreen(
        capabilityAvailable: capabilities.canCreateEmbeddedWallet,
        onCreated: onPrimaryAction ?? () => _navigate(context, 'wallet-backup'),
      ),
      'wallet-backup' => _WalletBackupScreen(
        capabilities: capabilities,
        onNavigate: (destination) => _navigate(context, destination),
      ),
      'seed-show' => _SeedShowScreen(
        capabilities: capabilities,
        recoveryWords: recoveryWords,
        onContinue: () => _navigate(context, 'seed-verify'),
      ),
      'seed-verify' => _SeedVerifyScreen(
        capabilityAvailable: capabilities.canVerifyRecoveryPhrase,
        onVerified:
            onPrimaryAction ?? () => _navigate(context, 'security-setup'),
      ),
      'wallet-import' => _WalletImportScreen(
        capabilities: capabilities,
        onImported:
            onPrimaryAction ?? () => _navigate(context, 'security-setup'),
      ),
      'security-setup' => _SecuritySetupScreen(
        capabilities: capabilities,
        onContinue: () => _navigate(context, 'profile-setup'),
      ),
      'profile-setup' => _ProfileSetupScreen(
        onComplete: onPrimaryAction ?? () => _navigate(context, 'home'),
      ),
      _ => const _UnknownAccountScreen(),
    };
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen({required this.versionLabel, required this.onContinue});

  final String versionLabel;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: <Widget>[
          const Positioned.fill(child: LoopBackdrop()),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 28, 24, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const _LoopWordmark(),
                  const Spacer(),
                  const Center(child: _IdentityOrbit(size: 184)),
                  const SizedBox(height: 40),
                  Text(
                    'Your onchain life,\nheld in one loop.',
                    style: Theme.of(context).textTheme.displayMedium,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'Checking your session and account protection before you continue.',
                    style: Theme.of(
                      context,
                    ).textTheme.bodyLarge?.copyWith(color: LoopColors.vapor),
                  ),
                  const SizedBox(height: 24),
                  Semantics(
                    liveRegion: true,
                    label: 'Checking account status',
                    child: Row(
                      children: <Widget>[
                        const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'Checking account status…',
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                        TextButton(
                          onPressed: onContinue,
                          child: const Text('Continue'),
                        ),
                      ],
                    ),
                  ),
                  const Spacer(),
                  Text(
                    versionLabel,
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OnboardingScreen extends StatefulWidget {
  const _OnboardingScreen({required this.onComplete});

  final VoidCallback onComplete;

  @override
  State<_OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<_OnboardingScreen> {
  final PageController _controller = PageController();
  int _page = 0;

  static const _stories =
      <
        ({
          String eyebrow,
          String title,
          String body,
          IconData icon,
          Color color,
        })
      >[
        (
          eyebrow: 'DISCOVER',
          title: 'Read the market\nwithout losing context.',
          body:
              'Move from a market signal to the conversation around it, with the asset still in view.',
          icon: Icons.radar_rounded,
          color: LoopColors.market,
        ),
        (
          eyebrow: 'DISCUSS',
          title: 'Talk as an identity,\nnot an address.',
          body:
              'Use a rotating alias, choose what others can see, and keep wallet details private by default.',
          icon: Icons.forum_outlined,
          color: LoopColors.chat,
        ),
        (
          eyebrow: 'EXECUTE',
          title: 'Review the facts.\nThen make the move.',
          body:
              'Every sensitive action returns to a clear review step before your wallet signs.',
          icon: Icons.bolt_rounded,
          color: LoopColors.mint,
        ),
      ];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _next() {
    if (_page == _stories.length - 1) {
      widget.onComplete();
      return;
    }
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    _controller.animateToPage(
      _page + 1,
      duration: reduceMotion
          ? Duration.zero
          : const Duration(milliseconds: 320),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: <Widget>[
          const Positioned.fill(child: LoopBackdrop()),
          SafeArea(
            child: Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 12, 0),
                  child: Row(
                    children: <Widget>[
                      const _LoopWordmark(),
                      const Spacer(),
                      TextButton(
                        onPressed: widget.onComplete,
                        child: const Text('Skip'),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: PageView.builder(
                    controller: _controller,
                    itemCount: _stories.length,
                    onPageChanged: (page) => setState(() => _page = page),
                    itemBuilder: (context, index) {
                      final story = _stories[index];
                      return Padding(
                        padding: const EdgeInsets.fromLTRB(20, 30, 20, 20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            _OnboardingArtifact(
                              index: index,
                              icon: story.icon,
                              color: story.color,
                            ),
                            const Spacer(),
                            Text(
                              story.eyebrow,
                              style: Theme.of(context).textTheme.labelMedium
                                  ?.copyWith(
                                    color: story.color,
                                    letterSpacing: 1.5,
                                  ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              story.title,
                              style: Theme.of(context).textTheme.displayMedium,
                            ),
                            const SizedBox(height: 14),
                            Text(
                              story.body,
                              style: Theme.of(context).textTheme.bodyLarge
                                  ?.copyWith(color: LoopColors.vapor),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
                  child: Column(
                    children: <Widget>[
                      Row(
                        children: List<Widget>.generate(
                          _stories.length,
                          (index) => Expanded(
                            child: AnimatedContainer(
                              duration: MediaQuery.disableAnimationsOf(context)
                                  ? Duration.zero
                                  : const Duration(milliseconds: 180),
                              height: 3,
                              margin: EdgeInsets.only(
                                right: index == _stories.length - 1 ? 0 : 6,
                              ),
                              decoration: BoxDecoration(
                                color: index <= _page
                                    ? _stories[_page].color
                                    : LoopColors.line,
                                borderRadius: LoopRadius.pill,
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          onPressed: _next,
                          child: Text(
                            _page == _stories.length - 1
                                ? 'Set up LOOP'
                                : 'Continue',
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AuthScreen extends StatelessWidget {
  const _AuthScreen({required this.capabilities, required this.onNavigate});

  final PrivyWalletCapabilities capabilities;
  final ValueChanged<String> onNavigate;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'YOUR ACCOUNT',
      title: 'Welcome to LOOP',
      subtitle:
          'Choose how you want to sign in. Your social identity and wallet remain separate until you decide to link them.',
      children: <Widget>[
        _AccountMethodTile(
          icon: Icons.alternate_email_rounded,
          title: 'Continue with email',
          detail: 'We’ll send a one-time code',
          tone: LoopTone.positive,
          onTap: () => onNavigate('auth-otp'),
        ),
        const SizedBox(height: 10),
        _AccountMethodTile(
          icon: Icons.apple_rounded,
          title: 'Continue with Apple',
          detail: 'Use your Apple account',
          onTap: () => onNavigate('wallet-create'),
        ),
        const SizedBox(height: 10),
        _AccountMethodTile(
          icon: Icons.g_mobiledata_rounded,
          title: 'Continue with Google',
          detail: 'Use your Google account',
          onTap: () => onNavigate('wallet-create'),
        ),
        const SizedBox(height: 10),
        _AccountMethodTile(
          icon: Icons.key_rounded,
          title: 'Use a passkey',
          detail: capabilities.canUsePasskey
              ? 'Confirm with this device'
              : 'Not available on this device',
          enabled: capabilities.canUsePasskey,
          onTap: () => onNavigate('wallet-create'),
        ),
        const LoopSectionLabel('Already have a wallet?'),
        _AccountMethodTile(
          icon: Icons.account_balance_wallet_outlined,
          title: 'Connect an external wallet',
          detail: capabilities.canConnectExternalWallet
              ? 'Use an installed wallet or WalletConnect'
              : 'Wallet connection is unavailable right now',
          tone: LoopTone.market,
          enabled: capabilities.canConnectExternalWallet,
          onTap: () => onNavigate('auth-wallet'),
        ),
        const SizedBox(height: 10),
        _AccountMethodTile(
          icon: Icons.download_rounded,
          title: 'Import or watch a wallet',
          detail: 'Available methods depend on your account',
          onTap: () => onNavigate('wallet-import'),
        ),
        const SizedBox(height: 18),
        const _PlainDisclosure(
          icon: Icons.lock_outline_rounded,
          text:
              'LOOP never asks for recovery words during sign-in. Sensitive wallet actions require a separate confirmation.',
        ),
      ],
    );
  }
}

class _OtpScreen extends StatefulWidget {
  const _OtpScreen({required this.destination, required this.onVerified});

  final String destination;
  final VoidCallback onVerified;

  @override
  State<_OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<_OtpScreen> {
  final _controllers = List<TextEditingController>.generate(
    6,
    (_) => TextEditingController(),
  );
  final _focusNodes = List<FocusNode>.generate(6, (_) => FocusNode());
  Timer? _timer;
  int _remaining = 30;
  String? _error;

  bool get _complete =>
      _controllers.every((controller) => controller.text.length == 1);

  @override
  void initState() {
    super.initState();
    _startTimer();
  }

  void _startTimer() {
    _timer?.cancel();
    _remaining = 30;
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      if (_remaining <= 1) {
        timer.cancel();
        setState(() => _remaining = 0);
      } else {
        setState(() => _remaining -= 1);
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    for (final controller in _controllers) {
      controller.dispose();
    }
    for (final node in _focusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  void _changed(int index, String value) {
    setState(() => _error = null);
    if (value.isNotEmpty && index < _focusNodes.length - 1) {
      _focusNodes[index + 1].requestFocus();
    }
  }

  void _verify() {
    if (!_complete) {
      setState(() => _error = 'Enter all six digits.');
      return;
    }
    widget.onVerified();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'VERIFICATION',
      title: 'Enter your code',
      subtitle: 'We sent a six-digit code to ${widget.destination}.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _complete ? _verify : null,
            child: const Text('Verify code'),
          ),
        ),
      ),
      children: <Widget>[
        Semantics(
          label: 'Six digit verification code',
          child: Row(
            children: List<Widget>.generate(6, (index) {
              return Expanded(
                child: Padding(
                  padding: EdgeInsets.only(right: index == 5 ? 0 : 7),
                  child: TextField(
                    controller: _controllers[index],
                    focusNode: _focusNodes[index],
                    autofocus: index == 0,
                    textAlign: TextAlign.center,
                    keyboardType: TextInputType.number,
                    textInputAction: index == 5
                        ? TextInputAction.done
                        : TextInputAction.next,
                    inputFormatters: <TextInputFormatter>[
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(1),
                    ],
                    style: context.dataStyle.copyWith(fontSize: 20),
                    decoration: InputDecoration(
                      contentPadding: const EdgeInsets.symmetric(vertical: 16),
                      errorText: null,
                      counterText: '',
                    ),
                    onChanged: (value) => _changed(index, value),
                    onSubmitted: (_) {
                      if (index == 5 && _complete) _verify();
                    },
                  ),
                ),
              );
            }),
          ),
        ),
        if (_error != null) ...<Widget>[
          const SizedBox(height: 12),
          Text(
            _error!,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: LoopColors.danger),
          ),
        ],
        const SizedBox(height: 20),
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                _remaining > 0
                    ? 'Resend available in 0:${_remaining.toString().padLeft(2, '0')}'
                    : 'Didn’t receive a code?',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            TextButton(
              onPressed: _remaining == 0 ? () => setState(_startTimer) : null,
              child: const Text('Resend'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const _PlainDisclosure(
          icon: Icons.shield_outlined,
          text:
              'For your security, repeated incorrect attempts temporarily pause verification.',
        ),
      ],
    );
  }
}

class _ExternalWalletScreen extends StatefulWidget {
  const _ExternalWalletScreen({
    required this.capabilityAvailable,
    required this.onConnected,
  });

  final bool capabilityAvailable;
  final VoidCallback onConnected;

  @override
  State<_ExternalWalletScreen> createState() => _ExternalWalletScreenState();
}

class _ExternalWalletScreenState extends State<_ExternalWalletScreen> {
  String _selected = 'Browser wallet';

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'EXTERNAL WALLET',
      title: 'Connect a wallet',
      subtitle:
          'Choose an installed wallet, or scan the code from another device.',
      bottom: widget.capabilityAvailable
          ? LoopActionDock(
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: widget.onConnected,
                  child: Text('Connect $_selected'),
                ),
              ),
            )
          : null,
      children: <Widget>[
        if (!widget.capabilityAvailable) ...<Widget>[
          const LoopStateCard(
            title: 'Wallet connection is unavailable',
            message:
                'Continue with email, Apple, or Google and try connecting a wallet later.',
            icon: Icons.link_off_rounded,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 18),
        ],
        AbsorbPointer(
          absorbing: !widget.capabilityAvailable,
          child: Opacity(
            opacity: widget.capabilityAvailable ? 1 : 0.5,
            child: Column(
              children: <Widget>[
                for (final wallet in const <(String, String, IconData)>[
                  (
                    'Browser wallet',
                    'Continue in an installed wallet',
                    Icons.language_rounded,
                  ),
                  (
                    'Mobile wallet',
                    'Open a supported app on this phone',
                    Icons.phone_iphone_rounded,
                  ),
                ]) ...<Widget>[
                  _ChoiceTile(
                    title: wallet.$1,
                    detail: wallet.$2,
                    icon: wallet.$3,
                    selected: _selected == wallet.$1,
                    onTap: () => setState(() => _selected = wallet.$1),
                  ),
                  const SizedBox(height: 10),
                ],
                const LoopSectionLabel('Connect from another device'),
                LoopCard(
                  padding: const EdgeInsets.all(20),
                  child: Row(
                    children: <Widget>[
                      Container(
                        width: 104,
                        height: 104,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: LoopColors.chalk,
                          borderRadius: LoopRadius.small,
                        ),
                        child: const Icon(
                          Icons.qr_code_2_rounded,
                          color: LoopColors.abyss,
                          size: 84,
                        ),
                      ),
                      const SizedBox(width: 18),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              'Scan to connect',
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            const SizedBox(height: 7),
                            Text(
                              'Open WalletConnect in your wallet app and scan this code.',
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        const _PlainDisclosure(
          icon: Icons.draw_outlined,
          text:
              'Your wallet will ask you to sign a sign-in message. This does not move funds or approve token access.',
        ),
      ],
    );
  }
}

class _WalletCreateScreen extends StatelessWidget {
  const _WalletCreateScreen({
    required this.capabilityAvailable,
    required this.onCreated,
  });

  final bool capabilityAvailable;
  final VoidCallback onCreated;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'EMBEDDED WALLET',
      title: 'Set up your wallet',
      subtitle:
          'Your account can hold an embedded wallet when this capability is available for your configuration.',
      bottom: capabilityAvailable
          ? LoopActionDock(
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: onCreated,
                  child: const Text('Create wallet securely'),
                ),
              ),
            )
          : null,
      children: <Widget>[
        const Center(child: _IdentityOrbit(size: 156)),
        const SizedBox(height: 28),
        if (capabilityAvailable)
          const LoopStateCard(
            title: 'Ready to create',
            message:
                'Wallet creation happens inside the secured wallet service. LOOP does not receive raw key material.',
            icon: Icons.verified_user_outlined,
            tone: LoopTone.positive,
          )
        else
          const LoopStateCard(
            title: 'Embedded wallet unavailable',
            message:
                'No wallet will be created. Connect an external wallet or return to sign-in options.',
            icon: Icons.lock_clock_outlined,
            tone: LoopTone.warning,
          ),
        const LoopSectionLabel('What happens next'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              _StepRow(
                number: '1',
                title: 'Create',
                detail:
                    'The wallet service prepares an address for this account.',
              ),
              _StepRow(
                number: '2',
                title: 'Protect',
                detail: 'You choose an available recovery method.',
              ),
              _StepRow(
                number: '3',
                title: 'Review',
                detail: 'Sensitive actions require an explicit confirmation.',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _WalletBackupScreen extends StatelessWidget {
  const _WalletBackupScreen({
    required this.capabilities,
    required this.onNavigate,
  });

  final PrivyWalletCapabilities capabilities;
  final ValueChanged<String> onNavigate;

  void _unavailable(BuildContext context) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('This recovery method is not available for this wallet.'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'RECOVERY',
      title: 'Choose how to recover',
      subtitle:
          'Available methods are confirmed for this wallet at the moment you choose them.',
      children: <Widget>[
        _RecoveryMethodTile(
          icon: Icons.cloud_outlined,
          title: 'Cloud recovery',
          detail: 'Restore after signing in to your protected account',
          available: capabilities.canUseCloudRecovery,
          onTap: () => capabilities.canUseCloudRecovery
              ? onNavigate('security-setup')
              : _unavailable(context),
        ),
        const SizedBox(height: 10),
        _RecoveryMethodTile(
          icon: Icons.password_rounded,
          title: 'Recovery phrase',
          detail: 'Record recovery words offline',
          available:
              capabilities.canRevealRecoveryPhrase &&
              capabilities.secureScreenProtectionActive,
          onTap: () =>
              capabilities.canRevealRecoveryPhrase &&
                  capabilities.secureScreenProtectionActive
              ? onNavigate('seed-show')
              : _unavailable(context),
        ),
        const SizedBox(height: 10),
        _RecoveryMethodTile(
          icon: Icons.group_outlined,
          title: 'Social recovery',
          detail: 'Require two of three trusted guardians',
          available: capabilities.canUseSocialRecovery,
          onTap: () => capabilities.canUseSocialRecovery
              ? onNavigate('social-recovery')
              : _unavailable(context),
        ),
        const SizedBox(height: 22),
        LoopStateCard(
          title: 'Skipping recovery can lock you out',
          message:
              'If you lose access before setting a recovery method, assets may be permanently unreachable.',
          icon: Icons.warning_amber_rounded,
          tone: LoopTone.danger,
          action: OutlinedButton(
            onPressed: () => _showSkipWarning(context),
            child: const Text('Decide later'),
          ),
        ),
      ],
    );
  }

  Future<void> _showSkipWarning(BuildContext context) async {
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Continue without recovery?'),
        content: const Text(
          'You may permanently lose access to wallet assets if you lose this account or device before adding recovery.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Go back'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: LoopColors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Accept risk and continue'),
          ),
        ],
      ),
    );
    if (leave ?? false) onNavigate('security-setup');
  }
}

class _SeedShowScreen extends StatefulWidget {
  const _SeedShowScreen({
    required this.capabilities,
    required this.recoveryWords,
    required this.onContinue,
  });

  final PrivyWalletCapabilities capabilities;
  final List<String>? recoveryWords;
  final VoidCallback onContinue;

  @override
  State<_SeedShowScreen> createState() => _SeedShowScreenState();
}

class _SeedShowScreenState extends State<_SeedShowScreen>
    with WidgetsBindingObserver {
  bool _riskAccepted = false;
  bool _revealed = false;
  bool _recorded = false;

  bool get _authorized =>
      widget.capabilities.canRevealRecoveryPhrase &&
      widget.capabilities.secureScreenProtectionActive &&
      widget.recoveryWords != null &&
      widget.recoveryWords!.isNotEmpty;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && _revealed && mounted) {
      setState(() {
        _revealed = false;
        _recorded = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'RECOVERY PHRASE',
      title: 'Record it offline',
      subtitle:
          'Anyone with these words can control the wallet. Never share them with support or paste them into a website.',
      bottom: _authorized && _revealed
          ? LoopActionDock(
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _recorded ? widget.onContinue : null,
                  child: const Text('Verify my backup'),
                ),
              ),
            )
          : null,
      children: <Widget>[
        const LoopStateCard(
          title: 'Private screen',
          message:
              'Move away from cameras and people. The phrase hides when LOOP leaves the foreground.',
          icon: Icons.visibility_off_outlined,
          tone: LoopTone.danger,
        ),
        const SizedBox(height: 16),
        if (!_authorized)
          LoopStateCard(
            title: 'Recovery phrase unavailable',
            message: widget.capabilities.secureScreenProtectionActive
                ? 'This wallet has not authorized recovery-word access. Nothing is shown or generated on this screen.'
                : 'Screen-capture protection could not be confirmed, so recovery words stay hidden.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.warning,
          )
        else ...<Widget>[
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _riskAccepted,
            onChanged: (value) => setState(() {
              _riskAccepted = value ?? false;
              if (!_riskAccepted) _revealed = false;
            }),
            controlAffinity: ListTileControlAffinity.leading,
            title: const Text(
              'I understand that anyone with these words can control this wallet.',
            ),
          ),
          const SizedBox(height: 6),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _riskAccepted
                  ? () => setState(() => _revealed = !_revealed)
                  : null,
              icon: Icon(
                _revealed
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined,
              ),
              label: Text(
                _revealed ? 'Hide recovery words' : 'Reveal recovery words',
              ),
            ),
          ),
          const SizedBox(height: 16),
          AnimatedCrossFade(
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 180),
            crossFadeState: _revealed
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            firstChild: _HiddenSeedPanel(
              wordCount: widget.recoveryWords!.length,
            ),
            secondChild: _SeedWordGrid(words: widget.recoveryWords!),
          ),
          if (_revealed) ...<Widget>[
            const SizedBox(height: 12),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _recorded,
              onChanged: (value) => setState(() => _recorded = value ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text(
                'I recorded every word in order and stored it offline.',
              ),
            ),
          ],
        ],
      ],
    );
  }
}

class _SeedVerifyScreen extends StatefulWidget {
  const _SeedVerifyScreen({
    required this.capabilityAvailable,
    required this.onVerified,
  });

  final bool capabilityAvailable;
  final VoidCallback onVerified;

  @override
  State<_SeedVerifyScreen> createState() => _SeedVerifyScreenState();
}

class _SeedVerifyScreenState extends State<_SeedVerifyScreen> {
  final _controllers = List<TextEditingController>.generate(
    3,
    (_) => TextEditingController(),
  );

  bool get _complete =>
      _controllers.every((controller) => controller.text.trim().isNotEmpty);

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'FINAL CHECK',
      title: 'Verify your backup',
      subtitle:
          'Enter the requested words exactly as you recorded them. LOOP will not reveal or suggest the answer.',
      bottom: widget.capabilityAvailable
          ? LoopActionDock(
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _complete ? widget.onVerified : null,
                  child: const Text('Verify recovery phrase'),
                ),
              ),
            )
          : null,
      children: <Widget>[
        if (!widget.capabilityAvailable)
          const LoopStateCard(
            title: 'Verification unavailable',
            message:
                'This wallet has not authorized recovery-phrase verification. Your setup remains incomplete.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.warning,
          )
        else
          for (final item in const <(int, String)>[
            (3, 'First check'),
            (7, 'Second check'),
            (11, 'Final check'),
          ]) ...<Widget>[
            Text(
              'Word ${item.$1}',
              style: Theme.of(context).textTheme.labelLarge,
            ),
            const SizedBox(height: 7),
            TextField(
              controller: _controllers[const [3, 7, 11].indexOf(item.$1)],
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              keyboardType: TextInputType.visiblePassword,
              decoration: InputDecoration(hintText: item.$2),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 16),
          ],
        const _PlainDisclosure(
          icon: Icons.no_accounts_outlined,
          text:
              'Support will never ask for your full recovery phrase or private key.',
        ),
      ],
    );
  }
}

enum _ImportMode { phrase, privateKey, watchOnly }

class _WalletImportScreen extends StatefulWidget {
  const _WalletImportScreen({
    required this.capabilities,
    required this.onImported,
  });

  final PrivyWalletCapabilities capabilities;
  final VoidCallback onImported;

  @override
  State<_WalletImportScreen> createState() => _WalletImportScreenState();
}

class _WalletImportScreenState extends State<_WalletImportScreen> {
  _ImportMode _mode = _ImportMode.watchOnly;
  final TextEditingController _value = TextEditingController();

  bool get _available => switch (_mode) {
    _ImportMode.phrase => widget.capabilities.canImportRecoveryPhrase,
    _ImportMode.privateKey => widget.capabilities.canImportPrivateKey,
    _ImportMode.watchOnly => widget.capabilities.canImportWatchOnly,
  };

  String get _label => switch (_mode) {
    _ImportMode.phrase => 'Recovery phrase',
    _ImportMode.privateKey => 'Private key',
    _ImportMode.watchOnly => 'Public wallet address',
  };

  String get _hint => switch (_mode) {
    _ImportMode.phrase => 'Enter words in their original order',
    _ImportMode.privateKey => 'Enter your private key',
    _ImportMode.watchOnly => '0x…',
  };

  @override
  void dispose() {
    _value.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'EXISTING WALLET',
      title: 'Add a wallet',
      subtitle:
          'Choose a method. Import options appear only when the secured wallet service confirms support.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _available && _value.text.trim().isNotEmpty
                ? widget.onImported
                : null,
            child: Text(
              _mode == _ImportMode.watchOnly
                  ? 'Add watch-only wallet'
                  : 'Import wallet securely',
            ),
          ),
        ),
      ),
      children: <Widget>[
        SegmentedButton<_ImportMode>(
          showSelectedIcon: false,
          segments: const <ButtonSegment<_ImportMode>>[
            ButtonSegment(value: _ImportMode.phrase, label: Text('Phrase')),
            ButtonSegment(
              value: _ImportMode.privateKey,
              label: Text('Private key'),
            ),
            ButtonSegment(
              value: _ImportMode.watchOnly,
              label: Text('Watch only'),
            ),
          ],
          selected: <_ImportMode>{_mode},
          onSelectionChanged: (selection) => setState(() {
            _mode = selection.first;
            _value.clear();
          }),
        ),
        const SizedBox(height: 22),
        if (!_available) ...<Widget>[
          LoopStateCard(
            title: '$_label import is unavailable',
            message:
                'Nothing entered here will be processed. Choose another available method.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 18),
        ],
        Text(_label, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 8),
        TextField(
          controller: _value,
          enabled: _available,
          minLines: _mode == _ImportMode.phrase ? 4 : 1,
          maxLines: _mode == _ImportMode.phrase ? 6 : 1,
          autocorrect: false,
          enableSuggestions: false,
          obscureText: _mode == _ImportMode.privateKey,
          keyboardType: TextInputType.visiblePassword,
          decoration: InputDecoration(hintText: _hint),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        _PlainDisclosure(
          icon: _mode == _ImportMode.watchOnly
              ? Icons.visibility_outlined
              : Icons.shield_outlined,
          text: _mode == _ImportMode.watchOnly
              ? 'Watch-only wallets can show balances and activity but cannot sign or move assets.'
              : 'Sensitive material must remain inside the secured wallet boundary and must never be sent to LOOP servers.',
        ),
      ],
    );
  }
}

class _SecuritySetupScreen extends StatefulWidget {
  const _SecuritySetupScreen({
    required this.capabilities,
    required this.onContinue,
  });

  final PrivyWalletCapabilities capabilities;
  final VoidCallback onContinue;

  @override
  State<_SecuritySetupScreen> createState() => _SecuritySetupScreenState();
}

class _SecuritySetupScreenState extends State<_SecuritySetupScreen> {
  bool _passkey = false;
  bool _biometric = false;
  bool _pin = true;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'ACCOUNT PROTECTION',
      title: 'Protect sensitive actions',
      subtitle:
          'Choose at least one local check for wallet recovery, withdrawals, and account changes.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _passkey || _biometric || _pin
                ? widget.onContinue
                : null,
            child: const Text('Save protection'),
          ),
        ),
      ),
      children: <Widget>[
        _SecurityToggle(
          icon: Icons.key_rounded,
          title: 'Passkey',
          detail: widget.capabilities.canUsePasskey
              ? 'Confirm with this device or a synced passkey'
              : 'Not available for this account',
          value: _passkey,
          enabled: widget.capabilities.canUsePasskey,
          onChanged: (value) => setState(() => _passkey = value),
        ),
        const SizedBox(height: 10),
        _SecurityToggle(
          icon: Icons.fingerprint_rounded,
          title: 'Biometrics',
          detail: widget.capabilities.canUseBiometrics
              ? 'Use Face ID, Touch ID, or device biometrics'
              : 'This device does not support biometrics',
          value: _biometric,
          enabled: widget.capabilities.canUseBiometrics,
          onChanged: (value) => setState(() => _biometric = value),
        ),
        const SizedBox(height: 10),
        _SecurityToggle(
          icon: Icons.pin_outlined,
          title: 'Six-digit app PIN',
          detail:
              'Fallback protection stored by the app’s secure storage layer',
          value: _pin,
          onChanged: (value) => setState(() => _pin = value),
        ),
        const SizedBox(height: 18),
        const _PlainDisclosure(
          icon: Icons.info_outline_rounded,
          text:
              'Device biometrics never leave your phone. LOOP receives only the success or failure of the device check.',
        ),
      ],
    );
  }
}

class _ProfileSetupScreen extends StatefulWidget {
  const _ProfileSetupScreen({required this.onComplete});

  final VoidCallback onComplete;

  @override
  State<_ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<_ProfileSetupScreen> {
  static const _aliases = <String>[
    'QuietComet',
    'VelvetOrbit',
    'NorthSignal',
    'SilverCurrent',
  ];
  static const _topics = <String>[
    'BTC',
    'ETH',
    'Solana',
    'Perps',
    'DeFi',
    'Memes',
  ];
  int _aliasIndex = 0;
  final Set<String> _selectedTopics = <String>{'BTC', 'ETH'};
  bool _notifications = false;

  @override
  Widget build(BuildContext context) {
    final alias = _aliases[_aliasIndex];
    return LoopPage(
      eyebrow: 'YOUR IDENTITY',
      title: 'Start private',
      subtitle:
          'Your alias is what people see in chats. Your wallet address stays hidden unless you share it.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: widget.onComplete,
            child: const Text('Enter LOOP'),
          ),
        ),
      ),
      children: <Widget>[
        LoopCard(
          accent: true,
          tone: LoopTone.conversation,
          child: Row(
            children: <Widget>[
              const _AliasAvatar(size: 64),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'CHAT ALIAS',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const SizedBox(height: 5),
                    Text(
                      alias,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Generate another alias',
                onPressed: () => setState(
                  () => _aliasIndex = (_aliasIndex + 1) % _aliases.length,
                ),
                icon: const Icon(Icons.shuffle_rounded),
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Follow first'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: _topics
              .map((topic) {
                final selected = _selectedTopics.contains(topic);
                return FilterChip(
                  selected: selected,
                  label: Text(topic),
                  onSelected: (value) => setState(() {
                    if (value) {
                      _selectedTopics.add(topic);
                    } else {
                      _selectedTopics.remove(topic);
                    }
                  }),
                );
              })
              .toList(growable: false),
        ),
        const LoopSectionLabel('Stay informed'),
        LoopCard(
          child: SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _notifications,
            title: const Text('Enable notifications'),
            subtitle: const Text(
              'Security alerts and order updates. You can change categories later.',
            ),
            onChanged: (value) => setState(() => _notifications = value),
          ),
        ),
      ],
    );
  }
}

class _UnknownAccountScreen extends StatelessWidget {
  const _UnknownAccountScreen();

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      eyebrow: 'ACCOUNT',
      title: 'Page unavailable',
      subtitle: 'This account page could not be opened.',
      children: <Widget>[
        LoopStateCard(
          title: 'Return to sign in',
          message: 'No account or wallet changes were made.',
          icon: Icons.route_outlined,
        ),
      ],
    );
  }
}

class _LoopWordmark extends StatelessWidget {
  const _LoopWordmark();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: LoopColors.mint, width: 2),
          ),
          child: Container(
            width: 7,
            height: 7,
            decoration: const BoxDecoration(
              color: LoopColors.mint,
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Text(
          'LOOP',
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
            letterSpacing: 2,
            color: LoopColors.chalk,
          ),
        ),
      ],
    );
  }
}

class _IdentityOrbit extends StatelessWidget {
  const _IdentityOrbit({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'One identity connects markets, conversations, and wallet actions',
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          alignment: Alignment.center,
          children: <Widget>[
            Container(
              width: size,
              height: size,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: LoopColors.line),
              ),
            ),
            Container(
              width: size * 0.64,
              height: size * 0.64,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: LoopColors.basalt,
                border: Border.all(
                  color: LoopColors.mint.withValues(alpha: 0.42),
                ),
                boxShadow: <BoxShadow>[
                  BoxShadow(
                    color: LoopColors.mint.withValues(alpha: 0.08),
                    blurRadius: 28,
                    spreadRadius: 4,
                  ),
                ],
              ),
              alignment: Alignment.center,
              child: Text(
                'L',
                style: Theme.of(
                  context,
                ).textTheme.displayMedium?.copyWith(color: LoopColors.mint),
              ),
            ),
            Positioned(
              top: 9,
              child: _OrbitNode(
                color: LoopColors.market,
                icon: Icons.show_chart_rounded,
              ),
            ),
            Positioned(
              left: 3,
              bottom: size * 0.18,
              child: _OrbitNode(
                color: LoopColors.chat,
                icon: Icons.chat_bubble_outline_rounded,
              ),
            ),
            Positioned(
              right: 3,
              bottom: size * 0.18,
              child: _OrbitNode(
                color: LoopColors.mint,
                icon: Icons.bolt_rounded,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OrbitNode extends StatelessWidget {
  const _OrbitNode({required this.color, required this.icon});

  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        color: LoopColors.abyss,
        shape: BoxShape.circle,
        border: Border.all(color: color.withValues(alpha: 0.7)),
      ),
      child: Icon(icon, color: color, size: 18),
    );
  }
}

class _OnboardingArtifact extends StatelessWidget {
  const _OnboardingArtifact({
    required this.index,
    required this.icon,
    required this.color,
  });

  final int index;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'Onboarding illustration ${index + 1}',
      child: AspectRatio(
        aspectRatio: 1.18,
        child: LoopCard(
          padding: EdgeInsets.zero,
          accent: true,
          tone: switch (index) {
            0 => LoopTone.market,
            1 => LoopTone.conversation,
            _ => LoopTone.positive,
          },
          child: Stack(
            children: <Widget>[
              Positioned(
                top: 30,
                left: 32,
                right: 32,
                child: Container(height: 1, color: LoopColors.line),
              ),
              Positioned(
                left: 36,
                bottom: 34,
                right: 36,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: <Widget>[
                    _TinyNode(color: LoopColors.market, active: index >= 0),
                    Expanded(
                      child: Container(
                        height: 1,
                        color: index >= 1 ? LoopColors.chat : LoopColors.line,
                      ),
                    ),
                    _TinyNode(color: LoopColors.chat, active: index >= 1),
                    Expanded(
                      child: Container(
                        height: 1,
                        color: index >= 2 ? LoopColors.mint : LoopColors.line,
                      ),
                    ),
                    _TinyNode(color: LoopColors.mint, active: index >= 2),
                  ],
                ),
              ),
              Center(
                child: Container(
                  width: 112,
                  height: 112,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.1),
                    shape: BoxShape.circle,
                    border: Border.all(color: color.withValues(alpha: 0.42)),
                  ),
                  child: Icon(icon, size: 48, color: color),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TinyNode extends StatelessWidget {
  const _TinyNode({required this.color, required this.active});

  final Color color;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: active ? color : LoopColors.line,
        boxShadow: active
            ? <BoxShadow>[
                BoxShadow(color: color.withValues(alpha: 0.3), blurRadius: 10),
              ]
            : null,
      ),
    );
  }
}

class _AccountMethodTile extends StatelessWidget {
  const _AccountMethodTile({
    required this.icon,
    required this.title,
    required this.detail,
    required this.onTap,
    this.enabled = true,
    this.tone = LoopTone.neutral,
  });

  final IconData icon;
  final String title;
  final String detail;
  final VoidCallback onTap;
  final bool enabled;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return Opacity(
      opacity: enabled ? 1 : 0.52,
      child: LoopCard(
        onTap: enabled ? onTap : null,
        semanticLabel: '$title. $detail',
        child: Row(
          children: <Widget>[
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.1),
                borderRadius: LoopRadius.small,
              ),
              child: Icon(icon, color: color, size: 21),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 3),
                  Text(detail, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
          ],
        ),
      ),
    );
  }
}

class _PlainDisclosure extends StatelessWidget {
  const _PlainDisclosure({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(icon, size: 18, color: LoopColors.vapor),
        const SizedBox(width: 10),
        Expanded(
          child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
        ),
      ],
    );
  }
}

class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.title,
    required this.detail,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String detail;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      accent: selected,
      tone: LoopTone.market,
      child: Row(
        children: <Widget>[
          Icon(icon, color: selected ? LoopColors.market : LoopColors.vapor),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(detail, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
          Icon(
            selected
                ? Icons.radio_button_checked_rounded
                : Icons.radio_button_off_rounded,
            color: selected ? LoopColors.market : LoopColors.vapor,
          ),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.number,
    required this.title,
    required this.detail,
    this.last = false,
  });

  final String number;
  final String title;
  final String detail;
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
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: LoopColors.mint.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            child: Text(
              number,
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: LoopColors.mint),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(detail, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RecoveryMethodTile extends StatelessWidget {
  const _RecoveryMethodTile({
    required this.icon,
    required this.title,
    required this.detail,
    required this.available,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool available;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      child: Row(
        children: <Widget>[
          Icon(icon, color: available ? LoopColors.mint : LoopColors.vapor),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(detail, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
          LoopStatusPill(
            label: available ? 'Available' : 'Unavailable',
            tone: available ? LoopTone.positive : LoopTone.neutral,
          ),
        ],
      ),
    );
  }
}

class _HiddenSeedPanel extends StatelessWidget {
  const _HiddenSeedPanel({required this.wordCount});

  final int wordCount;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: SizedBox(
        height: 178,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(
                Icons.visibility_off_outlined,
                color: LoopColors.vapor,
                size: 30,
              ),
              const SizedBox(height: 10),
              Text(
                '$wordCount recovery words hidden',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SeedWordGrid extends StatelessWidget {
  const _SeedWordGrid({required this.words});

  final List<String> words;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '${words.length} recovery words revealed',
      child: LoopCard(
        accent: true,
        tone: LoopTone.danger,
        child: GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: words.length,
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            childAspectRatio: 2.25,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
          ),
          itemBuilder: (context, index) {
            return Container(
              alignment: Alignment.centerLeft,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                color: LoopColors.elevated,
                borderRadius: LoopRadius.small,
              ),
              child: Text(
                '${index + 1}. ${words[index]}',
                maxLines: 1,
                overflow: TextOverflow.fade,
                style: context.dataStyle.copyWith(fontSize: 12),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _SecurityToggle extends StatelessWidget {
  const _SecurityToggle({
    required this.icon,
    required this.title,
    required this.detail,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: enabled ? 1 : 0.55,
      child: LoopCard(
        child: Row(
          children: <Widget>[
            Icon(
              icon,
              color: value && enabled ? LoopColors.mint : LoopColors.vapor,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(detail, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
            Switch(value: value, onChanged: enabled ? onChanged : null),
          ],
        ),
      ),
    );
  }
}

class _AliasAvatar extends StatelessWidget {
  const _AliasAvatar({this.size = 54});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[LoopColors.market, LoopColors.chat],
        ),
        border: Border.all(color: LoopColors.chalk.withValues(alpha: 0.18)),
      ),
      alignment: Alignment.center,
      child: Icon(
        Icons.blur_on_rounded,
        color: LoopColors.abyss,
        size: size * 0.5,
      ),
    );
  }
}
