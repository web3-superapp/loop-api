import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

@immutable
class ProfileIdentity {
  const ProfileIdentity({
    this.alias = 'QuietComet',
    this.address = '0x7c4e…9f21',
    this.bio = 'Reading markets, sharing carefully.',
    this.connections = 128,
    this.groups = 7,
    this.watchlistItems = 12,
  });

  final String alias;
  final String address;
  final String bio;
  final int connections;
  final int groups;
  final int watchlistItems;
}

/// Privy-backed capabilities used by Profile security and recovery surfaces.
/// Sensitive capabilities remain unavailable until the integration confirms
/// them for the current account and device.
@immutable
class PrivyProfileCapabilities {
  const PrivyProfileCapabilities({
    this.mfaAvailable = false,
    this.appLockAvailable = false,
    this.deviceManagementAvailable = false,
    this.recoveryPhraseRevealAvailable = false,
    this.socialRecoveryAvailable = false,
    this.secureScreenProtectionActive = false,
  });

  const PrivyProfileCapabilities.unavailable() : this();

  final bool mfaAvailable;
  final bool appLockAvailable;
  final bool deviceManagementAvailable;
  final bool recoveryPhraseRevealAvailable;
  final bool socialRecoveryAvailable;
  final bool secureScreenProtectionActive;
}

typedef ProfileNavigation = void Function(String destination);
typedef SensitiveProfileAuthentication = Future<bool> Function();

/// Single routing surface for H1-H16.
class ProfileSurfaceScreen extends StatelessWidget {
  const ProfileSurfaceScreen.fromId(
    this.surfaceId, {
    super.key,
    this.identity = const ProfileIdentity(),
    this.capabilities = const PrivyProfileCapabilities.unavailable(),
    this.onNavigate,
    this.onAuthenticateSensitiveAction,
    this.recoveryWords,
  });

  static const supportedIds = <String>{
    'profile',
    'profile-edit',
    'privacy',
    'copytrade-perms',
    'security',
    'devices',
    'seed-backup',
    'social-recovery',
    'notif-settings',
    'connections',
    'blocklist',
    'settings',
    'about',
    'support',
    'mining',
    'referral',
  };

  final String surfaceId;
  final ProfileIdentity identity;
  final PrivyProfileCapabilities capabilities;
  final ProfileNavigation? onNavigate;
  final SensitiveProfileAuthentication? onAuthenticateSensitiveAction;

  /// Injected only after a secure, freshly authorized recovery operation.
  final List<String>? recoveryWords;

  String get _id => surfaceId.replaceFirst('#', '').toLowerCase();

