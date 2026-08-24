import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/features/perp/perp_models.dart';
import 'package:loop_mobile/features/perp/perp_widgets.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

/// D8 — Hyperliquid margin account projection.
class PerpAccountScreen extends StatelessWidget {
  const PerpAccountScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D8 · Margin account',
      title: 'Perp account',
      subtitle:
          'A read-only account projection; LOOP does not maintain a second ledger.',
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/perp/risk'),
          tooltip: 'Open risk notice',
          icon: const Icon(Icons.shield_outlined),
        ),
      ],
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 20),
          LoopCard(
            accent: true,
            tone: LoopTone.positive,
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'ACCOUNT EQUITY · FIXTURE',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 9),
                Text(
                  '\$14,820.64',
                  style: Theme.of(context).textTheme.displayMedium,
                ),
                const SizedBox(height: 6),
                Text(
                  'Hyperliquid account snapshot · not a LOOP balance',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 19),
                const Row(
                  children: <Widget>[
                    Expanded(
                      child: LoopMetric(
                        label: 'Available',
                        value: '9,466.20 USDC',
                      ),
                    ),
                    Expanded(
                      child: LoopMetric(
                        label: 'Used margin',
                        value: '4,806.18 USDC',
                      ),
                    ),
                    Expanded(
                      child: LoopMetric(
                        label: 'Unrealized PnL',
                        value: '+548.26 USDC',
                        tone: LoopTone.positive,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Margin health'),
          LoopCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const LoopStatusPill(
                      label: 'WATCH · FIXTURE',
                      tone: LoopTone.warning,
                      icon: Icons.warning_amber_rounded,
                    ),
                    const Spacer(),
                    Text(
                      '32.4%',
                      style: context.dataStyle.copyWith(fontSize: 18),
                    ),
                  ],
                ),
                const SizedBox(height: 13),
                ClipRRect(
                  borderRadius: LoopRadius.pill,
                  child: const LinearProgressIndicator(
                    value: 0.324,
                    minHeight: 9,
                    color: LoopColors.warning,
                    backgroundColor: LoopColors.elevated,
                  ),
                ),
                const SizedBox(height: 12),
                const LoopKeyValueRow(
                  label: 'Maintenance margin',
                  value: '684.20 USDC',
                ),
                const LoopKeyValueRow(
                  label: 'Withdrawable',
                  value: '8,930.00 USDC',
                ),
                const LoopKeyValueRow(
                  label: 'Closest liq. estimate',
                  value: 'ETH 4,410.00',
                  tone: LoopTone.warning,
                  last: true,
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Account routes'),
          _AccountRouteCard(
            icon: Icons.swap_horiz_rounded,
            title: 'Spot ↔ Perp transfer',
            description:
                'Inspect official account transfer context and rollback states.',
            path: '/perp/transfer',
          ),
          const SizedBox(height: 10),
          _AccountRouteCard(
            icon: Icons.account_balance_outlined,
            title: 'Deposit & withdrawal',
            description:
                'Inspect official Hyperliquid bridge context and network requirements.',
            path: '/perp/deposit',
          ),
          const SizedBox(height: 10),
          _AccountRouteCard(
            icon: Icons.timeline_rounded,
            title: 'Funding details',
            description:
                'Review simulated rate history and the next settlement window.',
            path: '/perp/funding',
          ),
          const SizedBox(height: 10),
          _AccountRouteCard(
            icon: Icons.gpp_maybe_outlined,
            title: 'Leverage & risk notice',
            description:
                'Read the mandatory first-use acknowledgement preview.',
            path: '/perp/risk',
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(),
        ],
      ],
    );
  }
}

class _AccountRouteCard extends StatelessWidget {
  const _AccountRouteCard({
    required this.icon,
    required this.title,
    required this.description,
    required this.path,
  });

  final IconData icon;
  final String title;
  final String description;
  final String path;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      onTap: () => context.push(path),
      semanticLabel: 'Open $title',
      child: Row(
        children: <Widget>[
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: LoopColors.mint.withValues(alpha: 0.09),
              borderRadius: LoopRadius.small,
            ),
            child: Icon(icon, color: LoopColors.mint),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(
                  description,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
          const Icon(Icons.arrow_forward_rounded, size: 19),
        ],
      ),
    );
  }
}

/// D9 — Official Spot ↔ Perp transfer preview.
class PerpTransferScreen extends StatefulWidget {
  const PerpTransferScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  State<PerpTransferScreen> createState() => _PerpTransferScreenState();
}

class _PerpTransferScreenState extends State<PerpTransferScreen> {
  String _direction = 'Spot → Perp';

