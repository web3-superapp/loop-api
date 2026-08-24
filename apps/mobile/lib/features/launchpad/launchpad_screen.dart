import 'package:flutter/material.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class LaunchpadScreen extends StatelessWidget {
  const LaunchpadScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return LoopPage(
      title: 'Launchpad',
      eyebrow: 'Future loop',
      subtitle:
          'Project discovery will open only when issuer facts, eligibility and participation controls are complete.',
      children: <Widget>[
        const Align(
          alignment: Alignment.centerLeft,
          child: LoopContextRail(stage: LoopStage.discover),
        ),
        const SizedBox(height: 22),
        LoopCard(
          accent: true,
          tone: LoopTone.market,
          padding: const EdgeInsets.all(22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 52,
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: LoopColors.market.withValues(alpha: 0.12),
                  borderRadius: LoopRadius.small,
                ),
                child: const Icon(
                  Icons.rocket_launch_outlined,
                  color: LoopColors.market,
                ),
              ),
              const SizedBox(height: 28),
              Text(
                'Built for informed participation',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 8),
              Text(
                'Each launch will connect verifiable project facts, its public conversation and an explicit wallet review.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
        const LoopSectionLabel('Release gates'),
        const _LaunchGate(
          number: '01',
          title: 'Issuer and contract facts',
          detail: 'Ownership, vesting and source timestamps must be visible.',
          complete: true,
        ),
        const _LaunchGate(
          number: '02',
          title: 'Eligibility controls',
          detail:
              'Region and account checks must fail without blocking the rest of LOOP.',
        ),
        const _LaunchGate(
          number: '03',
          title: 'Participation review',
          detail:
              'Exact amount, allocation rule and settlement path need one signing intent.',
        ),
        const SizedBox(height: 18),
        const LoopStateCard(
          title: 'No live launches',
          message:
              'Launch discovery, details and applications are intentionally deferred. Nothing on this page accepts funds.',
          icon: Icons.schedule_rounded,
        ),
      ],
    );
  }
}

class _LaunchGate extends StatelessWidget {
  const _LaunchGate({
    required this.number,
    required this.title,
    required this.detail,
    this.complete = false,
  });

  final String number;
  final String title;
  final String detail;
  final bool complete;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: (complete ? LoopColors.mint : LoopColors.elevated)
                  .withValues(alpha: complete ? 0.12 : 1),
              shape: BoxShape.circle,
              border: Border.all(
                color: complete ? LoopColors.mint : LoopColors.line,
              ),
            ),
            child: Text(
              number,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: complete ? LoopColors.mint : LoopColors.vapor,
              ),
            ),
          ),
          const SizedBox(width: 12),
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
        ],
      ),
    );
  }
}
