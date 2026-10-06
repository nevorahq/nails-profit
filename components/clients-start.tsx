"use client";

import Link from "next/link";
import { useState } from "react";

import type { AppLocale } from "@/i18n/messages";
import { useTranslator } from "@/components/lexicon-provider";

/** Where «Из телефона» leads: the client import, with the way to export contacts said first. */
const IMPORT_CLIENTS_FROM_PHONE = "/app/import?entity=client&from=phone#import-upload";
const IMPORT_CLIENTS_FROM_FILE = "/app/import?entity=client#import-upload";

/**
 * «У вас уже есть клиенты?» — offered once the prices are set and again on an
 * empty client list, the two moments a master moving in from another system or
 * from their phone is most likely to have the list to hand.
 *
 * Optional by design: «Позже» is a full answer, not a skip that nags. Shown
 * only to a role that may import clients, which the caller decides with
 * `canImport` — a link to an import the role would be refused is no offer.
 */
export function ClientsStart({
  locale,
  onLater,
  heading = "h2",
}: {
  locale: AppLocale;
  onLater: () => void;
  /** `h1` when it is the whole screen, as it is after «Ваш прайс и часы». */
  heading?: "h1" | "h2";
}) {
  const t = useTranslator(locale);
  const Heading = heading;

  return (
    <div className="clients-start">
      <Heading>{t("clientsStart.title")}</Heading>
      <p className="muted">{t("clientsStart.lead")}</p>
      <div className="clients-start-actions">
        <Link className="primary-button" href={IMPORT_CLIENTS_FROM_PHONE}>
          {t("clientsStart.phone")}
        </Link>
        <Link className="secondary-button" href={IMPORT_CLIENTS_FROM_FILE}>
          {t("clientsStart.file")}
        </Link>
        <button className="secondary-button" type="button" onClick={onLater}>
          {t("clientsStart.later")}
        </button>
      </div>
    </div>
  );
}

/** The same question as a panel on an empty client list, where «Позже» just folds it away. */
export function ClientsStartPanel({ locale }: { locale: AppLocale }) {
  const [later, setLater] = useState(false);
  if (later) return null;
  return (
    <section className="panel">
      <ClientsStart locale={locale} onLater={() => setLater(true)} />
    </section>
  );
}
