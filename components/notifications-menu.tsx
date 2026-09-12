"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ChromeIcon } from "@/components/icons";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { playNotificationChime, unlockNotificationChime } from "@/lib/notification-chime";
import { useDismissiblePanel } from "@/lib/use-dismissible-panel";

type NotificationItem = Readonly<{
  id: string;
  specialist_id: string;
  specialist_name: string;
  client_name: string | null;
  /** The card's own name, sent only when the request was made under another. */
  client_card_name: string | null;
  service_name: string | null;
  local_date: string;
  local_time: string;
}>;

/** How often an open tab checks for a new request while nobody has clicked the bell. */
const POLL_INTERVAL_MS = 30_000;

async function fetchNotifications(locale: AppLocale, fallback: string): Promise<NotificationItem[]> {
  const response = await fetch(`/api/v1/notifications?locale=${locale}`);
  if (!response.ok) throw new Error(fallback);
  const body = (await response.json()) as { data: NotificationItem[] };
  return body.data;
}

/**
 * The bell in the topbar: appointments still waiting on the studio to
 * confirm them (`pending_confirmation`, roadmap section 7.2) — the same
 * queue that dc88142 started mailing a master and the owner about. This is
 * the same list read as a glance rather than an inbox.
 *
 * Fetched on mount, so the badge is right without the panel ever having been
 * opened, then polled every `POLL_INTERVAL_MS` so a studio's screen notices a
 * new request without anyone having to check — a chime marks the moment the
 * list actually grows, not just any refresh.
 */
export function NotificationsMenu({ locale }: { locale: AppLocale }) {
  const t = getTranslator(locale);
  const loadFailed = t("notifications.loadFailed");

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { root, trigger } = useDismissiblePanel(open, () => setOpen(false));

  // Null until the first successful load, so that load never counts as
  // "new" — only a request that lands after the list was already known to.
  const knownIds = useRef<Set<string> | null>(null);

  function applyItems(rows: NotificationItem[]) {
    const ids = new Set(rows.map((row) => row.id));
    if (knownIds.current && rows.some((row) => !knownIds.current!.has(row.id))) {
      playNotificationChime();
    }
    knownIds.current = ids;
    setItems(rows);
    setFailed(false);
  }

  useEffect(() => {
    unlockNotificationChime();
    let ignore = false;

    function poll() {
      void fetchNotifications(locale, loadFailed)
        .then((rows) => {
          if (!ignore) applyItems(rows);
        })
        .catch(() => {
          if (!ignore) setFailed(true);
        });
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [locale, loadFailed]);

  async function reload() {
    try {
      applyItems(await fetchNotifications(locale, loadFailed));
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="notifications-menu" ref={root}>
      <button
        className="topbar-notifications"
        type="button"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.notifications")}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void reload();
        }}
      >
        <ChromeIcon name="bell" />
        {items !== null && items.length > 0 && (
          <span className="topbar-notifications-badge" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          className="account-menu-panel notifications-panel"
          role="menu"
          aria-label={t("nav.notifications")}
        >
          <div className="account-menu-head">
            <strong>{t("nav.notifications")}</strong>
          </div>

          {failed && <p className="notifications-empty">{loadFailed}</p>}
          {!failed && items === null && <p className="notifications-empty">{t("notifications.loading")}</p>}
          {!failed && items !== null && items.length === 0 && (
            <p className="notifications-empty">{t("notifications.empty")}</p>
          )}

          {items !== null && items.length > 0 && (
            <ul className="notifications-list">
              {items.map((item) => (
                <li key={item.id}>
                  {/*
                    The day the request sits on, and whose it is. No status.

                    It used to carry one — `pending_confirmation,confirmed`,
                    widened from `pending_confirmation` alone after confirming
                    a booking made it vanish from the screen that confirmed it
                    (commit 9ffa713: the calendar refreshes on the same URL, so
                    the answer erased the question). The widening survived only
                    because the calendar also showed the filter and let it be
                    cleared; with that panel gone, a status arriving here would
                    be a state the reader could not get out of. So the link
                    stops setting one, which is the same fix made at the cause
                    rather than at the symptom.

                    The specialist stays: the calendar shows that filter openly
                    in its toolbar, and «Все мастера» is one tap away.
                  */}
                  <Link
                    className="notifications-item"
                    role="menuitem"
                    href={`/app/calendar?date=${item.local_date}&specialist=${item.specialist_id}`}
                    onClick={() => setOpen(false)}
                  >
                    <strong>{item.client_name ?? t("calendar.noClient")}</strong>
                    {/*
                      Whose card it landed on, when that is somebody else's
                      name. One number in a household is one card, and the
                      request above was made under the name of whoever is
                      actually coming — which is the name the master needs, with
                      the card named underneath so the two can be told apart.
                    */}
                    {item.client_card_name && (
                      <small>{t("calendar.clientCard", { name: item.client_card_name })}</small>
                    )}
                    <small>{[item.service_name, item.specialist_name].filter(Boolean).join(" · ")}</small>
                    <small>{`${item.local_date} · ${item.local_time}`}</small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
