/*
 * What a refused sign-in or sign-up is allowed to say, and nothing else.
 *
 * Its own file for the reason `domain/invitation-link.ts` is: the decision is
 * the part worth testing, there is no renderer in this repository to test it
 * through (see `tests/accessibility.test.ts`), and it needs nothing but a
 * status code.
 */

/** Which of the three answers a refusal gets. */
export type AuthRefusal =
  /** The limiter turned it away. Says nothing about the address. */
  | "rate_limited"
  /** A sign-in that did not match — deliberately without saying which half. */
  | "no_match"
  /** Anything else, which is Better Auth's own message: a rejected sign-up. */
  | "provider";

/**
 * Better Auth answers a refused sign-in «Invalid email or password» and the
 * interface must not improve on that: naming which half was wrong would let
 * anybody discover, address by address, who has an account here.
 *
 * What it must also not do is answer it the other way. «Аккаунт не найден —
 * нужна регистрация» was one of the two answers stated as fact, and false
 * whenever the password was simply mistyped.
 *
 * The limiter is separate for the same reason. `/sign-in/email` allows ten
 * attempts per five minutes and `/sign-up/email` five an hour — see the
 * `rateLimit.customRules` in `lib/auth.ts` — and the 429 those produce carries
 * no verdict about the address at all. Read as «no such account» it sends
 * somebody off to register a duplicate; a rejected sign-up got Better Auth's
 * English sentence, so registration is answered here too.
 */
export function authRefusal(mode: "signin" | "signup", status: number): AuthRefusal {
  if (status === 429) return "rate_limited";
  return mode === "signin" ? "no_match" : "provider";
}
