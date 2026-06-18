/**
 * Send-window policy — the 9am–9pm IST quiet-hours rule (DPDP/TRAI), SERVER-side.
 *
 * Commercial communication is permitted only inside [09:00, 21:00) Asia/Kolkata.
 * Outside the window the send is NOT dropped and NEVER sent late — it is QUEUED to
 * pending_window and released at the next 09:00 IST (see pending-window.handler).
 *
 * IST is a fixed UTC+05:30 offset with NO daylight-saving transitions, so the window
 * is computed against a fixed offset rather than a tz database — deterministic and
 * dependency-free (the cost paradigm: pure deterministic logic).
 *
 * FAIL-CLOSED: an unparseable / NaN clock yields { inWindow: false, releaseAfter: null }
 * which the engine maps to `block: unknown` — never an out-of-window send.
 */

/** IST offset in minutes (UTC+05:30). India observes no DST. */
const IST_OFFSET_MIN = 5 * 60 + 30;
const MS_PER_MIN = 60_000;
const WINDOW_OPEN_HOUR = 9; // 09:00 IST inclusive
const WINDOW_CLOSE_HOUR = 21; // 21:00 IST exclusive

export interface WindowDecision {
  inWindow: boolean;
  /**
   * When out of window: the ISO-8601 UTC instant of the next 09:00 IST.
   * Null when in window, or when the clock is unparseable (fail-closed).
   */
  releaseAfter: string | null;
}

/**
 * Convert a UTC instant to the IST wall-clock fields (year/month/day/hour/...).
 * Returns null when `now` is not a finite instant (fail-closed signal).
 */
function istWallClock(now: Date): {
  hour: number;
  minute: number;
  istMs: number;
} | null {
  const utcMs = now.getTime();
  if (!Number.isFinite(utcMs)) return null;
  const istMs = utcMs + IST_OFFSET_MIN * MS_PER_MIN;
  const ist = new Date(istMs);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    istMs,
  };
}

/**
 * Compute the UTC instant of the next 09:00 IST relative to `now`.
 * If it is currently before 09:00 IST on the same IST day, that day's 09:00 IST;
 * otherwise tomorrow's 09:00 IST.
 */
function nextNineAmIstUtc(now: Date): string | null {
  const wall = istWallClock(now);
  if (!wall) return null;

  const ist = new Date(wall.istMs);
  // Build 09:00 IST on the current IST calendar day (as a UTC-fields Date on the
  // shifted clock), then shift back to real UTC by subtracting the IST offset.
  const yyyy = ist.getUTCFullYear();
  const mm = ist.getUTCMonth();
  const dd = ist.getUTCDate();

  let openIstMs = Date.UTC(yyyy, mm, dd, WINDOW_OPEN_HOUR, 0, 0, 0);
  // If we are already at/after 09:00 IST today, the next open is tomorrow.
  if (wall.istMs >= openIstMs) {
    openIstMs = Date.UTC(yyyy, mm, dd + 1, WINDOW_OPEN_HOUR, 0, 0, 0);
  }
  // openIstMs is the open instant expressed on the IST-shifted clock; convert to UTC.
  const openUtcMs = openIstMs - IST_OFFSET_MIN * MS_PER_MIN;
  return new Date(openUtcMs).toISOString();
}

/**
 * Evaluate the 9am–9pm IST send window for a given instant.
 * @param now defaults to the current instant; injectable for deterministic tests.
 */
export function evaluateSendWindow(now: Date = new Date()): WindowDecision {
  const wall = istWallClock(now);
  if (!wall) {
    // Fail-closed: unknown/unparseable time → not in window, no release (→ block).
    return { inWindow: false, releaseAfter: null };
  }
  const inWindow =
    wall.hour >= WINDOW_OPEN_HOUR && wall.hour < WINDOW_CLOSE_HOUR;
  if (inWindow) {
    return { inWindow: true, releaseAfter: null };
  }
  return { inWindow: false, releaseAfter: nextNineAmIstUtc(now) };
}
