import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "./transport.js";

// A 429/503 Retry-After replaces the exponential backoff for the next retry
// (whisperr-spec SPEC.md → Delivery contract). Default backoff for the first
// retry is 2000ms (+ up to 250ms jitter).

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");

  it("reads delay-seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP-date relative to now (past dates mean retry now)", () => {
    expect(parseRetryAfter("Sat, 26 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Sat, 26 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("caps long waits at 60 s", () => {
    expect(parseRetryAfter("3600", now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("Sun, 27 Sep 2026 12:00:00 GMT", now)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("ignores absent or malformed values", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
    expect(parseRetryAfter("1.5", now)).toBeUndefined();
  });
});

describe("Retry-After on delivery", () => {
  let calls: number;

  /** First batch attempt answers `status` (+ Retry-After), every later one 202. */
  function stubFetch(status: number, retryAfter?: string) {
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.endsWith("/v1/events/batch")) return { ok: true, status: 202 } as Response;
        calls++;
        if (calls === 1) {
          const headers = new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter });
          return { ok: false, status, headers } as Response;
        }
        return { ok: true, status: 202, headers: new Headers() } as Response;
      }),
    );
  }

  async function sendOne(): Promise<{ done: Promise<void> }> {
    const w = new WhisperrClient({
      apiKey: "wrk_test",
      flushIntervalMs: 0,
      flushOnAppBackground: false,
      trackAppLifecycleEvents: false,
      maxRetries: 3,
    });
    w.identify("u1");
    await w.flush(); // identify delivered
    w.track("a");
    const done = w.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    return { done }; // wrapped: an async fn returning a promise would await it
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-26T12:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits the Retry-After seconds on a 429 instead of the backoff", async () => {
    stubFetch(429, "5");
    const { done } = await sendOne();
    await vi.advanceTimersByTimeAsync(4900);
    expect(calls).toBe(1); // backoff alone would have retried at ~2s
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBe(2);
    await done;
  });

  it("honors an HTTP-date Retry-After on a 503", async () => {
    stubFetch(503, new Date(Date.now() + 8000).toUTCString());
    const { done } = await sendOne();
    await vi.advanceTimersByTimeAsync(7900);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBe(2);
    await done;
  });

  it("caps an excessive Retry-After at 60 s", async () => {
    stubFetch(429, "86400");
    const { done } = await sendOne();
    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 100);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBe(2);
    await done;
  });

  it("falls back to exponential backoff without a usable header", async () => {
    stubFetch(429, "later");
    const { done } = await sendOne();
    await vi.advanceTimersByTimeAsync(2300);
    expect(calls).toBe(2);
    await done;
  });

  it("ignores Retry-After on other 5xx", async () => {
    stubFetch(500, "30");
    const { done } = await sendOne();
    await vi.advanceTimersByTimeAsync(2300);
    expect(calls).toBe(2);
    await done;
  });
});
