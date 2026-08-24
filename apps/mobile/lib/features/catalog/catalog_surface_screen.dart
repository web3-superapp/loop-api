import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:loop_mobile/core/navigation/surface_catalog.dart';
import 'package:loop_mobile/core/theme/loop_theme.dart';
import 'package:loop_mobile/widgets/loop_ui.dart';

class CatalogSurfaceScreen extends StatelessWidget {
  const CatalogSurfaceScreen({required this.surface, super.key});

  final AppSurface surface;

  @override
  Widget build(BuildContext context) {
    final tone = _toneForModule(surface.module);
    return LoopPage(
      title: surface.title,
      eyebrow: '${surface.id} · ${_tierLabel(surface.tier)}',
      subtitle: surface.description,
      actions: <Widget>[
        IconButton(
          onPressed: () => context.push('/inventory'),
          tooltip: 'Open UI inventory',
          icon: const Icon(Icons.grid_view_rounded),
        ),
        const SizedBox(width: 4),
      ],
      children: <Widget>[
        if (surface.deferred)
          LoopStateCard(
            title: 'Outside the current release',
            message: _deferredMessage(surface),
            icon: Icons.schedule_rounded,
            tone: surface.module == SurfaceModule.home
                ? LoopTone.warning
                : LoopTone.neutral,
          )
        else ...<Widget>[
          _SurfacePreview(surface: surface, tone: tone),
          const LoopSectionLabel('Product state'),
          LoopCard(
            child: Column(
              children: <Widget>[
                LoopKeyValueRow(label: 'Surface', value: surface.id),
                LoopKeyValueRow(label: 'Route', value: surface.path),
                LoopKeyValueRow(
                  label: 'Delivery',
                  value: _tierLabel(surface.tier),
                ),
                LoopKeyValueRow(
                  label: 'Data state',
                  value: 'Preview · not live',
                  last: true,
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          const LoopStateCard(
            title: 'Safe preview data',
            message:
                'Values on this catalog surface illustrate layout and states. No provider request or wallet mutation was made.',
            icon: Icons.visibility_outlined,
          ),
        ],
      ],
    );
  }

  static LoopTone _toneForModule(SurfaceModule module) => switch (module) {
    SurfaceModule.market ||
    SurfaceModule.perp ||
    SurfaceModule.launchpad => LoopTone.market,
    SurfaceModule.chat => LoopTone.conversation,
    SurfaceModule.wallet => LoopTone.positive,
    SurfaceModule.system => LoopTone.warning,
    _ => LoopTone.neutral,
  };

  static String _tierLabel(DeliveryTier tier) => switch (tier) {
    DeliveryTier.core => 'Core',
    DeliveryTier.phaseOne => 'Phase one',
    DeliveryTier.later => 'Later',
  };

  static String _deferredMessage(AppSurface surface) {
    if (surface.path.startsWith('/pay') || surface.path == '/onramp') {
      return 'Payments and fiat funding are deliberately excluded while the wallet, trading and communication core is completed.';
    }
    return '${surface.title} stays visible in the product map, but no control on this preview claims the capability is live.';
  }
}

class _SurfacePreview extends StatelessWidget {
  const _SurfacePreview({required this.surface, required this.tone});

  final AppSurface surface;
  final LoopTone tone;

  @override
  Widget build(BuildContext context) {
    final color = loopToneColor(tone);
    return LoopCard(
      accent: true,
      tone: tone,
      padding: const EdgeInsets.all(22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                width: 48,
                height: 48,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: LoopRadius.small,
                ),
                child: Icon(_iconFor(surface), color: color),
              ),
              const Spacer(),
              LoopStatusPill(label: surface.kind.name, tone: tone),
            ],
          ),
          const SizedBox(height: 28),
          Text(
            _headlineFor(surface),
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 8),
          Text(
            _bodyFor(surface),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }

  static IconData _iconFor(AppSurface surface) => switch (surface.module) {
    SurfaceModule.market => Icons.query_stats_rounded,
    SurfaceModule.perp => Icons.candlestick_chart_rounded,
    SurfaceModule.chat => Icons.forum_outlined,
    SurfaceModule.wallet => Icons.account_balance_wallet_outlined,
    SurfaceModule.launchpad => Icons.rocket_launch_outlined,
    SurfaceModule.profile => Icons.manage_accounts_outlined,
    SurfaceModule.system => Icons.layers_outlined,
    SurfaceModule.account => Icons.person_outline_rounded,
    SurfaceModule.home => Icons.space_dashboard_outlined,
  };

  static String _headlineFor(AppSurface surface) => switch (surface.kind) {
    SurfaceKind.sheet => 'A focused decision surface',
    SurfaceKind.component => 'Reusable in context',
    SurfaceKind.globalState => 'Clear recovery context',
    SurfaceKind.screen => 'A complete product route',
  };

  static String _bodyFor(AppSurface surface) => switch (surface.kind) {
    SurfaceKind.sheet =>
      'Critical facts stay compact, keyboard reachable and explicit before any action.',
    SurfaceKind.component =>
      'The component carries its source time and never silently becomes a live transaction.',
    SurfaceKind.globalState =>
      'The state explains what failed, what remains available and the next safe action.',
    SurfaceKind.screen =>
      'Loading, empty, partial and unavailable states share the same information hierarchy.',
  };
}

class UiInventoryScreen extends StatefulWidget {
  const UiInventoryScreen({super.key});

  @override
  State<UiInventoryScreen> createState() => _UiInventoryScreenState();
}

class _UiInventoryScreenState extends State<UiInventoryScreen> {
  SurfaceModule? selected;

  @override
  Widget build(BuildContext context) {
    final surfaces = selected == null
        ? SurfaceCatalog.all
        : SurfaceCatalog.forModule(selected!);
    return LoopPage(
      title: 'UI inventory',
      eyebrow: '${SurfaceCatalog.all.length} surfaces',
      subtitle:
          'The implementation map for every screen, sheet, component and global state.',
      children: <Widget>[
        SizedBox(
          height: 40,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: const Text('All'),
                  selected: selected == null,
                  onSelected: (_) => setState(() => selected = null),
                ),
              ),
              ...SurfaceModule.values.map((module) {
                return Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(module.name),
                    selected: selected == module,
                    onSelected: (_) => setState(() => selected = module),
                  ),
                );
              }),
            ],
          ),
        ),
        const SizedBox(height: 18),
        ...surfaces.map((surface) {
          return Padding(
            padding: const EdgeInsets.only(bottom: 9),
            child: LoopCard(
              onTap: () => context.push(surface.path),
              semanticLabel: 'Open ${surface.title}',
              child: Row(
                children: <Widget>[
                  SizedBox(
                    width: 35,
                    child: Text(
                      surface.id,
                      style: context.dataStyle.copyWith(color: LoopColors.mint),
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          surface.title,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          surface.path,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontFamily: 'monospace'),
                        ),
                      ],
                    ),
                  ),
                  if (surface.deferred)
                    const LoopStatusPill(label: 'Later')
                  else
                    const Icon(
                      Icons.chevron_right_rounded,
                      color: LoopColors.vapor,
                    ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }
}
