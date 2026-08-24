import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Wallet',
      eyebrow: 'Embedded wallet',
      subtitle: '0x71E4…6A09 · Privy protection enabled',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/wallet/manage'),
          tooltip: 'Manage wallets',
          icon: const Icon(Icons.account_balance_wallet_outlined),
        ),
        IconButton(
          onPressed: () => context.push('/profile/security'),
          tooltip: 'Wallet security',
          icon: const Icon(Icons.shield_outlined),
        ),
        const SizedBox(width: 4),
      ],
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: LoopContextRail(stage: LoopStage.execute),
        ),
        const SizedBox(height: 22),
        const _WalletBalanceCard(),
        const SizedBox(height: 16),
        Row(
          children: <Widget>[
            Expanded(
              child: _WalletAction(
                label: 'Send',
                icon: Icons.north_east_rounded,
                onTap: () => context.push('/wallet/send'),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: _WalletAction(
                label: 'Receive',
                icon: Icons.south_west_rounded,
                onTap: () => context.push('/wallet/receive'),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: _WalletAction(
                label: 'Swap',
                icon: Icons.swap_vert_rounded,
                onTap: () => context.push('/wallet/swap'),
              ),
            ),
          ],
        ),
        const LoopSectionLabel('Assets'),
        _AssetRow(
          symbol: 'ETH',
          name: 'Ethereum',
          amount: '4.82 ETH',
          value: r'$22,319.01',
          change: '+3.8%',
          onTap: () => context.push('/wallet/asset'),
        ),
        _AssetRow(
          symbol: 'USDC',
          name: 'USD Coin',
          amount: '6,810.20 USDC',
          value: r'$6,810.20',
          change: '0.0%',
          onTap: () => context.push('/wallet/asset'),
        ),
        _AssetRow(
          symbol: 'SOL',
          name: 'Solana',
          amount: '13.44 SOL',
          value: r'$2,110.79',
          change: '-1.2%',
          onTap: () => context.push('/wallet/asset'),
        ),
        const LoopSectionLabel('Trading account'),
        LoopCard(
          onTap: () => context.push('/perp/account'),
          accent: true,
          tone: LoopTone.market,
          semanticLabel: 'Open Hyperliquid margin account',
          child: Row(
            children: <Widget>[
              const LoopAssetMark(symbol: 'H', color: LoopColors.market),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Hyperliquid',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      r'Equity $15,566.25 · margin healthy',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
            ],
          ),
        ),
        const LoopSectionLabel('Review'),
        LoopStateCard(
          title: '1 app can spend USDC',
          message:
              'Review the exact allowance and revoke it if you no longer use the app.',
          icon: Icons.policy_outlined,
          tone: LoopTone.warning,
          action: OutlinedButton(
            onPressed: () => context.push('/wallet/approvals'),
            child: const Text('Review permission'),
          ),
        ),
      ],
    );
  }
}

class _WalletBalanceCard extends StatelessWidget {
  const _WalletBalanceCard();

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.positive,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                'AVAILABLE PORTFOLIO',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const Spacer(),
              const LoopStatusPill(
                label: '3 networks',
                tone: LoopTone.positive,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(r'$31,240.00', style: Theme.of(context).textTheme.displayMedium),
          const SizedBox(height: 6),
          Text(
            r'+$844.18 today',
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: LoopColors.mint),
          ),
          const SizedBox(height: 18),
          const Row(
            children: <Widget>[
              LoopStatusPill(label: 'Ethereum'),
              SizedBox(width: 7),
              LoopStatusPill(label: 'Arbitrum'),
              SizedBox(width: 7),
              LoopStatusPill(label: 'Solana'),
            ],
          ),
        ],
      ),
    );
  }
}

class _WalletAction extends StatelessWidget {
  const _WalletAction({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onTap,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(62),
        padding: const EdgeInsets.symmetric(vertical: 10),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 20, color: LoopColors.mint),
          const SizedBox(height: 5),
          Text(label),
        ],
      ),
    );
  }
}

class _AssetRow extends StatelessWidget {
  const _AssetRow({
    required this.symbol,
    required this.name,
    required this.amount,
    required this.value,
    required this.change,
    required this.onTap,
  });

  final String symbol;
  final String name;
  final String amount;
  final String value;
  final String change;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final positive = !change.startsWith('-');
    return ListTile(
      onTap: onTap,
      minTileHeight: 68,
      contentPadding: EdgeInsets.zero,
      leading: LoopAssetMark(symbol: symbol),
      title: Text(name, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(amount, style: Theme.of(context).textTheme.bodyMedium),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          Text(value, style: context.dataStyle),
          const SizedBox(height: 3),
          Text(
            change,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: positive ? LoopColors.mint : LoopColors.danger,
            ),
          ),
        ],
      ),
    );
  }
}

