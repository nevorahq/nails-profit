"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { formatBasisPoints, formatMoneyMinor } from "@/lib/format";

export type SpecialistRow = {
  id: string;
  name: string;
  cooperation_type: string;
  default_rule: {
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
  } | null;
  service_exceptions: {
    service_id: string | null;
    type: string;
    basis_points: number | null;
    fixed_amount_minor: number | null;
  }[];
};

const cooperationLabels: Record<string, string> = {
  commission: "процент",
  rent: "аренда",
  staff: "оклад",
};

function describeRule(rule: SpecialistRow["default_rule"], currency: string) {
  if (!rule) return null;
  if (rule.type === "fixed") {
    return `${formatMoneyMinor(rule.fixed_amount_minor ?? 0, currency)} за услугу`;
  }
  const rate = formatBasisPoints(rule.basis_points);
  return rule.type === "percentage_after_materials" ? `${rate} после материалов` : `${rate} от выручки`;
}

export function SpecialistManager({
  specialists,
  services,
  currency,
  canManage,
}: {
  specialists: SpecialistRow[];
  services: { id: string; name: string }[];
  currency: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(url: string, payload: unknown, form?: HTMLFormElement) {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? "Не удалось сохранить");
      setPending(false);
      return;
    }
    form?.reset();
    setPending(false);
    router.refresh();
  }

  function ruleFromForm(data: FormData) {
    const type = String(data.get("rule_type"));
    const value = Number(String(data.get("rule_value") ?? "").trim());
    if (!Number.isFinite(value)) return null;
    return type === "fixed"
      ? { type, fixed_amount_minor: Math.round(value * 100) }
      : { type, basis_points: Math.round(value * 100) };
  }

  async function createSpecialist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    await send(
      "/api/v1/specialists",
      {
        name: data.get("name"),
        cooperation_type: data.get("cooperation_type"),
        ...(rule ? { default_rule: rule } : {}),
      },
      form,
    );
  }

  async function addException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const rule = ruleFromForm(data);
    if (!rule) {
      setError("Укажите значение комиссии");
      return;
    }
    await send(
      `/api/v1/specialists/${data.get("specialist_id")}/commission-rules`,
      { ...rule, service_id: data.get("service_id") },
      form,
    );
  }

  const withoutRule = specialists.filter(
    (person) => person.cooperation_type === "commission" && person.default_rule === null,
  );

  return (
    <>
      {withoutRule.length > 0 && (
        <div className="warning-banner">
          У {withoutRule.length} мастер(ов) нет правила комиссии. Услуги нельзя посчитать: комиссия не
          считается нулевой, пока правило не задано.
        </div>
      )}

      {!canManage && (
        <div className="warning-banner">
          Ваша роль видит только собственный результат и не может менять правила комиссии.
        </div>
      )}

      {canManage && (
        <section className="panel">
          <h2>Добавить мастера</h2>
          <form className="inline-form" onSubmit={createSpecialist}>
            <label>
              Имя
              <input name="name" required maxLength={200} placeholder="Ирина" />
            </label>
            <label>
              Сотрудничество
              <select name="cooperation_type" defaultValue="commission">
                <option value="commission">процент</option>
                <option value="rent">аренда</option>
                <option value="staff">оклад</option>
              </select>
            </label>
            <label>
              Тип комиссии
              <select name="rule_type" defaultValue="percentage">
                <option value="percentage">процент от выручки</option>
                <option value="percentage_after_materials">процент после материалов</option>
                <option value="fixed">фиксированная сумма</option>
              </select>
            </label>
            <label>
              Значение
              <input name="rule_value" type="number" step="0.01" min="0" placeholder="40" />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? "Сохраняем…" : "Добавить"}
            </button>
          </form>
          <p className="muted">
            Для процента укажите 40 — это 40%. Для фиксированной суммы — сумму в {currency}.
          </p>
        </section>
      )}

      {error && <div className="form-error">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Мастер</th>
            <th>Сотрудничество</th>
            <th>Комиссия по умолчанию</th>
            <th>Исключения по услугам</th>
          </tr>
        </thead>
        <tbody>
          {specialists.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Мастеров пока нет.
              </td>
            </tr>
          )}
          {specialists.map((person) => (
            <tr key={person.id}>
              <td>{person.name}</td>
              <td>{cooperationLabels[person.cooperation_type] ?? person.cooperation_type}</td>
              <td>
                {person.default_rule ? (
                  describeRule(person.default_rule, currency)
                ) : (
                  <span className="badge-warning">не задана</span>
                )}
              </td>
              <td>
                {person.service_exceptions.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <ul className="compact-list">
                    {person.service_exceptions.map((rule) => (
                      <li key={`${person.id}-${rule.service_id}`}>
                        {services.find((service) => service.id === rule.service_id)?.name ?? "услуга"}:{" "}
                        {describeRule(rule, currency)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && specialists.length > 0 && services.length > 0 && (
        <section className="panel">
          <h2>Исключение по услуге</h2>
          <p className="muted">
            Правило для конкретной услуги имеет приоритет над комиссией по умолчанию. Прошлые расчёты не
            меняются — создаётся новая версия правила.
          </p>
          <form className="inline-form" onSubmit={addException}>
            <label>
              Мастер
              <select name="specialist_id">
                {specialists.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Услуга
              <select name="service_id">
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Тип
              <select name="rule_type" defaultValue="percentage">
                <option value="percentage">процент от выручки</option>
                <option value="percentage_after_materials">процент после материалов</option>
                <option value="fixed">фиксированная сумма</option>
              </select>
            </label>
            <label>
              Значение
              <input name="rule_value" type="number" step="0.01" min="0" placeholder="50" required />
            </label>
            <button className="primary-button" type="submit" disabled={pending}>
              Сохранить исключение
            </button>
          </form>
        </section>
      )}
    </>
  );
}

