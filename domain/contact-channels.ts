import { contactChannels, type ContactChannel } from "@/domain/contact-links";

/**
 * What the studio knows about reaching a client, and how it came to know it.
 *
 * The product cannot ask WhatsApp whether a number is registered — that check
 * left the Cloud API — and Telegram answers only to a user account, which no
 * product should be running. So this is not detection. It is what somebody
 * said: the client, choosing on the booking page how they would like to be
 * reached, or the studio, writing down what they found out by writing.
 *
 * Three states rather than two, and the third is the point. «Неизвестно» is not
 * «нет»: a channel nobody has spoken about must not be drawn as one the client
 * does not have, or the desk stops trying a messenger that would have worked.
 * Absence from this record is that third state.
 */
export type ContactChannelState = "yes" | "no";

/**
 * The channels worth asking a client about: the messengers, and nothing else.
 *
 * The call is not among them and cannot be. The number is a required field on
 * the form above, so a call and an SMS are possible by construction — a
 * checkbox for them would ask somebody to confirm a fact they have already
 * stated, and a field with one possible answer is not a field.
 *
 * It also means «nothing ticked» is an answer rather than an error: no
 * messengers, so write to them the way the number allows. The set of links a
 * studio is offered is still all four — see `contactChannels` — because
 * reaching a client and asking them a question are different lists.
 */
export const messengerChannels: readonly ContactChannel[] = ["whatsapp", "telegram", "viber"];

/** Who said so. A later claim from the same source replaces the earlier one. */
export type ContactChannelSource = "client" | "studio";

export type ContactChannelMark = Readonly<{
  state: ContactChannelState;
  source: ContactChannelSource;
  /** ISO 8601 — when it was last said, so a stale «нет» can be read as stale. */
  at: string;
}>;

export type ContactChannelMarks = Readonly<Partial<Record<ContactChannel, ContactChannelMark>>>;

const STATES: readonly ContactChannelState[] = ["yes", "no"];
const SOURCES: readonly ContactChannelSource[] = ["client", "studio"];

export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === "string" && (contactChannels as readonly string[]).includes(value);
}

/**
 * The column read back into marks, dropping anything unrecognised.
 *
 * `jsonb` holds whatever was written into it, including shapes from a build
 * that no longer exists. A mark that does not parse is not a mark, and the
 * channel it was about falls back to «неизвестно», which is the safe end of
 * this scale.
 */
export function parseContactChannels(raw: unknown): ContactChannelMarks {
  if (typeof raw !== "object" || raw === null) return {};

  const marks: Record<string, ContactChannelMark> = {};
  for (const [channel, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isContactChannel(channel)) continue;
    if (typeof value !== "object" || value === null) continue;

    const mark = value as Record<string, unknown>;
    const state = mark.state;
    const source = mark.source;
    const at = mark.at;

    if (typeof state !== "string" || !STATES.includes(state as ContactChannelState)) continue;
    if (typeof source !== "string" || !SOURCES.includes(source as ContactChannelSource)) continue;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;

    marks[channel] = {
      state: state as ContactChannelState,
      source: source as ContactChannelSource,
      at,
    };
  }

  return marks;
}

/**
 * What a client ticking boxes on the booking page is allowed to change.
 *
 * Additive, and deliberately so. A returning client who books again without
 * touching the choices has not told anybody their WhatsApp is gone — they have
 * said nothing — and reading silence as a denial would empty the record of
 * every client who books twice. So a tick adds, and nothing here ever removes.
 *
 * Taking a channel away is the studio's to do, on the screen where a person who
 * wrote and got no answer is standing. That is the one place the knowledge
 * actually exists.
 *
 * The studio's own mark is not overwritten either: they wrote it after trying,
 * and a form has not learned anything since.
 */
export function withClientChoice(
  existing: ContactChannelMarks,
  chosen: readonly ContactChannel[],
  now: Date,
): ContactChannelMarks {
  const next: Record<string, ContactChannelMark> = { ...existing };

  for (const channel of chosen) {
    if (next[channel]?.source === "studio") continue;
    next[channel] = { state: "yes", source: "client", at: now.toISOString() };
  }

  return next;
}

/** What the studio writes down after trying, which may be a «нет». */
export function withStudioMark(
  existing: ContactChannelMarks,
  channel: ContactChannel,
  state: ContactChannelState,
  now: Date,
): ContactChannelMarks {
  return { ...existing, [channel]: { state, source: "studio", at: now.toISOString() } };
}

/** Empty means «nobody has said», which every screen has to show as its own state. */
export function isEmptyChannelMarks(marks: ContactChannelMarks): boolean {
  return Object.keys(marks).length === 0;
}

/**
 * The ways worth putting in front of a master, which is no longer all of them.
 *
 * The row used to be every address a phone number can be turned into, with the
 * marks changing only how each one looked — a «нет» drawn struck through and
 * still pressable, on the argument that it was somebody's note from last week
 * rather than a fact about today. That argument is about the note. The cost is
 * about the row: four marks, of which two are application schemes that do
 * nothing at all where the app is not installed, read by somebody mid-
 * conversation with a client who is late.
 *
 * So presence carries the meaning now. A messenger is in the row because
 * somebody said it reaches this client, and who said so does not enter into it:
 * the studio's mark comes from having written and got an answer, which is
 * better evidence than a tick on a form, not worse.
 *
 * The call is never filtered out. It is the one channel that cannot be ticked —
 * the number is required to book at all, so a call and an SMS are possible by
 * construction — and the only one that needs no application installed. Nothing
 * writes a mark against it today, and if something ever did, it would still not
 * take the call away.
 *
 * Which makes «nobody has said anything» resolve to the call alone. That is the
 * studio's decision rather than this function's inference: a client typed in at
 * the desk has answered no questions, and guessing on their behalf is the habit
 * this row is being narrowed to break.
 */
export function offeredChannels(marks: ContactChannelMarks): readonly ContactChannel[] {
  return contactChannels.filter(
    (channel) => channel === "call" || marks[channel]?.state === "yes",
  );
}
