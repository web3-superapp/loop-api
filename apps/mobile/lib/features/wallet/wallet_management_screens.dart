import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class TransactionHistoryScreen extends StatefulWidget {
  const TransactionHistoryScreen({super.key});

  @override
  State<TransactionHistoryScreen> createState() =>
      _TransactionHistoryScreenState();
}

class _TransactionHistoryScreenState extends State<TransactionHistoryScreen> {
  String filter = 'All';

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Transaction history',
      subtitle: 'Confirmed wallet activity, grouped by settlement date.',
      children: <Widget>[
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <String>['All', 'Sent', 'Received', 'Swaps']
              .map((item) {
                return ChoiceChip(
                  label: Text(item),
                  selected: filter == item,
                  onSelected: (_) => setState(() => filter = item),
                );
              })
              .toList(growable: false),
        ),
        const LoopSectionLabel('Today'),
        const _HistoryRow(
          icon: Icons.south_west_rounded,
          title: 'Received USDC',
          detail: '+1,250.00 USDC',
          meta: 'Arbitrum · confirmed',
          tone: LoopTone.positive,
        ),
        const _HistoryRow(
          icon: Icons.swap_horiz_rounded,
          title: 'Swapped ETH to USDC',
          detail: '-0.12 ETH',
          meta: 'Ethereum · confirmed',
          tone: LoopTone.market,
        ),
        const LoopSectionLabel('August 21'),
        const _HistoryRow(
          icon: Icons.north_east_rounded,
          title: 'Sent ETH',
          detail: '-0.08 ETH',
          meta: 'Ethereum · 0x71e4…c02a',
        ),
        const SizedBox(height: 12),
        const LoopStateCard(
          title: 'History is settled data',
          message:
              'Pending submissions stay on their transaction result screen until the network receipt is known.',
          icon: Icons.receipt_long_outlined,
        ),
      ],
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.meta,
    this.tone = LoopTone.neutral,
  });

  final IconData icon;
  final String title;
  final String detail;
  final String meta;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      minTileHeight: 68,
      leading: CircleAvatar(
        backgroundColor: loopToneColor(tone).withValues(alpha: 0.12),
        child: Icon(icon, color: loopToneColor(tone)),
      ),
      title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(meta, style: Theme.of(context).textTheme.bodyMedium),
      trailing: Text(detail, style: context.dataStyle),
    );
  }
}

class WalletManagerScreen extends StatefulWidget {
  const WalletManagerScreen({super.key});

  @override
  State<WalletManagerScreen> createState() => _WalletManagerScreenState();
}

class _WalletManagerScreenState extends State<WalletManagerScreen> {
  String selected = 'Daily wallet';

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Manage wallets',
      eyebrow: 'Privy account',
      subtitle:
          'Switch identities and inspect only the controls supported by each wallet.',
      children: <Widget>[
        _WalletIdentity(
          title: 'Daily wallet',
          address: '0x71E4…6A09',
          label: 'Embedded · active',
          selected: selected == 'Daily wallet',
          onTap: () => setState(() => selected = 'Daily wallet'),
        ),
        const SizedBox(height: 10),
        _WalletIdentity(
          title: 'Trading wallet',
          address: '0x88C2…F14B',
          label: 'External · connected',
          selected: selected == 'Trading wallet',
          onTap: () => setState(() => selected = 'Trading wallet'),
        ),
        const LoopSectionLabel('Selected wallet'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(
                label: 'Signing policy',
                value: r'MFA above $1,000',
              ),
              LoopKeyValueRow(label: 'Recovery', value: 'Cloud + passkey'),
              LoopKeyValueRow(
                label: 'Last used',
                value: 'Today, 09:18',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        OutlinedButton.icon(
          onPressed: null,
          icon: const Icon(Icons.add_rounded),
          label: const Text('Add wallet when provider is connected'),
        ),
      ],
    );
  }
}

