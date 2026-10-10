/** Handles are how family members find each other: exact match only, no browsing. */

export const HANDLE_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

const RESERVED = new Set([
  "admin",
  "agora",
  "gullak",
  "help",
  "mera",
  "monad",
  "official",
  "root",
  "security",
  "support",
  "system",
  "team",
]);

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** Returns a human-readable problem with the handle, or null when it is acceptable. */
export function handleProblem(handle: string): string | null {
  if (handle.length < 3) return "Use at least 3 characters.";
  if (handle.length > 20) return "Use at most 20 characters.";
  if (!HANDLE_PATTERN.test(handle)) return "Start with a letter; use letters, numbers, or _.";
  if (RESERVED.has(handle)) return "That handle is reserved.";
  return null;
}

export const DISPLAY_NAME_MAX = 40;

export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
