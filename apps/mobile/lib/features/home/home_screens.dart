import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Home overview',
      eyebrow: 'gm, Voyager 7',
      subtitle: 'Your market, conversations and wallet stay in one context.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/search'),
          tooltip: 'Search',
          icon: const Icon(Icons.search_rounded),
        ),
        IconButton(
          onPressed: () => context.push('/notifications'),
          tooltip: 'Notifications',
          icon: Badge(
            smallSize: 7,
            backgroundColor: LoopColors.danger,
            child: const Icon(Icons.notifications_none_rounded),
          ),
        ),
        const SizedBox(width: 4),
      ],
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: LoopContextRail(stage: LoopStage.discover),
        ),
        const SizedBox(height: 24),
        _PortfolioHero(onTap: () => context.push('/home/net-worth')),
        const LoopSectionLabel('Continue the loop'),
        _LoopStep(
          number: '01',
          icon: Icons.radar_rounded,
          title: 'Discover',
          body: 'ETH funding eased while BTC open interest held steady.',
          meta: '3 watchlist moves',
          tone: LoopTone.market,
          onTap: () => context.go('/market'),
        ),
        const SizedBox(height: 10),
        _LoopStep(
          number: '02',
          icon: Icons.forum_outlined,
          title: 'Discuss',
          body: 'ETH Holders Lounge is comparing this week’s positioning.',
          meta: '18 unread',
          tone: LoopTone.conversation,
          onTap: () => context.go('/chat'),
        ),
        const SizedBox(height: 10),
        _LoopStep(
          number: '03',
          icon: Icons.account_balance_wallet_outlined,
          title: 'Execute',
          body: 'Your wallet has one approval worth reviewing.',
          meta: 'Wallet ready',
          tone: LoopTone.positive,
          onTap: () => context.go('/wallet'),
        ),
        const LoopSectionLabel('Live context'),
        LoopCard(
          accent: true,
          tone: LoopTone.conversation,
          onTap: () => context.push('/chat/voice'),
          semanticLabel: 'Open ETH Holders voice room',
          child: Row(
            children: <Widget>[
              const _LiveGlyph(),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'ETH Holders Lounge',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Voice room · connection required',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
            ],
          ),
        ),
        const LoopSectionLabel('Today'),
        _ActivityRow(
          icon: Icons.show_chart_rounded,
          color: LoopColors.market,
          title: 'ETH moved above your alert',
          subtitle: r'$4,630.50 · source refreshed 12s ago',
          time: '2m',
          onTap: () => context.push('/market/token'),
        ),
        _ActivityRow(
          icon: Icons.shield_outlined,
          color: LoopColors.warning,
          title: 'One approval can spend your USDC',
          subtitle: 'Review the app and exact allowance',
          time: '1h',
          onTap: () => context.push('/wallet/approvals'),
        ),
        _ActivityRow(
          icon: Icons.swap_horiz_rounded,
          color: LoopColors.mint,
          title: 'Spot to perp transfer settled',
          subtitle: '250.00 USDC · Hyperliquid account',
          time: '4h',
          onTap: () => context.push('/perp/account'),
        ),
      ],
    );
  }
}

class _PortfolioHero extends StatelessWidget {
  const _PortfolioHero({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      semanticLabel: 'Open net worth details',
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                'TOTAL NET WORTH',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const Spacer(),
              const LoopStatusPill(
                label: '+2.6% today',
                tone: LoopTone.positive,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(r'$46,806.55', style: Theme.of(context).textTheme.displayMedium),
          const SizedBox(height: 16),
          const LoopMiniChart(
            points: <double>[18, 19, 17.8, 20.3, 21, 20.5, 23, 22.7, 24.8, 26],
            height: 62,
            semanticLabel: 'Net worth increased 2.6 percent today',
          ),
          const SizedBox(height: 12),
          const Row(
            children: <Widget>[
              Expanded(
                child: LoopMetric(label: 'WALLET', value: r'$31,240'),
              ),
              Expanded(
                child: LoopMetric(label: 'PERP EQUITY', value: r'$15,566'),
              ),
              Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
            ],
          ),
        ],
      ),
    );
  }
}

