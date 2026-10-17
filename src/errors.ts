/**
 * Automatic error capture: React Native's global JS error handler
 * (`ErrorUtils`) and, in release builds on Hermes, unhandled promise
 * rejections. Every client with `captureErrors` on is a sink. The handler
 * always calls the handler that was installed before it (React Native's red
 * box, Sentry, Crashlytics), even when a sink throws.
 */
import { isDevBuild } from "./runtime.js";

export interface ErrorSink {
  /** An uncaught error (`fatal`: the runtime is about to terminate). */
  captureUncaught(error: unknown, fatal: boolean): void;
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalHandler | undefined;
  setGlobalHandler?: (handler: GlobalHandler) => void;
}

const sinks = new Set<ErrorSink>();
/** The handler this module installed last; a different current handler means someone replaced it. */
let installed: GlobalHandler | null = null;
let rejectionTracking = false;

function dispatch(error: unknown, fatal: boolean): void {
  for (const sink of [...sinks]) {
    try {
      sink.captureUncaught(error, fatal);
    } catch {
      /* the SDK must never make an error worse */
    }
  }
}

/** Starts sending uncaught errors to `sink`. Returns a stop function. */
export function addErrorSink(sink: ErrorSink): () => void {
  sinks.add(sink);
  installGlobalHandler();
  enableRejectionTracking();
  return () => void sinks.delete(sink);
}

function installGlobalHandler(): void {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!utils || typeof utils.setGlobalHandler !== "function") return;
  let previous: GlobalHandler | undefined;
  try {
    previous = utils.getGlobalHandler?.();
  } catch {
    previous = undefined;
  }
  if (installed && previous === installed) return; // ours is still the current handler
  const handler: GlobalHandler = (error, isFatal) => {
    try {
      dispatch(error, isFatal === true);
    } finally {
      previous?.(error, isFatal);
    }
  };
  try {
    utils.setGlobalHandler(handler);
    installed = handler;
  } catch {
    /* exotic runtime: no automatic capture */
  }
}

/**
 * Hermes reports unhandled rejections only to a tracker someone enabled.
 * React Native enables its own in development (LogBox), so this one runs in
 * release builds only, and once per JS context.
 */
function enableRejectionTracking(): void {
  if (rejectionTracking || isDevBuild()) return;
  const hermes = (
    globalThis as {
      HermesInternal?: {
        enablePromiseRejectionTracker?: (options: {
          allRejections: boolean;
          onUnhandled: (id: number, rejection: unknown) => void;
        }) => void;
      };
    }
  ).HermesInternal;
  if (typeof hermes?.enablePromiseRejectionTracker !== "function") return;
  try {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, rejection) => dispatch(rejection, false),
    });
    rejectionTracking = true;
  } catch {
    /* not available in this Hermes build */
  }
}

/** Test hook: forget the installed handler, the rejection tracker and every sink. */
export function __resetErrorCapture(): void {
  sinks.clear();
  installed = null;
  rejectionTracking = false;
}
