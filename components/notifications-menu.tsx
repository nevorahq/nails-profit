"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChromeIcon } from "@/components/icons";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { playNotificationChime, unlockNotificationChime } from "@/lib/notification-chime";
/*
 * The feed's kinds taken from the writer rather than copied beside it.
 *
 * This was a union of its own here, and it fell behind the moment the feed
 * learned two new kinds: the list arrives as JSON and is cast, so nothing
 * type-checks against the truth and the only signal would have been a line
 * rendering as its own key in somebody's topbar. `import type` is erased, so
 * no server module reaches the browser bundle.
 */
import type { StaffNoticeKind as NoticeKind } from "@/lib/staff-notices";
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

/** One appointment's story, however many events it took. */
type NoticeItem = Readonly<{
  booking_id: string;
  kind: NoticeKind;
  /** What happened before the line above it, oldest first. */
  earlier: readonly NoticeKind[];
  unread: boolean;
  happened_at: string;
  client_name: string | null;
  specialist_id: string;
  specialist_name: string;
  local_date: string;
  local_time: string;
  previous_local_date: string | null;
  previous_local_time: string | null;
  /** The day this reader can act on, which is not always the booking's own. */
  link_date: string;
}>;

type Notifications = Readonly<{
  pending: readonly NotificationItem[];
  feed: readonly NoticeItem[];
  unread: number;
}>;

/**
 * What the chime is for: something arrived, not something changed.
 *
 * A request is new by its id. A notice is new by the moment it happened, so
 * that a second cancellation on an appointment the reader has already seen
 * still sounds — it is another hour gone, and the row it collapses into looks
 * almost the same.
 */
function keysOf(next: Notifications) {
  return new Set([
    ...next.pending.map((row) => `pending:${row.id}`),
    ...next.feed.map((row) => `notice:${row.booking_id}:${row.happened_at}`),
  ]);
}

/** How often an open tab checks for a new request while nobody has clicked the bell. */
const POLL_INTERVAL_MS = 30_000;

async function fetchNotifications(locale: AppLocale, fallback: string): Promise<Notifications> {
  const response = await fetch(`/api/v1/notifications?locale=${locale}`);
  if (!response.ok) throw new Error(fallback);
  const body = (await response.json()) as { data: Notifications };
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
  const [data, setData] = useState<Notifications | null>(null);
  const [failed, setFailed] = useState(false);
  const { root, trigger } = useDismissiblePanel(open, () => setOpen(false));

  // Null until the first successful load, so that load never counts as
  // "new" — only something that lands after the list was already known to.
  const known = useRef<Set<string> | null>(null);

  const apply = useCallback((next: Notifications) => {
    const keys = keysOf(next);
    if (known.current && [...keys].some((key) => !known.current!.has(key))) {
      playNotificationChime();
    }
    known.current = keys;
    setData(next);
    setFailed(false);
  }, []);

  useEffect(() => {
    unlockNotificationChime();
    let ignore = false;

    function poll() {
      void fetchNotifications(locale, loadFailed)
        .then((next) => {
          if (!ignore) apply(next);
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
  }, [apply, locale, loadFailed]);

  async function reload() {
    try {
      apply(await fetchNotifications(locale, loadFailed));
    } catch {
      setFailed(true);
    }
  }

  /**
   * Opening one appointment is what reads its line.
   *
   * Opening the panel used to read the whole feed at once, which is the right
   * shape for «есть ли что-то новое» and the wrong one for what this list has
   * become: a queue somebody works through. A list that empties itself the
   * moment you glance at it cannot also be the list of what is left.
   *
   * So the line sinks below the ones still waiting — sorted by the server, not
   * hidden — and the dot on the bell now goes out as lines are dealt with
   * rather than when the panel is opened.
   *
   * Written on the server and taken locally at once rather than waited for: the
   * count is the answer to a click, and a badge that blinked until a round trip
   * finished would be the interface asking to be clicked again. A failed write
   * leaves the line where it was, which the next poll shows honestly.
   */
  async function markSeen(bookingId: string) {
    setData((current) => {
      if (!current) return current;
      const feed = current.feed.map((row) =>
        row.booking_id === bookingId ? { ...row, unread: false } : row,
      );
      return { ...current, feed, unread: feed.filter((row) => row.unread).length };
    });
    try {
      await fetch("/api/v1/notifications/read", {
        method: "POST",
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch {
      /* The line comes back on the next poll, which is the honest answer. */
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
        {/* A dot for either half: a request nobody has answered, or something
            that happened since this person last looked. */}
        {data !== null && (data.pending.length > 0 || data.unread > 0) && (
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
          {!failed && data === null && <p className="notifications-empty">{t("notifications.loading")}</p>}
          {!failed && data !== null && data.pending.length === 0 && data.feed.length === 0 && (
            <p className="notifications-empty">{t("notifications.empty")}</p>
          )}

          {data !== null && data.pending.length > 0 && (
            <>
              {/* Named only when there is a second group under it: one list
                  needs no heading to tell it from the list it is not beside. */}
              {data.feed.length > 0 && (
                <p className="notifications-group">{t("notifications.waiting")}</p>
              )}
              <ul className="notifications-list">
              {data.pending.map((item) => (
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
            </>
          )}

          {data !== null && data.feed.length > 0 && (
            <>
              <p className="notifications-group">{t("notifications.happened")}</p>
              <ul className="notifications-list">
                {data.feed.map((notice) => (
                  <li key={`${notice.booking_id}:${notice.happened_at}`}>
                    <Link
                      className={`notifications-item${notice.unread ? " unread" : ""}`}
                      role="menuitem"
                      href={`/app/calendar?date=${notice.link_date}&specialist=${notice.specialist_id}`}
                      onClick={() => {
                        setOpen(false);
                        // Opening the day is seeing what the line was about.
                        // The two that are not this one keep their place.
                        void markSeen(notice.booking_id);
                      }}
                    >
                      <strong>
                        {notice.client_name ?? t("calendar.noClient")}
                        <span className="notifications-what">
                          {t(`notifications.kind.${notice.kind}` as MessageKey)}
                        </span>
                      </strong>
                      <small>{notice.specialist_name}</small>
                      {/* The hour it was at, where that is not the hour it is
                          at now: a move states both, and a cancellation has
                          only the one it will no longer be at. */}
                      <small>
                        {notice.previous_local_date
                          ? t("notifications.was", {
                              when: `${notice.previous_local_date} · ${notice.previous_local_time}`,
                            })
                          : `${notice.local_date} · ${notice.local_time}`}
                      </small>
                      <small className="notifications-when">
                        {happenedAt(notice.happened_at, locale)}
                        {notice.earlier.length > 0 &&
                          ` · ${t("notifications.more", { count: String(notice.earlier.length) })}`}
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * When it happened, on the reader's own clock.
 *
 * The appointment times on these rows are the location's — a client reads their
 * own hour, and so does the master standing in that room. This one is not about
 * the appointment at all: it answers «когда это произошло», which is a question
 * about the moment the person reading is living in.
 */
function happenedAt(iso: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
