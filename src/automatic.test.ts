import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPEC_REF } from "../test/spec.js";
import { __setAppState, __setInitialURL, __setPlatform, AppState } from "../test/react-native.js";
import { SDK_NAME } from "./autocapture.js";
import { WhisperrClient } from "./client.js";
import { LIB_VERSION } from "./runtime.js";
import { errorFingerprint } from "./signals.js";
import { MemoryStorage } from "./storage.js";
import type { PushPermissionStatus } from "./types.js";

// The harness controls what the device reports (automatic.json `device`).
const device = vi.hoisted(() => ({ traits: {} as Record<string, string> }));
vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => ({ ...device.traits }),
}));

const SPEC_URL =
  `https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/${SPEC_REF}/conformance/automatic.json`;

const realFetch = globalThis.fetch.bind(globalThis);
const RealDate = Date;

type Step =
  | {
      launch: {
        appVersion?: string;
        appBuild?: string;
        via?: { push?: Record<string, unknown>; link?: string; shortcut?: unknown };
      };
    }
  | { track: string }
  | { trackError: { name: string; kind?: string; screen?: string } }
  | { uncaughtError: { name: string; fatal: boolean } }
  | { background: { afterMs: number } }
  | { foreground: { afterMs: number } }
  | { terminate: true }
  | { screen: string }
  | { pushOpened: Record<string, unknown> }
  | { pushPermission: "authorized" | "provisional" | "denied" | "not_determined" }
  | { reset: true }
  | { optOut: true }
  | { optIn: true }
  | { receivePush: { data: Record<string, unknown>; source: string; foreground: boolean } }
  | { openPush: { data: Record<string, unknown>; launchedApp: boolean; actionId?: string } };

interface AutomaticCase {
  name: string;
  storage?: "empty" | "legacy_sdk_state";
  config?: { automaticEvents?: boolean; captureErrors?: boolean; debugBuild?: boolean };
  device: { osVersion?: string; locale?: string; timezone?: string; timezoneOffsetMinutes?: number };
  steps: Step[];
  expectedEvents: Array<{ event_type: string; properties: Record<string, unknown>; context?: Record<string, unknown> }>;
}

interface PushEventsV2 {
  supersedes: string[];
  cases: AutomaticCase[];
}

/** Context keys contract v2 governs: a named one must match, an unnamed one must be absent. */
const GOVERNED = ["app_version", "app_build", "platform", "sdk_name", "sdk_version", "locale"];

interface SignalsV3 {
  legacyStrip: { events: string[]; properties: string[] };
  fingerprintVectors: Array<{ errorName: string; frames: string[]; fingerprint: string }>;
  sections: Record<string, { appliesTo: string[]; cases: AutomaticCase[] }>;
}

async function loadSpec(): Promise<{ cases: AutomaticCase[]; pushEventsV2?: PushEventsV2; signalsV3?: SignalsV3 }> {
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
  $error_kind: "js",
  $fatal_detected_by: "js_fatal",
};

