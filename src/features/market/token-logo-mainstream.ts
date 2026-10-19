/**
 * Mainstream BSC tokens whose logos are always pre-warmed (Decision 0161
 * §2). Maintained by hand: add a row, keep the address lowercase.
 *
 * Every address was checked on 2026-10-19 against DexScreener
 * (`/tokens/v1/bsc/…`: the base token symbol of its pairs) and the Trust
 * Wallet assets repository (`blockchains/smartchain/assets/<EIP-55>/logo.png`
 * answers 200, except where noted). `symbol` is a label for people reading
 * this file and the pre-warm log; it is never a key.
 *
 * The native coin (BNB) is pre-warmed separately as `native`.
 */

export interface MainstreamTokenLogo {
  readonly symbol: string;
  readonly address: string;
}

export const bscMainstreamTokenLogos: readonly MainstreamTokenLogo[] =
  Object.freeze([
    { symbol: "WBNB", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" },
    { symbol: "BTCB", address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c" },
    { symbol: "ETH", address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8" },
    { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955" },
    { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
    { symbol: "USD1", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d" },
    { symbol: "FDUSD", address: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409" },
    { symbol: "BUSD", address: "0xe9e7cea3dedca5984780bafc599bd69add087d56" },
    { symbol: "DAI", address: "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3" },
    { symbol: "TUSD", address: "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9" },
    { symbol: "CAKE", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82" },
    { symbol: "DOGE", address: "0xba2ae424d960c26247dd6c32edc70b295c744c43" },
    { symbol: "SHIB", address: "0x2859e4544c4bb03966803b044a93563bd2d0dd4d" },
    { symbol: "XRP", address: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe" },
    { symbol: "ADA", address: "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47" },
    { symbol: "DOT", address: "0x7083609fce4d1d8dc0c979aab8c869ea2c873402" },
    { symbol: "LINK", address: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd" },
    { symbol: "UNI", address: "0xbf5140a22578168fd562dccf235e5d43a02ce9b1" },
    { symbol: "LTC", address: "0x4338665cbb7b2485a8855a139b75d5e34ab0db94" },
    { symbol: "TRX", address: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3" },
    { symbol: "TON", address: "0x76a797a59ba2c17726896976b7b3747bfd1d220f" },
    // Trust Wallet has no file and DexScreener no image (2026-10-19): the
    // row stays `missing` until a pair image appears or an operator uploads.
    { symbol: "PEPE", address: "0x25d887ce7a35172c62febfd67a1856f20faebb00" },
    { symbol: "AVAX", address: "0x1ce0c2827e2ef14d5c4f29a091d735a204794041" },
    { symbol: "POL", address: "0xcc42724c6683b7e57334c4e856f4c9965ed682bd" },
    { symbol: "ATOM", address: "0x0eb3a705fc54725037cc9e008bdede697f62f335" },
    { symbol: "FIL", address: "0x0d8ce2a99bb6e3b7db580ed848240e4a0f9ae153" },
    { symbol: "BCH", address: "0x8ff795a6f4d97e7887c79bea79aba5cc76444adf" },
    { symbol: "ETC", address: "0x3d6545b08693dae087e957cb1180ee38b9e3c25e" },
    { symbol: "TWT", address: "0x4b0f1812e5df2a09796481ff14017e6005508003" },
    { symbol: "XVS", address: "0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63" },
    { symbol: "FLOKI", address: "0xfb5b838b6cfeedc2873ab27866079ac55363d37e" },
    { symbol: "SOL", address: "0x570a5d26f7765ecb712c0924e4de545b89fd43df" },
    { symbol: "AAVE", address: "0xfb6115445bff7b52feb98650c87f44907e58f802" },
    { symbol: "1INCH", address: "0x111111111117dc0aa78b770fa6a738034120c302" },
  ]);
