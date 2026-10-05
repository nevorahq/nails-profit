"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import type { BusinessType } from "@/i18n/business-labels";
import { useRegister, useTranslator } from "@/components/lexicon-provider";
import { SetupGuideDialog, useSetupGuide, type SetupGuideBaseline } from "@/components/setup-guide";

/**
 * «Как вы платите налоги?» and «Как платят клиенты?», asked on «Деньги» until
 * they are answered — the two last steps of the month's guide, and the reason
 * the report stops saying its profit is before taxes and the bank's fee.
 *
 * Always mounted, answered or not, at the anchor the guide and the report link
 * to: the guide's window is opened by the answer, and the refresh that follows
 * it re-renders this page without the question. A component that unmounted
 * with its question would take the window with it.
 *
 * No rate is ever filled in. What a studio owes the state and its bank is the
 * owner's to say, and a suggested 20% left in place would be a tax the product
 * invented and the report then subtracted. A placeholder would read as one.
 */
export function MoneyQuestion({
  question,
  answered,
  locale,
  businessType,
  monthGuide,
}: {
  question: "taxes" | "payments";
  answered: boolean;
  locale: AppLocale;
  businessType: BusinessType;
  monthGuide: SetupGuideBaseline;
}) {
  const router = useRouter();
  const guide = useSetupGuide(monthGuide, "/api/v1/onboarding/month");

  async function onAnswered() {
    await guide.check();
    router.refresh();
  }

  return (
    <div id={question} className="money-anchor">
      <SetupGuideDialog
        guide={guide}
        locale={locale}
        businessType={businessType}
        strings="monthGuide"
        doneHref="/app/reports/month"
      />
      {!answered &&
        (question === "taxes" ? (
          <TaxesForm locale={locale} onAnswered={onAnswered} />
        ) : (
          <PaymentsForm locale={locale} onAnswered={onAnswered} />
        ))}
    </div>
  );
}

/** "20", "20,5" or "2.2" as basis points, or null when it is not a rate. */
function toBasisPoints(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."));
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

function useAnswer(locale: AppLocale, url: string, onAnswered: () => Promise<void>) {
  const t = useTranslator(locale);
  const register = useRegister();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(payload: unknown) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (!response?.ok) {
      const body = await response?.json().catch(() => null);
      const code = body?.error?.code;
      setError(
        code
          ? getErrorMessage(code, body.error.message ?? t("common.saveFailed"), locale, register)
          : t("common.saveFailed"),
      );
      setPending(false);
      return;
    }
    await onAnswered();
    setPending(false);
  }

  return { t, pending, error, setError, send };
}

const taxAnswers = ["none", "turnover", "vat"] as const;

function TaxesForm({ locale, onAnswered }: { locale: AppLocale; onAnswered: () => Promise<void> }) {
  const { t, pending, error, setError, send } = useAnswer(locale, "/api/v1/onboarding/taxes", onAnswered);
  const [answer, setAnswer] = useState<(typeof taxAnswers)[number] | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (answer === null) return setError(t("money.chooseOne"));
    if (answer === "none") return void send({ answer });
    const rate = toBasisPoints(String(new FormData(event.currentTarget).get("rate") ?? ""));
    if (rate === null) return setError(t("tax.rateRequired"));
    void send({ answer, basis_points: rate });
  }

  return (
    <section className="panel money-question" aria-labelledby="taxes-question">
      <h2 id="taxes-question">{t("money.taxes.question")}</h2>
      <p className="muted">{t("money.taxes.hint")}</p>
      <form className="inline-form" onSubmit={submit}>
        <fieldset className="choice-group">
          <legend className="sr-only">{t("money.taxes.question")}</legend>
          {taxAnswers.map((option) => (
            <div key={option}>
              <label className="checkbox-field">
                <input
                  type="radio"
                  name="answer"
                  value={option}
                  checked={answer === option}
                  onChange={() => {
                    setAnswer(option);
                    setError(null);
                  }}
                />
                {t(`money.taxes.${option}`)}
              </label>
              {answer === option && option !== "none" && (
                <label className="inline-field">
                  {t("tax.rate")}
                  <input name="rate" type="number" inputMode="decimal" step="0.01" min="0" max="100" required />
                </label>
              )}
            </div>
          ))}
        </fieldset>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("money.answer")}
        </button>
      </form>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

const paymentKinds = ["cash", "card", "transfer"] as const;
type PaymentKind = (typeof paymentKinds)[number];

function PaymentsForm({ locale, onAnswered }: { locale: AppLocale; onAnswered: () => Promise<void> }) {
  const { t, pending, error, setError, send } = useAnswer(locale, "/api/v1/onboarding/payments", onAnswered);
  const [chosen, setChosen] = useState<readonly PaymentKind[]>([]);
  const [usual, setUsual] = useState<PaymentKind | null>(null);
  // The most frequent is asked only when there is more than one to choose from.
  const defaultKind = chosen.length === 1 ? chosen[0] : usual && chosen.includes(usual) ? usual : null;

  function toggle(kind: PaymentKind) {
    setError(null);
    setChosen((current) =>
      current.includes(kind) ? current.filter((one) => one !== kind) : paymentKinds.filter((one) => one === kind || current.includes(one)),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen.length === 0) return setError(t("money.payments.pickOne"));
    if (defaultKind === null) return setError(t("money.payments.pickUsual"));
    const card = chosen.includes("card");
    const rate = card ? toBasisPoints(String(new FormData(event.currentTarget).get("card_rate") ?? "")) : null;
    if (card && rate === null) return setError(t("money.payments.cardRateRequired"));
    void send({
      methods: chosen,
      default: defaultKind,
      ...(card ? { card_commission_basis_points: rate } : {}),
    });
  }

  return (
    <section className="panel money-question" aria-labelledby="payments-question">
      <h2 id="payments-question">{t("money.payments.question")}</h2>
      <p className="muted">{t("money.payments.hint")}</p>
      <form className="inline-form" onSubmit={submit}>
        <fieldset className="choice-group">
          <legend className="sr-only">{t("money.payments.question")}</legend>
          {paymentKinds.map((kind) => (
            <div key={kind}>
              <label className="checkbox-field">
                <input type="checkbox" checked={chosen.includes(kind)} onChange={() => toggle(kind)} />
                {t(`payment.kind.${kind}`)}
              </label>
              {kind === "card" && chosen.includes("card") && (
                <label className="inline-field">
                  {t("money.payments.cardRate")}
                  <input name="card_rate" type="number" inputMode="decimal" step="0.01" min="0" max="100" required />
                </label>
              )}
            </div>
          ))}
        </fieldset>
        {chosen.length > 1 && (
          <fieldset className="choice-group">
            <legend>{t("money.payments.usual")}</legend>
            {chosen.map((kind) => (
              <label key={kind} className="checkbox-field">
                <input
                  type="radio"
                  name="usual"
                  value={kind}
                  checked={usual === kind}
                  onChange={() => {
                    setUsual(kind);
                    setError(null);
                  }}
                />
                {t(`payment.kind.${kind}`)}
              </label>
            ))}
          </fieldset>
        )}
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("money.answer")}
        </button>
      </form>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
