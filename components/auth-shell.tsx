import Link from "next/link";

import { displayFont } from "@/app/display-font";

/**
 * The ground every sign-in, recovery, invitation and set-up screen stands on:
 * the Mint look the landing wears, so someone who presses «Начать расчёт» stays
 * in one place from the first page to the first screen of their own studio.
 *
 * `.auth-mint` carries the styling and the class from `next/font` declares
 * `--font-display` for it. It is one component so that no screen can have one
 * without the other — a shell without the font variable falls back to Georgia
 * without saying so.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return <main className={`auth-shell auth-mint ${displayFont.variable}`}>{children}</main>;
}

/** The wordmark above a card. A link on the screens somebody may want to leave by. */
export function AuthBrand({ linked = true }: { linked?: boolean }) {
  const mark = (
    <>
      <span className="brand-np" aria-hidden="true">NP</span>
      Nail Profit OS
    </>
  );
  return linked ? (
    <Link className="brand" href="/">
      {mark}
    </Link>
  ) : (
    <span className="brand">{mark}</span>
  );
}
