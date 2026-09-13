/**
 * The ways to reach a client from their number, spec section 7.8's «клиент
 * опаздывает» answered in the shape the desk actually works in.
 *
 * One number, four addresses. The studio does not know which messenger a client
 * uses — nothing in the product records it, and asking would be a field nobody
 * fills in — so the card offers the choices and the person who knows the client
 * picks one. Moldova is Viber country with WhatsApp beside it; Telegram is
 * there because the alternative to offering it is a number copied by hand.
 *
 * Two of the four are honest links and two are gambles, and the difference is
 * the messengers' own. `tel:` and `wa.me` resolve anywhere — the second falls
 * back to the web client. `tg://` and `viber://` are application schemes: they
 * open the app where it is installed and do nothing at all where it is not.
 * Neither has a public web address that takes a phone number, so there is
 * nothing better to point at.
 */

export type ContactChannel = "call" | "whatsapp" | "telegram" | "viber";

/** The order the block shows them in: the one that always works, first. */
export const contactChannels: readonly ContactChannel[] = [
  "call",
  "whatsapp",
  "telegram",
  "viber",
];

/**
 * E.164 and nothing else.
 *
 * `normalizePhone` stores `+37369384050`, which is what every one of these
 * addresses is built from — and what none of them accepts in the same shape:
 * `tel:` wants the plus, `wa.me` and Telegram want bare digits, Viber wants the
 * plus encoded. Building them from a number with a space in it is how a card
 * comes to dial something the screen does not show, so anything that is not
 * E.164 produces no link rather than a broken one.
 */
function digitsOf(phone: string): string | null {
  return /^\+\d{8,15}$/.test(phone) ? phone.slice(1) : null;
}

export function contactLink(channel: ContactChannel, phone: string): string | null {
  const digits = digitsOf(phone);
  if (!digits) return null;

  switch (channel) {
    case "call":
      return `tel:+${digits}`;
    case "whatsapp":
      return `https://wa.me/${digits}`;
    case "telegram":
      return `tg://resolve?phone=${digits}`;
    case "viber":
      return `viber://chat?number=%2B${digits}`;
  }
}

export type ContactWay = Readonly<{ channel: ContactChannel; href: string }>;

/** Every way there is to reach this number, or nothing when it is not a number. */
export function contactWays(phone: string | null): readonly ContactWay[] {
  if (!phone) return [];

  return contactChannels
    .map((channel) => ({ channel, href: contactLink(channel, phone) }))
    .filter((way): way is ContactWay => way.href !== null);
}