  @override
  Widget build(BuildContext context) {
    final hasFacts = widget.snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D9 · Official account transfer',
      title: 'Move USDC',
      subtitle:
          'Preview the exact source and destination. No custom bridge, router, or LOOP ledger is involved.',
      children: <Widget>[
        PerpSnapshotBanner(state: widget.snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: widget.snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          SegmentedButton<String>(
            segments: const <ButtonSegment<String>>[
              ButtonSegment<String>(
                value: 'Spot → Perp',
                label: Text('Spot → Perp'),
              ),
              ButtonSegment<String>(
                value: 'Perp → Spot',
                label: Text('Perp → Spot'),
              ),
            ],
            selected: <String>{_direction},
            onSelectionChanged: (selection) =>
                setState(() => _direction = selection.first),
          ),
          const SizedBox(height: 16),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            child: Column(
              children: <Widget>[
                _TransferAccount(
                  label: 'FROM',
                  account: _direction.startsWith('Spot')
                      ? 'Hyperliquid Spot'
                      : 'Hyperliquid Perp',
                  balance: _direction.startsWith('Spot')
                      ? '3,420.00 USDC'
                      : '9,466.20 USDC',
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  child: Row(
                    children: <Widget>[
                      const Expanded(child: Divider()),
                      Container(
                        margin: const EdgeInsets.symmetric(horizontal: 12),
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: LoopColors.market.withValues(alpha: 0.12),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: LoopColors.market.withValues(alpha: 0.3),
                          ),
                        ),
                        child: const Icon(
                          Icons.south_rounded,
                          color: LoopColors.market,
                        ),
                      ),
                      const Expanded(child: Divider()),
                    ],
                  ),
                ),
                _TransferAccount(
                  label: 'TO',
                  account: _direction.startsWith('Spot')
                      ? 'Hyperliquid Perp'
                      : 'Hyperliquid Spot',
                  balance: _direction.startsWith('Spot')
                      ? '9,466.20 USDC'
                      : '3,420.00 USDC',
                ),
                const SizedBox(height: 16),
                const TextField(
                  readOnly: true,
                  decoration: InputDecoration(
                    labelText: 'Amount',
                    hintText: '500.00',
                    suffixText: 'USDC',
                    suffixIcon: Icon(Icons.lock_outline_rounded, size: 18),
                  ),
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Transfer states'),
          const LoopCard(
            child: Column(
              children: <Widget>[
                LoopKeyValueRow(
                  label: 'Provider route',
                  value: 'Official Spot ↔ Perp',
                ),
                LoopKeyValueRow(
                  label: 'Expected state',
                  value: 'Pending → confirmed',
                ),
                LoopKeyValueRow(
                  label: 'Failure rule',
                  value: 'Keep source account explicit',
                ),
                LoopKeyValueRow(
                  label: 'Custom routing',
                  value: 'None',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.lock_outline_rounded),
            label: const Text('Review transfer unavailable'),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'Transfer execution is disabled. A production failure must always state whether funds remain in Spot or Perp.',
          ),
        ],
      ],
    );
  }
}

class _TransferAccount extends StatelessWidget {
  const _TransferAccount({
    required this.label,
    required this.account,
    required this.balance,
  });

  final String label;
  final String account;
  final String balance;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Container(
          width: 42,
          height: 42,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            color: LoopColors.elevated,
          ),
          child: const Icon(Icons.account_balance_wallet_outlined, size: 20),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(label, style: Theme.of(context).textTheme.labelMedium),
              const SizedBox(height: 4),
              Text(account, style: Theme.of(context).textTheme.titleMedium),
            ],
          ),
        ),
        Text(balance, style: context.dataStyle.copyWith(fontSize: 12)),
      ],
    );
  }
}

/// D10 — Official bridge deposit / withdrawal preview.
class PerpDepositScreen extends StatefulWidget {
  const PerpDepositScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  State<PerpDepositScreen> createState() => _PerpDepositScreenState();
}

class _PerpDepositScreenState extends State<PerpDepositScreen> {
  String _mode = 'Deposit';

