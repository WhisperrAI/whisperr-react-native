import { WhisperrClient } from "./client.js";
import type { WhisperrApi, WhisperrOptions } from "./types.js";

let singleton: WhisperrClient | null = null;

/**
 * Whisperr.init() creates the singleton client (idempotent). Construct
 * WhisperrClient directly when you want explicit lifetimes or more than one
 * client.
 */
export const Whisperr = {
  init(options: WhisperrOptions): WhisperrApi {
    if (!singleton) {
      singleton = new WhisperrClient(options);
    }
    return singleton;
  },
  /** The current client, or null if init() hasn't run. */
  get instance(): WhisperrApi | null {
    return singleton;
  },
};
