import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/intent/signing_intent.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class SwapScreen extends StatefulWidget {
  const SwapScreen({super.key});

  @override
  State<SwapScreen> createState() => _SwapScreenState();
}

class _SwapScreenState extends State<SwapScreen> {
  final payController = TextEditingController(text: '0.50');
  bool quoteCurrent = true;

  @override
  void dispose() {
    payController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Swap',
      subtitle:
          'The active wallet provider supplies the final quote and transaction.',
      bottom: LoopActionDock(
        child: FilledButton(
          onPressed: quoteCurrent
              ? () {
                  final now = DateTime.now().toUtc();
                  context.push(
                    '/preview/signing-review',
                    extra: SigningIntent.swap(
                      revision: 'swap_eth_usdc_0001',
                      pay: '0.50 ETH',
                      receive: '2,302.18 USDC',
                      rate: '1 ETH = 4,604.36 USDC',
                      fee: '2.30 USDC',
                      observedAt: now,
                      expiresAt: now.add(const Duration(seconds: 20)),
                    ),
                  );
                }
              : () => setState(() => quoteCurrent = true),
          child: Text(quoteCurrent ? 'Review swap' : 'Refresh quote'),
        ),
      ),
      children: <Widget>[
        _AssetAmountCard(
          label: 'YOU PAY',
          symbol: 'ETH',
          controller: payController,
          balance: 'Balance 4.82 ETH',
          onChanged: (_) => setState(() => quoteCurrent = false),
        ),
        Transform.translate(
          offset: const Offset(0, -7),
          child: Center(
            child: IconButton.filledTonal(
              onPressed: () {},
              tooltip: 'Reverse assets',
              icon: const Icon(Icons.swap_vert_rounded),
            ),
          ),
        ),
        const _ReceiveAmountCard(),
        const SizedBox(height: 16),
        if (quoteCurrent)
          const LoopStateCard(
            title: 'Quote valid for 20 seconds',
            message:
                'Expected receive 2,302.18 USDC · minimum 2,290.66 USDC at 0.5% slippage.',
            icon: Icons.timer_outlined,
            tone: LoopTone.positive,
          )
        else
          const LoopStateCard(
            title: 'Quote expired',
            message: 'The amount changed. Refresh the quote before continuing.',
            icon: Icons.refresh_rounded,
            tone: LoopTone.warning,
          ),
        const LoopSectionLabel('Quote'),
        LoopCard(
          onTap: () => context.push('/wallet/swap/route'),
          semanticLabel: 'Open swap quote details',
          child: const Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Rate', value: '1 ETH = 4,604.36 USDC'),
              LoopKeyValueRow(label: 'Provider fee', value: '2.30 USDC'),
              LoopKeyValueRow(label: 'Network fee', value: '0.00031 ETH'),
              LoopKeyValueRow(
                label: 'Price impact',
                value: '0.08%',
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

class _AssetAmountCard extends StatelessWidget {
  const _AssetAmountCard({
    required this.label,
    required this.symbol,
    required this.controller,
    required this.balance,
    required this.onChanged,
  });

  final String label;
  final String symbol;
  final TextEditingController controller;
  final String balance;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label, style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 13),
          Row(
            children: <Widget>[
              const LoopAssetMark(symbol: 'ETH'),
              const SizedBox(width: 10),
              Text(symbol, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: controller,
                  onChanged: onChanged,
                  textAlign: TextAlign.right,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  style: context.dataStyle.copyWith(fontSize: 24),
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    filled: false,
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(balance, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}

class _ReceiveAmountCard extends StatelessWidget {
  const _ReceiveAmountCard();

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      accent: true,
      tone: LoopTone.positive,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('YOU RECEIVE', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 13),
          Row(
            children: <Widget>[
              const LoopAssetMark(symbol: 'USDC'),
              const SizedBox(width: 10),
              Text('USDC', style: Theme.of(context).textTheme.titleLarge),
              const Spacer(),
              Text('2,302.18', style: context.dataStyle.copyWith(fontSize: 24)),
            ],
          ),
          const SizedBox(height: 10),
          Text(r'≈ $2,302.18', style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}

class SwapRouteScreen extends StatelessWidget {
  const SwapRouteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const LoopPage(
      title: 'Quote details',
      subtitle:
          'The provider does not expose split routing, so LOOP shows the final quote and fees only.',
      children: <Widget>[
        LoopStateCard(
          title: 'Provider-selected quote',
          message:
              'A route comparison is not shown when the provider does not supply verifiable route legs.',
          icon: Icons.route_outlined,
          tone: LoopTone.market,
        ),
        LoopSectionLabel('Final amounts'),
        LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'Input', value: '0.50 ETH'),
              LoopKeyValueRow(label: 'Expected output', value: '2,302.18 USDC'),
              LoopKeyValueRow(label: 'Minimum output', value: '2,290.66 USDC'),
              LoopKeyValueRow(
                label: 'All estimated fees',
                value: '3.73 USDC',
                last: true,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class BridgeScreen extends StatelessWidget {
  const BridgeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Bridge',
      subtitle:
          'Cross-chain routing will be supplied by the selected provider; LOOP does not operate a bridge.',
      bottom: LoopActionDock(
        child: FilledButton(
          onPressed: () => context.push('/wallet/bridge/status'),
          child: const Text('Preview route status'),
        ),
      ),
      children: <Widget>[
        const LoopCard(
          child: Column(
            children: <Widget>[
              LoopKeyValueRow(label: 'From', value: 'Ethereum · 250 USDC'),
              LoopKeyValueRow(label: 'To', value: 'Arbitrum · 248.92 USDC'),
              LoopKeyValueRow(label: 'Estimated time', value: '2–5 minutes'),
              LoopKeyValueRow(
                label: 'Estimated fees',
                value: '1.08 USDC',
                last: true,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const LoopStateCard(
          title: 'Route preview only',
          message:
              'Production routing credentials are not configured. No bridge request will be submitted.',
          icon: Icons.lock_outline_rounded,
          tone: LoopTone.warning,
        ),
      ],
    );
  }
}

class BridgeStatusScreen extends StatefulWidget {
  const BridgeStatusScreen({super.key});

  @override
  State<BridgeStatusScreen> createState() => _BridgeStatusScreenState();
}

class _BridgeStatusScreenState extends State<BridgeStatusScreen> {
  bool needsClaim = false;

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Bridge progress',
      subtitle:
          'A user can leave this screen and return without losing the provider reference.',
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                'Preview state',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            Switch(
              value: needsClaim,
              onChanged: (value) => setState(() => needsClaim = value),
            ),
            Text('Needs claim', style: Theme.of(context).textTheme.bodyMedium),
          ],
        ),
        const SizedBox(height: 14),
        const _BridgeStep(
          index: '01',
          title: 'Source confirmed',
          detail: 'Ethereum · 14 confirmations',
          complete: true,
        ),
        const _BridgeStep(
          index: '02',
          title: 'Relay processing',
          detail: 'Provider is preparing the destination transfer',
          complete: true,
        ),
        _BridgeStep(
          index: '03',
          title: needsClaim ? 'Manual claim required' : 'Destination pending',
          detail: needsClaim
              ? 'Open the verified provider claim flow'
              : 'Waiting for Arbitrum receipt',
          complete: false,
          warning: needsClaim,
        ),
        const SizedBox(height: 18),
        if (needsClaim)
          FilledButton.icon(
            onPressed: () {},
            icon: const Icon(Icons.open_in_new_rounded),
            label: const Text('Open verified claim flow'),
          )
        else
          OutlinedButton.icon(
            onPressed: () {},
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('Refresh status'),
          ),
      ],
    );
  }
}

class _BridgeStep extends StatelessWidget {
  const _BridgeStep({
    required this.index,
    required this.title,
    required this.detail,
    required this.complete,
    this.warning = false,
  });

  final String index;
  final String title;
  final String detail;
  final bool complete;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final color = warning
        ? LoopColors.warning
        : (complete ? LoopColors.mint : LoopColors.vapor);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: LoopCard(
        accent: complete || warning,
        tone: warning
            ? LoopTone.warning
            : (complete ? LoopTone.positive : LoopTone.neutral),
        child: Row(
          children: <Widget>[
            Text(index, style: context.dataStyle.copyWith(color: color)),
            const SizedBox(width: 14),
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
              complete
                  ? Icons.check_circle_rounded
                  : (warning
                        ? Icons.warning_amber_rounded
                        : Icons.more_horiz_rounded),
              color: color,
            ),
          ],
        ),
      ),
    );
  }
}
