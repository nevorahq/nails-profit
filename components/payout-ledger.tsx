"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { formatMoneyMinor } from "@/lib/format";

export type PayoutRowView = Readonly<{
  specialistId: string;
  name: string;
  openingMinor: number;
  commissionMinor: number;
  wageMinor: number;
  accruedMinor: number;
  paidMinor: number;
  closingMinor: number;
}>;

export type PayoutEntryView = Readonly<{
  id: string;
  name: string;
  amountMinor: number;
  paidOn: string;
  note: string | null;
}>;

/**
 * «К выплате»: one card per master rather than a table of five money columns,
 * which a phone cannot hold. Each card is the month's balance read left to
 * right — owed at the start, earned, handed over, owed at the end — and the
 * press that changes the third figure.
 *
 * The amount offered is what is owed, because settling the balance is what a
 * payout nearly always is; it can be changed to pay part of it.
 */
export function PayoutLedger({
  rows,
  entries,
  tracking,
  currency,
  locale,
  localeTag,
  today,
}: {
  rows: readonly PayoutRowView[];
  entries: readonly PayoutEntryView[];
  /** Whether the running balance reaches this month; until then only the month's own figures mean anything. */
  tracking: boolean;
  currency: string;
  locale: AppLocale;
  localeTag: string;
  /** The studio's date, `YYYY-MM-DD`, offered as the day of the payout. */
  today: string;
}) {
  const t = useTranslator(locale);
  const register = useRegister();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = (amount: number) => formatMoneyMinor(amount, currency, localeTag);

  async function request(url: string, init: RequestInit) {
    setPending(true);
    setError(null);
    const response = await fetch(url, init);
    setPending(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code;
      setError(code ? getErrorMessage(code, t("common.saveFailed"), locale, register) : t("common.saveFailed"));
      return false;
    }
    router.refresh();
    return true;
  }

  async function markPaid(event: FormEvent<HTMLFormElement>, specialistId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const typed = String(data.get("amount") ?? "").trim();
    const amount = Number(typed);
    if (typed === "" || !Number.isFinite(amount) || amount <= 0) {
      setError(t("payouts.amountRequired"));
      return;
    }
    const note = String(data.get("note") ?? "").trim();
    const paidOn = String(data.get("paid_on") ?? "");
    const saved = await request("/api/v1/payouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specialist_id: specialistId,
        amount_minor: Math.round(amount * 100),
        currency,
        ...(paidOn ? { paid_on: paidOn } : {}),
        ...(note ? { note } : {}),
      }),
    });
    if (saved) setOpen(null);
  }

  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <section className="empty-state">
          <p>{t("payouts.empty")}</p>
        </section>
      ) : (
        rows.map((row) => (
          <section className="panel payout-card" key={row.specialistId} aria-label={row.name}>
            <h2>{row.name}</h2>
            <dl className="payout-figures">
              {tracking && (
                <div>
                  <dt>{t("payouts.opening")}</dt>
                  <dd>{money(row.openingMinor)}</dd>
                </div>
              )}
              <div>
                <dt>{t("payouts.accrued")}</dt>
                <dd>
                  {money(row.accruedMinor)}
                  {row.wageMinor > 0 && row.commissionMinor > 0 && (
                    <span className="unit-hint">
                      {t("payouts.accruedSplit", { visits: money(row.commissionMinor), wage: money(row.wageMinor) })}
                    </span>
                  )}
                </dd>
              </div>
              {tracking && (
                <div>
                  <dt>{t("payouts.paid")}</dt>
                  <dd>{money(row.paidMinor)}</dd>
                </div>
              )}
              {tracking && (
                <div>
                  <dt>{t("payouts.closing")}</dt>
                  <dd className={row.closingMinor < 0 ? "metric-negative" : undefined}>
                    <strong>{money(row.closingMinor)}</strong>
                  </dd>
                </div>
              )}
            </dl>
            {row.closingMinor < 0 && <p className="muted">{t("payouts.overpaid")}</p>}

            {open === row.specialistId ? (
              <form className="inline-form" onSubmit={(event) => markPaid(event, row.specialistId)}>
                <label>
                  {t("payouts.amount", { currency })}
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    autoFocus
                    defaultValue={
                      (tracking ? row.closingMinor : row.accruedMinor) > 0
                        ? ((tracking ? row.closingMinor : row.accruedMinor) / 100).toFixed(2)
                        : ""
                    }
                  />
                </label>
                <label>
                  {t("payouts.paidOn")}
                  <input name="paid_on" type="date" defaultValue={today} max={today} required />
                </label>
                <label>
                  {t("payouts.note")}
                  <input name="note" maxLength={500} autoComplete="off" />
                </label>
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? t("common.saving") : t("payouts.save")}
                </button>
                <button className="inline-action" type="button" disabled={pending} onClick={() => setOpen(null)}>
                  {t("common.cancel")}
                </button>
              </form>
            ) : (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setError(null);
                  setOpen(row.specialistId);
                }}
              >
                {t("payouts.mark")}
              </button>
            )}
          </section>
        ))
      )}

      {entries.length > 0 && (
        <section className="panel">
          <h2>{t("payouts.entriesTitle")}</h2>
          <ul className="compact-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                {new Date(`${entry.paidOn}T00:00:00Z`).toLocaleDateString(localeTag, { timeZone: "UTC" })} ·{" "}
                {entry.name} · <strong>{money(entry.amountMinor)}</strong>
                {entry.note && <span className="unit-hint">{entry.note}</span>}
                <button
                  className="inline-action danger"
                  type="button"
                  disabled={pending}
                  aria-label={t("payouts.deleteLabel", { name: entry.name })}
                  onClick={() => request(`/api/v1/payouts?id=${entry.id}`, { method: "DELETE" })}
                >
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
