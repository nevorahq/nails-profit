"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  defaultExpenseCategory,
  expenseCategories,
  type ExpenseCategory,
} from "@/domain/expense-categories";
import { expenseClassOf } from "@/domain/expense-classes";
import type { ExpenseRow } from "@/lib/expenses";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";
import { localeTag } from "@/i18n/translate";
import { formatDay, formatMoneyMinor } from "@/lib/format";

/*
 * The add form and the table are two components rather than one: the form lives
 * inside the collapsible panel the header's button opens, the table below it.
 * They share no state — the form posts and calls `router.refresh()`, and the
 * table renders whatever the server sent back. `ExpenseLedger` puts the two
 * together and owns the panel.
 */

export function ExpenseLedger({ expenses, locale }: { expenses: ExpenseRow[]; locale: AppLocale }) {
  /*
   * The panel: nothing on the page until the header opens it — the anchors
   * `app/app/expenses/page.tsx` renders are the *only* control (`.header-action`
   * on a phone, `.calendar-create` on a desktop). That page is a Server
   * Component and cannot hold this listener, which is why the click is
   * delegated on `document` here.
   *
   * It was a `<details>` once, whose `<summary>` stayed visible — and clickable
   * — while closed, putting a second «Добавить» directly under the header's own
   * button. A `.compose-wrap` collapsed by class leaves no such strip.
   */
  // Lazy so it reads the real hash on the client's own first render rather than
  // in a follow-up effect — `location` does not exist during the server's
  // render of this "use client" component.
  const [open, setOpen] = useState(() => typeof window !== "undefined" && location.hash === "#add-expense");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      const trigger = (event.target as HTMLElement).closest('a[href="#add-expense"]');
      if (!trigger) return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (open) panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.querySelectorAll<HTMLAnchorElement>('a.header-action[href="#add-expense"]').forEach((button) => {
      const label = open ? button.dataset.labelOpen : button.dataset.labelClosed;
      if (label) button.setAttribute("aria-label", label);
    });
  }, [open]);

  return (
    <>
      <div className={`compose-wrap${open ? "" : " is-closed"}`} id="add-expense" ref={panel}>
        <div className="compose-inner">
          <ExpenseForm locale={locale} onAdded={() => setOpen(false)} />
        </div>
      </div>
      <ExpenseTable expenses={expenses} locale={locale} />
    </>
  );
}

