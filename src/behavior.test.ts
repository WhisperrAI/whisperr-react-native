import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";
import type { WhisperrError } from "./types.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/behavior.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

interface BehaviorCase {
  name: string;
  op: "track";
  scenario: {
    externalUserId: string;
    eventType: string;
    properties?: Record<string, unknown>;
  };
  clientOptions?: { maxRetries?: number };
  firstResponse: { status: number };
  recoveryResponse: { status: number };
  expect: {
    errorType: "auth" | "retry_exhausted" | "dropped";
    retainedAfterFirstFlush: boolean;
    deliveredAfterRecovery: boolean;
    retriesAfterRecovery: boolean;
    stableMessageIdOnRetry?: boolean;
  };
}

let captured: Array<{ path: string; body: any }> = [];
let status = 200;

async function loadSpec(): Promise<{ cases: BehaviorCase[] }> {
  const local = process.env.WHISPERR_BEHAVIOR_SPEC_PATH ?? siblingBehaviorPath();
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch behavior spec: ${res.status}`);
  return res.json();
}

function siblingBehaviorPath(): string | undefined {
  const wire = process.env.WHISPERR_SPEC_PATH;
  return wire ? join(dirname(wire), "behavior.json") : undefined;
}

beforeEach(() => {
  captured = [];
  status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({
        path: url.replace("https://api.whisperr.net", ""),
        body: JSON.parse(init.body),
      });
      return { ok: status >= 200 && status < 300, status } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("behavior conformance (whisperr-spec)", () => {
  it("honors shared delivery semantics", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      captured = [];
      const errors: WhisperrError[] = [];
      status = c.firstResponse.status;

      // Identity restored from a previous launch — no identify op in the queue.
      const storage = new MemoryStorage();
      storage.setItem("whisperr.user_id", c.scenario.externalUserId);

      const client = new WhisperrClient({
        apiKey: "wrk_test",
        storage,
        flushIntervalMs: 0,
        flushOnAppBackground: false,
        maxRetries: c.clientOptions?.maxRetries ?? 0,
        onError: (e) => errors.push(e),
      });

      client.track(c.scenario.eventType, c.scenario.properties);
      await client.flush();

      expect(errors.some((e) => e.type === c.expect.errorType), c.name).toBe(true);
      const afterFirst = batchCalls();
      expect(afterFirst.length, `${c.name}: first delivery attempt`).toBe(1);
      expect(client.pendingCount, `${c.name}: retained after first flush`).toBe(
        c.expect.retainedAfterFirstFlush ? 1 : 0,
      );

      status = c.recoveryResponse.status;
      await client.flush();

      const afterRecovery = batchCalls();
      const retried = afterRecovery.length > afterFirst.length;
      expect(retried, `${c.name}: retried after recovery`).toBe(c.expect.retriesAfterRecovery);
      const recoveryDelivered =
        retried && afterRecovery.at(-1)?.body.events?.[0]?.event_type === c.scenario.eventType;
      expect(recoveryDelivered, `${c.name}: delivered after recovery`).toBe(
        c.expect.deliveredAfterRecovery,
      );

      if (c.expect.stableMessageIdOnRetry) {
        expect(afterRecovery[1]!.body.events[0].context.$message_id).toBe(
          afterRecovery[0]!.body.events[0].context.$message_id,
        );
      }
    }
  });
});

function batchCalls(): Array<{ path: string; body: any }> {
  return captured.filter((c) => c.path === "/v1/events/batch");
}
