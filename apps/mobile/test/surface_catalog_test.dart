import 'package:flutter_test/flutter_test.dart';
import 'package:loop_mobile/app.dart';
import 'package:loop_mobile/core/navigation/surface_catalog.dart';

void main() {
  test('catalog keeps all 103 product surfaces addressable', () {
    expect(SurfaceCatalog.all, hasLength(103));
    expect(
      SurfaceCatalog.all.map((surface) => surface.id).toSet(),
      hasLength(103),
    );
    expect(
      SurfaceCatalog.all.map((surface) => surface.path).toSet(),
      hasLength(103),
    );
  });

  test('payments remain deferred while the six primary tabs stay fixed', () {
    final payments = SurfaceCatalog.all.where(
      (surface) => surface.path.startsWith('/pay') || surface.path == '/onramp',
    );
    expect(payments, isNotEmpty);
    expect(payments.every((surface) => surface.deferred), isTrue);

    expect(SurfaceCatalog.primaryPaths, <String>[
      '/home',
      '/market',
      '/launchpad',
      '/chat',
      '/wallet',
      '/profile',
    ]);
    expect(SurfaceCatalog.primaryPaths, isNot(contains('/perp')));
    expect(SurfaceCatalog.byPath('/perp').module, SurfaceModule.perp);
  });

  test('generic catalog pages are reserved for deferred capabilities', () {
    final genericSurfaces = SurfaceCatalog.all.where(
      (surface) => !LoopRouteRegistry.customSurfacePaths.contains(surface.path),
    );

    expect(genericSurfaces, isNotEmpty);
    expect(genericSurfaces.every((surface) => surface.deferred), isTrue);
  });
}