function IconEdit() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.013 1.427a1.75 1.75 0 0 1 2.474 2.474L4.75 12.639l-3.5.875.875-3.5 8.888-8.587Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4h12M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4m1.5 0-.75 9.5a1 1 0 0 1-1 .917H5.75a1 1 0 0 1-1-.917L4 4"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconX() {
  return (
    <svg className="btn-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Today where the person is standing, as `<input type="date">` wants it. */
function today(): string {
  const now = new Date();
  // Their own midnight, not UTC's: at 02:00 in Chișinău `toISOString` still
  // says yesterday, and the field would open on the wrong day every night.
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Money the person typed ("240", "240.5") as minor units. */
function toMinorUnits(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function ExpenseForm({ locale, onAdded }: { locale: AppLocale; onAdded: () => void }) {
  const router = useRouter();
  const t = getTranslator(locale);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const note = String(data.get("note") ?? "").trim();

    const response = await fetch("/api/v1/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        category: data.get("category"),
        spent_on: data.get("spent_on"),
        amount_minor: toMinorUnits(String(data.get("amount") ?? "")),
        ...(note ? { note } : {}),
        // The interval starts on the day of the payment: a recurring expense
        // entered today starts today, and asking twice for one date is a
        // question nobody wants to answer.
        ...(data.get("is_recurring") ? { is_recurring: true } : {}),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("expenses.saveFailed"));
      setPending(false);
      return;
    }

    form.reset();
    setPending(false);
    onAdded();
    router.refresh();
  }

  return (
    <section className="panel">
      <h2>{t("expenses.addTitle")}</h2>
      <form className="inline-form" onSubmit={submit}>
        <label>
          {t("expenses.name")}
          <input name="name" required maxLength={200} placeholder={t("expenses.namePlaceholder")} />
        </label>
        <label>
          {t("expenses.category")}
          <select name="category" defaultValue={defaultExpenseCategory}>
            {expenseCategories.map((category) => (
              <option key={category} value={category}>
                {t(`expenses.category.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("expenses.date")}
          <input name="spent_on" type="date" required defaultValue={today()} />
        </label>
        <label>
          {t("expenses.amount")}
          <input name="amount" type="number" step="0.01" min="0" required placeholder="1200" />
        </label>
        <label>
          {t("expenses.note")}
          <input name="note" maxLength={2000} placeholder={t("expenses.notePlaceholder")} />
        </label>
        {/*
          A checkbox rather than a second date field. Rent is entered once and
          counted every month until it is ended; asking for an end date up front
          would ask the owner to predict when they will move out.
        */}
        <label className="checkbox-field">
          <input name="is_recurring" type="checkbox" />
          {t("expenses.recurring")}
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("common.add")}
        </button>
      </form>
      <p className="muted">{t("expenses.recurringHint")}</p>
      <p className="muted">{t("expenses.classHint")}</p>
      {error && (
        <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
          {error}
        </div>
      )}
    </section>
  );
}

type EditState = {
  id: string;
  name: string;
  category: ExpenseCategory;
  spentOn: string;
  amount: string;
  note: string;
};

function ExpenseTable({ expenses, locale }: { expenses: ExpenseRow[]; locale: AppLocale }) {
  const router = useRouter();
  const t = getTranslator(locale);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null);
  const [endPending, setEndPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * One total per currency, not one total.
   *
   * Every row carries the currency it was recorded in, and the organization's
   * currency can be changed without converting what is already stored — so a
   * ledger can hold both, and one sum across them would be a number that is not
   * money. An ordinary ledger has a single currency and gets a single line,
   * exactly as before; a mixed one gets a line each and hides nothing.
   */
  const totals = [
    ...expenses
      .reduce(
        (byCurrency, expense) =>
          byCurrency.set(expense.currency, (byCurrency.get(expense.currency) ?? 0) + expense.amount_minor),
        new Map<string, number>(),
      )
      .entries(),
  ];

  function startEdit(expense: ExpenseRow) {
    setEdit({
      id: expense.id,
      name: expense.name,
      category: expense.category,
      spentOn: expense.spent_on,
      amount: String(expense.amount_minor / 100),
      note: expense.note ?? "",
    });
    setEditError(null);
    setConfirmDeleteId(null);
  }

  async function saveEdit() {
    if (!edit) return;
    setEditPending(true);
    setEditError(null);

    const response = await fetch(`/api/v1/expenses/${edit.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: edit.name.trim(),
        category: edit.category,
        spent_on: edit.spentOn,
        amount_minor: toMinorUnits(edit.amount),
        // Null, not "", so clearing the field clears the column.
        note: edit.note.trim() || null,
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setEditError(payload?.error?.message ?? t("expenses.editFailed"));
      setEditPending(false);
      return;
    }

    setEdit(null);
    setEditPending(false);
    router.refresh();
  }

  /*
   * Ending a recurring expense is not deleting it.
   *
   * Archiving takes the row out of every month it ever applied to, which is
   * right for something typed by mistake and wrong for rent that really was
   * paid until August. Closing the interval leaves every month already reported
   * exactly as it was and stops the next one.
   */
  async function endExpense(id: string) {
    setEndPending(id);

    const response = await fetch(`/api/v1/expenses/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recurring_to: today() }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("expenses.editFailed"));
      setEndPending(null);
      return;
    }

    setEndPending(null);
    setConfirmEndId(null);
    router.refresh();
  }

  async function deleteExpense(id: string) {
    setDeletePending(true);

    const response = await fetch(`/api/v1/expenses/${id}`, { method: "DELETE" });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? t("expenses.deleteFailed"));
      setDeletePending(false);
      setConfirmDeleteId(null);
      return;
    }

    setConfirmDeleteId(null);
    setDeletePending(false);
    router.refresh();
  }

  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("expenses.name")}</th>
            <th>{t("expenses.category")}</th>
            <th>{t("expenses.date")}</th>
            <th>{t("expenses.amountColumn")}</th>
            <th>{t("expenses.note")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {expenses.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("expenses.none")}
              </td>
            </tr>
          )}
          {expenses.map((expense) => {
            if (edit?.id === expense.id) {
              return (
                <tr key={expense.id}>
                  <td>
                    <input
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      aria-label={t("expenses.name")}
                      maxLength={200}
                      required
                      style={cellInputStyle}
                    />
                  </td>
                  <td>
                    <select
                      value={edit.category}
                      onChange={(e) => setEdit({ ...edit, category: e.target.value as ExpenseCategory })}
                      aria-label={t("expenses.category")}
                      style={cellInputStyle}
                    >
                      {expenseCategories.map((category) => (
                        <option key={category} value={category}>
                          {t(`expenses.category.${category}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={edit.spentOn}
                      onChange={(e) => setEdit({ ...edit, spentOn: e.target.value })}
                      aria-label={t("expenses.date")}
                      type="date"
                      required
                      style={cellInputStyle}
                    />
                  </td>
                  <td>
                    <input
                      value={edit.amount}
                      onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                      aria-label={t("expenses.amountColumn")}
                      type="number"
                      step="0.01"
                      min="0"
                      style={cellInputStyle}
                    />
                  </td>
                  <td>
                    <input
                      value={edit.note}
                      onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                      aria-label={t("expenses.note")}
                      maxLength={2000}
                      style={cellInputStyle}
                    />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editError && (
                      <span style={{ display: "block", color: "var(--danger)", fontSize: "12rem", marginBottom: "4rem" }}>
                        {editError}
                      </span>
                    )}
                    <button
                      className="inline-action"
                      type="button"
                      disabled={editPending || edit.name.trim().length === 0}
                      onClick={saveEdit}
                    >
                      {editPending ? t("common.saving") : t("common.save")}
                    </button>
                    <button
                      className="inline-action"
                      type="button"
                      onClick={() => { setEdit(null); setEditError(null); }}
                      disabled={editPending}
                    >
                      {t("common.cancel")}
                    </button>
                  </td>
                </tr>
              );
            }

            return (
              <tr key={expense.id}>
                <td>
                  {expense.name}
                  {/*
                    Rent is one row that answers for many months, and nothing
                    else on this line would say so — the date column shows the
                    day of the payment, which looks like any other purchase.
                  */}
                  {expense.is_recurring && (
                    <span className="badge-accent">
                      {expense.recurring_to
                        ? t("expenses.recurringUntil", {
                            date: formatDay(expense.recurring_to, localeTag(locale)),
                          })
                        : t("expenses.recurringBadge")}
                    </span>
                  )}
                </td>
                <td>
                  {t(`expenses.category.${expense.category}`)}
                  {/*
                    Said on the row, not only in the report: the owner types the
                    category here, and here is where it is decided whether the
                    amount will reduce the month's profit or only its cash.
                  */}
                  {expenseClassOf[expense.category] === "cash_only" && (
                    <span className="unit-hint">{t("expenses.classCashOnly")}</span>
                  )}
                </td>
                <td>{formatDay(expense.spent_on, localeTag(locale))}</td>
                <td>{formatMoneyMinor(expense.amount_minor, expense.currency, localeTag(locale))}</td>
                <td className={expense.note ? undefined : "muted"}>{expense.note || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="inline-action"
                    type="button"
                    onClick={() => startEdit(expense)}
                    disabled={deletePending}
                    aria-label={`${t("expenses.edit")} ${expense.name}`}
                  >
                    <IconEdit />
                    <span className="btn-label">{t("expenses.edit")}</span>
                  </button>
                  {/*
                    Offered only while it is still running, and only for a
                    recurring row: there is nothing to end otherwise.
                  */}
                  {expense.is_recurring && expense.recurring_to === null && (
                    confirmEndId === expense.id ? (
                      <>
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => endExpense(expense.id)}
                          disabled={endPending !== null}
                        >
                          <span className="btn-label">{t("expenses.endConfirm")}</span>
                        </button>
                        <button
                          className="inline-action"
                          type="button"
                          onClick={() => setConfirmEndId(null)}
                          disabled={endPending !== null}
                        >
                          <IconX />
                          <span className="btn-label">{t("common.cancel")}</span>
                        </button>
                        <p className="pl-note">{t("expenses.endHint")}</p>
                      </>
                    ) : (
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => { setConfirmEndId(expense.id); setConfirmDeleteId(null); setEdit(null); }}
                        disabled={endPending !== null}
                        aria-label={`${t("expenses.end")} ${expense.name}`}
                      >
                        <span className="btn-label">{t("expenses.end")}</span>
                      </button>
                    )
                  )}
                  {confirmDeleteId === expense.id ? (
                    <>
                      <button
                        className="inline-action danger"
                        type="button"
                        onClick={() => deleteExpense(expense.id)}
                        disabled={deletePending}
                      >
                        <IconTrash />
                        <span className="btn-label">{t("expenses.deleteConfirm")}</span>
                      </button>
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        disabled={deletePending}
                      >
                        <IconX />
                        <span className="btn-label">{t("common.cancel")}</span>
                      </button>
                      {/*
                        Deleting a recurring row is the destructive one: it
                        takes the rent out of last January too. Said at the
                        moment of asking, where it can still change the answer.
                      */}
                      {expense.is_recurring && (
                        <p className="pl-note">{t("expenses.deleteRecurringWarning")}</p>
                      )}
                    </>
                  ) : (
                    <button
                      className="inline-action danger"
                      type="button"
                      onClick={() => { setConfirmDeleteId(expense.id); setEdit(null); }}
                      disabled={deletePending}
                      aria-label={`${t("expenses.delete")} ${expense.name}`}
                    >
                      <IconTrash />
                      <span className="btn-label">{t("expenses.delete")}</span>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {/*
          The total of what is on screen, so it answers the filter above it
          rather than the whole ledger.
        */}
        {totals.length > 0 && (
          <tfoot>
            {totals.map(([currency, amount]) => (
              <tr key={currency}>
                <td colSpan={3}>{t("expenses.total")}</td>
                <td>
                  <strong>{formatMoneyMinor(amount, currency, localeTag(locale))}</strong>
                </td>
                <td colSpan={2} />
              </tr>
            ))}
          </tfoot>
        )}
      </table>
    </>
  );
}

const cellInputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: "80rem",
  padding: "5rem 8rem",
  borderRadius: "8rem",
  border: "1rem solid var(--line)",
  font: "inherit",
  fontSize: "14rem",
  background: "var(--surface-strong)",
};