  @override
  Widget build(BuildContext context) {
    final hasFacts = widget.snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D10 · Official bridge',
      title: 'Deposit & withdraw',
      subtitle:
          'Network and amount details are visible for review; address copy and submission are disabled.',
      children: <Widget>[
        PerpSnapshotBanner(state: widget.snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: widget.snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 18),
          SegmentedButton<String>(
            segments: const <ButtonSegment<String>>[
              ButtonSegment<String>(value: 'Deposit', label: Text('Deposit')),
              ButtonSegment<String>(value: 'Withdraw', label: Text('Withdraw')),
            ],
            selected: <String>{_mode},
            onSelectionChanged: (selection) =>
                setState(() => _mode = selection.first),
          ),
          const SizedBox(height: 16),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            child: Column(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Container(
                      width: 46,
                      height: 46,
                      decoration: BoxDecoration(
                        color: LoopColors.market.withValues(alpha: 0.11),
                        borderRadius: LoopRadius.small,
                      ),
                      child: Icon(
                        _mode == 'Deposit'
                            ? Icons.south_west_rounded
                            : Icons.north_east_rounded,
                        color: LoopColors.market,
                      ),
                    ),
                    const SizedBox(width: 13),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            'USDC on Arbitrum',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Official Hyperliquid bridge context',
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ],
                      ),
                    ),
                    const LoopStatusPill(
                      label: 'FIXTURE',
                      tone: LoopTone.market,
                    ),
                  ],
                ),
                const SizedBox(height: 17),
                if (_mode == 'Deposit') ...<Widget>[
                  Container(
                    width: 152,
                    height: 152,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: LoopColors.elevated,
                      borderRadius: LoopRadius.small,
                      border: Border.all(color: LoopColors.line),
                    ),
                    child: const Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Icon(
                          Icons.qr_code_2_rounded,
                          size: 58,
                          color: LoopColors.vapor,
                        ),
                        SizedBox(height: 7),
                        Text('NO LIVE ADDRESS'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  const TextField(
                    enabled: false,
                    decoration: InputDecoration(
                      labelText: 'Deposit address',
                      hintText: 'Unavailable in preview',
                      suffixIcon: Icon(Icons.content_copy_rounded),
                    ),
                  ),
                ] else ...<Widget>[
                  const TextField(
                    readOnly: true,
                    decoration: InputDecoration(
                      labelText: 'Withdrawal amount',
                      hintText: '100.00',
                      suffixText: 'USDC',
                      suffixIcon: Icon(Icons.lock_outline_rounded, size: 18),
                    ),
                  ),
                  const SizedBox(height: 11),
                  const TextField(
                    enabled: false,
                    decoration: InputDecoration(
                      labelText: 'Destination',
                      hintText: 'No live address',
                    ),
                  ),
                ],
              ],
            ),
          ),
          const LoopSectionLabel('Provider requirements'),
          const LoopCard(
            child: Column(
              children: <Widget>[
                LoopKeyValueRow(label: 'Network', value: 'Arbitrum · preview'),
                LoopKeyValueRow(label: 'Asset', value: 'USDC'),
                LoopKeyValueRow(
                  label: 'Minimum',
                  value: 'Provider value unavailable',
                ),
                LoopKeyValueRow(
                  label: 'Router',
                  value: 'Official bridge only',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const LoopStateCard(
            title: 'Timeouts need a case ID',
            message:
                'Production pending, timeout, and manual-review states must preserve the provider transaction identity.',
            icon: Icons.schedule_rounded,
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: null,
            icon: const Icon(Icons.lock_outline_rounded),
            label: Text('${_mode.toLowerCase()} unavailable'),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'No deposit address, withdrawal request, custom bridge, or routing transaction is created by this preview.',
          ),
        ],
      ],
    );
  }
}

/// D11 — Funding-rate projection.
class PerpFundingScreen extends StatelessWidget {
  const PerpFundingScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  Widget build(BuildContext context) {
    final hasFacts = snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D11 · Funding ledger',
      title: 'Funding rates',
      subtitle:
          'Rates and settlement times are preview projections, not forecasts or live market facts.',
      children: <Widget>[
        PerpSnapshotBanner(state: snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 20),
          LoopCard(
            accent: true,
            tone: LoopTone.market,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    const LoopAssetMark(symbol: 'ETH'),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            'ETH-PERP',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Current preview rate',
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                        ],
                      ),
                    ),
                    Text(
                      '0.0082%',
                      style: context.dataStyle.copyWith(
                        fontSize: 20,
                        color: LoopColors.mint,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                const LoopMiniChart(
                  points: <double>[
                    3,
                    4,
                    3.5,
                    5,
                    4.2,
                    5.8,
                    6.2,
                    5.5,
                    7.1,
                    6.6,
                    8.2,
                  ],
                  color: LoopColors.market,
                  height: 100,
                  semanticLabel: 'Simulated ETH funding rate trend',
                ),
                const SizedBox(height: 14),
                const Row(
                  children: <Widget>[
                    Expanded(
                      child: LoopMetric(
                        label: 'Next settlement',
                        value: '03:18:42',
                        detail: 'Static preview',
                      ),
                    ),
                    Expanded(
                      child: LoopMetric(
                        label: 'Est. payment',
                        value: '-0.47 USDC',
                        detail: 'Not final',
                      ),
                    ),
                    Expanded(
                      child: LoopMetric(label: '8h average', value: '0.0076%'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const LoopSectionLabel('Rate history · preview'),
          const _FundingRow(
            time: '00:00 UTC',
            rate: '0.0079%',
            payment: '-0.45 USDC',
          ),
          const _FundingRow(
            time: '16:00 UTC',
            rate: '0.0084%',
            payment: '-0.48 USDC',
          ),
          const _FundingRow(
            time: '08:00 UTC',
            rate: '0.0068%',
            payment: '-0.39 USDC',
            last: true,
          ),
          const SizedBox(height: 14),
          const PerpReadOnlyNotice(
            message:
                'The countdown does not tick because this is a deterministic preview. Production settlement state must come from Hyperliquid.',
          ),
        ],
      ],
    );
  }
}

class _FundingRow extends StatelessWidget {
  const _FundingRow({
    required this.time,
    required this.rate,
    required this.payment,
    this.last = false,
  });

  final String time;
  final String rate;
  final String payment;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(time, style: Theme.of(context).textTheme.bodyMedium),
          ),
          Text(rate, style: context.dataStyle),
          const SizedBox(width: 28),
          Text(
            payment,
            style: context.dataStyle.copyWith(color: LoopColors.warning),
          ),
        ],
      ),
    );
  }
}

