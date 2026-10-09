import { PrivyClient } from "@privy-io/node";

import type { PrivyConfig } from "../../config.js";

export interface PrivyClientConfiguration extends PrivyConfig {
  readonly jwtVerificationKey?: string;
}

/**
 * Creates the process-scoped Privy server client. Composition code should share
 * this client between authentication and current-user lookup instead of
 * creating one SDK client per adapter or request.
 */
export function createPrivyServerClient(
  options: PrivyClientConfiguration,
): PrivyClient {
  return new PrivyClient({
    appId: options.appId,
    appSecret: options.appSecret,
    ...(options.jwtVerificationKey === undefined
      ? {}
      : { jwtVerificationKey: options.jwtVerificationKey }),
  });
}
