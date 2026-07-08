import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import { MemoryStorage } from "./storage.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/push.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

type Step =
  | { identify: { externalUserId: string; [k: string]: unknown } }
  | { setPushToken: string }
  | { restart: boolean };

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

      // One storage per case — a `restart` step hands it to the next instance,
      // like an app relaunch reopening the same AsyncStorage.
      const storage = new MemoryStorage();
      const makeClient = () =>
        new WhisperrClient({
          apiKey: "wrk_test",
          storage,
          flushIntervalMs: 0,
          flushOnAppBackground: false,
        });

      let w = makeClient();
      for (const step of c.steps) {
        if ("identify" in step) {
          const { externalUserId, ...params } = step.identify;
          w.identify(externalUserId, params);
        } else if ("setPushToken" in step) {
          w.setPushToken(step.setPushToken);
        } else {
          // restart: tear down the client, construct a fresh one on the same
          // storage — persisted identity and last-sent token must be restored.
          await w.close();
          w = makeClient();
        }
        await w.flush(); // deliver each step before the next, so order is pinned
      }
      await w.close();

      expect(identifies, c.name).toEqual(c.expectedBodies);
    }
  }, 20000);
});
