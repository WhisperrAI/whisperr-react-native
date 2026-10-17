/**
 * Tests drive time with fake Date: durations (foreground_ms) read the same
 * clock, so the SDK's monotonic clock follows Date here.
 */
import { __setMonotonicClock } from "../src/runtime.js";

__setMonotonicClock(() => Date.now());
