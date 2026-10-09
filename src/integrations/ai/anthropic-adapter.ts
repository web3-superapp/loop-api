/**
 * Anthropic Messages API boundary for Community AI (Decision 0066).
 *
 * The adapter is deliberately narrow: one request shape, one forced tool, one
 * strictly parsed answer. It holds the API key in a closure and never returns,
 * logs, or attaches it to an error. The caller's question and the community
 * facts pass through and are not retained here.
 *
 * Structured output is not "parsed out of prose": the request forces the
 * `community_ai_answer` tool, and anything other than exactly one well-formed
 * `tool_use` block for that tool is a rejection.
 */

/**
 * Default Provider origin. The effective origin is `baseUrl` on the gateway
 * input (`COMMUNITY_AI_BASE_URL`), which may point at any Anthropic-compatible
 * gateway; the request path is always `/v1/messages`.
 */
export const defaultAnthropicBaseUrl = "https://api.anthropic.com";
export const anthropicMessagesPath = "/v1/messages";
/** The default request URL; kept for reference, not used when `baseUrl` differs. */
export const anthropicMessagesUrl = `${defaultAnthropicBaseUrl}${anthropicMessagesPath}`;
export const anthropicVersionHeader = "2023-06-01";

/**
 * `${baseUrl}/v1/messages` with any trailing slashes on the origin removed, so
 * `https://api.onlyrouter.ai/` and `https://api.onlyrouter.ai` both resolve to
 * `https://api.onlyrouter.ai/v1/messages`.
 */
export function communityAiMessagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${anthropicMessagesPath}`;
}
export const communityAiToolName = "community_ai_answer";

export type CommunityAiProviderFailureReason =
  /** The Provider answered, but not with the forced tool contract. */
  | "COMMUNITY_AI_PROVIDER_MALFORMED"
  /** A deterministic 4xx: bad key, refused request, unknown model. */
  | "COMMUNITY_AI_PROVIDER_REJECTED"
  /** 5xx, 408/409/429, transport failure, or the local timeout. */
  | "COMMUNITY_AI_PROVIDER_UNAVAILABLE";

/**
 * What a malformed answer looked like, without the answer: enough to tell a
 * truncated reply (`stop_reason: "max_tokens"`, only a `thinking` block) from
 * a model that ignored the tool. Never a text, never an input.
 */
export interface CommunityAiProviderDiagnostics {
  readonly stopReason: string | null;
  readonly outputTokens: number | null;
  readonly contentBlockTypes: readonly string[];
}

export class CommunityAiProviderError extends Error {
  readonly reason: CommunityAiProviderFailureReason;
  readonly diagnostics: CommunityAiProviderDiagnostics | null;

  constructor(
    reason: CommunityAiProviderFailureReason,
    diagnostics: CommunityAiProviderDiagnostics | null = null,
  ) {
    // The message is the reason code only: no Provider body, no prompt, no key.
    super(reason);
    this.name = "CommunityAiProviderError";
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

export interface CommunityAiGatewayLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface CommunityAiCitationDraft {
  readonly sourceId: string;
}

export interface CommunityAiCompletion {
  readonly answer: string;
  readonly citations: readonly CommunityAiCitationDraft[];
  readonly refusal: string | null;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface CommunityAiCompletionRequest {
  /** Server-authored rules; never client-influenceable. */
  readonly system: string;
  /** The assembled sources plus the caller's question, already fenced. */
  readonly userContent: string;
  readonly signal?: AbortSignal | undefined;
  /**
   * Overrides the gateway's default ceiling for this call. The background
   * brief uses it: it answers no request, so the `ask` ceiling that keeps a
   * request inside the HTTP deadlines does not apply to it.
   */
  readonly timeoutMs?: number | undefined;
}

export interface CommunityAiGateway {
  readonly model: string;
  complete(
    request: CommunityAiCompletionRequest,
  ): Promise<CommunityAiCompletion>;
}

export type AnthropicFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface CreateAnthropicCommunityAiGatewayInput {
  readonly apiKey: string;
  /** Provider origin, e.g. `https://api.anthropic.com` or `https://api.onlyrouter.ai`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maximumOutputTokens: number;
  /** Injected so tests never reach the network. */
  readonly fetch?: AnthropicFetch | undefined;
  /**
   * Receives one sanitized line per malformed answer (reason, stop reason,
   * output tokens, block types). Absent means silence (tests, scripts).
   */
  readonly logger?: CommunityAiGatewayLogger | undefined;
}

