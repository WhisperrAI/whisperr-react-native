import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import type { PushPermissionStatus } from "./types.js";

// Device-derived trait defaults (timezone / locale) are environment-dependent,
// so the spec fixtures never pin them (SPEC.md → Reserved trait keys): run with
// them disabled so every identify body is exactly what the scenario supplied.
// device.test.ts covers the defaults themselves.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));
import { MemoryStorage } from "./storage.js";

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/push.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

type Step =
  | { identify: { externalUserId: string; [k: string]: unknown } }
  | { setPushToken: string | { token: string; kind?: string; platform?: string; pushEnv?: string } }
  | { restart: boolean }
  | { reset: boolean }
  | { optOut: boolean }
  | { optIn: boolean }
  | { pushPermission: "authorized" | "provisional" | "denied" | "not_determined" };

/** The spec's status names, in this SDK's permission vocabulary. */
const PERMISSION: Record<string, PushPermissionStatus> = {
  authorized: "granted",
  provisional: "provisional",
  denied: "denied",
  not_determined: "undetermined",
};

interface PushCase {
  name: string;
  steps: Step[];
  expectedBodies: Record<string, unknown>[];
}

async function loadSpec(): Promise<{ cases: PushCase[]; kindCases?: PushCase[] }> {
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
    await runCases(spec.cases);
  }, 20000);

  it("sends the token kind, platform, and push_env per the spec (kindCases)", async () => {
    const spec = await loadSpec();
    expect(spec.kindCases?.length ?? 0).toBeGreaterThan(0);
    await runCases(spec.kindCases ?? []);
  }, 20000);
});

async function runCases(cases: PushCase[]): Promise<void> {
  for (const c of cases) {
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
        trackAppLifecycleEvents: false, // spec harnesses pin only explicit calls
      });

    let w = makeClient();
    for (const step of c.steps) {
      if ("identify" in step) {
        const { externalUserId, ...params } = step.identify;
        w.identify(externalUserId, params);
        await w.flush();
      } else if ("setPushToken" in step) {
        w.setPushToken(step.setPushToken as Parameters<WhisperrClient["setPushToken"]>[0]);
        await w.flush();
      } else if ("reset" in step) {
        w.reset();
        await w.flush();
      } else if ("optOut" in step) {
        w.optOut();
        await w.flush();
      } else if ("optIn" in step) {
        w.optIn();
        await w.flush();
      } else if ("pushPermission" in step) {
        w.setPushPermission(PERMISSION[step.pushPermission]!);
        await w.flush();
      } else if ("restart" in step) {
        // restart: tear down the client, construct a fresh one on the same
        // storage. Do NOT drain init here — real apps call identify() /
        // setPushToken() in the launch tick, before the async restore
        // resolves. The next step runs against the still-initializing client
        // (its own flush() forces restore); this is what exposes an SDK that
        // skips restoring the persisted push pair once identify() has run.
        await w.close();
        w = makeClient();
      } else {
        throw new Error(`${c.name}: unknown step ${JSON.stringify(step)}`);
      }
    }
    await w.close();

    expect(identifies, c.name).toEqual(c.expectedBodies);
  }
}
