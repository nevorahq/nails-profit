import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * The period and specialist filter, shared by the report and the visit list.
 *
 * The specialist select is omitted rather than disabled when the caller's scope
 * is "own": section 6.1 limits a Master to their own rows, and a control that
 * cannot change anything only invites the question of why it is there.
 */
export function PeriodFilter({
  locale,
  from,
  to,
  specialistId,
  people,
  showSpecialist,
}: {
  locale: AppLocale;
  from?: string;
  to?: string;
  specialistId?: string;
  people: readonly { id: string; name: string }[];
  showSpecialist: boolean;
}) {
  const t = getTranslator(locale);

  return (
    <form className="inline-form" method="get">
      <label>
        {t("filters.from")}
        <input type="date" name="from" defaultValue={from ?? ""} />
      </label>
      <label>
        {t("filters.to")}
        <input type="date" name="to" defaultValue={to ?? ""} />
      </label>
      {showSpecialist && (
        <label>
          {t("filters.specialist")}
          <select name="specialist" defaultValue={specialistId ?? ""}>
            <option value="">{t("filters.all")}</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="secondary-button" type="submit">
        {t("filters.apply")}
      </button>
    </form>
  );
}