  void _navigate(BuildContext context, String destination) {
    if (onNavigate != null) {
      onNavigate!(destination);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('This setting is ready to open.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    void navigate(String destination) => _navigate(context, destination);
    return switch (_id) {
      'profile' => _ProfileHome(identity: identity, onNavigate: navigate),
      'profile-edit' => _ProfileEdit(identity: identity),
      'privacy' => const _PrivacyCenter(),
      'copytrade-perms' => const _CopyTradePermissions(),
      'security' => _SecurityCenter(
        capabilities: capabilities,
        onNavigate: navigate,
      ),
      'devices' => _DeviceManagement(
        capabilityAvailable: capabilities.deviceManagementAvailable,
      ),
      'seed-backup' => _RecoveryPhraseAccess(
        capabilities: capabilities,
        authenticate: onAuthenticateSensitiveAction,
        recoveryWords: recoveryWords,
      ),
      'social-recovery' => _SocialRecovery(
        capabilityAvailable: capabilities.socialRecoveryAvailable,
      ),
      'notif-settings' => const _NotificationSettings(),
      'connections' => const _ConnectionsScreen(),
      'blocklist' => const _BlocklistScreen(),
      'settings' => const _GeneralSettings(),
      'about' => const _AboutAndLegal(),
      'support' => const _SupportScreen(),
      'mining' => const _ComingLaterScreen(
        eyebrow: 'MINING & REWARDS',
        title: 'Rewards are coming later',
        message:
            'Tasks, contribution rewards, and daily claims are planned for Phase 2. No points are accruing yet.',
        icon: Icons.hexagon_outlined,
        accent: LoopColors.market,
      ),
      'referral' => const _ComingLaterScreen(
        eyebrow: 'INVITE FRIENDS',
        title: 'Referrals are coming later',
        message:
            'Invite codes and reward rules are planned for Phase 2. Sharing now will not create a referral.',
        icon: Icons.group_add_outlined,
        accent: LoopColors.chat,
      ),
      _ => const _UnknownProfileScreen(),
    };
  }
}

class _ProfileHome extends StatelessWidget {
  const _ProfileHome({required this.identity, required this.onNavigate});

  final ProfileIdentity identity;
  final ValueChanged<String> onNavigate;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'YOUR IDENTITY',
      title: 'Profile',
      actions: <Widget>[
        IconButton(
          tooltip: 'Edit profile',
          onPressed: () => onNavigate('profile-edit'),
          icon: const Icon(Icons.edit_outlined),
        ),
      ],
      children: <Widget>[
        _IdentityThreadCard(identity: identity),
        const LoopSectionLabel('Control'),
        _SettingsGroup(
          children: <Widget>[
            _SettingsTile(
              icon: Icons.visibility_outlined,
              title: 'Privacy center',
              detail: 'Aliases, visibility, and portfolio sharing',
              tone: LoopTone.conversation,
              onTap: () => onNavigate('privacy'),
            ),
            _SettingsTile(
              icon: Icons.content_copy_rounded,
              title: 'Copy-trade permissions',
              detail: 'Nobody can copy you by default',
              onTap: () => onNavigate('copytrade-perms'),
            ),
            _SettingsTile(
              icon: Icons.shield_outlined,
              title: 'Security center',
              detail: 'MFA, app lock, devices, and recovery',
              tone: LoopTone.positive,
              onTap: () => onNavigate('security'),
              last: true,
            ),
          ],
        ),
        const LoopSectionLabel('People & communication'),
        _SettingsGroup(
          children: <Widget>[
            _SettingsTile(
              icon: Icons.people_outline_rounded,
              title: 'Connections',
              detail: '${identity.connections} people in your network',
              onTap: () => onNavigate('connections'),
            ),
            _SettingsTile(
              icon: Icons.notifications_outlined,
              title: 'Notifications',
              detail: 'Trades, prices, community, and security',
              onTap: () => onNavigate('notif-settings'),
            ),
            _SettingsTile(
              icon: Icons.block_outlined,
              title: 'Blocked items',
              detail: 'People, contracts, and domains',
              onTap: () => onNavigate('blocklist'),
              last: true,
            ),
          ],
        ),
        const LoopSectionLabel('LOOP'),
        _SettingsGroup(
          children: <Widget>[
            _SettingsTile(
              icon: Icons.tune_rounded,
              title: 'General settings',
              detail: 'Language, currency, theme, and data',
              onTap: () => onNavigate('settings'),
            ),
            _SettingsTile(
              icon: Icons.help_outline_rounded,
              title: 'Help & support',
              detail: 'Guides and account help',
              onTap: () => onNavigate('support'),
            ),
            _SettingsTile(
              icon: Icons.info_outline_rounded,
              title: 'About & legal',
              detail: 'Terms, privacy, risks, and licenses',
              onTap: () => onNavigate('about'),
              last: true,
            ),
          ],
        ),
        const LoopSectionLabel('Later'),
        Row(
          children: <Widget>[
            Expanded(
              child: _LaterTile(
                icon: Icons.hexagon_outlined,
                title: 'Mining',
                onTap: () => onNavigate('mining'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _LaterTile(
                icon: Icons.group_add_outlined,
                title: 'Referrals',
                onTap: () => onNavigate('referral'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _ProfileEdit extends StatefulWidget {
  const _ProfileEdit({required this.identity});

  final ProfileIdentity identity;

  @override
  State<_ProfileEdit> createState() => _ProfileEditState();
}

class _ProfileEditState extends State<_ProfileEdit> {
  static const _aliases = <String>[
    'QuietComet',
    'NorthSignal',
    'VelvetOrbit',
    'ClearCurrent',
  ];
  late final TextEditingController _alias;
  late final TextEditingController _bio;
  String _visibility = 'Connections';

  @override
  void initState() {
    super.initState();
    _alias = TextEditingController(text: widget.identity.alias);
    _bio = TextEditingController(text: widget.identity.bio);
  }

  @override
  void dispose() {
    _alias.dispose();
    _bio.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'PUBLIC PROFILE',
      title: 'Edit profile',
      subtitle:
          'Change what people recognize. Wallet addresses remain controlled separately in Privacy.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Profile changes saved.')),
            ),
            child: const Text('Save changes'),
          ),
        ),
      ),
      children: <Widget>[
        Center(
          child: Stack(
            clipBehavior: Clip.none,
            children: <Widget>[
              const _ProfileAvatar(size: 92),
              Positioned(
                right: -6,
                bottom: -6,
                child: IconButton.filled(
                  tooltip: 'Change avatar',
                  onPressed: () {},
                  icon: const Icon(Icons.camera_alt_outlined, size: 19),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 30),
        Text('Alias', style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 8),
        TextField(
          controller: _alias,
          maxLength: 24,
          decoration: InputDecoration(
            suffixIcon: IconButton(
              tooltip: 'Generate another alias',
              onPressed: () {
                final current = _aliases.indexOf(_alias.text);
                _alias.text = _aliases[(current + 1) % _aliases.length];
              },
              icon: const Icon(Icons.shuffle_rounded),
            ),
          ),
        ),
        const SizedBox(height: 14),
        Text('Bio', style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 8),
        TextField(
          controller: _bio,
          minLines: 3,
          maxLines: 4,
          maxLength: 120,
          decoration: const InputDecoration(
            hintText: 'What should people know about you?',
          ),
        ),
        const SizedBox(height: 14),
        DropdownButtonFormField<String>(
          initialValue: _visibility,
          decoration: const InputDecoration(labelText: 'Profile visibility'),
          items: const <String>['Private', 'Connections', 'Everyone']
              .map(
                (value) =>
                    DropdownMenuItem<String>(value: value, child: Text(value)),
              )
              .toList(growable: false),
          onChanged: (value) =>
              setState(() => _visibility = value ?? _visibility),
        ),
      ],
    );
  }
}

class _PrivacyCenter extends StatefulWidget {
  const _PrivacyCenter();

  @override
  State<_PrivacyCenter> createState() => _PrivacyCenterState();
}

class _PrivacyCenterState extends State<_PrivacyCenter> {
  bool _anonymousAlias = true;
  bool _portfolioBroadcast = false;
  bool _activityVisible = false;
  bool _positionsVisible = false;
  final Set<String> _allowedGroups = <String>{'ETH Research'};

  Future<void> _setBroadcast(bool enabled) async {
    if (!enabled) {
      setState(() => _portfolioBroadcast = false);
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Share portfolio updates?'),
        content: const Text(
          'Chosen groups may see assets you buy and sell. Exact balances and private positions remain hidden unless you change their visibility.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep private'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Choose groups'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) setState(() => _portfolioBroadcast = true);
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'PRIVACY',
      title: 'You decide what leaves',
      subtitle:
          'Your alias, wallet, activity, and positions have separate visibility controls.',
      children: <Widget>[
        _SwitchSetting(
          icon: Icons.theater_comedy_outlined,
          title: 'Anonymous chat alias',
          detail: 'Hide wallet addresses in conversations',
          value: _anonymousAlias,
          onChanged: (value) => setState(() => _anonymousAlias = value),
        ),
        const SizedBox(height: 10),
        _SwitchSetting(
          icon: Icons.campaign_outlined,
          title: 'Portfolio Broadcast',
          detail: 'Share selected trades only in approved groups',
          value: _portfolioBroadcast,
          onChanged: _setBroadcast,
        ),
        if (_portfolioBroadcast) ...<Widget>[
          const LoopSectionLabel('Allowed groups'),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children:
                const <String>['ETH Research', 'Perp Desk', 'Solana Builders']
                    .map((group) {
                      final selected = _allowedGroups.contains(group);
                      return FilterChip(
                        label: Text(group),
                        selected: selected,
                        onSelected: (value) => setState(() {
                          if (value) {
                            _allowedGroups.add(group);
                          } else {
                            _allowedGroups.remove(group);
                          }
                        }),
                      );
                    })
                    .toList(growable: false),
          ),
        ],
        const LoopSectionLabel('Visibility matrix'),
        LoopCard(
          child: Column(
            children: <Widget>[
              const _VisibilityRow(
                label: 'Chat alias',
                audience: 'Everyone',
                tone: LoopTone.conversation,
              ),
              const _VisibilityRow(
                label: 'Wallet address',
                audience: 'Private',
              ),
              _VisibilitySwitchRow(
                label: 'Trading activity',
                value: _activityVisible,
                onChanged: (value) => setState(() => _activityVisible = value),
              ),
              _VisibilitySwitchRow(
                label: 'Open positions',
                value: _positionsVisible,
                onChanged: (value) => setState(() => _positionsVisible = value),
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        const _PrivacyFootnote(),
      ],
    );
  }
}

enum _CopyAudience { nobody, approved, followers }

class _CopyTradePermissions extends StatefulWidget {
  const _CopyTradePermissions();

  @override
  State<_CopyTradePermissions> createState() => _CopyTradePermissionsState();
}

class _CopyTradePermissionsState extends State<_CopyTradePermissions> {
  _CopyAudience _audience = _CopyAudience.nobody;
  final TextEditingController _perTrade = TextEditingController(text: '100');
  final TextEditingController _daily = TextEditingController(text: '500');
  bool _pauseOnDrawdown = true;

  @override
  void dispose() {
    _perTrade.dispose();
    _daily.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = _audience != _CopyAudience.nobody;
    return LoopPage(
      eyebrow: 'COPY TRADING',
      title: 'Permission starts at nobody',
      subtitle:
          'Changing this lets other people mirror trades you explicitly share. It never gives them wallet access.',
      bottom: LoopActionDock(
        child: SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  active
                      ? 'Copy-trade permissions saved.'
                      : 'Copy trading remains off.',
                ),
              ),
            ),
            child: const Text('Save permissions'),
          ),
        ),
      ),
      children: <Widget>[
        SegmentedButton<_CopyAudience>(
          showSelectedIcon: false,
          segments: const <ButtonSegment<_CopyAudience>>[
            ButtonSegment(value: _CopyAudience.nobody, label: Text('Nobody')),
            ButtonSegment(
              value: _CopyAudience.approved,
              label: Text('Approved'),
            ),
            ButtonSegment(
              value: _CopyAudience.followers,
              label: Text('Followers'),
            ),
          ],
          selected: <_CopyAudience>{_audience},
          onSelectionChanged: (selection) =>
              setState(() => _audience = selection.first),
        ),
        const SizedBox(height: 20),
        if (!active)
          const LoopStateCard(
            title: 'Copy trading is off',
            message:
                'No one can mirror your trades. Shared trade cards remain informational.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.positive,
          )
        else ...<Widget>[
          TextField(
            controller: _perTrade,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
            ],
            decoration: const InputDecoration(
              labelText: 'Maximum per copied trade',
              prefixText: r'$ ',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _daily,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
            ],
            decoration: const InputDecoration(
              labelText: 'Daily copied-trade limit',
              prefixText: r'$ ',
            ),
          ),
          const SizedBox(height: 12),
          _SwitchSetting(
            icon: Icons.pause_circle_outline_rounded,
            title: 'Pause after a sharp loss',
            detail: 'Stop new copied trades after your configured drawdown',
            value: _pauseOnDrawdown,
            onChanged: (value) => setState(() => _pauseOnDrawdown = value),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: () => setState(() => _audience = _CopyAudience.nobody),
            icon: const Icon(Icons.block_outlined),
            label: const Text('Revoke all copy permissions'),
          ),
        ],
      ],
    );
  }
}

class _SecurityCenter extends StatelessWidget {
  const _SecurityCenter({required this.capabilities, required this.onNavigate});

  final PrivyProfileCapabilities capabilities;
  final ValueChanged<String> onNavigate;

  @override
  Widget build(BuildContext context) {
    final recoveryReady =
        capabilities.recoveryPhraseRevealAvailable ||
        capabilities.socialRecoveryAvailable;
    return LoopPage(
      eyebrow: 'SECURITY',
      title: 'Protect the account',
      subtitle:
          'Account checks protect sensitive actions. Trading limits and wallet permissions are managed separately.',
      children: <Widget>[
        _ProtectionSummary(
          enabled: <bool>[
            capabilities.mfaAvailable,
            capabilities.appLockAvailable,
            recoveryReady,
          ].where((value) => value).length,
        ),
        const LoopSectionLabel('Account protection'),
        _SettingsGroup(
          children: <Widget>[
            _SettingsTile(
              icon: Icons.verified_user_outlined,
              title: 'Multi-factor authentication',
              detail: capabilities.mfaAvailable
                  ? 'Available for this account'
                  : 'Not available for this account',
              trailing: _CapabilityPill(available: capabilities.mfaAvailable),
              onTap: () => onNavigate('security-setup'),
            ),
            _SettingsTile(
              icon: Icons.lock_outline_rounded,
              title: 'App lock',
              detail: capabilities.appLockAvailable
                  ? 'Require a local check when LOOP opens'
                  : 'Not available on this device',
              trailing: _CapabilityPill(
                available: capabilities.appLockAvailable,
              ),
              onTap: () => onNavigate('security-setup'),
            ),
            _SettingsTile(
              icon: Icons.devices_other_outlined,
              title: 'Devices & sessions',
              detail: capabilities.deviceManagementAvailable
                  ? 'Review active sessions'
                  : 'Session management unavailable',
              trailing: _CapabilityPill(
                available: capabilities.deviceManagementAvailable,
              ),
              onTap: () => onNavigate('devices'),
              last: true,
            ),
          ],
        ),
        const LoopSectionLabel('Recovery'),
        _SettingsGroup(
          children: <Widget>[
            _SettingsTile(
              icon: Icons.password_rounded,
              title: 'Recovery phrase',
              detail: capabilities.recoveryPhraseRevealAvailable
                  ? 'Requires a fresh identity check'
                  : 'Not available for this wallet',
              trailing: _CapabilityPill(
                available: capabilities.recoveryPhraseRevealAvailable,
              ),
              onTap: () => onNavigate('seed-backup'),
            ),
            _SettingsTile(
              icon: Icons.group_outlined,
              title: 'Social recovery',
              detail: capabilities.socialRecoveryAvailable
                  ? 'Configure two of three guardians'
                  : 'Not available for this wallet',
              trailing: _CapabilityPill(
                available: capabilities.socialRecoveryAvailable,
              ),
              onTap: () => onNavigate('social-recovery'),
              last: true,
            ),
          ],
        ),
        if (!recoveryReady) ...<Widget>[
          const SizedBox(height: 18),
          const LoopStateCard(
            title: 'Recovery is not set',
            message:
                'Review the methods available for this wallet before relying on this account for long-term access.',
            icon: Icons.warning_amber_rounded,
            tone: LoopTone.warning,
          ),
        ],
        const LoopSectionLabel('Recent sign-ins'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              _LoginRow(
                device: 'iPhone 16 Pro',
                place: 'Shanghai · now',
                current: true,
              ),
              _LoginRow(
                device: 'Safari on Mac',
                place: 'Shanghai · 2 days ago',
                current: false,
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _DeviceManagement extends StatefulWidget {
  const _DeviceManagement({required this.capabilityAvailable});

  final bool capabilityAvailable;

  @override
  State<_DeviceManagement> createState() => _DeviceManagementState();
}

class _DeviceManagementState extends State<_DeviceManagement> {
  final Set<String> _revoked = <String>{};

  Future<void> _remove(String device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Sign out $device?'),
        content: const Text(
          'That device will need to sign in and complete account protection again.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out device'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) setState(() => _revoked.add(device));
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'SESSIONS',
      title: 'Devices with access',
      subtitle: 'Sign out a device you no longer recognize or use.',
      children: <Widget>[
        if (!widget.capabilityAvailable)
          const LoopStateCard(
            title: 'Session controls unavailable',
            message:
                'Device access cannot be changed right now. Your current session is unchanged.',
            icon: Icons.phonelink_erase_outlined,
            tone: LoopTone.warning,
          )
        else ...<Widget>[
          const _DeviceCard(
            icon: Icons.phone_iphone_rounded,
            title: 'iPhone 16 Pro',
            detail: 'Shanghai · active now',
            current: true,
          ),
          const SizedBox(height: 10),
          if (!_revoked.contains('Safari on Mac'))
            _DeviceCard(
              icon: Icons.laptop_mac_rounded,
              title: 'Safari on Mac',
              detail: 'Shanghai · 2 days ago',
              onRemove: () => _remove('Safari on Mac'),
            ),
          if (!_revoked.contains('Safari on Mac')) const SizedBox(height: 10),
          if (!_revoked.contains('Chrome on Windows'))
            _DeviceCard(
              icon: Icons.computer_rounded,
              title: 'Chrome on Windows',
              detail: 'Singapore · 18 days ago',
              tone: LoopTone.warning,
              onRemove: () => _remove('Chrome on Windows'),
            ),
          if (_revoked.isNotEmpty) ...<Widget>[
            const SizedBox(height: 14),
            LoopStateCard(
              title: '${_revoked.length} device signed out',
              message: 'Its session can no longer open this account.',
              icon: Icons.check_circle_outline_rounded,
              tone: LoopTone.positive,
            ),
          ],
        ],
      ],
    );
  }
}

class _RecoveryPhraseAccess extends StatefulWidget {
  const _RecoveryPhraseAccess({
    required this.capabilities,
    required this.authenticate,
    required this.recoveryWords,
  });

  final PrivyProfileCapabilities capabilities;
  final SensitiveProfileAuthentication? authenticate;
  final List<String>? recoveryWords;

  @override
  State<_RecoveryPhraseAccess> createState() => _RecoveryPhraseAccessState();
}

class _RecoveryPhraseAccessState extends State<_RecoveryPhraseAccess>
    with WidgetsBindingObserver {
  bool _authenticating = false;
  bool _revealed = false;
  String? _message;

  bool get _available =>
      widget.capabilities.recoveryPhraseRevealAvailable &&
      widget.capabilities.secureScreenProtectionActive &&
      widget.authenticate != null &&
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
    if (state != AppLifecycleState.resumed && mounted) {
      setState(() => _revealed = false);
    }
  }

  Future<void> _authenticate() async {
    if (!_available) return;
    setState(() {
      _authenticating = true;
      _message = null;
    });
    bool allowed;
    try {
      allowed = await widget.authenticate!();
    } on Object {
      allowed = false;
    }
    if (!mounted) return;
    setState(() {
      _authenticating = false;
      _revealed = allowed;
      _message = allowed
          ? null
          : 'Identity check failed. Recovery words remain hidden.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'RECOVERY',
      title: 'View recovery words',
      subtitle:
          'A fresh identity check is required every time. Words hide as soon as LOOP leaves the foreground.',
      children: <Widget>[
        const LoopStateCard(
          title: 'Never share these words',
          message:
              'Anyone with the full phrase can control the wallet. Support will never ask you for it.',
          icon: Icons.warning_amber_rounded,
          tone: LoopTone.danger,
        ),
        const SizedBox(height: 16),
        if (!_available)
          LoopStateCard(
            title: 'Recovery words unavailable',
            message: widget.capabilities.secureScreenProtectionActive
                ? 'This wallet has not authorized a secure recovery-word reveal. Nothing is displayed.'
                : 'Screen-capture protection could not be confirmed, so recovery words stay hidden.',
            icon: Icons.lock_outline_rounded,
            tone: LoopTone.warning,
          )
        else if (!_revealed) ...<Widget>[
          LoopCard(
            child: Column(
              children: <Widget>[
                const Icon(
                  Icons.fingerprint_rounded,
                  color: LoopColors.mint,
                  size: 52,
                ),
                const SizedBox(height: 14),
                Text(
                  'Confirm it’s you',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 7),
                Text(
                  'Use your configured passkey, biometrics, or app PIN.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 18),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _authenticating ? null : _authenticate,
                    child: Text(
                      _authenticating ? 'Checking…' : 'Verify identity',
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (_message != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              _message!,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: LoopColors.danger),
            ),
          ],
        ] else ...<Widget>[
          _RecoveryWordGrid(words: widget.recoveryWords!),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: () => setState(() => _revealed = false),
              icon: const Icon(Icons.visibility_off_outlined),
              label: const Text('Hide recovery words'),
            ),
          ),
        ],
      ],
    );
  }
}

class _SocialRecovery extends StatefulWidget {
  const _SocialRecovery({required this.capabilityAvailable});

  final bool capabilityAvailable;

  @override
  State<_SocialRecovery> createState() => _SocialRecoveryState();
}

class _SocialRecoveryState extends State<_SocialRecovery> {
  final List<({String name, String detail, bool confirmed})> _guardians =
      <({String name, String detail, bool confirmed})>[
        (name: 'Guardian one', detail: 'Confirmed', confirmed: true),
        (name: 'Guardian two', detail: 'Invitation sent', confirmed: false),
      ];

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'SOCIAL RECOVERY',
      title: 'Two of three guardians',
      subtitle:
          'Recovery requires two trusted people. Guardians cannot see balances or move assets.',
      bottom: widget.capabilityAvailable
          ? LoopActionDock(
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _guardians.length < 3
                      ? () => setState(
                          () => _guardians.add((
                            name: 'Guardian three',
                            detail: 'Invitation ready',
                            confirmed: false,
                          )),
                        )
                      : null,
                  icon: const Icon(Icons.person_add_alt_1_rounded),
                  label: Text(
                    _guardians.length < 3
                        ? 'Add guardian'
                        : 'Three guardians added',
                  ),
                ),
              ),
            )
          : null,
      children: <Widget>[
        if (!widget.capabilityAvailable)
          const LoopStateCard(
            title: 'Social recovery unavailable',
            message:
                'This wallet does not currently support guardian-based recovery. No invitations can be sent.',
            icon: Icons.group_off_outlined,
            tone: LoopTone.warning,
          )
        else ...<Widget>[
          _GuardianProgress(
            confirmed: _guardians
                .where((guardian) => guardian.confirmed)
                .length,
          ),
          const LoopSectionLabel('Guardians'),
          for (final guardian in _guardians) ...<Widget>[
            LoopCard(
              child: Row(
                children: <Widget>[
                  _ProfileAvatar(size: 42, muted: !guardian.confirmed),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          guardian.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          guardian.detail,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  LoopStatusPill(
                    label: guardian.confirmed ? 'Confirmed' : 'Waiting',
                    tone: guardian.confirmed
                        ? LoopTone.positive
                        : LoopTone.warning,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          const _PrivacyFootnote(
            text:
                'Choose people you can reach independently. Do not choose three contacts controlled by the same person or account.',
          ),
        ],
      ],
    );
  }
}

class _NotificationSettings extends StatefulWidget {
  const _NotificationSettings();

  @override
  State<_NotificationSettings> createState() => _NotificationSettingsState();
}

class _NotificationSettingsState extends State<_NotificationSettings> {
  final Map<String, bool> _settings = <String, bool>{
    'Price alerts': true,
    'Orders and fills': true,
    'Liquidation risk': true,
    'Community activity': false,
    'Security alerts': true,
    'System notices': true,
  };

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'NOTIFICATIONS',
      title: 'Choose what interrupts you',
      subtitle:
          'Security notices stay prominent. Everything else can be tuned by category.',
      children: <Widget>[
        const LoopStateCard(
          title: 'System notifications are off',
          message:
              'Enable notifications in device settings to receive alerts when LOOP is closed.',
          icon: Icons.notifications_off_outlined,
          tone: LoopTone.warning,
          action: _OpenSettingsButton(),
        ),
        const LoopSectionLabel('Categories'),
        LoopCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: _settings.entries
                .map((entry) {
                  final security = entry.key == 'Security alerts';
                  return SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: entry.value,
                    title: Text(entry.key),
                    subtitle: security
                        ? const Text('Recommended for account protection')
                        : null,
                    onChanged: (value) =>
                        setState(() => _settings[entry.key] = value),
                  );
                })
                .toList(growable: false),
          ),
        ),
        const LoopSectionLabel('Quiet hours'),
        const LoopCard(
          child: Row(
            children: <Widget>[
              Icon(Icons.bedtime_outlined, color: LoopColors.vapor),
              SizedBox(width: 12),
              Expanded(
                child: Text('23:00–08:00 · security alerts still arrive'),
              ),
              Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
            ],
          ),
        ),
      ],
    );
  }
}

enum _ConnectionView { following, followers }

class _ConnectionsScreen extends StatefulWidget {
  const _ConnectionsScreen();

  @override
  State<_ConnectionsScreen> createState() => _ConnectionsScreenState();
}

class _ConnectionsScreenState extends State<_ConnectionsScreen> {
  _ConnectionView _view = _ConnectionView.following;
  final Set<String> _unfollowed = <String>{};

  static const _following = <(String, String)>[
    ('NorthSignal', 'ETH · market structure'),
    ('BlockHarbor', 'BTC · macro'),
    ('SableDesk', 'Perps · risk management'),
  ];
  static const _followers = <(String, String)>[
    ('CopperField', 'Follows your shared watchlist'),
    ('QuietVector', 'Met in ETH Research'),
  ];

  @override
  Widget build(BuildContext context) {
    final people = _view == _ConnectionView.following ? _following : _followers;
    final visible = people
        .where((person) => !_unfollowed.contains(person.$1))
        .toList(growable: false);
    return LoopPage(
      eyebrow: 'NETWORK',
      title: 'Connections',
      subtitle:
          'Social connections use aliases. Wallet addresses are not shared by following someone.',
      children: <Widget>[
        SegmentedButton<_ConnectionView>(
          showSelectedIcon: false,
          segments: const <ButtonSegment<_ConnectionView>>[
            ButtonSegment(
              value: _ConnectionView.following,
              label: Text('Following'),
            ),
            ButtonSegment(
              value: _ConnectionView.followers,
              label: Text('Followers'),
            ),
          ],
          selected: <_ConnectionView>{_view},
          onSelectionChanged: (selection) =>
              setState(() => _view = selection.first),
        ),
        const SizedBox(height: 18),
        if (visible.isEmpty)
          const LoopStateCard(
            title: 'No connections here',
            message: 'People you follow or approve will appear in this list.',
            icon: Icons.people_outline_rounded,
          )
        else
          for (final person in visible) ...<Widget>[
            LoopCard(
              child: Row(
                children: <Widget>[
                  const _ProfileAvatar(size: 44),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          person.$1,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          person.$2,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: () => setState(() => _unfollowed.add(person.$1)),
                    child: Text(
                      _view == _ConnectionView.following
                          ? 'Unfollow'
                          : 'Remove',
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
      ],
    );
  }
}

enum _BlockedKind { people, contracts, domains }

class _BlocklistScreen extends StatefulWidget {
  const _BlocklistScreen();

  @override
  State<_BlocklistScreen> createState() => _BlocklistScreenState();
}

class _BlocklistScreenState extends State<_BlocklistScreen> {
  _BlockedKind _kind = _BlockedKind.people;
  final Map<_BlockedKind, List<(String, String)>> _items =
      <_BlockedKind, List<(String, String)>>{
        _BlockedKind.people: <(String, String)>[
          ('LoudOrbit', 'Blocked 12 Aug'),
        ],
        _BlockedKind.contracts: <(String, String)>[
          ('0x90a2…e114', 'Hidden from discovery'),
        ],
        _BlockedKind.domains: <(String, String)>[
          ('claim-example.xyz', 'Links blocked'),
        ],
      };

  @override
  Widget build(BuildContext context) {
    final items = _items[_kind]!;
    return LoopPage(
      eyebrow: 'BLOCKED ITEMS',
      title: 'Control what you see',
      subtitle:
          'Blocked people cannot message you. Blocked contracts and domains are hidden from discovery surfaces.',
      children: <Widget>[
        SegmentedButton<_BlockedKind>(
          showSelectedIcon: false,
          segments: const <ButtonSegment<_BlockedKind>>[
            ButtonSegment(value: _BlockedKind.people, label: Text('People')),
            ButtonSegment(
              value: _BlockedKind.contracts,
              label: Text('Contracts'),
            ),
            ButtonSegment(value: _BlockedKind.domains, label: Text('Domains')),
          ],
          selected: <_BlockedKind>{_kind},
          onSelectionChanged: (selection) =>
              setState(() => _kind = selection.first),
        ),
        const SizedBox(height: 18),
        if (items.isEmpty)
          const LoopStateCard(
            title: 'Nothing blocked',
            message:
                'Items you block will appear here so you can restore them later.',
            icon: Icons.block_outlined,
          )
        else
          for (final item in List<(String, String)>.of(items)) ...<Widget>[
            LoopCard(
              child: Row(
                children: <Widget>[
                  const Icon(Icons.block_outlined, color: LoopColors.danger),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          item.$1,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          item.$2,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: () => setState(() => items.remove(item)),
                    child: const Text('Unblock'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
      ],
    );
  }
}

class _GeneralSettings extends StatefulWidget {
  const _GeneralSettings();

  @override
  State<_GeneralSettings> createState() => _GeneralSettingsState();
}

class _GeneralSettingsState extends State<_GeneralSettings> {
  String _language = 'English';
  String _currency = 'USD';
  String _theme = 'Dark';
  bool _reduceData = false;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'GENERAL',
      title: 'Settings',
      subtitle: 'Choose how LOOP looks, reads, and uses mobile data.',
      children: <Widget>[
        _SelectSetting(
          icon: Icons.language_rounded,
          label: 'Language',
          value: _language,
          values: const <String>['English', '简体中文', '繁體中文'],
          onChanged: (value) => setState(() => _language = value),
        ),
        const SizedBox(height: 10),
        _SelectSetting(
          icon: Icons.attach_money_rounded,
          label: 'Display currency',
          value: _currency,
          values: const <String>['USD', 'CNY', 'EUR', 'USDC'],
          onChanged: (value) => setState(() => _currency = value),
        ),
        const SizedBox(height: 10),
        _SelectSetting(
          icon: Icons.dark_mode_outlined,
          label: 'Theme',
          value: _theme,
          values: const <String>['Dark', 'Use device setting'],
          onChanged: (value) => setState(() => _theme = value),
        ),
        const SizedBox(height: 10),
        _SwitchSetting(
          icon: Icons.data_saver_on_rounded,
          title: 'Reduce mobile data',
          detail: 'Load charts on demand and lower media quality',
          value: _reduceData,
          onChanged: (value) => setState(() => _reduceData = value),
        ),
        const SizedBox(height: 18),
        const _PrivacyFootnote(
          text:
              'Language and display currency change presentation only. They do not change settlement assets or trading terms.',
        ),
      ],
    );
  }
}

class _AboutAndLegal extends StatelessWidget {
  const _AboutAndLegal();

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'ABOUT LOOP',
      title: 'Clear terms, one place',
      subtitle:
          'Review the rules and risks that apply before using wallet or trading features.',
      children: <Widget>[
        LoopCard(
          accent: true,
          tone: LoopTone.positive,
          child: Row(
            children: <Widget>[
              const _LoopMark(),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'LOOP mobile',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Version 0.1.0 (1)',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const LoopStatusPill(label: 'Current', tone: LoopTone.positive),
            ],
          ),
        ),
        const LoopSectionLabel('Legal'),
        const _SettingsGroup(
          children: <Widget>[
            _DocumentTile(
              title: 'Terms of use',
              detail: 'Last updated 18 Aug 2026',
            ),
            _DocumentTile(
              title: 'Privacy policy',
              detail: 'How identity and activity data are handled',
            ),
            _DocumentTile(
              title: 'Trading risk disclosure',
              detail: 'Leverage, liquidation, and market risk',
            ),
            _DocumentTile(
              title: 'Open-source licenses',
              detail: 'Libraries used by this app',
              last: true,
            ),
          ],
        ),
        const SizedBox(height: 18),
        const _PrivacyFootnote(
          text:
              'Availability of wallet and trading features may vary by account, product, and region.',
        ),
      ],
    );
  }
}

class _SupportScreen extends StatelessWidget {
  const _SupportScreen();

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: 'HELP',
      title: 'Find an answer first',
      subtitle:
          'LOOP support will never ask for a recovery phrase, private key, or one-time code.',
      children: <Widget>[
        const TextField(
          decoration: InputDecoration(
            hintText: 'Search help',
            prefixIcon: Icon(Icons.search_rounded),
          ),
        ),
        const LoopSectionLabel('Common questions'),
        const LoopCard(
          padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Column(
            children: <Widget>[
              ExpansionTile(
                title: Text('Why can’t I access a wallet action?'),
                children: <Widget>[
                  Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Text(
                      'Some actions depend on your wallet type, account protection, device, and region.',
                    ),
                  ),
                ],
              ),
              ExpansionTile(
                title: Text('How do I recover my account?'),
                children: <Widget>[
                  Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Text(
                      'Open Security center to see the recovery methods available for your wallet.',
                    ),
                  ),
                ],
              ),
              ExpansionTile(
                title: Text('How do I report a suspicious message?'),
                children: <Widget>[
                  Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Text(
                      'Open the message menu, choose Report, and block the sender if needed.',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Contact'),
        const LoopStateCard(
          title: 'Support replies are slower right now',
          message:
              'You can still submit a request. Include the screen and time of the issue, but never include secret wallet information.',
          icon: Icons.schedule_rounded,
          tone: LoopTone.warning,
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.support_agent_rounded),
            label: const Text('Support temporarily offline'),
          ),
        ),
      ],
    );
  }
}

class _ComingLaterScreen extends StatelessWidget {
  const _ComingLaterScreen({
    required this.eyebrow,
    required this.title,
    required this.message,
    required this.icon,
    required this.accent,
  });

  final String eyebrow;
  final String title;
  final String message;
  final IconData icon;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      eyebrow: eyebrow,
      title: title,
      subtitle: message,
      children: <Widget>[
        AspectRatio(
          aspectRatio: 1.2,
          child: LoopCard(
            child: Stack(
              alignment: Alignment.center,
              children: <Widget>[
                Container(
                  width: 176,
                  height: 176,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: accent.withValues(alpha: 0.22)),
                  ),
                ),
                Container(
                  width: 112,
                  height: 112,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: accent.withValues(alpha: 0.1),
                    border: Border.all(color: accent.withValues(alpha: 0.42)),
                  ),
                  child: Icon(icon, color: accent, size: 48),
                ),
                Positioned(
                  right: 18,
                  top: 18,
                  child: LoopStatusPill(
                    label: 'COMING LATER',
                    tone: accent == LoopColors.chat
                        ? LoopTone.conversation
                        : LoopTone.market,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        const _PrivacyFootnote(
          text:
              'This page is informational. No rewards, balances, codes, or eligibility are active.',
        ),
      ],
    );
  }
}

class _UnknownProfileScreen extends StatelessWidget {
  const _UnknownProfileScreen();

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      eyebrow: 'PROFILE',
      title: 'Setting unavailable',
      subtitle: 'This profile setting could not be opened.',
      children: <Widget>[
        LoopStateCard(
          title: 'No changes made',
          message: 'Return to Profile and choose another setting.',
          icon: Icons.settings_backup_restore_rounded,
        ),
      ],
    );
  }
}

class _IdentityThreadCard extends StatelessWidget {
  const _IdentityThreadCard({required this.identity});

  final ProfileIdentity identity;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.conversation,
      padding: const EdgeInsets.all(20),
      child: Column(
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const _ProfileAvatar(size: 70),
              const SizedBox(width: 15),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      identity.alias,
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 5),
                    Text(
                      identity.bio,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 9),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 9,
                        vertical: 6,
                      ),
                      decoration: const BoxDecoration(
                        color: LoopColors.elevated,
                        borderRadius: LoopRadius.pill,
                      ),
                      child: Text(
                        identity.address,
                        style: context.dataStyle.copyWith(fontSize: 11),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 22),
          const _IdentityThread(),
          const SizedBox(height: 22),
          Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(
                  label: 'CONNECTIONS',
                  value: '${identity.connections}',
                ),
              ),
              Expanded(
                child: LoopMetric(label: 'GROUPS', value: '${identity.groups}'),
              ),
              Expanded(
                child: LoopMetric(
                  label: 'WATCHLIST',
                  value: '${identity.watchlistItems}',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _IdentityThread extends StatelessWidget {
  const _IdentityThread();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Alias public, wallet private, activity private',
      child: Row(
        children: <Widget>[
          const _ThreadNode(
            label: 'ALIAS',
            icon: Icons.theater_comedy_outlined,
            color: LoopColors.chat,
          ),
          Expanded(child: Container(height: 1, color: LoopColors.line)),
          const _ThreadNode(
            label: 'WALLET',
            icon: Icons.account_balance_wallet_outlined,
            color: LoopColors.mint,
          ),
          Expanded(child: Container(height: 1, color: LoopColors.line)),
          const _ThreadNode(
            label: 'ACTIVITY',
            icon: Icons.show_chart_rounded,
            color: LoopColors.market,
          ),
        ],
      ),
    );
  }
}

class _ThreadNode extends StatelessWidget {
  const _ThreadNode({
    required this.label,
    required this.icon,
    required this.color,
  });

  final String label;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: 0.1),
            border: Border.all(color: color.withValues(alpha: 0.4)),
          ),
          child: Icon(icon, size: 18, color: color),
        ),
        const SizedBox(height: 6),
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(fontSize: 9),
        ),
      ],
    );
  }
}

class _SettingsGroup extends StatelessWidget {
  const _SettingsGroup({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: Column(children: children),
    );
  }
}

class _SettingsTile extends StatelessWidget {
  const _SettingsTile({
    required this.icon,
    required this.title,
    required this.detail,
    required this.onTap,
    this.tone = LoopTone.neutral,
    this.trailing,
    this.last = false,
  });

  final IconData icon;
  final String title;
  final String detail;
  final VoidCallback onTap;
  final LoopTone tone;
  final Widget? trailing;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return Semantics(
      button: true,
      label: '$title. $detail',
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 68),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            border: last
                ? null
                : const Border(bottom: BorderSide(color: LoopColors.line)),
          ),
          child: Row(
            children: <Widget>[
              Icon(
                icon,
                size: 21,
                color: tone == LoopTone.neutral ? LoopColors.vapor : color,
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
              const SizedBox(width: 8),
              trailing ??
                  const Icon(
                    Icons.chevron_right_rounded,
                    color: LoopColors.vapor,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LaterTile extends StatelessWidget {
  const _LaterTile({
    required this.icon,
    required this.title,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, color: LoopColors.vapor),
          const SizedBox(height: 14),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 5),
          Text('Coming later', style: Theme.of(context).textTheme.labelMedium),
        ],
      ),
    );
  }
}

class _SwitchSetting extends StatelessWidget {
  const _SwitchSetting({
    required this.icon,
    required this.title,
    required this.detail,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Row(
        children: <Widget>[
          Icon(icon, color: value ? LoopColors.mint : LoopColors.vapor),
          const SizedBox(width: 13),
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
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}

class _VisibilityRow extends StatelessWidget {
  const _VisibilityRow({
    required this.label,
    required this.audience,
    this.tone = LoopTone.neutral,
  });

  final String label;
  final String audience;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        children: <Widget>[
          Expanded(child: Text(label)),
          LoopStatusPill(label: audience, tone: tone),
        ],
      ),
    );
  }
}

class _VisibilitySwitchRow extends StatelessWidget {
  const _VisibilitySwitchRow({
    required this.label,
    required this.value,
    required this.onChanged,
    this.last = false,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 5),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: value,
        title: Text(label),
        subtitle: Text(value ? 'Visible to approved connections' : 'Private'),
        onChanged: onChanged,
      ),
    );
  }
}

class _PrivacyFootnote extends StatelessWidget {
  const _PrivacyFootnote({
    this.text =
        'Changing visibility affects future views. Content already shared in a conversation may remain visible to its participants.',
  });

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Icon(
          Icons.info_outline_rounded,
          size: 18,
          color: LoopColors.vapor,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
        ),
      ],
    );
  }
}

class _ProtectionSummary extends StatelessWidget {
  const _ProtectionSummary({required this.enabled});