/**
 * The closed answer contract. `additionalProperties: false` is declared to the
 * Provider and re-checked locally: a field LOOP did not ask for is a malformed
 * answer, not an extra the client silently receives.
 */
const communityAiTool = Object.freeze({
  name: communityAiToolName,
  description:
    "Return the answer, the source numbers it is based on, and a refusal when the question cannot be answered from the given sources.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "citations"],
    properties: {
      answer: {
        type: "string",
        description:
          "The answer in Chinese, based only on the numbered sources. Empty when refusing.",
      },
      citations: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceId"],
          properties: {
            sourceId: {
              type: "string",
              description: "A sourceId from the given sources, such as s1.",
            },
          },
        },
      },
      refusal: {
        type: "string",
        description:
          "Present only when the question cannot or must not be answered; explains why in Chinese.",
      },
    },
  },
});

/** Client errors worth retrying; every other 4xx is deterministic. */
const retryableStatusCodes: readonly number[] = Object.freeze([408, 409, 429]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function diagnose(body: unknown): CommunityAiProviderDiagnostics {
  if (!isRecord(body)) {
    return Object.freeze({
      stopReason: null,
      outputTokens: null,
      contentBlockTypes: Object.freeze([]),
    });
  }
  const usage = isRecord(body["usage"]) ? body["usage"] : {};
  const content = Array.isArray(body["content"])
    ? (body["content"] as unknown[])
    : [];
  return Object.freeze({
    stopReason:
      typeof body["stop_reason"] === "string"
        ? body["stop_reason"].slice(0, 32)
        : null,
    outputTokens: tokenCount(usage["output_tokens"]),
    contentBlockTypes: Object.freeze(
      content.map((block) =>
        isRecord(block) && typeof block["type"] === "string"
          ? block["type"].slice(0, 32)
          : "unknown",
      ),
    ),
  });
}

function malformed(body: unknown): never {
  throw new CommunityAiProviderError(
    "COMMUNITY_AI_PROVIDER_MALFORMED",
    diagnose(body),
  );
}

/**
 * Exactly one `tool_use` block for the forced tool, with a `string` answer, a
 * citation array of `{sourceId}` objects, and an optional string refusal. A
 * text-only reply (the model ignoring the tool), two tool blocks, another tool
 * name, or an unexpected key is rejected rather than half-trusted.
 */
export function parseCommunityAiCompletion(
  body: unknown,
  fallbackModel: string,
): CommunityAiCompletion {
  if (!isRecord(body) || !Array.isArray(body["content"])) {
    return malformed(body);
  }
  const toolBlocks = (body["content"] as unknown[]).filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block["type"] === "tool_use",
  );
  if (toolBlocks.length !== 1) {
    return malformed(body);
  }
  const block = toolBlocks[0];
  if (block === undefined || block["name"] !== communityAiToolName) {
    return malformed(body);
  }
  const input = block["input"];
  if (!isRecord(input)) {
    return malformed(body);
  }
  for (const key of Object.keys(input)) {
    if (!["answer", "citations", "refusal"].includes(key)) {
      return malformed(body);
    }
  }
  const answer = input["answer"];
  const citations = input["citations"];
  const refusal = input["refusal"];
  if (typeof answer !== "string" || !Array.isArray(citations)) {
    return malformed(body);
  }
  if (refusal !== undefined && typeof refusal !== "string") {
    return malformed(body);
  }
  const parsedCitations: CommunityAiCitationDraft[] = [];
  for (const citation of citations as unknown[]) {
    if (!isRecord(citation) || typeof citation["sourceId"] !== "string") {
      return malformed(body);
    }
    for (const key of Object.keys(citation)) {
      if (key !== "sourceId") {
        return malformed(body);
      }
    }
    parsedCitations.push(Object.freeze({ sourceId: citation["sourceId"] }));
  }
  const trimmedRefusal = typeof refusal === "string" ? refusal.trim() : "";
  const trimmedAnswer = answer.trim();
  if (trimmedAnswer === "" && trimmedRefusal === "") {
    return malformed(body);
  }
  const usage = isRecord(body["usage"]) ? body["usage"] : {};
  const model =
    typeof body["model"] === "string" ? body["model"] : fallbackModel;
  return Object.freeze({
    answer: trimmedAnswer,
    citations: Object.freeze(parsedCitations),
    refusal: trimmedRefusal === "" ? null : trimmedRefusal,
    model,
    inputTokens: tokenCount(usage["input_tokens"]),
    outputTokens: tokenCount(usage["output_tokens"]),
  });
}

