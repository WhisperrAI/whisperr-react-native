import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";

// Device-derived trait defaults (timezone / locale) are environment-dependent,
// so the spec fixtures never pin them (SPEC.md → Reserved trait keys): run with
// them disabled so every identify body is exactly what the scenario supplied.
// device.test.ts covers the defaults themselves.
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({}),
}));

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/wire.json";
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

interface WireCase {
  name: string;
  op: "track" | "identify";
  scenario: any;
  endpoint: string;
  expectedEvent?: Record<string, unknown>;
  expectedBody?: Record<string, unknown>;
  contextMustContain?: string[];
  occurredAtRfc3339Z?: boolean;
  expectedOccurredAt?: string;
}

async function loadSpec(): Promise<{ cases: WireCase[] }> {
  const local = process.env.WHISPERR_SPEC_PATH;
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch wire spec: ${res.status}`);
  return res.json();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("wire conformance (whisperr-spec)", () => {
  it("serializes every case to the canonical wire shape", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      const captured: { path: string; body: any }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: any) => {
          captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
          return { ok: true, status: 200 } as Response;
        }),
      );
      if (c.scenario.clockIso) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(c.scenario.clockIso));
      }

      const w = new WhisperrClient({
        apiKey: "wrk_test",
        flushIntervalMs: 0,
        flushOnAppBackground: false,
        trackAppLifecycleEvents: false, // spec harnesses pin only explicit calls
      });
      const s = c.scenario;
      if (c.op === "track") {
        w.identify(s.externalUserId);
        w.track(s.eventType, s.properties);
      } else {
        w.identify(s.externalUserId, {
          traits: s.traits,
          email: s.email,
          phone: s.phone,
          pushToken: s.pushToken,
          preferredChannel: s.preferredChannel,
          channels: s.channels?.map((ch: any) => ({
            type: ch.type,
            address: ch.address,
            optedIn: ch.optedIn,
            verified: ch.verified,
          })),
        });
      }
      await w.flush();
      vi.useRealTimers();

      const call = captured.find((x) => x.path === c.endpoint);
      expect(call, `${c.name}: expected POST ${c.endpoint}`).toBeTruthy();

      if (c.op === "track") {
        const ev = call!.body.events[0];
        for (const [k, v] of Object.entries(c.expectedEvent ?? {})) {
          expect(ev[k], `${c.name}.${k}`).toEqual(v);
        }
        for (const key of c.contextMustContain ?? []) {
          expect(ev.context?.[key], `${c.name} context.${key}`).toBeTruthy();
        }
        if (c.occurredAtRfc3339Z) expect(ev.occurred_at).toMatch(RFC3339_Z);
        if (c.expectedOccurredAt) {
          expect(ev.occurred_at, `${c.name}.occurred_at`).toBe(c.expectedOccurredAt);
        }
      } else {
        for (const [k, v] of Object.entries(withKnownDivergences(c.name, c.expectedBody ?? {}))) {
          expect(call!.body[k], `${c.name}.${k}`).toEqual(v);
        }
      }
    }
  }, 20000);
});

/**
 * Deliberate, documented departures from the spec fixture while the spec
 * catches up (plan of record, Workstream 4 step 4: no automatic opt-in).
 *
 * - The `email` shortcut asserts no consent: the SDK leaves `opted_in` off
 *   the email channel instead of claiming `true` for the user. Idempotent, so
 *   this stays correct once the fixture drops `opted_in` itself.
 */
function withKnownDivergences(name: string, expected: Record<string, unknown>): Record<string, unknown> {
  if (name !== "identify_email_shortcut" || !Array.isArray(expected.channels)) return expected;
  return {
    ...expected,
    channels: (expected.channels as Record<string, unknown>[]).map((ch) => {
      if (ch.channel !== "email") return ch;
      const { opted_in: _omitted, ...rest } = ch;
      return rest;
    }),
  };
}