  final int enabled;

  @override
  Widget build(BuildContext context) {
    final color = enabled >= 2 ? LoopColors.mint : LoopColors.warning;
    return LoopCard(
      accent: true,
      tone: enabled >= 2 ? LoopTone.positive : LoopTone.warning,
      child: Row(
        children: <Widget>[
          SizedBox.square(
            dimension: 72,
            child: Stack(
              alignment: Alignment.center,
              children: <Widget>[
                CircularProgressIndicator(
                  value: enabled / 3,
                  strokeWidth: 6,
                  color: color,
                  backgroundColor: LoopColors.line,
                ),
                Text(
                  '$enabled/3',
                  style: context.dataStyle.copyWith(color: color),
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  enabled >= 2
                      ? 'Core protections ready'
                      : 'Add another protection',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 5),
                Text(
                  'MFA, app lock, and recovery each protect a different failure point.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CapabilityPill extends StatelessWidget {
  const _CapabilityPill({required this.available});

  final bool available;

  @override
  Widget build(BuildContext context) {
    return LoopStatusPill(
      label: available ? 'Available' : 'Unavailable',
      tone: available ? LoopTone.positive : LoopTone.neutral,
    );
  }
}

class _LoginRow extends StatelessWidget {
  const _LoginRow({
    required this.device,
    required this.place,
    required this.current,
    this.last = false,
  });

  final String device;
  final String place;
  final bool current;
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
        children: <Widget>[
          Icon(
            current ? Icons.phone_iphone_rounded : Icons.laptop_mac_rounded,
            color: LoopColors.vapor,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(device, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(place, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
          if (current)
            const LoopStatusPill(label: 'This device', tone: LoopTone.positive),
        ],
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({
    required this.icon,
    required this.title,
    required this.detail,
    this.current = false,
    this.tone = LoopTone.neutral,
    this.onRemove,
  });

  final IconData icon;
  final String title;
  final String detail;
  final bool current;
  final LoopTone tone;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: tone != LoopTone.neutral,
      tone: tone,
      child: Row(
        children: <Widget>[
          Icon(icon, color: loopToneColor(tone)),
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
          if (current)
            const LoopStatusPill(label: 'Current', tone: LoopTone.positive)
          else
            TextButton(onPressed: onRemove, child: const Text('Sign out')),
        ],
      ),
    );
  }
}

class _RecoveryWordGrid extends StatelessWidget {
  const _RecoveryWordGrid({required this.words});

  final List<String> words;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.danger,
      child: GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        itemCount: words.length,
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 3,
          childAspectRatio: 2.25,
          crossAxisSpacing: 8,
          mainAxisSpacing: 8,
        ),
        itemBuilder: (context, index) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          alignment: Alignment.centerLeft,
          decoration: const BoxDecoration(
            color: LoopColors.elevated,
            borderRadius: LoopRadius.small,
          ),
          child: Text(
            '${index + 1}. ${words[index]}',
            maxLines: 1,
            overflow: TextOverflow.fade,
            style: context.dataStyle.copyWith(fontSize: 12),
          ),
        ),
      ),
    );
  }
}

class _GuardianProgress extends StatelessWidget {
  const _GuardianProgress({required this.confirmed});

  final int confirmed;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: confirmed >= 2 ? LoopTone.positive : LoopTone.warning,
      child: Row(
        children: <Widget>[
          for (var index = 0; index < 3; index++) ...<Widget>[
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: index < confirmed
                    ? LoopColors.mint.withValues(alpha: 0.12)
                    : LoopColors.elevated,
                shape: BoxShape.circle,
                border: Border.all(
                  color: index < confirmed ? LoopColors.mint : LoopColors.line,
                ),
              ),
              child: Icon(
                index < confirmed
                    ? Icons.check_rounded
                    : Icons.person_outline_rounded,
                color: index < confirmed ? LoopColors.mint : LoopColors.vapor,
                size: 19,
              ),
            ),
            if (index < 2)
              Expanded(child: Container(height: 1, color: LoopColors.line)),
          ],
          const SizedBox(width: 14),
          Text(
            '$confirmed confirmed',
            style: Theme.of(context).textTheme.labelLarge,
          ),
        ],
      ),
    );
  }
}

class _OpenSettingsButton extends StatelessWidget {
  const _OpenSettingsButton();

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: () {},
      child: const Text('Open device settings'),
    );
  }
}

