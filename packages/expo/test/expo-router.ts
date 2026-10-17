/** Minimal expo-router fake (aliased in vitest.config.ts). */
let segments: string[] = [];

export function useSegments(): string[] {
  return segments;
}

/** Test hook: the segments useSegments() returns. */
export function __setSegments(next: string[]): void {
  segments = next;
}
