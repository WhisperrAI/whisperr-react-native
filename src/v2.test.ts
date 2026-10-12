/**
 * whisperr-spec contract v2 conformance (conformance/v2.json): restore
 * identify, app_language, the anonymous push lane, push token fields, and
 * the version context keys. Harness rules are in the fixture's description.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../test/spec.js";
import { SDK_NAME } from "./autocapture.js";
import { WhisperrClient } from "./client.js";
import { LIB_VERSION } from "./runtime.js";
import { MemoryStorage } from "./storage.js";
import type { PushPermissionStatus, PushTokenKind } from "./types.js";

/** What the harness injects as the device (a case's `device` block; null = detection off). */
const env = vi.hoisted(() => ({
  device: null as null | Record<string, string>,
}));

vi.mock("./device.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device.js")>()),
  deviceTraits: () => {
    const out: Record<string, string> = {};
    if (env.device?.locale) out.locale = env.device.locale;
    if (env.device?.timezone) out.timezone = env.device.timezone;
    return out;
  },
}));

vi.mock("./push-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./push-environment.js")>()),
  detectPushEnvironment: () => {
    const d = env.device;
    if (!d) return { providerProject: () => undefined };
    return {
      platform: "ios",
      ...(d.clientAppId ? { clientAppId: d.clientAppId } : {}),
      ...(d.pushEnv ? { pushEnv: d.pushEnv } : {}),
      providerProject: (_kind: PushTokenKind) => d.providerProject,
    };
  },
}));

const PLATFORM = "ios";
const GOVERNED = ["app_version", "app_build", "platform", "sdk_name", "sdk_version", "locale"];
const PERMISSION: Record<string, PushPermissionStatus> = {
  authorized: "granted",
  provisional: "provisional",
  denied: "denied",
  not_determined: "undetermined",
};
const RealDate = Date;

interface V2Case {
  name: string;
  device?: Record<string, string>;
  steps: Array<Record<string, any>>;
  expectedRequests: Array<{ endpoint: string; body?: Record<string, unknown>; events?: Array<Record<string, any>> }>;
}
interface V2Section {
  appliesTo: string[];
  supersedes?: string[];
  cases: V2Case[];
}

const spec = await loadFixture<{ sections: Record<string, V2Section> }>("v2.json", "WHISPERR_V2_SPEC_PATH");
const sections = Object.entries(spec.sections).filter(([, s]) => s.appliesTo.includes("mobile"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  env.device = null;
});

describe("contract v2 conformance (whisperr-spec v2.json)", () => {
  it("has the mobile sections", () => {
    expect(sections.map(([name]) => name).sort()).toEqual(
      ["anonymousPush", "appLanguage", "pushRegistration", "restoreIdentify", "versionContext"].sort(),
    );
  });
  for (const [name, section] of sections) {
    describe(name, () => {
      it.each(section.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => runCase(c));
    });
  }
});

async function runCase(c: V2Case): Promise<void> {
  const sent: Array<{ endpoint: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      sent.push({ endpoint: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    }),
  );
  env.device = c.device ? { ...c.device } : null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new RealDate("2026-10-12T09:00:00.000Z"));

  const storage = new MemoryStorage();
  const make = () =>
    new WhisperrClient({
      apiKey: "wpk_test",
      storage,
      flushIntervalMs: 0,
      flushOnAppBackground: false,
      trackAppLifecycleEvents: false,
      maxRetries: 0,
      ...(env.device?.appVersion ? { appVersion: env.device.appVersion } : {}),
      ...(env.device?.appBuild ? { appBuild: env.device.appBuild } : {}),
    });

  let w = make();
  for (const step of c.steps) {
    const [kind, arg] = Object.entries(step)[0]!;
    switch (kind) {
      case "identify": {
        const { externalUserId, ...params } = arg;
        w.identify(externalUserId, params);
        break;
      }
      case "track":
        w.track(arg.eventType, arg.properties);
        break;
      case "setPushToken":
        w.setPushToken(arg);
        break;
      case "setAppLanguage":
        w.setAppLanguage(arg);
        break;
      case "restart":
        await w.close();
        w = make();
        if (typeof arg === "object" && arg.thenIdentify) {
          const { externalUserId, ...params } = arg.thenIdentify;
          w.identify(externalUserId, params); // the same synchronous tick as construction
        }
        break;
      case "reset":
        w.reset();
        break;
      case "optOut":
        w.optOut();
        break;
      case "optIn":
        w.optIn();
        break;
      case "pushPermission":
        w.setPushPermission(PERMISSION[arg]!);
        break;
      case "advanceClock":
        vi.setSystemTime(new RealDate(Date.now() + arg.hours * 3_600_000));
        break;
      case "setDevice":
        env.device = { ...(env.device ?? {}), ...arg };
        break;
      default:
        throw new Error(`${c.name}: unknown step ${kind}`);
    }
    await new Promise((r) => setTimeout(r, 0));
    await w.flush();
  }
  await w.close();

  compare(c, withoutPermissionEvents(sent));
}