class _SelectSetting extends StatelessWidget {
  const _SelectSetting({
    required this.icon,
    required this.label,
    required this.value,
    required this.values,
    required this.onChanged,
  });

  final IconData icon;
  final String label;
  final String value;
  final List<String> values;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Row(
        children: <Widget>[
          Icon(icon, color: LoopColors.vapor),
          const SizedBox(width: 13),
          Expanded(
            child: Text(label, style: Theme.of(context).textTheme.titleMedium),
          ),
          DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: value,
              items: values
                  .map(
                    (item) => DropdownMenuItem<String>(
                      value: item,
                      child: Text(item),
                    ),
                  )
                  .toList(growable: false),
              onChanged: (next) {
                if (next != null) onChanged(next);
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _DocumentTile extends StatelessWidget {
  const _DocumentTile({
    required this.title,
    required this.detail,
    this.last = false,
  });

  final String title;
  final String detail;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return _SettingsTile(
      icon: Icons.description_outlined,
      title: title,
      detail: detail,
      onTap: () {},
      last: last,
    );
  }
}

class _LoopMark extends StatelessWidget {
  const _LoopMark();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 54,
      height: 54,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: LoopColors.mint, width: 2),
      ),
      child: Text(
        'L',
        style: Theme.of(
          context,
        ).textTheme.headlineMedium?.copyWith(color: LoopColors.mint),
      ),
    );
  }
}

class _ProfileAvatar extends StatelessWidget {
  const _ProfileAvatar({required this.size, this.muted = false});

  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: muted
            ? null
            : const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: <Color>[LoopColors.market, LoopColors.chat],
              ),
        color: muted ? LoopColors.elevated : null,
        border: Border.all(
          color: muted
              ? LoopColors.line
              : LoopColors.chalk.withValues(alpha: 0.18),
        ),
      ),
      alignment: Alignment.center,
      child: Icon(
        Icons.blur_on_rounded,
        color: muted ? LoopColors.vapor : LoopColors.abyss,
        size: size * 0.48,
      ),
    );
  }
}