afterEach(() => {
  delete (globalThis as { __DEV__?: boolean }).__DEV__;
  delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  __setInitialURL(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  AppState.currentState = "active";
  __setPlatform({ OS: "ios", Version: "17.4", constants: { systemName: "iOS" } });
});

const spec = await loadSpec();

// Contract v2: this SDK runs pushEventsV2 and skips the cases it supersedes.
const pushEventsV2 = spec.pushEventsV2;
const superseded = new Set(
  (pushEventsV2?.supersedes ?? []).filter((e) => e.startsWith("automatic.json:")).map((e) => e.split(":")[1]),
);

// This SDK sends the signals v3 properties and events on every launch. The
// legacy cases keep their v1 meaning with them stripped (signalsV3.legacyStrip;
// the same list until the spec that defines it is on main).
const signalsV3 = spec.signalsV3;
const legacyStrip = signalsV3?.legacyStrip ?? {
  events: ["app_error", "app_crashed"],
  properties: [
    "launch_source",
    "whisperr_message_id",
    "link_route",
    "link_host",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "first_after_update",
    "session_id",
    "screen_count",
    "unique_screen_count",
    "event_count",
    "error_count",
  ],
};

describe("automatic events conformance (whisperr-spec)", () => {
  it("has cases", () => expect(spec.cases.length).toBeGreaterThan(0));
  it.each(spec.cases.filter((c) => !superseded.has(c.name)).map((c) => [c.name, c] as const))("%s", (_name, c) =>
    runCase(c, true),
  );
});

describe("contract v2 push events (automatic.json pushEventsV2)", () => {
  it("has cases", () => expect(pushEventsV2?.cases.length ?? 0).toBeGreaterThan(0));
  it.each((pushEventsV2?.cases ?? []).map((c) => [c.name, c] as const))("%s", (_name, c) => runCase(c, true));
});

const v3Cases = Object.entries(signalsV3?.sections ?? {})
  .filter(([, section]) => section.appliesTo.includes("mobile"))
  .flatMap(([name, section]) => section.cases.map((c) => [`${name}: ${c.name}`, c] as const));

describe.skipIf(!signalsV3)("signals v3 (automatic.json signalsV3)", () => {
  it.each(v3Cases)("%s", (_name, c) => runCase(c, false));
  it.each((signalsV3?.fingerprintVectors ?? []).map((v) => [v.errorName, v] as const))(
    "fingerprint vector %s",
    (_name, v) => expect(errorFingerprint(v.errorName, v.frames)).toBe(v.fingerprint),
  );
});

/** An error of type `name` whose message must never be sent. */
function namedError(name: string): Error {
  const error = new Error("secret message: user@example.com");
  error.name = name;
  return error;
}

async function runCase(c: AutomaticCase, legacy: boolean): Promise<void> {
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
  if (c.config?.debugBuild) (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  // The harness's own global handler: the SDK must keep calling it.
  let harnessHandlerCalls = 0;
  let globalHandler: (error: unknown, isFatal?: boolean) => void = () => void harnessHandlerCalls++;
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => globalHandler,
    setGlobalHandler: (h: typeof globalHandler) => void (globalHandler = h),
  };
  let uncaught = 0;

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
      __setInitialURL(step.launch.via?.link ?? null);
      w = new WhisperrClient({
        apiKey: "wrk_test",
        storage,
        flushIntervalMs: 0,
        maxRetries: 0,
        trackAppLifecycleEvents: c.config?.automaticEvents ?? true,
        captureErrors: c.config?.captureErrors ?? true,
        appVersion: step.launch.appVersion,
        appBuild: step.launch.appBuild,
      });
      w.identify("user_1");
      __setInitialURL(null);
      if (step.launch.via?.push) w.trackPushOpened(step.launch.via.push, { coldStart: true });
    } else if ("track" in step) {
      client().track(step.track);
    } else if ("trackError" in step) {
      client().trackError(namedError(step.trackError.name), {
        ...(step.trackError.kind ? { kind: step.trackError.kind as "network" } : {}),
        ...(step.trackError.screen ? { screen: step.trackError.screen } : {}),
      });
    } else if ("uncaughtError" in step) {
      uncaught++;
      globalHandler(namedError(step.uncaughtError.name), step.uncaughtError.fatal);
      expect(harnessHandlerCalls, `${c.name}: the previous global handler still runs`).toBe(uncaught);
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
    } else if ("receivePush" in step) {
      client().trackPushReceived(step.receivePush.data, {
        foreground: step.receivePush.foreground,
        source: step.receivePush.source as "foreground",
      });
    } else if ("openPush" in step) {
      client().trackPushOpened(step.openPush.data, {
        coldStart: step.openPush.launchedApp,
        ...(step.openPush.actionId ? { actionId: step.openPush.actionId } : {}),
      });
    } else {
      throw new Error(`${c.name}: unknown step ${JSON.stringify(step)}`);
    }
    await settle();
  }
  if (w) await w.close();

  for (const event of sent) expect(event.context?.$message_id, `${c.name}: $message_id`).toBeTruthy();
  expect(JSON.stringify(sent), `${c.name}: no error message is sent`).not.toContain("secret message");
  if (legacy) {
    // Signals v3 additions are not part of the legacy cases.
    const strip = new Set(legacyStrip.properties);
    const kept = sent.filter((e) => !legacyStrip.events.includes(e.event_type));
    // A key the legacy case itself expects (push_opened's whisperr_message_id) stays.
    kept.forEach((e, i) => {
      const expected = c.expectedEvents[i]?.properties ?? {};
      for (const key of Object.keys(e.properties ?? {})) if (strip.has(key) && !(key in expected)) delete e.properties[key];
    });
    sent.splice(0, sent.length, ...kept);
  }
  // $session_<x> / $fp_<x>: bound to the first value seen; distinct placeholders, distinct values.
  const bound = new Map<string, unknown>();
  const bind = (placeholder: string, actual: unknown, shape: RegExp): unknown => {
    if (!bound.has(placeholder)) {
      if (typeof actual !== "string" || !shape.test(actual)) return placeholder;
      if ([...bound.values()].includes(actual)) return placeholder;
      bound.set(placeholder, actual);
    }
    return bound.get(placeholder);
  };
  const SESSION = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const resolve = (v: unknown, actual: unknown): unknown => {
    if (typeof v !== "string") return v;
    if (v.startsWith("$session_")) return bind(v, actual, SESSION);
    if (v.startsWith("$fp_")) return bind(v, actual, /^[0-9a-f]{16}$/);
    return v in PLACEHOLDERS ? PLACEHOLDERS[v] : v;
  };
  c.expectedEvents.forEach((e, i) => {
    const sid = e.context?.session_id;
    if (typeof sid === "string") {
      expect(sent[i]?.context?.session_id, `${c.name} event ${i} context.session_id`).toBe(
        resolve(sid, sent[i]?.context?.session_id),
      );
    }
  });
  const sub = (v: unknown) => (typeof v === "string" && v in PLACEHOLDERS ? PLACEHOLDERS[v] : v);
  c.expectedEvents.forEach((e, i) => {
    if (!e.context || !legacy) return; // signals v3 cases name only context.session_id
    for (const key of GOVERNED) {
      if (key in e.context) expect(sent[i]?.context?.[key], `${c.name} event ${i} context.${key}`).toEqual(sub(e.context[key]));
      else expect(sent[i]?.context, `${c.name} event ${i} context.${key} absent`).not.toHaveProperty(key);
    }
  });
  const actual = sent.map((e) => ({ event_type: e.event_type, properties: e.properties ?? {} }));
  const expected = c.expectedEvents.map((e, i) => ({
    event_type: e.event_type,
    properties: Object.fromEntries(
      Object.entries(e.properties).map(([k, v]) => [k, resolve(v, sent[i]?.properties?.[k])]),
    ),
  }));
  expect(actual, c.name).toEqual(expected);
}
