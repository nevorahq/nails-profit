-- A studio chooses how much finance it reads.
--
-- `detailed_analytics` is «Подробная финансовая аналитика» in Настройки: off,
-- the reports say «выручка, расходы, осталось»; on, they keep the economist's
-- terms — economic profit, the owner's imputed wage and its add-back, the
-- reserve, «Можно вывести», practical capacity. Wording and visibility only;
-- no figure is computed differently either side of it.
--
-- Off for every organization registered from now on. For the ones that exist,
-- on wherever turning it off would take something away from somebody who uses
-- it: a wage set for the owner's own work, a reserve, or an owner who takes
-- visits under a rule that books their work at a price — the month's report
-- adds that commission back on a line the plain view does not draw, and those
-- studios keep reading their months exactly as they did. Defaulted and
-- NOT NULL, so the previous version, which never names the column, keeps
-- writing organizations.

ALTER TABLE "organization" ADD COLUMN "detailed_analytics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organization" AS o SET "detailed_analytics" = true
WHERE o."withdrawal_reserve_minor" > 0
  OR EXISTS (
    SELECT 1 FROM "labor_cost_rule" AS l
    WHERE l."organization_id" = o."id" AND l."recipient"::text = 'owner'
  )
  OR EXISTS (
    SELECT 1 FROM "commission_rule" AS r
    JOIN "specialist" AS s ON s."id" = r."specialist_id"
    WHERE r."organization_id" = o."id"
      AND s."is_principal"
      AND (coalesce(r."basis_points", 0) > 0 OR coalesce(r."fixed_amount_minor", 0) > 0)
  );
