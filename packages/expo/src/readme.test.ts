import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// npm renders the package README outside the repository, so a relative link
// such as `../../README.md` is broken on npmjs.com.
const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../README.md"), "utf8");

describe("README on npm", () => {
  it("links only to absolute URLs or anchors on the same page", () => {
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !/^(https:\/\/|#)/.test(t))).toEqual([]);
  });

  it("shows identify with an email and the consent flag, and track", () => {
    expect(readme).toContain("emailOptedIn");
    expect(readme).toMatch(/whisperr\.identify\(user\.id, \{[\s\S]*email: user\.email,/);
    expect(readme).toContain("whisperr.track(");
  });
});
