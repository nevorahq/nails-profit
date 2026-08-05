"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { OnboardingProgress } from "@/lib/onboarding";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

/**
 * The path to a first number, roadmap phase 4 "onboarding progress".
 *
 * Every step is linked, not just the next one — an owner who already has a
 * price list open should not be walked through a wizard to reach materials.
 * The list is a map of what is missing, not a gate.
 */
export function OnboardingPanel({
  progress,
  starterCount,
  canSeedMaterials,
  locale,
}: {
  progress: OnboardingProgress;
  starterCount: number;
  canSeedMaterials: boolean;
  locale: AppLocale;
}) {
  const router = useRouter();
  const t = getTranslator(locale);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState<number | null>(null);

  async function seedStarterMaterials() {
    setPending(true);
    const response = await fetch("/api/v1/materials/starter", { method: "POST" });
    setPending(false);
    if (!response.ok) return;
    const body = await response.json();
    setAdded(body.data.created);
    router.refresh();
  }

  return (
    <section className="panel">
      <h2>{t("onboarding.title")}</h2>
      <p className="muted">{t("onboarding.progress", { done: progress.done, total: progress.total })}</p>

      <ol className="compact-list">
        {progress.steps.map((step) => (
          <li key={step.key} className={step.done ? "muted" : undefined}>
            <span aria-hidden="true">{step.done ? "✓" : "○"}</span>{" "}
            {step.done ? (
              t(`onboarding.${step.key}` as MessageKey)
            ) : (
              <Link className="text-link" href={step.href}>
                {t(`onboarding.${step.key}` as MessageKey)}
              </Link>
            )}
          </li>
        ))}
      </ol>

      <p className="muted">{t("onboarding.why")}</p>

      {canSeedMaterials && !progress.steps[1].done && (
        <>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              onClick={seedStarterMaterials}
              disabled={pending}
            >
              {pending ? t("common.saving") : t("onboarding.starter")}
            </button>
          </div>
          <p className="muted">{t("onboarding.starterHint", { count: starterCount })}</p>
        </>
      )}

      {added !== null && <p className="muted">{t("onboarding.starterAdded", { count: added })}</p>}
    </section>
  );
}
