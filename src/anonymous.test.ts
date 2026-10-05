import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";

// Device-derived trait defaults (timezone / locale) are environment-dependent
// and the fixture pins identify bodies exactly, so the harness runs with them
// disabled — the same way conformance.test.ts does for wire.json.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/anonymous.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

type Step =
  | { track: { eventType: string; properties?: Record<string, unknown> } }
  | { identify: { externalUserId: string; traits?: Record<string, unknown> } }
  | { reset: true };

type ExpectedRequest =
  | { endpoint: "/v1/events/batch"; events: Record<string, unknown>[] }
  | { endpoint: "/v1/identify"; body: Record<string, unknown> };

interface AnonymousCase {
  name: string;
  steps: Step[];
  expectedRequests: ExpectedRequest[];
}

async function loadSpec(): Promise<{ cases: AnonymousCase[] }> {
  // anonymous.json lives next to wire.json; derive it like behavior.test.ts does.
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local = process.env.WHISPERR_ANONYMOUS_SPEC_PATH ?? (wire ? join(dirname(wire), "anonymous.json") : null);
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch anonymous spec: ${res.status}`);
  return res.json();
}

afterEach(() => vi.unstubAllGlobals());

describe("anonymous-identity conformance (whisperr-spec)", () => {
  it("sends pre-identify events under anonymous_id, promotes on identify(), rotates on reset()", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      const captured: { path: string; body: any }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: any) => {
          captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
          return { ok: true, status: 202 } as Response;
        }),
      );

      const w = new WhisperrClient({
        apiKey: "wrk_test",
        flushIntervalMs: 0,
        flushOnAppBackground: false,
        trackAppLifecycleEvents: false, // spec harnesses pin only explicit calls
      });
      for (const step of c.steps) {
        if ("track" in step) w.track(step.track.eventType, step.track.properties);
        else if ("identify" in step) w.identify(step.identify.externalUserId, { traits: step.identify.traits });
        else w.reset();
        await w.flush();
      }
      await w.close();

      // Placeholders ($anon_a, …) bind to the first value seen; later uses
      // must match, different placeholders must differ, values are 1–128 chars.
      const bound = new Map<string, string>();
      const bind = (placeholder: string, actual: unknown) => {
        expect(typeof actual, `${c.name}: ${placeholder}`).toBe("string");
        const value = actual as string;
        expect(value.length, `${c.name}: ${placeholder} length`).toBeGreaterThanOrEqual(1);
        expect(value.length, `${c.name}: ${placeholder} length`).toBeLessThanOrEqual(128);
        const prior = bound.get(placeholder);
        if (prior !== undefined) expect(value, `${c.name}: ${placeholder} reused`).toBe(prior);
        else {
          expect([...bound.values()], `${c.name}: ${placeholder} distinct`).not.toContain(value);
          bound.set(placeholder, value);
        }
        return placeholder;
      };
      expect(captured.map((r) => r.path), c.name).toEqual(c.expectedRequests.map((r) => r.endpoint));
      c.expectedRequests.forEach((expected, i) => {
        const actual = captured[i]!.body;
        if (expected.endpoint === "/v1/events/batch") {
          expect(actual.events.length, `${c.name}[${i}] events`).toBe(expected.events.length);
          actual.events.forEach((ev: any, j: number) => {
            expect(ev.context?.$message_id, `${c.name}[${i}][${j}] $message_id`).toBeTruthy();
            const { occurred_at: _o, context: _c, ...rest } = ev;
            const want = expected.events[j]!;
            if (typeof want.anonymous_id === "string") rest.anonymous_id = bind(want.anonymous_id, rest.anonymous_id);
            expect(rest, `${c.name}[${i}][${j}]`).toEqual(want);
          });
        } else {
          const body = { ...actual };
          const want = expected.body;
          if (typeof want.anonymous_id === "string") body.anonymous_id = bind(want.anonymous_id, body.anonymous_id);
          expect(body, `${c.name}[${i}]`).toEqual(want);
        }
      });
    }
  }, 20000);
});
