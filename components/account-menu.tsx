"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ChromeIcon } from "@/components/icons";
import type { MemberRole } from "@/domain/rbac";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { authClient } from "@/lib/auth-client";

/**
 * The account chip in the topbar, and the menu it opens.
 *
 * The chip used to be a `<span>` that did nothing while looking like a control
 * — chevron included — and the application had no way to sign out at all: the
 * only `authClient.signOut()` in the codebase was the one that runs after an
 * organization is deleted.
 *
 * One panel at both widths rather than a dropdown on a desktop and a sheet on a
 * phone. It repeats the address and the role inside itself, which is not
 * duplication below 681px: the chip is only an avatar there, because the topbar
 * has no room for the text.
 */
export function AccountMenu({
  locale,
  role,
  userEmail,
}: {
  locale: AppLocale;
  role: MemberRole;
  userEmail: string;
}) {
  const t = getTranslator(locale);
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // A click anywhere else closes it — including on the topbar's other
    // buttons, which is why this listens on the document rather than on a
    // backdrop element: a backdrop would swallow that first click.
    function onPointerDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape hands focus back to what opened the menu; without this it lands
      // on `<body>` and the next Tab starts from the top of the page.
      trigger.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function signOut() {
    setPending(true);
    /*
     * The preview selection goes first, and unconditionally. It is bound to the
     * signed-out account's id, so leaving it behind could not hand the next
     * person someone else's view — but it would leave the browser carrying a
     * cookie that makes every tenant transaction read-only for a session it no
     * longer describes, which reads as a broken application rather than as a
     * stale cookie. Cheap to send, and it cannot fail in a way that should stop
     * a sign-out.
     */
    await fetch("/api/v1/preview", { method: "DELETE" }).catch(() => {});
    await authClient.signOut();
    // `replace`, not `push`: Back must not return to a page that now redirects.
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="account-menu" ref={root}>
      <button
        className="topbar-account"
        type="button"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.account")}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="sidebar-avatar" aria-hidden="true">
          {userEmail.slice(0, 1).toUpperCase()}
        </span>
        <span className="topbar-account-text">
          <strong>{userEmail}</strong>
          <small>{t(`roles.${role}` as MessageKey)}</small>
        </span>
        <ChromeIcon name="chevron" />
      </button>

      {open && (
        <div className="account-menu-panel" role="menu" aria-label={t("nav.account")}>
          <div className="account-menu-head">
            <strong>{userEmail}</strong>
            <small>{t(`roles.${role}` as MessageKey)}</small>
          </div>
          <button
            className="account-menu-item"
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={signOut}
          >
            <ChromeIcon name="signOut" />
            {pending ? t("nav.signingOut") : t("nav.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