/// D12 — Mandatory leverage and risk acknowledgement preview.
class PerpRiskScreen extends StatefulWidget {
  const PerpRiskScreen({
    super.key,
    this.snapshotState = PerpSnapshotState.preview,
  });

  final PerpSnapshotState snapshotState;

  @override
  State<PerpRiskScreen> createState() => _PerpRiskScreenState();
}

class _PerpRiskScreenState extends State<PerpRiskScreen> {
  bool _understood = false;

  @override
  Widget build(BuildContext context) {
    final hasFacts = widget.snapshotState == PerpSnapshotState.preview;
    return LoopPage(
      eyebrow: 'D12 · First-use gate',
      title: 'Leverage changes the loss',
      subtitle:
          'This acknowledgement is required before a production order review. Preview state is not persisted.',
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 166),
      bottom: LoopActionDock(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            FilledButton.icon(
              onPressed: hasFacts && _understood
                  ? () => context.push('/perp/trade', extra: 'ETH')
                  : null,
              icon: const Icon(Icons.arrow_forward_rounded),
              label: const Text('Continue to order preview'),
            ),
            const SizedBox(height: 7),
            Text(
              _understood
                  ? 'Local preview acknowledged · no production permission granted'
                  : 'Check the acknowledgement to continue',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: _understood ? LoopColors.mint : LoopColors.vapor,
              ),
            ),
          ],
        ),
      ),
      children: <Widget>[
        PerpSnapshotBanner(state: widget.snapshotState),
        if (!hasFacts) ...<Widget>[
          const SizedBox(height: 18),
          PerpStatePanel(state: widget.snapshotState),
        ] else ...<Widget>[
          const SizedBox(height: 20),
          const _RiskStatement(
            icon: Icons.compress_rounded,
            title: 'Leverage accelerates liquidation',
            message:
                'A small adverse price move can consume isolated margin. The displayed liquidation price is an estimate, not a guarantee.',
            tone: LoopTone.danger,
          ),
          const SizedBox(height: 10),
          const _RiskStatement(
            icon: Icons.waterfall_chart_rounded,
            title: 'Mark price drives risk',
            message:
                'Unrealized PnL and liquidation use provider mark price. A disconnected or stale feed must hide these values.',
            tone: LoopTone.warning,
          ),
          const SizedBox(height: 10),
          const _RiskStatement(
            icon: Icons.schedule_rounded,
            title: 'Funding is recurring',
            message:
                'Longs or shorts may pay funding at settlement. Rates can change before the next provider settlement.',
            tone: LoopTone.market,
          ),
          const SizedBox(height: 10),
          const _RiskStatement(
            icon: Icons.wifi_off_rounded,
            title: 'Orders can remain open',
            message:
                'Network loss does not guarantee cancellation. Production must reconcile provider state before showing controls again.',
            tone: LoopTone.warning,
          ),
          const LoopSectionLabel('Acknowledgement preview'),
          LoopCard(
            accent: !_understood,
            tone: _understood ? LoopTone.positive : LoopTone.warning,
            child: CheckboxListTile(
              value: _understood,
              onChanged: (value) =>
                  setState(() => _understood = value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text(
                'I understand that leverage can cause rapid loss and liquidation.',
              ),
              subtitle: const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'Local UI preview only · unchecked by default · never treated as durable consent.',
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          const PerpReadOnlyNotice(
            message:
                'Checking this box changes only local preview state. It does not enable trading or create a legal eligibility decision.',
          ),
        ],
      ],
    );
  }
}

class _RiskStatement extends StatelessWidget {
  const _RiskStatement({
    required this.icon,
    required this.title,
    required this.message,
    required this.tone,
  });

  final IconData icon;
  final String title;
  final String message;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    return LoopCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: loopToneColor(tone).withValues(alpha: 0.1),
              borderRadius: LoopRadius.small,
            ),
            child: Icon(icon, color: loopToneColor(tone), size: 21),
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 5),
                Text(message, style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
