import type { Currency } from "@/domain/money";
import { formatLocalTime } from "@/domain/timezone";

/**
 * What the setup screen fills itself in with, so that a studio can be created
 * by answering the two questions only its owner knows — what it is called and
 * where it is.
 *
 * Everything in this file is a default the owner overwrites, never a fact
 * invented behind their back: the screen shows every value it is about to save,
 * and each one is editable there and afterwards in its own section.
 */

/**
 * The week a studio starts with, and the one the rota form arrives pre-filled
 * with.
 *
 * Five days rather than seven and 08:00–16:00 rather than anything cleverer:
 * the point is not to guess a studio's hours but to spare the first-time owner
 * fourteen inputs before they have seen a single slot. These are the hours
 * break-even is computed from and the hours clients are shown free slots in,
 * and registration now writes them without asking — so «График» is where they
 * are read and corrected, and it shows exactly what was written.
 *
 * Two shapes of one week. `schedule_rule` stores minutes from midnight and a
 * rota form shows `HH:MM`, and both are wanted by callers here — registration
 * and `POST /api/v1/specialists` write rows, the setup and booking screens fill
 * in fields. The minutes are the source and the clock strings are derived from
 * them, so a default week cannot put somebody on the rota at an hour no screen
 * ever offered.
 */
const START_MINUTE = 8 * 60;
const END_MINUTE = 16 * 60;

export const DEFAULT_WORKWEEK = {
  weekdays: [1, 2, 3, 4, 5] as const,
  start: formatLocalTime(START_MINUTE),
  end: formatLocalTime(END_MINUTE),
  startMinute: START_MINUTE,
  endMinute: END_MINUTE,
};

/**
 * The share of a service's price the person doing the work is paid.
 *
 * Forty per cent is the middle of what the pilot studios pay, and it is the one
 * figure here that is a genuine guess rather than a convention — which is why
 * the setup screen puts it in a field with its own label rather than applying
 * it silently. Without any rule at all a visit cannot be closed
 * (MISSING_COMMISSION_RULE) and no service has a margin, so a wrong-but-visible
 * rate is worth more than an empty one: it produces a number the owner can
 * disagree with.
 */
export const DEFAULT_COMMISSION_PERCENT = 40;

/** The zones whose money is the rouble. Membership, not a prefix: `Asia/` holds most of the world. */
const ROUBLE_ZONES = new Set([
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Kirov",
  "Europe/Volgograd",
  "Europe/Astrakhan",
  "Europe/Saratov",
  "Europe/Ulyanovsk",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Barnaul",
  "Asia/Tomsk",
  "Asia/Novokuznetsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Chita",
  "Asia/Yakutsk",
  "Asia/Khandyga",
  "Asia/Vladivostok",
  "Asia/Ust-Nera",
  "Asia/Magadan",
  "Asia/Sakhalin",
  "Asia/Srednekolymsk",
  "Asia/Kamchatka",
  "Asia/Anadyr",
]);

/** Moldova, where the pilot is, and the one zone that is not a guess at all. */
const LEU_ZONES = new Set(["Europe/Chisinau", "Europe/Tiraspol"]);

/**
 * Which of the three currencies the books most likely open in, read from the
 * browser's own zone.
 *
 * The picker used to start on MDL for everybody, which is right for the pilot
 * and wrong for the first studio outside it — and wrong in the expensive
 * direction, because nothing already recorded is converted when the currency is
 * changed later (`components/organization-settings.tsx` says so out loud).
 *
 * Moldova keeps the leu, Russia the rouble, the rest of Europe is offered the
 * euro, and anything unrecognised falls back to the pilot's own currency rather
 * than to a fourth answer the schema does not have.
 */
export function currencyForTimezone(timezone: string | null | undefined): Currency {
  if (!timezone) return "MDL";
  if (LEU_ZONES.has(timezone)) return "MDL";
  if (ROUBLE_ZONES.has(timezone)) return "RUB";
  if (timezone.startsWith("Europe/")) return "EUR";
  return "MDL";
}

/**
 * The one service a studio is registered with, so that its first screen has
 * something to cost.
 *
 * A nail studio sells a manicure; the price is a placeholder and is meant to be
 * wrong — what it buys is a workspace that answers «сколько это приносит» on
 * the first screen instead of asking for a catalogue first. «Услуги» is two
 * clicks away and is where the real prices go in.
 *
 * Deliberately one row rather than the three the form used to pre-tick: three
 * wrong prices are three things to correct, and the point of the row is to
 * demonstrate the calculation, not to be the catalogue.
 */
export const DEFAULT_SERVICE = { key: "manicure", priceMinor: 20_000 };
