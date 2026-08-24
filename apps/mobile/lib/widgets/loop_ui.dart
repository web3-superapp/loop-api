import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';

enum LoopTone { neutral, positive, market, conversation, warning, danger }

Color loopToneColor(LoopTone tone) => switch (tone) {
  LoopTone.neutral => LoopColors.vapor,
  LoopTone.positive => LoopColors.mint,
  LoopTone.market => LoopColors.market,
  LoopTone.conversation => LoopColors.chat,
  LoopTone.warning => LoopColors.warning,
  LoopTone.danger => LoopColors.danger,
};

class LoopPage extends StatelessWidget {
  const LoopPage({
    required this.title,
    required this.children,
    super.key,
    this.eyebrow,
    this.subtitle,
    this.actions = const <Widget>[],
    this.leading,
    this.bottom,
    this.padding = const EdgeInsets.fromLTRB(20, 12, 20, 120),
  });

  final String title;
  final String? eyebrow;
  final String? subtitle;
  final List<Widget> actions;
  final Widget? leading;
  final List<Widget> children;
  final Widget? bottom;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading:
            leading ??
            (canPop
                ? IconButton(
                    onPressed: () => context.pop(),
                    tooltip: 'Back',
                    icon: const Icon(Icons.arrow_back_rounded),
                  )
                : null),
        actions: actions,
      ),
      body: SafeArea(
        top: false,
        bottom: false,
        child: Stack(
          children: <Widget>[
            const Positioned.fill(child: LoopBackdrop()),
            CustomScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              slivers: <Widget>[
                SliverToBoxAdapter(
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 760),
                      child: Padding(
                        padding: padding,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            if (eyebrow != null) ...<Widget>[
                              Text(
                                eyebrow!.toUpperCase(),
                                style: Theme.of(context).textTheme.labelMedium
                                    ?.copyWith(
                                      color: LoopColors.mint,
                                      letterSpacing: 1.4,
                                    ),
                              ),
                              const SizedBox(height: 9),
                            ],
                            Text(
                              title,
                              style: Theme.of(context).textTheme.headlineLarge,
                            ),
                            if (subtitle != null) ...<Widget>[
                              const SizedBox(height: 8),
                              Text(
                                subtitle!,
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ],
                            const SizedBox(height: 24),
                            ...children,
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            if (bottom != null)
              Positioned(left: 0, right: 0, bottom: 0, child: bottom!),
          ],
        ),
      ),
    );
  }
}

class LoopBackdrop extends StatelessWidget {
  const LoopBackdrop({super.key});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[
              LoopColors.market.withValues(alpha: 0.025),
              LoopColors.abyss,
              LoopColors.abyss,
            ],
            stops: const <double>[0, 0.36, 1],
          ),
        ),
      ),
    );
  }
}

class LoopCard extends StatelessWidget {
  const LoopCard({
    required this.child,
    super.key,
    this.padding = const EdgeInsets.all(16),
    this.onTap,
    this.tone = LoopTone.neutral,
    this.accent = false,
    this.semanticLabel,
  });

  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;
  final LoopTone tone;
  final bool accent;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    final card = DecoratedBox(
      decoration: BoxDecoration(
        color: LoopColors.basalt.withValues(alpha: 0.94),
        borderRadius: LoopRadius.medium,
        border: Border.all(
          color: accent ? color.withValues(alpha: 0.42) : LoopColors.line,
        ),
      ),
      child: ClipRRect(
        borderRadius: LoopRadius.medium,
        child: Stack(
          children: <Widget>[
            if (accent)
              Positioned(
                left: 0,
                top: 12,
                bottom: 12,
                child: Container(width: 3, color: color),
              ),
            Padding(padding: padding, child: child),
          ],
        ),
      ),
    );
    if (onTap == null) {
      return card;
    }
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: LoopRadius.medium,
          child: card,
        ),
      ),
    );
  }
}

class LoopSectionLabel extends StatelessWidget {
  const LoopSectionLabel(this.label, {super.key, this.trailing});

  final String label;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 28, bottom: 11),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              label.toUpperCase(),
              style: Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(letterSpacing: 1.15),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

class LoopStatusPill extends StatelessWidget {
  const LoopStatusPill({
    required this.label,
    super.key,
    this.tone = LoopTone.neutral,
    this.icon,
  });