class _LoopStep extends StatelessWidget {
  const _LoopStep({
    required this.number,
    required this.icon,
    required this.title,
    required this.body,
    required this.meta,
    required this.tone,
    required this.onTap,
  });

  final String number;
  final IconData icon;
  final String title;
  final String body;
  final String meta;
  final LoopTone tone;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return LoopCard(
      onTap: onTap,
      tone: tone,
      accent: true,
      semanticLabel: '$title. $body',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 35,
            child: Column(
              children: <Widget>[
                Text(
                  number,
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(color: color),
                ),
                const SizedBox(height: 8),
                Icon(icon, size: 20, color: color),
              ],
            ),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Text(title, style: Theme.of(context).textTheme.titleMedium),
                    const Spacer(),
                    Text(
                      meta,
                      style: Theme.of(
                        context,
                      ).textTheme.labelMedium?.copyWith(color: color),
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(body, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _LiveGlyph extends StatelessWidget {
  const _LiveGlyph();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 42,
      height: 42,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: LoopColors.chat.withValues(alpha: 0.12),
        shape: BoxShape.circle,
      ),
      child: const Icon(Icons.graphic_eq_rounded, color: LoopColors.chat),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.time,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final String time;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: LoopRadius.small,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 13),
          child: Row(
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  borderRadius: LoopRadius.small,
                  color: color.withValues(alpha: 0.1),
                ),
                child: Icon(icon, size: 20, color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(title, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(time, style: Theme.of(context).textTheme.labelMedium),
            ],
          ),
        ),
      ),
    );
  }
}

class NetWorthScreen extends StatelessWidget {
  const NetWorthScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Net worth',
      eyebrow: 'Portfolio',
      subtitle:
          'A read-only view across connected wallets and the active trading account.',
      children: <Widget>[
        const LoopCard(
          accent: true,
          tone: LoopTone.positive,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              LoopMetric(
                label: 'TOTAL',
                value: r'$46,806.55',
                detail: r'+$1,186.40 today',
                tone: LoopTone.positive,
              ),
              SizedBox(height: 18),
              LoopMiniChart(
                points: <double>[12, 16, 14, 19, 22, 21, 25, 24, 29, 31],
                height: 130,
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Allocation'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Ethereum wallets', value: r'$24,844.20'),
              LoopKeyValueRow(label: 'Solana wallets', value: r'$6,396.10'),
              LoopKeyValueRow(
                label: 'Hyperliquid equity',
                value: r'$15,566.25',
                last: true,
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Data health'),
        const LoopStateCard(
          title: 'All sources current',
          message:
              'Wallet balances refreshed 14 seconds ago. Hyperliquid equity refreshed 6 seconds ago.',
          icon: Icons.cloud_done_outlined,
          tone: LoopTone.positive,
        ),
      ],
    );
  }
}

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Notifications',
      subtitle: 'Updates stay grouped by what changed, not by provider.',
      actions: <Widget>[
        TextButton(onPressed: () {}, child: const Text('Mark all read')),
      ],
      children: <Widget>[
        const LoopSectionLabel('New'),
        _NotificationCard(
          tone: LoopTone.danger,
          icon: Icons.warning_amber_rounded,
          title: 'ETH position risk increased',
          body:
              'Margin ratio moved to 18.4%. Review before placing another order.',
          time: 'Now',
          onTap: () => context.push('/perp/position'),
        ),
        const SizedBox(height: 10),
        _NotificationCard(
          tone: LoopTone.market,
          icon: Icons.show_chart_rounded,
          title: r'ETH crossed $4,600',
          body: 'Your price alert triggered once. The alert is now paused.',
          time: '8m',
          onTap: () => context.push('/market/token'),
        ),
        const LoopSectionLabel('Earlier'),
        _NotificationCard(
          tone: LoopTone.conversation,
          icon: Icons.alternate_email_rounded,
          title: 'Mentioned in Glyph Hunters',
          body: 'NightOwl mentioned your alias in a reply.',
          time: '2h',
          onTap: () => context.push('/chat/group'),
        ),
      ],
    );
  }
}

