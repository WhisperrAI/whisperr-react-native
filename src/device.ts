/**
 * Environment-derived defaults for the reserved identify trait keys
 * (whisperr-spec SPEC.md → "Reserved trait keys"): `timezone` (IANA name) and
 * `locale` (BCP 47). The engine evaluates quiet hours / send timing in
 * `timezone` and picks the message language from `locale`.
 *
 * Sources, in order: Hermes/JSC `Intl` (modern React Native ships
 * `Intl.DateTimeFormat().resolvedOptions()` with the device zone + locale), then
 * React Native's `I18nManager` locale identifier (normalized to BCP 47) for the
 * locale. A value the runtime cannot provide is omitted — never guessed.
 */
import { platformLocaleIdentifier } from "./lifecycle.js";

export function deviceTraits(): Record<string, string> {
  const out: Record<string, string> = {};
  const resolved = intlResolvedOptions();
  const timezone = nonEmpty(resolved?.timeZone);
  if (timezone) out.timezone = timezone;
  const locale = languageTag(resolved?.locale) ?? normalizeLocaleTag(platformLocaleIdentifier());
  if (locale) out.locale = locale;
  return out;
}

function intlResolvedOptions(): { timeZone?: string; locale?: string } | undefined {
  try {
    if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return undefined;
    return Intl.DateTimeFormat().resolvedOptions();
  } catch {
    return undefined; // Intl present but unusable (no ICU data) — omit rather than guess
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An Intl-resolved locale is already BCP 47; "und" means the engine has no idea. */
function languageTag(value: unknown): string | undefined {
  const tag = nonEmpty(value);
  return tag && tag.toLowerCase() !== "und" ? tag : undefined;
}

/**
 * Normalizes a platform locale identifier to a BCP 47 tag:
 *   "de_DE" → "de-DE", "zh_CN_#Hans" → "zh-Hans-CN" (Java Locale.toString()),
 *   "en_US@calendar=gregorian" → "en-US" (Cocoa keywords), "en" → "en".
 * Returns undefined for anything without a plausible language subtag.
 */
export function normalizeLocaleTag(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const withoutKeywords = raw.split("@")[0] ?? "";
  // Java appends script + extensions after "#": "zh_CN_#Hans", "de_DE_#u-co-phonebk".
  const [base = "", extra = ""] = withoutKeywords.split("#");
  const parts = base.split(/[_-]/).filter((p) => p.length > 0);
  const language = parts[0];
  if (!language || !/^[A-Za-z]{2,8}$/.test(language) || language.toLowerCase() === "und") return undefined;
  const script = extra.split(/[_-]/).find((p) => /^[A-Za-z]{4}$/.test(p));
  return [language, ...(script ? [script] : []), ...parts.slice(1)].join("-");
}
