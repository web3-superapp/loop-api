import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class SendAssetScreen extends StatelessWidget {
  const SendAssetScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Choose asset',
      eyebrow: 'Send · 1 of 3',
      subtitle: 'Only available balances are shown.',
      children: <Widget>[
        const TextField(
          decoration: InputDecoration(
            hintText: 'Search assets',
            prefixIcon: Icon(Icons.search_rounded),
          ),
        ),
        const LoopSectionLabel('Available'),
        _SendAssetRow(
          symbol: 'ETH',
          name: 'Ethereum',
          balance: '4.82 ETH',
          value: r'$22,319.01',
          onTap: () => context.push('/wallet/send/to'),
        ),
        _SendAssetRow(
          symbol: 'USDC',
          name: 'USD Coin',
          balance: '6,810.20 USDC',
          value: r'$6,810.20',
          onTap: () => context.push('/wallet/send/to'),
        ),
        _SendAssetRow(
          symbol: 'SOL',
          name: 'Solana',
          balance: '13.44 SOL',
          value: r'$2,110.79',
          onTap: () => context.push('/wallet/send/to'),
        ),
        const LoopSectionLabel('Unavailable'),
        const LoopStateCard(
          title: 'ARB has no spendable balance',
          message:
              'The asset remains visible so a zero balance is not confused with a loading error.',
          icon: Icons.account_balance_wallet_outlined,
        ),
      ],
    );
  }
}

class _SendAssetRow extends StatelessWidget {
  const _SendAssetRow({
    required this.symbol,
    required this.name,
    required this.balance,
    required this.value,
    required this.onTap,
  });

  final String symbol;
  final String name;
  final String balance;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      minTileHeight: 68,
      contentPadding: EdgeInsets.zero,
      leading: LoopAssetMark(symbol: symbol),
      title: Text(name, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(balance, style: Theme.of(context).textTheme.bodyMedium),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(value, style: context.dataStyle),
          const SizedBox(width: 6),
          const Icon(Icons.chevron_right_rounded, color: LoopColors.vapor),
        ],
      ),
    );
  }
}

class SendRecipientScreen extends StatefulWidget {
  const SendRecipientScreen({super.key});

  @override
  State<SendRecipientScreen> createState() => _SendRecipientScreenState();
}

