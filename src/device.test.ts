import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setLocaleIdentifier } from "../test/react-native.js";
import { WhisperrClient } from "./client.js";
import { deviceTraits, normalizeLocaleTag } from "./device.js";

/** Pretend the JS engine's Intl reports this zone + locale (undefined = no Intl at all). */
function stubIntl(resolved: { timeZone?: string; locale?: string } | undefined) {
  if (!resolved) {
    vi.stubGlobal("Intl", undefined);
    return;
  }
  vi.stubGlobal("Intl", {
    DateTimeFormat: function DateTimeFormat() {
      return { resolvedOptions: () => resolved };
    },
  });
}

let captured: Array<{ path: string; body: any }> = [];

beforeEach(() => {
  captured = [];
  __setLocaleIdentifier(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setLocaleIdentifier(undefined);
});

function makeClient(): WhisperrClient {
  return new WhisperrClient({ apiKey: "wrk_test", flushIntervalMs: 0, flushOnAppBackground: false });
}

function identifyBodies() {
  return captured.filter((c) => c.path === "/v1/identify").map((c) => c.body);
}

describe("deviceTraits()", () => {
  it("reads the IANA zone and BCP 47 locale from Intl", () => {
    stubIntl({ timeZone: "Europe/Berlin", locale: "de-DE" });
    expect(deviceTraits()).toEqual({ timezone: "Europe/Berlin", locale: "de-DE" });
  });

  it("falls back to I18nManager's locale identifier (normalized) when Intl has none", () => {
    stubIntl({ timeZone: "Asia/Tokyo" });
    __setLocaleIdentifier("ja_JP");
    expect(deviceTraits()).toEqual({ timezone: "Asia/Tokyo", locale: "ja-JP" });
  });

  it("works without Intl at all (JSC without ICU): locale from the platform, no timezone guess", () => {
    stubIntl(undefined);
    __setLocaleIdentifier("de_DE");
    expect(deviceTraits()).toEqual({ locale: "de-DE" });
  });

  it("returns nothing when the runtime provides nothing", () => {
    stubIntl(undefined);
    expect(deviceTraits()).toEqual({});
    stubIntl({});
    expect(deviceTraits()).toEqual({});
  });

  it("treats an undetermined Intl locale as unavailable", () => {
    stubIntl({ timeZone: "UTC", locale: "und" });
    expect(deviceTraits()).toEqual({ timezone: "UTC" });
  });

  it("never throws when Intl is present but broken", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: function DateTimeFormat() {
        throw new RangeError("no ICU data");
      },
    });
    expect(deviceTraits()).toEqual({});
  });
});

describe("normalizeLocaleTag()", () => {
  it.each([
    ["de_DE", "de-DE"],
    ["en", "en"],
    ["en-US", "en-US"],
    ["zh_CN_#Hans", "zh-Hans-CN"],
    ["sr_RS_#Latn", "sr-Latn-RS"],
    ["de_DE_#u-co-phonebk", "de-DE"],
    ["en_US@calendar=gregorian", "en-US"],
    ["en_US_POSIX", "en-US-POSIX"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeLocaleTag(input)).toBe(expected);
  });

  it.each(["", "_", "und", "1234", undefined, null])("rejects %s", (input) => {
    expect(normalizeLocaleTag(input as string | undefined | null)).toBeUndefined();
  });
});

describe("identify() device-trait defaults", () => {
  it("fills traits.timezone and traits.locale by default, inside traits", async () => {
    stubIntl({ timeZone: "Europe/Berlin", locale: "de-DE" });
    const w = makeClient();
    w.identify("user_1", { traits: { plan: "pro" } });
    await w.flush();
    expect(identifyBodies()).toEqual([
      { external_user_id: "user_1", traits: { plan: "pro", timezone: "Europe/Berlin", locale: "de-DE" } },
    ]);
  });

  it("caller-supplied timezone / locale always win", async () => {
    stubIntl({ timeZone: "Europe/Berlin", locale: "de-DE" });
    const w = makeClient();
    w.identify("user_1", { traits: { timezone: "America/New_York", locale: "en-GB" } });
    await w.flush();
    expect(identifyBodies()[0].traits).toEqual({ timezone: "America/New_York", locale: "en-GB" });
  });

  it("a legacy time_zone / tz alias counts as caller-supplied", async () => {
    stubIntl({ timeZone: "Europe/Berlin", locale: "de-DE" });
    const w = makeClient();
    w.identify("user_1", { traits: { time_zone: "Asia/Tokyo" } });
    await w.flush();
    expect(identifyBodies()[0].traits).toEqual({ time_zone: "Asia/Tokyo", locale: "de-DE" });
  });

  it("sends no traits when the runtime provides nothing and the caller passes none", async () => {
    stubIntl(undefined);
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    expect(identifyBodies()).toEqual([{ external_user_id: "user_1" }]);
  });

  it("keeps setPushToken()'s partial identify traits-free", async () => {
    stubIntl({ timeZone: "Europe/Berlin", locale: "de-DE" });
    const w = makeClient();
    w.identify("user_1");
    await w.flush();
    w.setPushToken("fcm_tok_a");
    await w.flush();
    expect(identifyBodies()).toEqual([
      { external_user_id: "user_1", traits: { timezone: "Europe/Berlin", locale: "de-DE" } },
      { external_user_id: "user_1", channels: [{ channel: "push", address: "fcm_tok_a", opted_in: true }] },
    ]);
  });
});
