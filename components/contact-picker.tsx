"use client";

import { useMemo, useState } from "react";

import type { VCardContact } from "@/domain/vcard";
import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";

/**
 * The phone book, before any of it becomes a client.
 *
 * Nothing is ticked to begin with. A phone holds the plumber, the bank and the
 * owner's mother beside the clients, and a list that starts all-ticked asks the
 * owner to find and untick the hundred people who are not clients — the
 * mistake that goes unnoticed is then a stranger in the client base. Search
 * plus «отметить найденных» makes the other direction quick.
 */
export function ContactPicker({
  contacts,
  locale,
  pending,
  onContinue,
  onCancel,
}: {
  contacts: readonly VCardContact[];
  locale: AppLocale;
  pending: boolean;
  onContinue: (selected: number[]) => void;
  onCancel: () => void;
}) {
  const t = useTranslator(locale);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const found = useMemo(() => {
    const words = query.trim().toLowerCase();
    // Digits are compared as digits, so `069 12` finds `+37369123456`.
    const digits = words.replace(/\D/g, "");
    if (words === "") return contacts;
    return contacts.filter(
      (contact) =>
        contact.name.toLowerCase().includes(words) ||
        (contact.email ?? "").toLowerCase().includes(words) ||
        (digits.length >= 2 &&
          (contact.phone ?? contact.unreadablePhone ?? "").replace(/\D/g, "").includes(digits.replace(/^0/, ""))),
    );
  }, [contacts, query]);

  function toggle(index: number, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  return (
    <section className="panel contact-picker">
      <h2>{t("import.contactsTitle")}</h2>
      <p className="muted">{t("import.contactsLead")}</p>

      <label className="contact-picker-search">
        {t("import.contactsSearch")}
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      <div className="contact-picker-tools">
        <button
          className="secondary-button"
          type="button"
          disabled={found.length === 0}
          onClick={() => setSelected((current) => new Set([...current, ...found.map((contact) => contact.index)]))}
        >
          {t("import.contactsSelectFound", { count: found.length })}
        </button>
        <button className="secondary-button" type="button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          {t("import.contactsClear")}
        </button>
        <span className="muted" role="status">
          {t("import.contactsSelected", { count: selected.size, total: contacts.length })}
        </span>
      </div>

      {found.length === 0 ? (
        <p className="muted">{t("import.contactsNothingFound")}</p>
      ) : (
        <ul className="contact-picker-list">
          {found.map((contact) => (
            <li key={contact.index}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(contact.index)}
                  onChange={(event) => toggle(contact.index, event.target.checked)}
                />
                <span className="contact-picker-text">
                  <span className="contact-picker-name">{contact.name}</span>
                  <span className="contact-picker-phone">
                    {contact.phone ??
                      (contact.unreadablePhone
                        ? t("import.contactsUnreadable", { phone: contact.unreadablePhone })
                        : t("import.contactsNoPhone"))}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => onContinue([...selected].sort((a, b) => a - b))}
        >
          {pending ? t("import.reading") : t("import.contactsContinue", { count: selected.size })}
        </button>
        <button className="secondary-button" type="button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}
