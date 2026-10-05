import { extractPushOpened } from "./autocapture.js";
import { WhisperrClient } from "./client.js";
import { Whisperr } from "./singleton.js";
import type { WhisperrPushOpen } from "./types.js";

export * from "./types.js";
export { WhisperrClient, Whisperr };
export { MemoryStorage } from "./storage.js";
export { isExpoPushToken } from "./push.js";
export {
  WhisperrProvider,
  useWhisperr,
  useWhisperrClient,
  useWhisperrPushToken,
  type WhisperrProviderProps,
} from "./react.js";

/**
 * Reads `whisperr_message_id` and the deep link from a push payload (the data
 * map, a Firebase RemoteMessage, an expo-notifications response, or a
 * OneSignal notification) without sending anything. Null for a push that did
 * not come from Whisperr.
 */
export function parseWhisperrPush(data: unknown): WhisperrPushOpen | null {
  return extractPushOpened(data) ?? null;
}

export default Whisperr;
