import type { IdentifyOp, TrackOp } from "./types.js";

export type SendResult = "ok" | "retry" | "auth" | "drop";

export interface SendOutcome {
  result: SendResult;
  /** Server-requested wait before the next attempt (a 429/503 `Retry-After`), already capped. */
  retryAfterMs?: number;
}

/** Longest `Retry-After` we honor; a larger value waits this long, then retries. */
export const MAX_RETRY_AFTER_MS = 60000;

/**
 * Parses a `Retry-After` value — delay-seconds or an HTTP-date (RFC 9110
 * §10.2.3) — into milliseconds from `now`, capped at MAX_RETRY_AFTER_MS.
 * Returns undefined when absent or unparseable (the caller falls back to backoff).
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    // An HTTP-date always names its day/month; requiring a letter keeps
    // Date.parse's lenient guessing ("1.5", "-5") from reading numbers as dates.
    const at = /[a-z]/i.test(v) ? Date.parse(v) : NaN;
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** One queued track op in its wire shape (whisperr-spec conformance/wire.json). */
export function wireEvent(e: TrackOp): Record<string, unknown> {
  return {
    // One id is required; an identified event needs only the user's.
    ...(e.externalUserId ? { external_user_id: e.externalUserId } : { anonymous_id: e.anonymousId }),
    event_type: e.eventType,
    occurred_at: e.occurredAt,
    properties: e.properties ?? {},
    // $message_id is an idempotency key for backend dedup (nested in the
    // free-form context so the strict ingestion accepts it).
    context: { ...(e.context ?? {}), $message_id: e.messageId },
  };
}

/** The /v1/identify body for a queued identify op. */
export function identifyBody(op: IdentifyOp): Record<string, unknown> {
  const body: Record<string, unknown> = {
    external_user_id: op.externalUserId,
  };
  // The server promotes this handle's anonymous user into external_user_id.
  if (op.anonymousId) body.anonymous_id = op.anonymousId;
  if (op.traits && Object.keys(op.traits).length) body.traits = op.traits;
  if (op.preferredChannel) body.preferred_channel = op.preferredChannel;
  if (op.channels && op.channels.length) {
    body.channels = op.channels.map((c) => ({
      // wire field is `channel` (the server rejects unknown fields)
      channel: c.type,
      address: c.address,
      // Consent and verification are claims: send them only when the caller
      // (or a shortcut that implies them, like an OS-granted push token) set them.
      ...(c.optedIn !== undefined ? { opted_in: c.optedIn } : {}),
      ...(c.verified !== undefined ? { verified: c.verified } : {}),
    }));
  }
  return body;
}

/** Network transport for the ingestion API, on React Native's built-in fetch. */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly debug: boolean,
  ) {}

  async sendBatch(events: TrackOp[]): Promise<SendOutcome> {
    const wire = events.filter((e) => e.externalUserId || e.anonymousId).map(wireEvent);
    if (wire.length === 0) return { result: "ok" };
    return this.post("/v1/events/batch", { events: wire });
  }

  async sendIdentify(op: IdentifyOp): Promise<SendOutcome> {
    return this.post("/v1/identify", identifyBody(op));
  }

  private async post(path: string, body: unknown): Promise<SendOutcome> {
    const url = `${this.baseUrl}${path}`;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      if (res.ok) return { result: "ok" };
      if (res.status === 401 || res.status === 403) {
        this.warn(`auth rejected (${res.status}) — check your Whisperr API key`);
        return { result: "auth" };
      }
      if (res.status === 429 || res.status >= 500) {
        // Rate limited / temporarily unavailable: the server says when to come back.
        const retryAfterMs =
          res.status === 429 || res.status === 503
            ? parseRetryAfter(res.headers?.get?.("Retry-After"))
            : undefined;
        return retryAfterMs === undefined ? { result: "retry" } : { result: "retry", retryAfterMs };
      }
      // Other 4xx — malformed; dropping avoids an infinite retry loop.
      this.warn(`request to ${path} dropped (${res.status})`);
      return { result: "drop" };
    } catch {
      // Network error / timeout / abort — retry later.
      return { result: "retry" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private warn(msg: string): void {
    if (this.debug && typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(`[whisperr] ${msg}`);
    }
  }
}
