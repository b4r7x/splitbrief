const ORDINAL_DAY = /(\d{1,2})(?:st|nd|rd|th)/i;
const TRY_AGAIN_AT =
  /try again at ([a-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}\s?(?:am|pm)?)/i;
const TRY_AGAIN_AT_BARE_CLOCK = /try again at (\d{1,2}):(\d{2})\s?(am|pm)/i;
const TRY_AGAIN_IN_SECONDS = /try again in ([\d.]+)\s*s(?:econds?)?\b/i;
const TRY_AGAIN_IN_PARTS =
  /try again in (?:(\d+) days?)?\s*(?:(\d+) hours?)?\s*(?:(\d+) minutes?)?/i;
const RESETS_IN_COMPACT = /resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?![\w:])/i;
const RETRY_AFTER_SECONDS = /retry-after:\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds?)?)?)?(?![\w:])/i;
const RETRY_AFTER_HTTP_DATE =
  /retry-after:\s*([a-z]{3},\s*\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+gmt)/i;
const LIMIT_EPOCH = /limit reached\|(\d{10,13})\b/i;
const RESETS_AT =
  /resets (?:at )?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]* )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?:\s*\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\))?/i;

const WEEKDAYS: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function weekdayIndex(name: string): number | null {
  const index = WEEKDAYS.indexOf(name);
  return index === -1 ? null : index;
}

function readNumericPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const part = parts.find((candidate) => candidate.type === type);
  return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
}

function parseEpoch(text: string): Date | null {
  const match = LIMIT_EPOCH.exec(text);
  if (match?.[1] === undefined) return null;
  const raw = Number.parseInt(match[1], 10);
  return new Date(match[1].length >= 13 ? raw : raw * 1000);
}