class _WalletIdentity extends StatelessWidget {
  const _WalletIdentity({
    required this.title,
    required this.address,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String address;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      accent: selected,
      tone: LoopTone.positive,
      child: Row(
        children: <Widget>[
          CircleAvatar(
            backgroundColor: LoopColors.mint.withValues(alpha: 0.12),
            child: const Icon(
              Icons.account_balance_wallet_outlined,
              color: LoopColors.mint,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(
                  '$address · $label',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
          Icon(
            selected ? Icons.check_circle_rounded : Icons.circle_outlined,
            color: selected ? LoopColors.mint : LoopColors.vapor,
          ),
        ],
      ),
    );
  }
}

class DappBrowserScreen extends StatefulWidget {
  const DappBrowserScreen({super.key});

  @override
  State<DappBrowserScreen> createState() => _DappBrowserScreenState();
}

class _DappBrowserScreenState extends State<DappBrowserScreen> {
  final controller = TextEditingController(text: 'app.uniswap.org');

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'DApp browser',
      subtitle:
          'Domain and wallet context remain visible before any permission request.',
      children: <Widget>[
        TextField(
          controller: controller,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.lock_outline_rounded),
            suffixIcon: Icon(Icons.refresh_rounded),
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'Preview mode',
          message:
              'Embedded browsing and live wallet injection are unavailable until domain isolation is configured.',
          icon: Icons.language_rounded,
          tone: LoopTone.warning,
        ),
        const LoopSectionLabel('Before connecting'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Domain', value: 'app.uniswap.org'),
              LoopKeyValueRow(label: 'Selected wallet', value: '0x71E4…6A09'),
              LoopKeyValueRow(label: 'Network', value: 'Ethereum'),
              LoopKeyValueRow(
                label: 'Granted permissions',
                value: 'None',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class ApprovalInterceptScreen extends StatefulWidget {
  const ApprovalInterceptScreen({super.key});

  @override
  State<ApprovalInterceptScreen> createState() =>
      _ApprovalInterceptScreenState();
}

class _ApprovalInterceptScreenState extends State<ApprovalInterceptScreen> {
  bool unlimited = false;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Approval request',
      eyebrow: 'Wallet protection',
      subtitle: 'Choose the allowance you intend to grant before signing.',
      bottom: LoopActionDock(
        child: FilledButton(
          onPressed: unlimited
              ? null
              : () {
                  final now = DateTime.now().toUtc();
                  context.push(
                    '/preview/signing-review',
                    extra: SigningIntent.approval(
                      revision: 'approval_usdc_0001',
                      app: 'app.uniswap.org',
                      asset: 'USDC',
                      allowance: '250.00 USDC',
                      network: 'Ethereum',
                      observedAt: now,
                      expiresAt: now.add(const Duration(seconds: 30)),
                    ),
                  );
                },
          child: Text(
            unlimited
                ? 'Choose a limited allowance'
                : 'Review limited approval',
          ),
        ),
      ),
      children: <Widget>[
        const LoopStateCard(
          title: 'This app wants to spend USDC',
          message:
              'An approval is permission, not a payment. It remains active until you revoke it.',
          icon: Icons.policy_outlined,
          tone: LoopTone.warning,
        ),
        const LoopSectionLabel('Allowance'),
        LoopCard(
          child: RadioGroup<bool>(
            groupValue: unlimited,
            onChanged: (value) => setState(() => unlimited = value ?? false),
            child: const Column(
              children: <Widget>[
                RadioListTile<bool>(
                  value: false,
                  contentPadding: EdgeInsets.zero,
                  title: Text('Limited'),
                  subtitle: Text('Up to 250.00 USDC'),
                ),
                RadioListTile<bool>(
                  value: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text('Unlimited'),
                  subtitle: Text(
                    'Not recommended · action disabled in preview',
                  ),
                ),
              ],
            ),
          ),
        ),
        const LoopSectionLabel('Request facts'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'App', value: 'app.uniswap.org'),
              LoopKeyValueRow(label: 'Asset', value: 'USDC'),
              LoopKeyValueRow(label: 'Network', value: 'Ethereum'),
              LoopKeyValueRow(
                label: 'Current allowance',
                value: '0 USDC',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class ApprovalsScreen extends StatelessWidget {
  const ApprovalsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'App permissions',
      subtitle:
          'Token allowances that are currently visible on supported networks.',
      children: <Widget>[
        const LoopStateCard(
          title: '1 permission needs review',
          message:
              'The allowance is larger than the balance currently held in this wallet.',
          icon: Icons.warning_amber_rounded,
          tone: LoopTone.warning,
        ),
        const LoopSectionLabel('Ethereum'),
        LoopCard(
          accent: true,
          tone: LoopTone.warning,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  const LoopAssetMark(symbol: 'USDC'),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          'Uniswap Router',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          'Unlimited USDC · last used Aug 20',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text(
                        'Revocation requires a configured wallet provider.',
                      ),
                    ),
                  ),
                  child: const Text('Review revocation'),
                ),
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Arbitrum'),
        const LoopStateCard(
          title: 'No active allowances',
          message:
              'Nothing can currently spend supported assets on your behalf.',
          icon: Icons.verified_user_outlined,
          tone: LoopTone.positive,
        ),
      ],
    );
  }
}

class DappListScreen extends StatelessWidget {
  const DappListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      title: 'DApps',
      eyebrow: 'Later phase',
      subtitle:
          'Bookmarks and recent apps will appear after browser isolation and permission controls are production-ready.',
      children: <Widget>[
        LoopStateCard(
          title: 'Deliberately deferred',
          message:
              'The wallet can be completed without an embedded DApp directory. Direct domain connections remain the safer first release.',
          icon: Icons.apps_outlined,
        ),
      ],
    );
  }
}

class NetworksScreen extends StatefulWidget {
  const NetworksScreen({super.key});

  @override
  State<NetworksScreen> createState() => _NetworksScreenState();
}

class _NetworksScreenState extends State<NetworksScreen> {
  bool testnets = false;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Networks',
      subtitle: 'Enabled chains and the last known provider health.',
      children: <Widget>[
        const _NetworkRow(
          name: 'Ethereum',
          detail: 'Healthy · block 20,742,191',
          tone: LoopTone.positive,
        ),
        const _NetworkRow(
          name: 'Arbitrum',
          detail: 'Healthy · block 247,502,118',
          tone: LoopTone.positive,
        ),
        const _NetworkRow(
          name: 'Solana',
          detail: 'Delayed · last refresh 42s ago',
          tone: LoopTone.warning,
        ),
        const LoopSectionLabel('Developer access'),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: testnets,
          onChanged: (value) => setState(() => testnets = value),
          title: const Text('Show testnets'),
          subtitle: const Text(
            'Test assets never contribute to portfolio value.',
          ),
        ),
      ],
    );
  }
}

