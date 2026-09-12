/**
 * What a client's own browser remembers about the appointment they booked here,
 * so that the studio's booking page can tell them how it is going.
 *
 * `/book/[slug]` is anonymous by design — no account, no session — and the only
 * thing that can name one booking is the manage token, which the client already
 * has in their SMS or email. A copy of it kept here is what lets a returning
 * visitor be answered instead of being handed the same empty form: the page
 * spends that token on the status endpoint and shows what comes back.
 *
 * Nothing stored here is authoritative. Status and version are re-read from the
 * API on every visit; this record exists to know *which* booking to ask about,
 * and to have something on screen while the answer is in flight. It holds only
 * what the client themselves chose — the time of their visit — and never their
 * name, number or address: a phone can be shared, and the page it unlocks is
 * one tap further on, behind the token.
 */

/** Mirrors the `booking_status` enum. Kept here so a client bundle needs no schema. */
export type BookingStatus =
  | "pending_confirmation"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

const STATUSES: readonly BookingStatus[] = [
  "pending_confirmation",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
];

export type RememberedBooking = Readonly<{
  /** The manage token, spent on the public status endpoint and on the link out. */
  token: string;
  /** When the visit starts, as the client saw it. Refreshed when `version` moves. */
  startsAt: string;
  /**
   * The zone of the location that visit was booked at, stored rather than taken
   * from whichever location the form happens to be showing: a studio with two
   * addresses in two zones would otherwise print the hour of the wrong one.
   */
  timezone: string;
  status: BookingStatus;
  /**
   * The booking's optimistic-lock counter. It is the only thing that can tell
   * this record that the appointment was moved underneath it: the status
   * endpoint answers with a status and a version and nothing else, so an
   * unchanged status over a changed version is exactly the reschedule case.
   */
  version: number;
  /** When this browser first saw the current status, which dates the news below. */
  statusSeenAt: string;
}>;

const KEY_PREFIX = "npo.booking.";

/**
 * How long an appointment stays on the page.
 *
 * Twelve hours past the start, because a visit that has just happened is still
 * worth a line — «спасибо, что были у нас» on the evening of the same day reads
 * as attention, and the next morning it reads as a page that has not noticed
 * time passing.
 *
 * A cancellation is the exception: it is the one state the client may not have
 * heard about, since the message announcing it is the message most likely to
 * have gone missing. It stays for two days from the moment this browser first
 * saw it — but not past a week from the appointment itself, after which nobody
 * is still waiting for that visit and the notice is archaeology.
 */
const PAST_VISIT_GRACE_MS = 12 * 60 * 60 * 1_000;
const SETTLED_NOTICE_MS = 48 * 60 * 60 * 1_000;
const SETTLED_NOTICE_CAP_MS = 7 * 24 * 60 * 60 * 1_000;

export function storageKey(slug: string) {
  return `${KEY_PREFIX}${slug}`;
}

/** The two statuses that still occupy the specialist, section 7.5's wording. */
export function isActiveStatus(status: BookingStatus) {
  return status === "pending_confirmation" || status === "confirmed";
}

/** Whether an API field is one of the five, before it is written down as one. */
export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === "string" && STATUSES.includes(value as BookingStatus);
}

/**
 * Whether this record is still worth a strip on the page, or has become noise.
 *
 * Pure, and separate from the storage below, because it is the part with the
 * arithmetic in it and it should be readable — and testable — without a browser.
 */
export function isWorthShowing(entry: RememberedBooking, now: Date): boolean {
  const startsAt = Date.parse(entry.startsAt);
  const moment = now.getTime();

  if (entry.status === "cancelled" || entry.status === "no_show") {
    const seenAt = Date.parse(entry.statusSeenAt);
    return moment < seenAt + SETTLED_NOTICE_MS && moment < startsAt + SETTLED_NOTICE_CAP_MS;
  }

  return moment < startsAt + PAST_VISIT_GRACE_MS;
}

/**
 * The same record after the API has answered.
 *
 * `statusSeenAt` moves only when the status itself does, because it dates the
 * news rather than the check: a client who opens the page every hour of the day
 * their request was refused would otherwise keep resetting the two days that
 * notice is meant to last, and the strip would never go away.
 */
