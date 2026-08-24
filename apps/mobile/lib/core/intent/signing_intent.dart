enum SigningAuthority { privy }

enum IntentProvider { hyperliquidCore, wallet }

enum OrderDirection { buy, sell }

enum PerpOrderType { market, limit }

enum IntentKind { perpOrder, transfer, swap, approval }

final class IntentField {
  const IntentField({required this.label, required this.value});

  final String label;
  final String value;
}

final class SigningIntent {
  const SigningIntent._({
    required this.revision,
    required this.title,
    required this.kind,
    required this.authority,
    required this.provider,
    required this.observedAt,
    required this.expiresAt,
    required this.fields,
  });

  factory SigningIntent.perpOrder({
    required String revision,
    required String market,
    required OrderDirection direction,
    required PerpOrderType orderType,
    required String size,
    required int leverage,
    required String price,
    required String margin,
    required String fee,
    required String builderFee,
    required String liquidationEstimate,
    required DateTime observedAt,
    required DateTime expiresAt,
  }) {
    return SigningIntent._(
      revision: revision,
      title: '$market perpetual order',
      kind: IntentKind.perpOrder,
      authority: SigningAuthority.privy,
      provider: IntentProvider.hyperliquidCore,
      observedAt: observedAt,
      expiresAt: expiresAt,
      fields: <IntentField>[
        IntentField(label: 'Market', value: market),
        IntentField(
          label: 'Direction',
          value: direction == OrderDirection.buy
              ? 'Buy / Long'
              : 'Sell / Short',
        ),
        IntentField(
          label: 'Order type',
          value: orderType == PerpOrderType.market ? 'Market' : 'Limit',
        ),
        IntentField(label: 'Price', value: price),
        IntentField(label: 'Size', value: size),
        IntentField(label: 'Leverage', value: '$leverage×'),
        IntentField(label: 'Margin', value: margin),
        IntentField(label: 'Fee', value: fee),
        IntentField(label: 'Builder fee', value: builderFee),
        IntentField(label: 'Liquidation estimate', value: liquidationEstimate),
      ],
    );
  }

  factory SigningIntent.transfer({
    required String revision,
    required String asset,
    required String amount,
    required String recipient,
    required String network,
    required String fee,
    required DateTime observedAt,
    required DateTime expiresAt,
  }) {
    return SigningIntent._(
      revision: revision,
      title: 'Send $asset',
      kind: IntentKind.transfer,
      authority: SigningAuthority.privy,
      provider: IntentProvider.wallet,
      observedAt: observedAt,
      expiresAt: expiresAt,
      fields: <IntentField>[
        IntentField(label: 'Asset', value: asset),
        IntentField(label: 'Amount', value: amount),
        IntentField(label: 'Recipient', value: recipient),
        IntentField(label: 'Network', value: network),
        IntentField(label: 'Network fee', value: fee),
      ],
    );
  }

  factory SigningIntent.swap({
    required String revision,
    required String pay,
    required String receive,
    required String rate,
    required String fee,
    required DateTime observedAt,
    required DateTime expiresAt,
  }) {
    return SigningIntent._(
      revision: revision,
      title: 'Swap assets',
      kind: IntentKind.swap,
      authority: SigningAuthority.privy,
      provider: IntentProvider.wallet,
      observedAt: observedAt,
      expiresAt: expiresAt,
      fields: <IntentField>[
        IntentField(label: 'You pay', value: pay),
        IntentField(label: 'You receive', value: receive),
        IntentField(label: 'Rate', value: rate),
        IntentField(label: 'Provider fee', value: fee),
      ],
    );
  }

  factory SigningIntent.approval({
    required String revision,
    required String app,
    required String asset,
    required String allowance,
    required String network,
    required DateTime observedAt,
    required DateTime expiresAt,
  }) {
    return SigningIntent._(
      revision: revision,
      title: 'Approve token access',
      kind: IntentKind.approval,
      authority: SigningAuthority.privy,
      provider: IntentProvider.wallet,
      observedAt: observedAt,
      expiresAt: expiresAt,
      fields: <IntentField>[
        IntentField(label: 'App', value: app),
        IntentField(label: 'Asset', value: asset),
        IntentField(label: 'Allowance', value: allowance),
        IntentField(label: 'Network', value: network),
      ],
    );
  }

  final String revision;
  final String title;
  final IntentKind kind;
  final SigningAuthority authority;
  final IntentProvider provider;
  final DateTime observedAt;
  final DateTime expiresAt;
  final List<IntentField> fields;

  String? validateAt(DateTime now) {
    if (kind == IntentKind.perpOrder) {
      final market = fields
          .firstWhere((field) => field.label == 'Market')
          .value;
      if (!const <String>{'BTC', 'ETH', 'SOL'}.contains(market) ||
          market.contains(':')) {
        return 'market_not_core';
      }
      final builderFee = fields
          .firstWhere((field) => field.label == 'Builder fee')
          .value;
      if (builderFee != '0 USDC') {
        return 'builder_fee_forbidden';
      }
    }
    if (!expiresAt.isAfter(now)) {
      return 'intent_stale';
    }
    return null;
  }
}
