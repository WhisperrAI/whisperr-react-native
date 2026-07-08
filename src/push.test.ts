import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/push.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

type Step = { identify: { externalUserId: string; [k: string]: unknown } } | { setPushToken: string };

interface PushCase {
  name: string;
  steps: Step[];
  expectedBodies: Record<string, unknown>[];
}

async function loadSpec(): Promise<{ cases: PushCase[] }> {
  // push.json lives next to wire.json; derive it like behavior.test.ts does.
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local = process.env.WHISPERR_PUSH_SPEC_PATH ?? (wire ? join(dirname(wire), "push.json") : null);
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch push spec: ${res.status}`);
  return res.json();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push-token conformance (whisperr-spec)", () => {
  it("captures, buffers, dedups, and rotates push tokens per the spec", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      const identifies: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: any) => {
          if (url.endsWith("/v1/identify")) identifies.push(JSON.parse(init.body));
          return { ok: true, status: 200 } as Response;
        }),
      );

      const w = new WhisperrClient({
        apiKey: "wrk_test",
        flushIntervalMs: 0,
        flushOnAppBackground: false,
      });
      for (const step of c.steps) {
        if ("identify" in step) {
          const { externalUserId, ...params } = step.identify;
          w.identify(externalUserId, params);
        } else {
          w.setPushToken(step.setPushToken);
        }
        await w.flush(); // deliver each step before the next, so order is pinned
      }

      expect(identifies, c.name).toEqual(c.expectedBodies);
    }
  }, 20000);
});