  final String label;
  final LoopTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return Semantics(
      label: label,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: LoopRadius.pill,
          border: Border.all(color: color.withValues(alpha: 0.26)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (icon != null) ...<Widget>[
                Icon(icon, color: color, size: 14),
                const SizedBox(width: 5),
              ],
              Text(
                label,
                style: Theme.of(
                  context,
                ).textTheme.labelMedium?.copyWith(color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class LoopAssetMark extends StatelessWidget {
  const LoopAssetMark({
    required this.symbol,
    super.key,
    this.size = 42,
    this.color,
  });

  final String symbol;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final resolved = color ?? _colorForSymbol(symbol);
    return Semantics(
      label: '$symbol asset',
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: resolved.withValues(alpha: 0.13),
          border: Border.all(color: resolved.withValues(alpha: 0.32)),
        ),
        child: Text(
          _markForSymbol(symbol),
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
            color: resolved,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }

  static String _markForSymbol(String symbol) => switch (symbol.toUpperCase()) {
    'ETH' => 'Ξ',
    'BTC' => '₿',
    'SOL' => 'S',
    'USDC' => r'$',
    _ => symbol.characters.take(1).toString().toUpperCase(),
  };

  static Color _colorForSymbol(String symbol) => switch (symbol.toUpperCase()) {
    'ETH' => LoopColors.market,
    'BTC' => LoopColors.chat,
    'SOL' => LoopColors.mint,
    'USDC' => const Color(0xFF5796FF),
    _ => LoopColors.vapor,
  };
}

class LoopMetric extends StatelessWidget {
  const LoopMetric({
    required this.label,
    required this.value,
    super.key,
    this.detail,
    this.tone = LoopTone.neutral,
  });

  final String label;
  final String value;
  final String? detail;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 6),
        Text(
          value,
          style: context.dataStyle.copyWith(
            fontSize: 16,
            color: LoopColors.chalk,
          ),
        ),
        if (detail != null) ...<Widget>[
          const SizedBox(height: 3),
          Text(
            detail!,
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(color: color),
          ),
        ],
      ],
    );
  }
}

class LoopMiniChart extends StatelessWidget {
  const LoopMiniChart({
    required this.points,
    super.key,
    this.color = LoopColors.mint,
    this.height = 52,
    this.semanticLabel = 'Price trend',
  });

  final List<double> points;
  final Color color;
  final double height;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: semanticLabel,
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: CustomPaint(
          painter: _LinePainter(points: points, color: color),
        ),
      ),
    );
  }
}

class _LinePainter extends CustomPainter {
  const _LinePainter({required this.points, required this.color});

  final List<double> points;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2) return;
    final minValue = points.reduce(math.min);
    final maxValue = points.reduce(math.max);
    final span = math.max(maxValue - minValue, 0.0001);
    final path = Path();
    for (var index = 0; index < points.length; index++) {
      final x = size.width * index / (points.length - 1);
      final normalized = (points[index] - minValue) / span;
      final y = size.height - (normalized * (size.height - 8)) - 4;
      if (index == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke,
    );
  }

  @override
  bool shouldRepaint(covariant _LinePainter oldDelegate) {
    return oldDelegate.points != points || oldDelegate.color != color;
  }
}

enum LoopStage { discover, discuss, execute }

class LoopContextRail extends StatelessWidget {
  const LoopContextRail({required this.stage, super.key, this.compact = false});

  final LoopStage stage;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    const stages = <(LoopStage, String, Color)>[
      (LoopStage.discover, 'DISCOVER', LoopColors.market),
      (LoopStage.discuss, 'DISCUSS', LoopColors.chat),
      (LoopStage.execute, 'EXECUTE', LoopColors.mint),
    ];
    return Semantics(
      label: 'Current loop stage: ${stage.name}',
      child: Container(
        padding: EdgeInsets.all(compact ? 5 : 7),
        decoration: BoxDecoration(
          color: LoopColors.basalt,
          borderRadius: LoopRadius.pill,
          border: Border.all(color: LoopColors.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: stages
              .map((item) {
                final selected = item.$1 == stage;
                return AnimatedContainer(
                  duration: MediaQuery.disableAnimationsOf(context)
                      ? Duration.zero
                      : const Duration(milliseconds: 180),
                  padding: EdgeInsets.symmetric(
                    horizontal: compact ? 8 : 11,
                    vertical: compact ? 6 : 7,
                  ),
                  decoration: BoxDecoration(
                    color: selected
                        ? item.$3.withValues(alpha: 0.13)
                        : Colors.transparent,
                    borderRadius: LoopRadius.pill,
                  ),
                  child: Text(
                    compact ? item.$2.characters.take(1).toString() : item.$2,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: selected ? item.$3 : LoopColors.vapor,
                      fontSize: compact ? 9 : 10,
                      letterSpacing: selected ? 0.7 : 0.4,
                    ),
                  ),
                );
              })
              .toList(growable: false),
        ),
      ),
    );
  }
}

class LoopStateCard extends StatelessWidget {
  const LoopStateCard({
    required this.title,
    required this.message,
    super.key,
    this.icon = Icons.info_outline_rounded,
    this.tone = LoopTone.neutral,
    this.action,
  });

  final String title;
  final String message;
  final IconData icon;
  final LoopTone tone;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return LoopCard(
      accent: tone != LoopTone.neutral,
      tone: tone,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icon, color: color, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text(message, style: Theme.of(context).textTheme.bodyMedium),
                if (action != null) ...<Widget>[
                  const SizedBox(height: 14),
                  action!,
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class LoopKeyValueRow extends StatelessWidget {
  const LoopKeyValueRow({
    required this.label,
    required this.value,
    super.key,
    this.tone = LoopTone.neutral,
    this.last = false,
  });

  final String label;
  final String value;
  final LoopTone tone;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12),
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: LoopColors.line)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
          ),
          const SizedBox(width: 16),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: context.dataStyle.copyWith(
                color: tone == LoopTone.neutral
                    ? LoopColors.chalk
                    : loopToneColor(tone),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class LoopActionDock extends StatelessWidget {
  const LoopActionDock({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: LoopColors.abyss.withValues(alpha: 0.96),
          border: const Border(top: BorderSide(color: LoopColors.line)),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}
