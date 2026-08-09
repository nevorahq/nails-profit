"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Whether `href` is the section the current path belongs to.
 *
 * A prefix match, so `/app/calendar/{id}` keeps Календарь lit while an
 * appointment card is open — the user has not left the section by opening one
 * of its rows. `/app` is the exception: it is a prefix of every other route, so
 * it only matches itself.
 */
export function isActiveSection(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The only client component in the shell.
 *
 * Active state used to be a prop threaded through all fifteen pages, which
 * meant a new page was one forgotten string away from lighting nothing. Reading
 * the path here removes that, and the cost is bounded: the label and the icon
 * arrive as `children` already rendered on the server, so the dictionary and
 * the role never cross into the browser bundle.
 */
export function NavLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: React.ReactNode;
}) {
  const active = isActiveSection(usePathname(), href);

  return (
    <Link
      href={href}
      className={active ? `${className} active` : className}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