function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    release: (): void => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export function createAnthropicCommunityAiGateway(
  input: CreateAnthropicCommunityAiGatewayInput,
): CommunityAiGateway {
  const messagesUrl = communityAiMessagesUrl(input.baseUrl);
  const performFetch: AnthropicFetch =
    input.fetch ??
    ((url, init) =>
      fetch(url, {
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
        signal: init.signal,
      }));

  return Object.freeze({
    model: input.model,
    async complete(
      request: CommunityAiCompletionRequest,
    ): Promise<CommunityAiCompletion> {
      const { signal, release } = combineSignals(
        request.timeoutMs ?? input.timeoutMs,
        request.signal,
      );
      let response: Awaited<ReturnType<AnthropicFetch>>;
      try {
        response = await performFetch(messagesUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-api-key": input.apiKey,
            "anthropic-version": anthropicVersionHeader,
          },
          body: JSON.stringify({
            model: input.model,
            max_tokens: input.maximumOutputTokens,
            system: request.system,
            tools: [communityAiTool],
            tool_choice: { type: "tool", name: communityAiToolName },
            // A forced, schema-bound tool call needs no reasoning pass. With
            // thinking on, some models spend the whole `max_tokens` budget on
            // a `thinking` block and the reply is cut before `tool_use`,
            // which this adapter (rightly) rejects as malformed (S76d).
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: request.userContent }],
          }),
          signal,
        });
      } catch {
        // A transport failure, an abort, or the local timeout. The cause is
        // never attached: it can carry the request body.
        throw new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_UNAVAILABLE");
      } finally {
        release();
      }
      if (!response.ok) {
        throw new CommunityAiProviderError(
          response.status >= 400 &&
            response.status < 500 &&
            !retryableStatusCodes.includes(response.status)
            ? "COMMUNITY_AI_PROVIDER_REJECTED"
            : "COMMUNITY_AI_PROVIDER_UNAVAILABLE",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_MALFORMED");
      }
      try {
        return parseCommunityAiCompletion(parsed, input.model);
      } catch (error) {
        if (error instanceof CommunityAiProviderError) {
          // Shape only: stop reason, token count, block types. Never the
          // text of a block, never the tool input, never the prompt.
          input.logger?.warn(
            {
              reason: error.reason,
              model: input.model,
              stopReason: error.diagnostics?.stopReason ?? null,
              outputTokens: error.diagnostics?.outputTokens ?? null,
              contentBlockTypes: error.diagnostics?.contentBlockTypes ?? [],
              maxOutputTokens: input.maximumOutputTokens,
            },
            "Community AI Provider answer was malformed",
          );
        }
        throw error;
      }
    },
  });
}

/** The gateway used when no API key is configured: it answers nothing. */
export function createUnavailableCommunityAiGateway(
  model: string,
): CommunityAiGateway {
  return Object.freeze({
    model,
    complete(): Promise<CommunityAiCompletion> {
      return Promise.reject(
        new CommunityAiProviderError("COMMUNITY_AI_PROVIDER_UNAVAILABLE"),
      );
    },
  });
}