class _SendRecipientScreenState extends State<SendRecipientScreen> {
  final controller = TextEditingController(text: '0xA1c0…88C2');

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Choose recipient',
      eyebrow: 'Send ETH · 2 of 3',
      subtitle: 'The full address is reviewed again before signing.',
      bottom: LoopActionDock(
        child: FilledButton(
          onPressed: controller.text.trim().isEmpty
              ? null
              : () => context.push('/wallet/send/confirm'),
          child: const Text('Continue'),
        ),
      ),
      children: <Widget>[
        TextField(
          controller: controller,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: 'Address or name',
            prefixIcon: const Icon(Icons.alternate_email_rounded),
            suffixIcon: IconButton(
              onPressed: () {},
              tooltip: 'Scan address',
              icon: const Icon(Icons.qr_code_scanner_rounded),
            ),
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'First time sending here',
          message:
              'This address has not received funds from this wallet before. Check every character in the final review.',
          icon: Icons.person_search_outlined,
          tone: LoopTone.warning,
        ),
        const LoopSectionLabel('Recent'),
        const _RecipientRow(name: 'Treasury', address: '0x3C91…D710'),
        const _RecipientRow(name: 'Cold wallet', address: '0x21B4…A90F'),
        const LoopSectionLabel('Recipient facts'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Network', value: 'Ethereum'),
              LoopKeyValueRow(
                label: 'Address format',
                value: 'Valid',
                tone: LoopTone.positive,
              ),
              LoopKeyValueRow(
                label: 'Sanctions match',
                value: 'No known match',
                tone: LoopTone.positive,
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _RecipientRow extends StatelessWidget {
  const _RecipientRow({required this.name, required this.address});

  final String name;
  final String address;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: () {},
      contentPadding: EdgeInsets.zero,
      minTileHeight: 60,
      leading: const CircleAvatar(
        backgroundColor: LoopColors.elevated,
        child: Icon(Icons.person_outline_rounded, color: LoopColors.vapor),
      ),
      title: Text(name, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(
        address,
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(fontFamily: 'monospace'),
      ),
      trailing: const Icon(
        Icons.chevron_right_rounded,
        color: LoopColors.vapor,
      ),
    );
  }
}

class SendConfirmScreen extends StatefulWidget {
  const SendConfirmScreen({super.key});

  @override
  State<SendConfirmScreen> createState() => _SendConfirmScreenState();
}

class _SendConfirmScreenState extends State<SendConfirmScreen> {
  final controller = TextEditingController(text: '0.25');

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Confirm transfer',
      eyebrow: 'Send ETH · 3 of 3',
      subtitle:
          'No balance changes until the provider reports a confirmed transaction.',
      bottom: LoopActionDock(
        child: FilledButton(
          onPressed: () {
            final now = DateTime.now().toUtc();
            final intent = SigningIntent.transfer(
              revision: 'transfer_eth_0001',
              asset: 'ETH',
              amount: '${controller.text} ETH',
              recipient: '0xA1c0F6B39D3b9B0C5e7A8426CF52AaFB1fA888C2',
              network: 'Ethereum',
              fee: '0.00042 ETH',
              observedAt: now,
              expiresAt: now.add(const Duration(seconds: 30)),
            );
            context.push('/preview/signing-review', extra: intent);
          },
          child: const Text('Review transfer'),
        ),
      ),
      children: <Widget>[
        LoopCard(
          accent: true,
          tone: LoopTone.positive,
          child: Column(
            children: <Widget>[
              const LoopAssetMark(symbol: 'ETH', size: 52),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                textAlign: TextAlign.center,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                style: Theme.of(context).textTheme.displayMedium,
                decoration: const InputDecoration(
                  suffixText: 'ETH',
                  helperText: 'Available 4.82 ETH',
                ),
              ),
              const SizedBox(height: 8),
              Text(
                r'≈ $1,157.63',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Transfer details'),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'To', value: '0xA1c0…88C2'),
              LoopKeyValueRow(label: 'Network', value: 'Ethereum'),
              LoopKeyValueRow(
                label: 'Estimated network fee',
                value: '0.00042 ETH',
              ),
              LoopKeyValueRow(
                label: 'Estimated arrival',
                value: '~30 seconds',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'Simulation ready',
          message:
              'Expected result: 0.25 ETH leaves this wallet and no token approvals change.',
          icon: Icons.check_circle_outline_rounded,
          tone: LoopTone.positive,
        ),
      ],
    );
  }
}

enum TransactionPreviewState { pending, succeeded, failed, unknown }

class TransactionResultScreen extends StatefulWidget {
  const TransactionResultScreen({super.key});

  @override
  State<TransactionResultScreen> createState() =>
      _TransactionResultScreenState();
}

class _TransactionResultScreenState extends State<TransactionResultScreen> {
  TransactionPreviewState state = TransactionPreviewState.pending;

  @override
  Widget build(BuildContext context) {
    final view = switch (state) {
      TransactionPreviewState.pending => (
        Icons.hourglass_top_rounded,
        LoopTone.warning,
        'Transaction pending',
        'The wallet submitted the transaction. Waiting for a network receipt.',
      ),
      TransactionPreviewState.succeeded => (
        Icons.check_circle_rounded,
        LoopTone.positive,
        'Transfer complete',
        '0.25 ETH reached 0xA1c0…88C2.',
      ),
      TransactionPreviewState.failed => (
        Icons.error_outline_rounded,
        LoopTone.danger,
        'Transaction failed',
        'The network rejected the transaction. Your displayed balance was not changed.',
      ),
      TransactionPreviewState.unknown => (
        Icons.help_outline_rounded,
        LoopTone.warning,
        'Submission status unknown',
        'The request may have reached the network. LOOP will read back the account before offering another attempt.',
      ),
    };
    return LoopPage(
      title: 'Transaction result',
      subtitle:
          'Preview each terminal state without claiming a live transaction.',
      children: <Widget>[
        SegmentedButton<TransactionPreviewState>(
          segments: const <ButtonSegment<TransactionPreviewState>>[
            ButtonSegment<TransactionPreviewState>(
              value: TransactionPreviewState.pending,
              label: Text('Pending'),
            ),
            ButtonSegment<TransactionPreviewState>(
              value: TransactionPreviewState.succeeded,
              label: Text('Done'),
            ),
            ButtonSegment<TransactionPreviewState>(
              value: TransactionPreviewState.failed,
              label: Text('Failed'),
            ),
            ButtonSegment<TransactionPreviewState>(
              value: TransactionPreviewState.unknown,
              label: Text('Unknown'),
            ),
          ],
          selected: <TransactionPreviewState>{state},
          onSelectionChanged: (value) => setState(() => state = value.first),
          showSelectedIcon: false,
        ),
        const SizedBox(height: 22),
        LoopCard(
          accent: true,
          tone: view.$2,
          padding: const EdgeInsets.all(24),
          child: Column(
            children: <Widget>[
              Icon(view.$1, color: loopToneColor(view.$2), size: 50),
              const SizedBox(height: 16),
              Text(
                view.$3,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 8),
              Text(
                view.$4,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Asset', value: '0.25 ETH'),
              LoopKeyValueRow(label: 'Network', value: 'Ethereum'),
              LoopKeyValueRow(label: 'Recipient', value: '0xA1c0…88C2'),
              LoopKeyValueRow(
                label: 'Transaction',
                value: '0x72f1…9c2a',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        FilledButton(
          onPressed: () => context.go('/wallet'),
          child: const Text('Return to wallet'),
        ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: () {},
          icon: const Icon(Icons.open_in_new_rounded),
          label: const Text('Open block explorer'),
        ),
      ],
    );
  }
}
