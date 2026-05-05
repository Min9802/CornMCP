/**
 * Date utilities for parsing timestamps from corn-api.
 *
 * SQLite `datetime('now')` returns UTC strings in format "YYYY-MM-DD HH:MM:SS"
 * WITHOUT a timezone suffix. JavaScript's `new Date(str)` parses such strings as
 * LOCAL time in V8/Chrome, causing timestamps to be offset by the user's timezone
 * (e.g. 7h off for UTC+7 users in Vietnam).
 *
 * Always use `parseUTC()` when reading timestamps coming from the API.
 */

/**
 * Parse a timestamp string that may or may not include a timezone indicator.
 *
 * - Handles SQLite `datetime('now')` output: `"2026-05-05 07:28:00"` → treated as UTC.
 * - Handles ISO 8601 with `Z` or offset: `"2026-05-05T07:28:00Z"` → parsed as-is.
 * - Handles pre-existing `T` separator without `Z`: appends `Z`.
 *
 * Returns `new Date(NaN)` for empty/falsy input to keep downstream `.getTime()` safe.
 */
export function parseUTC(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date(NaN)

  // Already has explicit timezone (Z or +/- offset after T) → parse as-is.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(dateStr)) {
    return new Date(dateStr)
  }

  // Normalize "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')
  return new Date(normalized + 'Z')
}

/** Relative time string like "just now", "5m ago", "2h ago", "3d ago". */
export function timeAgo(dateStr: string | null | undefined): string {
  const d = parseUTC(dateStr)
  const ms = d.getTime()
  if (Number.isNaN(ms)) return '—'

  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/** Date-only format in the user's local timezone, e.g. "5/5/2026". */
export function formatLocalDate(dateStr: string | null | undefined): string {
  const d = parseUTC(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString()
}

/** Full date + time in the user's local timezone, e.g. "5/5/2026, 2:28:00 PM". */
export function formatLocalDateTime(dateStr: string | null | undefined): string {
  const d = parseUTC(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}