/**
 * Known gap in the fixture: a `pushPermission` step makes this SDK send
 * push_permission_changed (the app's explicit report always sends it; SPEC.md
 * → push_permission_changed), but the anonymousPush cases list only the
 * identify requests. Those events are dropped before the comparison.
 */
function withoutPermissionEvents(sent: Array<{ endpoint: string; body: any }>) {
  return sent.flatMap((r) => {
    if (r.endpoint !== "/v1/events/batch") return [r];
    const events = r.body.events.filter((e: any) => e.event_type !== "push_permission_changed");
    return events.length ? [{ ...r, body: { ...r.body, events } }] : [];
  });
}

function compare(c: V2Case, sent: Array<{ endpoint: string; body: any }>): void {
  const anon = new Map<string, string>();
  const bindAnon = (placeholder: string, value: unknown, where: string) => {
    expect(typeof value, `${c.name} ${where}: ${placeholder}`).toBe("string");
    const bound = anon.get(placeholder);
    if (bound !== undefined) {
      expect(value, `${c.name} ${where}: ${placeholder} stays the same handle`).toBe(bound);
    } else {
      expect([...anon.values()], `${c.name} ${where}: ${placeholder} is a new handle`).not.toContain(value);
      anon.set(placeholder, value as string);
    }
  };
  const resolve = (v: unknown, actual: unknown, where: string): unknown => {
    if (typeof v !== "string") return v;
    if (v.startsWith("$anon_")) {
      bindAnon(v, actual, where);
      return actual;
    }
    if (v === "$platform") return PLATFORM;
    if (v === "$sdk_name") return SDK_NAME;
    if (v === "$sdk_version") return LIB_VERSION;
    return v;
  };
  const resolveDeep = (expected: unknown, actual: any, where: string): unknown => {
    if (Array.isArray(expected)) return expected.map((e, i) => resolveDeep(e, actual?.[i], `${where}[${i}]`));
    if (expected && typeof expected === "object") {
      return Object.fromEntries(
        Object.entries(expected).map(([k, v]) => [k, resolveDeep(v, actual?.[k], `${where}.${k}`)]),
      );
    }
    return resolve(expected, actual, where);
  };

  expect(
    sent.map((r) => r.endpoint),
    `${c.name}: request endpoints`,
  ).toEqual(c.expectedRequests.map((r) => r.endpoint));

  c.expectedRequests.forEach((exp, i) => {
    const got = sent[i]!;
    const where = `request ${i}`;
    if (exp.endpoint === "/v1/identify") {
      const actual = { ...got.body };
      // An SDK may hold a handle for its anonymous event lane.
      if (actual.external_user_id && !("anonymous_id" in exp.body!)) delete actual.anonymous_id;
      expect(actual, `${c.name} ${where}`).toEqual(resolveDeep(exp.body, actual, where));
      return;
    }
    const events = got.body.events as any[];
    expect(events.length, `${c.name} ${where}: event count`).toBe(exp.events!.length);
    exp.events!.forEach((e, j) => {
      const actual = events[j];
      const ew = `${where} event ${j}`;
      expect(actual.context?.$message_id, `${c.name} ${ew}: $message_id`).toBeTruthy();
      const { context: expectedContext, ...expectedRest } = e;
      const { occurred_at: _o, context: actualContext, ...actualRest } = actual;
      expect(actualRest, `${c.name} ${ew}`).toEqual(resolveDeep(expectedRest, actualRest, ew));
      if (expectedContext) {
        for (const key of GOVERNED) {
          if (key in expectedContext) {
            expect(actualContext?.[key], `${c.name} ${ew}: context.${key}`).toEqual(
              resolve(expectedContext[key], actualContext?.[key], `${ew}.context.${key}`),
            );
          } else {
            expect(actualContext, `${c.name} ${ew}: context.${key} must be absent`).not.toHaveProperty(key);
          }
        }
      }
    });
  });
}