class _NotificationCard extends StatelessWidget {
  const _NotificationCard({
    required this.tone,
    required this.icon,
    required this.title,
    required this.body,
    required this.time,
    required this.onTap,
  });

  final LoopTone tone;
  final IconData icon;
  final String title;
  final String body;
  final String time;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: onTap,
      accent: true,
      tone: tone,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, color: loopToneColor(tone), size: 21),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    Text(time, style: Theme.of(context).textTheme.labelMedium),
                  ],
                ),
                const SizedBox(height: 5),
                Text(body, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class GlobalSearchScreen extends StatefulWidget {
  const GlobalSearchScreen({super.key});

  @override
  State<GlobalSearchScreen> createState() => _GlobalSearchScreenState();
}

class _GlobalSearchScreenState extends State<GlobalSearchScreen> {
  final controller = TextEditingController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Search',
      subtitle: 'Assets, Core perpetuals, groups and people.',
      children: <Widget>[
        TextField(
          controller: controller,
          autofocus: true,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            hintText: 'Try ETH or Glyph Hunters',
            prefixIcon: const Icon(Icons.search_rounded),
            suffixIcon: controller.text.isEmpty
                ? null
                : IconButton(
                    onPressed: () => setState(controller.clear),
                    tooltip: 'Clear search',
                    icon: const Icon(Icons.close_rounded),
                  ),
          ),
        ),
        const LoopSectionLabel('Suggested'),
        _SearchResult(
          icon: Icons.currency_bitcoin,
          tone: LoopTone.market,
          title: 'ETH',
          subtitle: r'Token · $4,630.50',
          onTap: () => context.push('/market/token'),
        ),
        _SearchResult(
          icon: Icons.candlestick_chart_rounded,
          tone: LoopTone.positive,
          title: 'ETH-PERP',
          subtitle: 'Hyperliquid Core · funding 0.0081%',
          onTap: () => context.push('/perp/trade'),
        ),
        _SearchResult(
          icon: Icons.forum_outlined,
          tone: LoopTone.conversation,
          title: 'ETH Holders Lounge',
          subtitle: 'Group · voice available',
          onTap: () => context.push('/chat/group'),
        ),
      ],
    );
  }
}

class _SearchResult extends StatelessWidget {
  const _SearchResult({
    required this.icon,
    required this.tone,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final LoopTone tone;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      minTileHeight: 62,
      contentPadding: EdgeInsets.zero,
      leading: Container(
        width: 42,
        height: 42,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: loopToneColor(tone).withValues(alpha: 0.1),
          borderRadius: LoopRadius.small,
        ),
        child: Icon(icon, color: loopToneColor(tone), size: 20),
      ),
      title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(subtitle, style: Theme.of(context).textTheme.bodyMedium),
      trailing: const Icon(
        Icons.chevron_right_rounded,
        color: LoopColors.vapor,
      ),
    );
  }
}

class SecurityActivityScreen extends StatelessWidget {
  const SecurityActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      title: 'Security activity',
      subtitle:
          'Facts from wallet policy and account events. No score is calculated.',
      children: <Widget>[
        LoopStateCard(
          title: 'No urgent action',
          message:
              'MFA is active and no new device signed in during the last seven days.',
          icon: Icons.verified_user_outlined,
          tone: LoopTone.positive,
        ),
        LoopSectionLabel('This week'),
        LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(
                label: 'Unlimited approval blocked',
                value: '1',
                tone: LoopTone.warning,
              ),
              LoopKeyValueRow(label: 'New recipients reviewed', value: '2'),
              LoopKeyValueRow(
                label: 'New device sessions',
                value: '0',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
