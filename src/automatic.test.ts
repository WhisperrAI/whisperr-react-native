import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppState, __setPlatform, AppState } from "../test/react-native.js";
import { SDK_NAME } from "./autocapture.js";
import { WhisperrClient } from "./client.js";
import { LIB_VERSION } from "./runtime.js";
import { MemoryStorage } from "./storage.js";
import type { PushPermissionStatus } from "./types.js";

// The harness controls what the device reports (automatic.json `device`).
const device = vi.hoisted(() => ({ traits: {} as Record<string, string> }));
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({ ...device.traits }),
}));

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/automatic.json";

const realFetch = globalThis.fetch.bind(globalThis);
const RealDate = Date;

type Step =
  | { launch: { appVersion?: string; appBuild?: string } }
  | { background: { afterMs: number } }
  | { foreground: { afterMs: number } }
  | { terminate: true }
  | { screen: string }
  | { pushOpened: Record<string, unknown> }
  | { pushPermission: "authorized" | "provisional" | "denied" | "not_determined" }
  | { reset: true }
  | { optOut: true }
  | { optIn: true };

interface AutomaticCase {
  name: string;
  storage?: "empty" | "legacy_sdk_state";
  config?: { automaticEvents?: boolean };
  device: { osVersion?: string; locale?: string; timezone?: string; timezoneOffsetMinutes?: number };
  steps: Step[];
  expectedEvents: Array<{ event_type: string; properties: Record<string, unknown> }>;
}

async function loadSpec(): Promise<{ cases: AutomaticCase[] }> {
  // automatic.json lives next to wire.json.
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local = process.env.WHISPERR_AUTOMATIC_SPEC_PATH ?? (wire ? join(dirname(wire), "automatic.json") : null);
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch automatic spec: ${res.status}`);
  return res.json();
}

/** The spec's status names, in this SDK's permission vocabulary. */
const PERMISSION: Record<string, PushPermissionStatus> = {
  authorized: "granted",
  provisional: "provisional",
  denied: "denied",
  not_determined: "undetermined",
};

const PLACEHOLDERS: Record<string, string> = {
  $platform: "ios",
  $sdk_name: SDK_NAME,
  $sdk_version: LIB_VERSION,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  AppState.currentState = "active";
  __setPlatform({ OS: "ios", Version: "17.4", constants: { systemName: "iOS" } });
});

const spec = await loadSpec();

describe("automatic events conformance (whisperr-spec)", () => {
  it("has cases", () => expect(spec.cases.length).toBeGreaterThan(0));
  it.each(spec.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => runCase(c));
});

async function runCase(c: AutomaticCase): Promise<void> {
  const sent: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/v1/events/batch")) sent.push(...body.events);
      else if (url.endsWith("/v1/events/track")) sent.push(body);
      return { ok: true, status: 202 } as Response;
    }),
  );

  device.traits = {};
  if (c.device.locale) device.traits.locale = c.device.locale;
  if (c.device.timezone) device.traits.timezone = c.device.timezone;
  const offset = c.device.timezoneOffsetMinutes;
  vi.spyOn(RealDate.prototype, "getTimezoneOffset").mockReturnValue(offset === undefined ? Number.NaN : -offset);
  __setPlatform({ OS: "ios", Version: c.device.osVersion ?? "", constants: {} });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new RealDate("2026-10-07T12:00:00.000Z"));

  const storage = new MemoryStorage();
  if (c.storage === "legacy_sdk_state") storage.setItem("whisperr.user_id", "user_1");

  let w: WhisperrClient | null = null;
  const client = (): WhisperrClient => {
    if (!w) throw new Error(`${c.name}: step before launch`);
    return w;
  };
  const settle = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await (client() as unknown as { lifecycleChain: Promise<void> }).lifecycleChain;
    await client().flush();
  };
  const advance = (ms: number) => vi.setSystemTime(new RealDate(Date.now() + ms));

  for (const step of c.steps) {
    if ("launch" in step) {
      AppState.currentState = "active";
      w = new WhisperrClient({
        apiKey: "wrk_test",
        storage,
        flushIntervalMs: 0,
        maxRetries: 0,
        trackAppLifecycleEvents: c.config?.automaticEvents ?? true,
        appVersion: step.launch.appVersion,
        appBuild: step.launch.appBuild,
      });
      w.identify("user_1");
    } else if ("background" in step) {
      advance(step.background.afterMs);
      __setAppState("background");
    } else if ("foreground" in step) {
      advance(step.foreground.afterMs);
      __setAppState("active");
    } else if ("terminate" in step) {
      await client().close();
      w = null;
      continue;
    } else if ("screen" in step) {
      client().screen(step.screen);
    } else if ("pushOpened" in step) {
      client().trackPushOpened(step.pushOpened);
    } else if ("pushPermission" in step) {
      client().setPushPermission(PERMISSION[step.pushPermission]!);
    } else if ("reset" in step) {
      client().reset();
    } else if ("optOut" in step) {
      client().optOut();
    } else if ("optIn" in step) {
      client().optIn();
    } else {
      throw new Error(`${c.name}: unknown step ${JSON.stringify(step)}`);
    }
    await settle();
  }
  if (w) await w.close();

  for (const event of sent) expect(event.context?.$message_id, `${c.name}: $message_id`).toBeTruthy();
  const actual = sent.map((e) => ({ event_type: e.event_type, properties: e.properties ?? {} }));
  const expected = c.expectedEvents.map((e) => ({
    event_type: e.event_type,
    properties: Object.fromEntries(
      Object.entries(e.properties).map(([k, v]) => [k, typeof v === "string" && v in PLACEHOLDERS ? PLACEHOLDERS[v] : v]),
    ),
  }));
  expect(actual, c.name).toEqual(expected);
}
