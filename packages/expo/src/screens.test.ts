import { afterEach, describe, expect, it, vi } from "vitest";
import * as expoRouter from "../test/expo-router.js";

// A one-component React: effects run after each render, refs persist.
const react = vi.hoisted(() => {
  const refs: Array<{ current: unknown }> = [];
  const deps: unknown[][] = [];
  let i = 0;
  let j = 0;
  return {
    begin() {
      i = 0;
      j = 0;
    },
    reset() {
      refs.length = 0;
      deps.length = 0;
    },
    useRef<T>(initial: T) {
      refs[i] ??= { current: initial };
      return refs[i++] as { current: T };
    },
    useEffect(effect: () => void, next: unknown[]) {
      const prev = deps[j];
      deps[j++] = next;
      if (!prev || prev.some((d, k) => d !== next[k])) effect();
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: react.useRef,
  useEffect: react.useEffect,
}));
vi.mock("@whisperr/react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@whisperr/react-native")>()),
  useWhisperrClient: () => null,
}));

const { __setExpoRouter, routeTemplate, useWhisperrScreens } = await import("./screens.js");
const { __setSegments } = expoRouter;

afterEach(() => react.reset());

describe("routeTemplate", () => {
  it.each([
    [["(tabs)", "lesson", "[id]"], "/lesson/[id]"],
    [[], "/"],
    [["(auth)", "(onboarding)", "welcome"], "/welcome"],
    [["shop", "[...rest]"], "/shop/[...rest]"],
  ])("%j → %s", (segments, expected) => expect(routeTemplate(segments)).toBe(expected));
});

describe("useWhisperrScreens", () => {
  it("does nothing without expo-router", () => {
    __setExpoRouter(null);
    const screen = vi.fn();
    react.begin();
    useWhisperrScreens({ client: { screen } as never });
    expect(screen).not.toHaveBeenCalled();
  });

  it("sends the route template once per change", () => {
    __setExpoRouter(expoRouter);
    const screen = vi.fn();
    const client = { screen } as never;
    const render = () => {
      react.begin();
      useWhisperrScreens({ client });
    };
    __setSegments(["(tabs)", "lesson", "[id]"]);
    render();
    render(); // same route (another lesson): skipped
    __setSegments(["(tabs)", "profile"]);
    render();
    expect(screen.mock.calls).toEqual([["/lesson/[id]"], ["/profile"]]);
  });
});