class _NetworkRow extends StatelessWidget {
  const _NetworkRow({
    required this.name,
    required this.detail,
    required this.tone,
  });

  final String name;
  final String detail;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      minTileHeight: 66,
      leading: Icon(Icons.hub_outlined, color: loopToneColor(tone)),
      title: Text(name, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(detail, style: Theme.of(context).textTheme.bodyMedium),
      trailing: LoopStatusPill(
        label: tone == LoopTone.positive ? 'Online' : 'Stale',
        tone: tone,
      ),
    );
  }
}

class ProtectionScreen extends StatelessWidget {
  const ProtectionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      title: 'Transaction protection',
      eyebrow: 'Later phase',
      subtitle:
          'Protection will explain concrete simulation findings without inventing a risk score.',
      children: <Widget>[
        LoopStateCard(
          title: 'No third-party protection configured',
          message:
              'Privy policies and MFA protect signing authority. Contract simulation and malicious-domain detection require a separate verified data source.',
          icon: Icons.shield_outlined,
          tone: LoopTone.warning,
        ),
        LoopSectionLabel('What remains protected'),
        LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'High-value actions', value: 'MFA policy'),
              LoopKeyValueRow(
                label: 'Exact transaction facts',
                value: 'Single review',
              ),
              LoopKeyValueRow(
                label: 'Provider result',
                value: 'Read back after signing',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
