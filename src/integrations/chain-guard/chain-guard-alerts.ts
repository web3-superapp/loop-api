import type { ChainGuardAlertConfig } from "../../config.js";
import type { ChainGuardDetails } from "../../features/chain-guard/chain-guard-contract.js";

/**
 * Decision 0135: the optional outlets of chain guard alerts besides the
 * worker log — a generic JSON webhook (`CHAIN_GUARD_WEBHOOK_URL`) and a
 * Telegram bot chat (`CHAIN_GUARD_TELEGRAM_BOT_TOKEN` +
 * `CHAIN_GUARD_TELEGRAM_CHAT_ID`, Bot API `sendMessage`, plain text).
 *
 * Every notification is one attempt per outlet with a 5 s timeout. A
 * failure is one warn line (`CHAIN_GUARD_ALERT_DELIVERY_FAILED`, the
 * outlet's host name only — never the URL path or the bot token) and is
 * otherwise ignored: `notify` never rejects, and callers do not await it,
 * so an outlet can neither block nor fail a tick.
 */

export const chainGuardAlertTimeoutMs = 5_000;
export const chainGuardAlertDeliveryFailed =
  "CHAIN_GUARD_ALERT_DELIVERY_FAILED";
const telegramApiHost = "api.telegram.org";
/** Telegram's sendMessage limit is 4096; details are trimmed well below. */
const detailsMaxCharacters = 600;

export type ChainGuardAlertEvent =
  | {
      readonly type: "incident_opened" | "incident_resolved";
      readonly chainId: string;
      readonly incidentId: string;
      readonly kind: string;
      readonly subject: string;
      readonly details: ChainGuardDetails;
      /** incident_resolved only. */
      readonly resolution?: "auto" | "manual";
      readonly at: string;
    }
  | {
      readonly type: "hold_engaged" | "hold_released";
      readonly chainId: string;
      readonly lane: string;
      /** The first holding incident (engaged only). */
      readonly kind: string | null;
      readonly subject: string | null;
      readonly holdCount: number;
      readonly at: string;
    };

export interface ChainGuardAlertNotifier {
  /** Resolves when every outlet answered or failed; never rejects. */
  notify(event: ChainGuardAlertEvent): Promise<void>;
}

export type ChainGuardAlertFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export function chainGuardAlertDetailsText(details: ChainGuardDetails): string {
  const text = JSON.stringify(details);
  return text.length <= detailsMaxCharacters
    ? text
    : `${text.slice(0, detailsMaxCharacters - 1)}…`;
}

export function chainGuardAlertText(event: ChainGuardAlertEvent): string {
  const lines: string[] = [];
  switch (event.type) {
    case "incident_opened":
      lines.push(`LOOP chain guard: incident opened — ${event.kind}`);
      break;
    case "incident_resolved":
      lines.push(
        `LOOP chain guard: incident resolved (${event.resolution ?? "auto"}) — ${event.kind}`,
      );
      break;
    case "hold_engaged":
      lines.push(`LOOP chain guard: hold engaged — lane ${event.lane}`);
      break;
    case "hold_released":
      lines.push(`LOOP chain guard: hold released — lane ${event.lane}`);
      break;
  }
  lines.push(`chain: ${event.chainId}`);
  if ("incidentId" in event) {
    lines.push(`subject: ${event.subject}`);
    lines.push(`incident: ${event.incidentId}`);
    lines.push(`details: ${chainGuardAlertDetailsText(event.details)}`);
  } else {
    if (event.kind !== null) lines.push(`kind: ${event.kind}`);
    if (event.subject !== null) lines.push(`subject: ${event.subject}`);
    lines.push(`holds: ${event.holdCount}`);
  }
  lines.push(`at: ${event.at}`);
  return lines.join("\n");
}

function webhookPayload(event: ChainGuardAlertEvent): Record<string, unknown> {
  return {
    source: "loop.chain_guard",
    ...event,
    ...("details" in event
      ? {
          details: event.details,
          detailsText: chainGuardAlertDetailsText(event.details),
        }
      : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

/** Null when no outlet is configured (behaviour identical to before 0135). */
export function createChainGuardAlertNotifier(input: {
  readonly config: ChainGuardAlertConfig | null | undefined;
  readonly fetch?: ChainGuardAlertFetch;
  readonly timeoutMs?: number;
  readonly onFailure: (event: {
    readonly reasonCode: string;
    readonly outlet: "webhook" | "telegram";
    readonly host: string;
    readonly status: number | null;
    readonly errorClass: string | null;
  }) => void;
}): ChainGuardAlertNotifier | null {
  const config = input.config ?? null;
  if (config === null) return null;
  if (config.webhookUrl === null && config.telegram === null) return null;
  const send: ChainGuardAlertFetch =
    input.fetch ??
    ((url, init) =>
      globalThis.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }));
  const timeoutMs = input.timeoutMs ?? chainGuardAlertTimeoutMs;

  async function attempt(
    outlet: "webhook" | "telegram",
    url: string,
    host: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    let status: number | null = null;
    let errorClass: string | null = null;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      status = response.status;
    } catch (error) {
      errorClass = error instanceof Error ? error.name : "UnknownError";
    }
    try {
      input.onFailure({
        reasonCode: chainGuardAlertDeliveryFailed,
        outlet,
        host,
        status,
        errorClass,
      });
    } catch {
      // A failing logger must not fail the caller either.
    }
  }

  return Object.freeze({
    async notify(event: ChainGuardAlertEvent): Promise<void> {
      const deliveries: Promise<void>[] = [];
      try {
        if (config.webhookUrl !== null) {
          deliveries.push(
            attempt(
              "webhook",
              config.webhookUrl,
              hostOf(config.webhookUrl),
              webhookPayload(event),
            ),
          );
        }
        if (config.telegram !== null) {
          deliveries.push(
            attempt(
              "telegram",
              `https://${telegramApiHost}/bot${config.telegram.botToken}/sendMessage`,
              telegramApiHost,
              {
                chat_id: config.telegram.chatId,
                text: chainGuardAlertText(event),
                disable_web_page_preview: true,
              },
            ),
          );
        }
        await Promise.all(deliveries);
      } catch {
        // `attempt` never throws; this guards the callback itself.
      }
    },
  });
}
