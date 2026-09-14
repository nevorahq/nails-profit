import { describe, expect, it } from "vitest";

import {
  isEmptyChannelMarks,
  offeredChannels,
  parseContactChannels,
  withClientChoice,
  withStudioMark,
  type ContactChannelMarks,
} from "@/domain/contact-channels";

const now = new Date("2026-09-14T09:00:00.000Z");
const later = new Date("2026-09-20T09:00:00.000Z");

describe("what a client says on the booking page", () => {
  it("records the channels they ticked, and nothing else", () => {
    const marks = withClientChoice({}, ["whatsapp", "viber"], now);

    expect(marks.whatsapp).toEqual({ state: "yes", source: "client", at: now.toISOString() });
    expect(marks.viber?.state).toBe("yes");
    // Telegram was not ticked, which is not the same as not having it.
    expect(marks.telegram).toBeUndefined();
  });

  /**
   * The rule this exists for. A client books a second time and taps nothing —
   * they have said nothing, not «у меня больше нет WhatsApp» — and reading that
   * silence as a denial would empty the record of everyone who returns.
   */
  it("never takes a channel away by being silent about it", () => {
    const first = withClientChoice({}, ["whatsapp"], now);
    const second = withClientChoice(first, [], later);

    expect(second.whatsapp?.state).toBe("yes");
  });

  it("adds to what was already known", () => {
    const first = withClientChoice({}, ["whatsapp"], now);
    const second = withClientChoice(first, ["telegram"], later);

    expect(Object.keys(second).sort()).toEqual(["telegram", "whatsapp"]);
  });

  /**
   * The studio wrote and got no answer; a form has learned nothing since. What
   * a person found out by trying outranks a tick on a page.
   */
  it("does not overwrite what the studio found out by trying", () => {
    const studio = withStudioMark({}, "viber", "no", now);
    const afterBooking = withClientChoice(studio, ["viber"], later);

    expect(afterBooking.viber).toEqual({ state: "no", source: "studio", at: now.toISOString() });
  });
});

describe("what the studio writes down", () => {
  it("can say no, which no other source may", () => {
    const marks = withStudioMark({}, "telegram", "no", now);
    expect(marks.telegram).toEqual({ state: "no", source: "studio", at: now.toISOString() });
  });

  it("can correct itself later", () => {
    const marks = withStudioMark(withStudioMark({}, "telegram", "no", now), "telegram", "yes", later);
    expect(marks.telegram).toEqual({ state: "yes", source: "studio", at: later.toISOString() });
  });
});

describe("reading the column back", () => {
  it("round-trips what was written", () => {
    const marks = withClientChoice({}, ["call", "whatsapp"], now);
    expect(parseContactChannels(JSON.parse(JSON.stringify(marks)))).toEqual(marks);
  });

  it("is empty for a client nobody has said anything about", () => {
    expect(parseContactChannels(null)).toEqual({});
    expect(parseContactChannels(undefined)).toEqual({});
    expect(isEmptyChannelMarks({})).toBe(true);
  });

  /**
   * `jsonb` keeps whatever was put in it, including shapes from a build that no
   * longer exists. Anything unreadable leaves its channel at «неизвестно»,
   * which is the end of the scale that costs nobody a call.
   */
  it.each([
    { skype: { state: "yes", source: "client", at: now.toISOString() } },
    { whatsapp: "yes" },
    { whatsapp: { state: "maybe", source: "client", at: now.toISOString() } },
    { whatsapp: { state: "yes", source: "guess", at: now.toISOString() } },
    { whatsapp: { state: "yes", source: "client", at: "some time last week" } },
    { whatsapp: { state: "yes", source: "client" } },
  ])("drops a mark it cannot read: %o", (raw) => {
    expect(parseContactChannels(raw)).toEqual({});
  });

  it("keeps the marks it can read beside the ones it cannot", () => {
    const mixed = parseContactChannels({
      whatsapp: { state: "yes", source: "client", at: now.toISOString() },
      skype: { state: "yes", source: "client", at: now.toISOString() },
    }) as ContactChannelMarks;

    expect(Object.keys(mixed)).toEqual(["whatsapp"]);
  });
});

/**
 * Which of the four the studio's screen puts in front of a master.
 *
 * The row was all of them, with the marks changing only how each one looked.
 * Two of the four are application schemes that do nothing where the app is not
 * installed, and the person reading the row has a client on the line — so
 * presence carries the meaning now, and a messenger appears because somebody
 * said it reaches this client.
 */
describe("the ways worth offering", () => {
  it("offers the call and nothing else when nobody has said anything", () => {
    // The client typed in at the desk, and every client who booked before the
    // question existed. They have answered nothing, and a row that guessed on
    // their behalf is what this narrowing exists to stop.
    expect(offeredChannels({})).toEqual(["call"]);
  });

  it("offers a messenger the client ticked", () => {
    const marks = withClientChoice({}, ["whatsapp"], now);

    expect(offeredChannels(marks)).toEqual(["call", "whatsapp"]);
  });

  it("leaves out the messengers nobody spoke about", () => {
    const marks = withClientChoice({}, ["viber"], now);

    // Telegram was not ticked, which is still not «нет» — it is simply not
    // something to put in front of somebody mid-conversation.
    expect(offeredChannels(marks)).not.toContain("telegram");
    expect(offeredChannels(marks)).toEqual(["call", "viber"]);
  });

  it("keeps the row in one order however the marks arrived", () => {
    const marks = withStudioMark(withClientChoice({}, ["viber"], now), "whatsapp", "yes", later);

    // The call first, then the order of `contactChannels` — the one that works
    // anywhere leads, and the row does not rearrange itself per client.
    expect(offeredChannels(marks)).toEqual(["call", "whatsapp", "viber"]);
  });

  it("trusts the studio's mark as readily as the client's tick", () => {
    // Written after somebody tried and got an answer, which is better evidence
    // than a box on a form, not worse.
    const marks = withStudioMark({}, "telegram", "yes", now);

    expect(offeredChannels(marks)).toEqual(["call", "telegram"]);
  });

  it("drops a messenger the studio found does not reach them", () => {
    const marks = withStudioMark(withClientChoice({}, ["telegram"], now), "telegram", "no", later);

    expect(offeredChannels(marks)).toEqual(["call"]);
  });

  it("keeps the call even against a mark saying otherwise", () => {
    /*
     * Nothing writes this today: the form offers the three messengers and the
     * call is not among them, because the number is required and a call is
     * therefore possible by construction. If something ever does, the one way
     * that needs no application installed still does not leave the row.
     */
    const marks = withStudioMark({}, "call", "no", now);

    expect(offeredChannels(marks)).toEqual(["call"]);
  });
});
