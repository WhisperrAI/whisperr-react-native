/**
 * Where the conformance fixtures come from (whisperr-spec `conformance/`).
 *
 * Local: WHISPERR_SPEC_PATH points at wire.json; the other fixtures sit next
 * to it (CI checks the spec repo out at SPEC_REF). Otherwise the tests fetch
 * them from GitHub at SPEC_REF.
 *
 * SPEC_REF is the contract v2 branch until whisperr-spec merges it; then it
 * flips back to "main" (here and in .github/workflows/ci.yml + publish.yml).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SPEC_REF = "feat/contract-v2-sdk";

const realFetch = globalThis.fetch.bind(globalThis);

/** Loads `conformance/<file>`; `override` names an env var with a direct path. */
export async function loadFixture<T>(file: string, override?: string): Promise<T> {
  const direct = override ? process.env[override] : undefined;
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local = direct ?? (wire ? join(dirname(wire), file) : undefined);
  if (local) return JSON.parse(readFileSync(local, "utf8")) as T;
  const url = `https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/${SPEC_REF}/conformance/${file}`;
  const res = await realFetch(url);
  if (!res.ok) throw new Error(`fetch ${file}: ${res.status}`);
  return (await res.json()) as T;
}

/** "push.json:case_name" entries a contract v2 section supersedes, for one fixture file. */
export function supersededIn(file: string, sections: ReadonlyArray<{ supersedes?: string[] }>): Set<string> {
  const out = new Set<string>();
  for (const s of sections) {
    for (const entry of s.supersedes ?? []) {
      const [f, name] = entry.split(":");
      if (f === file && name) out.add(name);
    }
  }
  return out;
}