function parseTryAgainAt(text: string): Date | null {
  const match = TRY_AGAIN_AT.exec(text);
  if (match?.[1] === undefined) return null;
  const parsed = new Date(match[1].replace(ORDINAL_DAY, '$1'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTryAgainAtBareClock(text: string, now: Date): Date | null {
  const match = TRY_AGAIN_AT_BARE_CLOCK.exec(text);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  let hour = Number.parseInt(match[1], 10) % 12;
  if (match[3].toLowerCase() === 'pm') hour += 12;
  const minute = Number.parseInt(match[2], 10);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * The wall-clock instant `hour:minute` names inside an IANA zone, resolved by
 * measuring that zone's offset at a first guess and correcting once — enough
 * for every offset except the ambiguous hour of a DST fall-back, where the
 * later of the two readings wins. Returns null for a zone the runtime does
 * not know, so an unparseable suffix degrades to the local reading.
 */
function zoneOffsetMs(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const asUtc = Date.UTC(
      readNumericPart(parts, 'year'),
      readNumericPart(parts, 'month') - 1,
      readNumericPart(parts, 'day'),
      readNumericPart(parts, 'hour') % 24,
      readNumericPart(parts, 'minute'),
      readNumericPart(parts, 'second'),
    );
    return Number.isNaN(asUtc) ? null : asUtc - at.getTime();
  } catch {
    return null;
  }
}

function zonedDayParts(
  zone: string,
  at: Date,
): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const year = readNumericPart(parts, 'year');
    const month = readNumericPart(parts, 'month');
    const day = readNumericPart(parts, 'day');
    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

function nextZonedClock(
  zone: string,
  now: Date,
  hour: number,
  minute: number,
  dayOffset: number,
  wrapDays: number,
): Date | null {
  const today = zonedDayParts(zone, now);
  if (today === null) return null;
  const resolve = (offsetDays: number): Date | null => {
    const naive = Date.UTC(today.year, today.month - 1, today.day + offsetDays, hour, minute);
    const firstOffset = zoneOffsetMs(zone, new Date(naive));
    if (firstOffset === null) return null;
    const corrected = zoneOffsetMs(zone, new Date(naive - firstOffset));
    return new Date(naive - (corrected ?? firstOffset));
  };
  const candidate = resolve(dayOffset);
  if (candidate === null) return null;
  if (dayOffset === 0 && candidate.getTime() <= now.getTime()) return resolve(wrapDays);
  return candidate;
}

function parseRelative(text: string, now: Date): Date | null {
  const httpDate = RETRY_AFTER_HTTP_DATE.exec(text);
  if (httpDate?.[1] !== undefined) {
    const parsed = new Date(httpDate[1]);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const seconds = TRY_AGAIN_IN_SECONDS.exec(text) ?? RETRY_AFTER_SECONDS.exec(text);
  if (seconds?.[1] !== undefined) {
    return new Date(now.getTime() + Math.ceil(Number.parseFloat(seconds[1]) * 1000));
  }
  const compact = RESETS_IN_COMPACT.exec(text);
  if (compact && (compact[1] ?? compact[2] ?? compact[3]) !== undefined) {
    const hours = compact[1] === undefined ? 0 : Number.parseInt(compact[1], 10);
    const minutes = compact[2] === undefined ? 0 : Number.parseInt(compact[2], 10);
    const seconds = compact[3] === undefined ? 0 : Number.parseInt(compact[3], 10);
    return new Date(now.getTime() + ((hours * 60 + minutes) * 60 + seconds) * 1000);
  }
  const parts = TRY_AGAIN_IN_PARTS.exec(text);
  if (!parts || (parts[1] === undefined && parts[2] === undefined && parts[3] === undefined)) {
    return null;
  }
  const days = parts[1] === undefined ? 0 : Number.parseInt(parts[1], 10);
  const hours = parts[2] === undefined ? 0 : Number.parseInt(parts[2], 10);
  const minutes = parts[3] === undefined ? 0 : Number.parseInt(parts[3], 10);
  return new Date(now.getTime() + ((days * 24 + hours) * 60 + minutes) * 60_000);
}

function zonedWeekdayOffset(zone: string, now: Date, weekday: string | undefined): number | null {
  if (weekday === undefined) return 0;
  const target = weekdayIndex(weekday);
  if (target === null) return null;
  let current: string;
  try {
    current = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' })
      .format(now)
      .slice(0, 3)
      .toLowerCase();
  } catch {
    return null;
  }
  const index = weekdayIndex(current);
  if (index === null) return null;
  return (target - index + 7) % 7;
}

function parseResetsAt(text: string, now: Date): Date | null {
  const match = RESETS_AT.exec(text);
  if (match?.[2] === undefined || match[4] === undefined) return null;
  let hour = Number.parseInt(match[2], 10) % 12;
  if (match[4].toLowerCase() === 'pm') hour += 12;
  const minute = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const zone = match[5];
  const weekday = match[1]?.toLowerCase();
  if (zone !== undefined) {
    const daysAhead = zonedWeekdayOffset(zone, now, weekday);
    if (daysAhead !== null) {
      const zoned = nextZonedClock(
        zone,
        now,
        hour,
        minute,
        daysAhead,
        weekday === undefined ? 1 : 7,
      );
      if (zoned !== null) return zoned;
    }
  }
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (weekday !== undefined) {
    const target = weekdayIndex(weekday);
    if (target === null) return null;
    let ahead = (target - candidate.getDay() + 7) % 7;
    if (ahead === 0 && candidate.getTime() <= now.getTime()) ahead = 7;
    candidate.setDate(candidate.getDate() + ahead);
  } else if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Extract the reset moment a limit diagnostic advertises, when it does:
 * codex "try again at <date>" / "try again at 3:27 PM" / "try again in N days
 * N hours N minutes",
 * Claude Code "resets 3:45pm" / "resets Mon 12:00am" / "resets 4pm
 * (Europe/Warsaw)" — a named IANA zone is read in that zone, not locally —
 * and the legacy "|<epoch>" suffix, Groq "try again in 7.66s", antigravity
 * "Resets in 2h6m30s", and an HTTP Retry-After in either of its wire forms, "retry-after: 120" (delay
 * seconds) or "retry-after: Wed, 21 Oct 2026 07:28:00 GMT". Returns null
 * when the message carries no parseable reset — classification never
 * depends on this. A relative reset is read against `Date.now()`, the one
 * clock every surface that spells the reset reads.
 */
export function parseUsageLimitReset(
  message: string,
  now: Date = new Date(Date.now()),
): Date | null {
  return (
    parseEpoch(message) ??
    parseTryAgainAt(message) ??
    parseTryAgainAtBareClock(message, now) ??
    parseRelative(message, now) ??
    parseResetsAt(message, now)
  );
}
