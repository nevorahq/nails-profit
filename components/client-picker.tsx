"use client";

import { useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { useTranslator } from "@/components/lexicon-provider";
import type { AppLocale } from "@/i18n/messages";

/**
 * Who the appointment is for, as one search instead of three fields.
 *
 * The desk takes a name or a number over the phone and wants the card it
 * belongs to, not a select of every client the studio has had. Typing finds
 * them in the base; if nobody fits, the same row turns into a new client, with
 * what was typed already in the right field. The form reads the answer from
 * `FormData` as it always has — `client_id` for an existing client, or
 * `client_name` and `client_phone` for a new one — so what it does with them is
 * unchanged. Nothing chosen is a booking with no client, as before.
 */

export type PickableClient = Readonly<{ id: string; name: string; phone?: string | null }>;

const SUGGESTIONS = 5;

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * Whether what was typed is a number rather than a name: no letters, and enough
 * digits that it cannot be the start of a house number. It decides which field
 * a new client's first words go to.
 */
export function looksLikePhone(query: string): boolean {
  return !/\p{L}/u.test(query) && digitsOf(query).length >= 3;
}

/**
 * The clients a query could mean, in the order the base lists them.
 *
 * A name matches anywhere in it, so «ира» finds «Ирина»; a number matches on
 * its digits alone, so «069 123» finds «+37369123456» whatever spaces and
 * brackets either was written with. A query of one or two digits matches no
 * number — that is a name being typed that starts with a digit, or nothing.
 */
export function matchClients(clients: readonly PickableClient[], query: string): PickableClient[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const digits = digitsOf(text);
  const byPhone = looksLikePhone(text);

  return clients
    .filter((client) => {
      if (byPhone) return digitsOf(client.phone ?? "").includes(digits);
      return client.name.toLowerCase().includes(text);
    })
    .slice(0, SUGGESTIONS);
}

type Choice =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "existing"; client: PickableClient }>
  | Readonly<{ kind: "new"; name: string; phone: string }>;

export function ClientPicker({
  clients,
  locale,
}: {
  clients: readonly PickableClient[];
  locale: AppLocale;
}) {
  const t = useTranslator(locale);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<Choice>({ kind: "none" });
  const [active, setActive] = useState(-1);

  const matches = matchClients(clients, query);
  const typed = query.trim();
  // The row after the matches is always «Новый клиент»: what was typed is not
  // always a person who is missing from the base, but it can always be one.
  const rows = typed ? matches.length + 1 : 0;

  function pick(client: PickableClient) {
    setChoice({ kind: "existing", client });
    setQuery("");
    setActive(-1);
  }

  function create() {
    const asPhone = looksLikePhone(typed);
    setChoice({ kind: "new", name: asPhone ? "" : typed, phone: asPhone ? typed : "" });
    setQuery("");
    setActive(-1);
  }

  function reset() {
    setChoice({ kind: "none" });
    setQuery("");
    setActive(-1);
  }

  function choose(index: number) {
    const client = matches[index];
    if (client) pick(client);
    else create();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && rows > 0) {
      event.preventDefault();
      setActive((current) => (current + 1) % rows);
    } else if (event.key === "ArrowUp" && rows > 0) {
      event.preventDefault();
      setActive((current) => (current <= 0 ? rows - 1 : current - 1));
    } else if (event.key === "Enter" && typed) {
      // Enter on a half-typed name must not send the whole form. With nothing
      // highlighted it takes the first match, or makes a new client when there
      // is none: a number typed and Enter is a new client with that number.
      event.preventDefault();
      choose(active >= 0 ? active : 0);
    } else if (event.key === "Escape" && typed) {
      event.stopPropagation();
      setQuery("");
      setActive(-1);
    }
  }

  if (choice.kind === "existing") {
    return (
      <div className="client-picker">
        <input type="hidden" name="client_id" value={choice.client.id} />
        <div className="client-picker-chosen">
          <span className="client-picker-label">{t("calendar.client")}</span>
          <div className="client-picker-card">
            <span className="client-picker-who">
              <strong>{choice.client.name}</strong>
              {choice.client.phone ? <small>{choice.client.phone}</small> : null}
            </span>
            <button type="button" className="client-picker-change" onClick={reset}>
              {t("calendar.clientChange")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (choice.kind === "new") {
    return (
      <div className="client-picker">
        <div className="client-picker-chosen">
          <span className="client-picker-label">{t("calendar.clientCreateEmpty")}</span>
          <button type="button" className="client-picker-change" onClick={reset}>
            {t("calendar.clientChange")}
          </button>
        </div>
        <label>
          {t("calendar.clientPhone")}
          <input
            name="client_phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            maxLength={32}
            defaultValue={choice.phone}
          />
        </label>
        <label>
          {t("calendar.clientName")}
          <input name="client_name" required maxLength={200} autoComplete="off" defaultValue={choice.name} />
        </label>
      </div>
    );
  }

  return (
    <div className="client-picker">
      <label>
        {t("calendar.client")}
        <input
          type="search"
          role="combobox"
          aria-expanded={rows > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          enterKeyHint="search"
          maxLength={200}
          placeholder={t("calendar.clientSearch")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {typed ? (
        <ul id={listId} className="client-picker-list" role="listbox" aria-label={t("calendar.clientResults")}>
          {matches.map((client, index) => (
            <li
              key={client.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={active === index}
              className="client-picker-option"
              // The press, not the click: a click lands after the input has lost
              // focus, and by then the list may already be gone.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(client);
              }}
            >
              <strong>{client.name}</strong>
              {client.phone ? <small>{client.phone}</small> : null}
            </li>
          ))}
          <li
            id={`${listId}-${matches.length}`}
            role="option"
            aria-selected={active === matches.length}
            className="client-picker-option client-picker-new"
            onMouseDown={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <strong>{t("calendar.clientCreate", { query: typed })}</strong>
            {matches.length === 0 ? <small>{t("calendar.clientNoMatches")}</small> : null}
          </li>
        </ul>
      ) : (
        <p id={listId} className="client-picker-hint">
          {t("calendar.clientSearchHint")}
        </p>
      )}
    </div>
  );
}