export function withStatus(
  entry: RememberedBooking,
  next: Readonly<{ status: BookingStatus; version: number }>,
  now: Date,
): RememberedBooking {
  if (next.status === entry.status && next.version === entry.version) return entry;
  return {
    ...entry,
    status: next.status,
    version: next.version,
    statusSeenAt: next.status === entry.status ? entry.statusSeenAt : now.toISOString(),
  };
}

/**
 * Whether the time this record carries has to be fetched again.
 *
 * The status endpoint answers with a status and a version, so a moved version
 * says only that *something* changed. Usually that something is the studio
 * answering: one bump, and a status that is no longer the one we had. Anything
 * else — a version that moved while the status stayed put, or that moved by
 * more than one — can have carried the appointment to another hour with it, and
 * the hour on this page is then the old one.
 *
 * Deciding it here rather than at the call site keeps the common case cheap:
 * the confirmation every waiting client is refreshing for costs one request,
 * and only a genuine reschedule pays for the second.
 */
export function needsFreshDetails(
  stored: RememberedBooking,
  next: Readonly<{ status: BookingStatus; version: number }>,
): boolean {
  if (next.version === stored.version) return false;
  return !(next.status !== stored.status && next.version === stored.version + 1);
}

/**
 * A stored string read back into a record, or null for anything unrecognised.
 *
 * Every field is checked rather than trusted. This is `localStorage`: it
 * survives deployments, so a shape from three versions ago can still be sitting
 * in it, and it is writable by anything else served from this origin. A record
 * that does not parse is simply not shown — the page falls back to the form,
 * which is what a first-time visitor sees anyway.
 */
export function parseRemembered(raw: string | null): RememberedBooking | null {
  if (!raw) return null;

  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    const entry = data as Record<string, unknown>;

    const token = entry.token;
    const startsAt = entry.startsAt;
    const timezone = entry.timezone;
    const status = entry.status;
    const version = entry.version;
    const statusSeenAt = entry.statusSeenAt;

    if (typeof token !== "string" || !token) return null;
    if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) return null;
    if (typeof timezone !== "string" || !timezone) return null;
    if (!isBookingStatus(status)) return null;
    if (typeof version !== "number" || !Number.isFinite(version)) return null;
    if (typeof statusSeenAt !== "string" || Number.isNaN(Date.parse(statusSeenAt))) return null;

    return { token, startsAt, timezone, status, version, statusSeenAt };
  } catch {
    return null;
  }
}

/*
 * The calls that touch storage, each one wrapped.
 *
 * `localStorage` is not merely empty in a private window or with site data
 * blocked — the accessor itself throws — and this page must render for a
 * stranger on any browser they happen to have. A memory that cannot be read is
 * treated as a memory that is not there.
 */

function readRaw(slug: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}

export function rememberBooking(slug: string, entry: RememberedBooking): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(storageKey(slug), JSON.stringify(entry));
    } catch {
      /* A booking that cannot be remembered is still a booking that was made. */
    }
  }
  announce();
}

export function forgetBooking(slug: string): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(storageKey(slug));
    } catch {
      /* Nothing to undo: the strip is already gone from the screen. */
    }
  }
  announce();
}

/*
 * The store the page subscribes to.
 *
 * Storage is an external system, and the page reads it the way React asks
 * external systems to be read rather than by setting state from an effect on
 * mount. Two things that requires. The snapshot has to return the *same* object
 * until the stored text actually changes, or every render produces a new record
 * and React re-renders on itself forever — hence the cache below, keyed by the
 * text it was parsed from. And the subscription has to be registered on every
 * mount, with no "already subscribed" guard: under Strict Mode the second mount
 * would get none, and the page would stop noticing its own writes.
 */
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; entry: RememberedBooking | null }>();

function announce() {
  for (const listener of listeners) listener();
}

export function subscribeRemembered(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function rememberedSnapshot(slug: string): RememberedBooking | null {
  const raw = readRaw(slug);
  const cached = snapshots.get(slug);
  if (cached && cached.raw === raw) return cached.entry;

  const entry = parseRemembered(raw);
  snapshots.set(slug, { raw, entry });
  return entry;
}

/** The server has no browser to ask, so it renders the page without a strip. */
export function noRememberedBooking(): RememberedBooking | null {
  return null;
}