class AssetDetailScreen extends StatelessWidget {
  const AssetDetailScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Ethereum',
      eyebrow: 'ETH · across 2 networks',
      subtitle: 'Balance and activity are a read-only provider projection.',
      children: <Widget>[
        const Row(
          children: <Widget>[
            LoopAssetMark(symbol: 'ETH', size: 52),
            SizedBox(width: 13),
            Expanded(
              child: LoopMetric(
                label: 'HOLDING',
                value: '4.82 ETH',
                detail: r'$22,319.01',
                tone: LoopTone.positive,
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Average cost', value: r'$3,844.20'),
              LoopKeyValueRow(
                label: 'Unrealized PnL',
                value: r'+$3,786.39',
                tone: LoopTone.positive,
              ),
              LoopKeyValueRow(label: 'Ethereum', value: '3.90 ETH'),
              LoopKeyValueRow(label: 'Arbitrum', value: '0.92 ETH', last: true),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: <Widget>[
            Expanded(
              child: FilledButton.icon(
                onPressed: () => context.push('/wallet/send'),
                icon: const Icon(Icons.north_east_rounded),
                label: const Text('Send'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => context.push('/wallet/receive'),
                icon: const Icon(Icons.south_west_rounded),
                label: const Text('Receive'),
              ),
            ),
          ],
        ),
        const LoopSectionLabel('Activity'),
        const _AssetActivity(
          title: 'Received',
          detail: '+0.40 ETH',
          time: 'Today, 09:18',
          positive: true,
        ),
        const _AssetActivity(
          title: 'Swapped ETH to USDC',
          detail: '-0.12 ETH',
          time: 'Yesterday, 21:44',
        ),
        const _AssetActivity(
          title: 'Sent',
          detail: '-0.08 ETH',
          time: 'Aug 21, 15:02',
        ),
      ],
    );
  }
}

class _AssetActivity extends StatelessWidget {
  const _AssetActivity({
    required this.title,
    required this.detail,
    required this.time,
    this.positive = false,
  });

  final String title;
  final String detail;
  final String time;
  final bool positive;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      minTileHeight: 62,
      leading: Icon(
        positive ? Icons.south_west_rounded : Icons.north_east_rounded,
        color: positive ? LoopColors.mint : LoopColors.vapor,
      ),
      title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(time, style: Theme.of(context).textTheme.bodyMedium),
      trailing: Text(
        detail,
        style: context.dataStyle.copyWith(
          color: positive ? LoopColors.mint : LoopColors.chalk,
        ),
      ),
    );
  }
}

class ReceiveScreen extends StatefulWidget {
  const ReceiveScreen({super.key});

  @override
  State<ReceiveScreen> createState() => _ReceiveScreenState();
}

class _ReceiveScreenState extends State<ReceiveScreen> {
  String network = 'Ethereum';

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Receive',
      subtitle: 'Only send assets supported on the selected network.',
      children: <Widget>[
        SegmentedButton<String>(
          segments: const <ButtonSegment<String>>[
            ButtonSegment<String>(value: 'Ethereum', label: Text('Ethereum')),
            ButtonSegment<String>(value: 'Arbitrum', label: Text('Arbitrum')),
            ButtonSegment<String>(value: 'Solana', label: Text('Solana')),
          ],
          selected: <String>{network},
          onSelectionChanged: (value) => setState(() => network = value.first),
          showSelectedIcon: false,
        ),
        const SizedBox(height: 22),
        LoopCard(
          child: Column(
            children: <Widget>[
              const _QrPreview(),
              const SizedBox(height: 20),
              Text(
                '0x71E4…6A09',
                style: context.dataStyle.copyWith(fontSize: 17),
              ),
              const SizedBox(height: 5),
              Text(network, style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: () {},
                icon: const Icon(Icons.copy_rounded),
                label: const Text('Copy address'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        LoopStateCard(
          title: 'Check the network',
          message:
              'Sending on a different network may make funds unavailable. This address is shown for $network only.',
          icon: Icons.info_outline_rounded,
          tone: LoopTone.warning,
        ),
      ],
    );
  }
}

class _QrPreview extends StatelessWidget {
  const _QrPreview();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'Wallet address QR code preview',
      child: Container(
        width: 208,
        height: 208,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: LoopColors.chalk,
          borderRadius: LoopRadius.medium,
        ),
        child: CustomPaint(painter: const _QrPainter()),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter();

  @override
  void paint(Canvas canvas, Size size) {
    const cells = 17;
    final cell = size.width / cells;
    final paint = Paint()..color = LoopColors.abyss;
    for (var row = 0; row < cells; row++) {
      for (var column = 0; column < cells; column++) {
        final corner =
            (row < 5 && column < 5) ||
            (row < 5 && column >= cells - 5) ||
            (row >= cells - 5 && column < 5);
        final fill = corner || ((row * 7 + column * 11 + row * column) % 5 < 2);
        if (fill) {
          canvas.drawRect(
            Rect.fromLTWH(column * cell, row * cell, cell - 0.7, cell - 0.7),
            paint,
          );
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
