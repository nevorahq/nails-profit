import {
  bookingSettings,
  commissionRules,
  expenses,
  locations,
  scheduleRules,
  services,
  specialistLocations,
  specialists,
} from "@/db/schema";
import type { TenantTransaction } from "@/db/tenant";
import type { Currency } from "@/domain/money";
import { catalogueEntry } from "@/domain/service-catalogue";
import { slugCandidatesFor } from "@/domain/slug";
import type { AppLocale } from "@/i18n/messages";
import { getTranslator } from "@/i18n/t";

/**
 * Everything a studio used to be sent around the product to enter, written in
 * the transaction that creates the studio itself.
 *
 * The setup used to end at an organization row, and the product then asked for
 * the rest one screen at a time: a commission rule on `/app/specialists`, a
 * priced service on `/app/services`, working hours on `/app/booking`, the rent
 * on `/app/expenses`. Four addresses, each reached from a checklist, each
 * answering nothing on its own — and the first number the owner came for
 * waiting behind all four.
 *
 * All of it is answerable on one screen because none of it is a fact only the
 * product knows: a rate, a few prices, a working week and a monthly rent. What
 * this module does is write them where they belong, at once, so that the
 * workspace that comes out of registration is a workspace rather than a to-do
 * list.
 *
 * One transaction with the organization, deliberately. The previous split —
 * organization first, location afterwards from the browser, failure ignored —
 * could leave an owner with a studio and no address, and resubmitting the form
 * is refused as MEMBERSHIP_EXISTS. Everything here either lands together or
 * does not land at all, and what does not land is a registration the owner can
 * simply repeat.
 */

export type WorkspaceServicePlan = Readonly<{
  /** A key of the fixed catalogue; the name is taken from there in all three languages. */
  key: string;
  priceMinor: number;
  durationMinutes: number;
}>;

export type WorkspaceWorkweek = Readonly<{
  weekdays: readonly number[];
  startMinute: number;
  endMinute: number;
}>;

export type WorkspacePlan = Readonly<{
  address?: string;
  /** IANA name of the browser that registered; falls back to the organization's own. */
  timezone?: string;
  /** The default rule every specialist created here is given. 4000 = 40%. */
  commissionBasisPoints?: number;
  /**
   * Whether the owner takes clients themselves, which is not what the format
   * says and used to be read off it.
   *
   * `solo` meant «I work alone» and therefore «I am the master»; `studio` meant
   * nothing at all, so the woman who owns a studio of three and stands at a
   * table herself was described nowhere — she had to find «Это я» on a screen
   * she had no reason to open. Asked directly instead, and the format goes back
   * to deciding wording.
   */
  ownerWorks?: boolean;
  /** What the owner's card is called, when the studio's own name is not it. */
  ownerName?: string;
  /**
   * Whether the studio's public page goes live with the workspace.
   *
   * The other half of this answer is `organization.booking_access`, set in
   * `POST /api/v1/organizations` where the row is written — both are needed
   * before `/book/<slug>` answers anything but 404.
   */
  publishBooking?: boolean;
  /** Other people who work here, named on the form. */
  masters?: readonly string[];
  services?: readonly WorkspaceServicePlan[];
  workweek?: WorkspaceWorkweek;
  rentMinor?: number;
}>;

export type ProvisionedWorkspace = Readonly<{
  locationId: string;
  specialistIds: readonly string[];
  serviceIds: readonly string[];
}>;

export async function provisionWorkspace(
  tx: TenantTransaction,
  options: {
    organization: Readonly<{
      id: string;
      name: string;
      currency: Currency;
      locale: AppLocale;
      timezone: string;
    }>;
    /** Who is registering. Their card, when they take clients, is linked to this account. */
    actor: Readonly<{ userId: string }>;
    plan: WorkspacePlan;
  },
): Promise<ProvisionedWorkspace> {
  const { organization, actor, plan } = options;
  const audit = { createdBy: actor.userId, updatedBy: actor.userId };

  /*
   * The studio's first address.
   *
   * Without one the rota cannot be written at all — a schedule belongs to a
   * specialist *at an address* — so the last step of the month's checklist used
   * to send an owner to a screen that first demanded something nobody had told
   * them about. The one fact only they know is asked on the form; the rest is
   * derived: the address is named after the studio, its link is the
   * transliteration of that name, and the timezone is the browser's own.
   *
   * `slugCandidatesFor` rather than `slugify`, because the latter can return
   * something `checkSlug` refuses — a name of two letters, or one made
   * entirely of punctuation. The first candidate is always usable, and inside
   * a brand-new organization it cannot collide with anything.
   */
  const [location] = await tx
    .insert(locations)
    .values({
      organizationId: organization.id,
      name: organization.name,
      slug: slugCandidatesFor(organization.name)[0],
      address: plan.address?.trim() || null,
      timezone: plan.timezone ?? organization.timezone,
      ...audit,
    })
    .returning({ id: locations.id });

  /*
   * Its booking settings, written in the same transaction exactly as
   * `POST /api/v1/locations` writes them: settings that exist are easier to
   * reason about than nulls meaning «спросите где-нибудь ещё», and the
   * availability engine can neither publish an address without them nor refuse
   * to. Defaults all the way down — the studio changes them in «Запись» when it
   * wants a different step or a longer buffer.
   */
  await tx.insert(bookingSettings).values({
    organizationId: organization.id,
    locationId: location.id,
    ...(plan.publishBooking
      ? {
          publicStatus: "published" as const,
          /*
           * Manual, and only for a page published by registration itself.
           *
           * What is on that page in its first minute is a price the product
           * suggested and hours nobody chose — so `instant`, the default
           * everywhere else, would hand a client a *confirmed* appointment on
           * terms the studio has not agreed to. As a request it is safe: the
           * owner is notified, and says yes or no. The switch back to instant
           * lives in «Онлайн-запись», to be flipped when the prices are real.
           */
          confirmationMode: "manual" as const,
        }
      : {}),
    ...audit,
  });

  /*
   * Who works here, starting with whoever is filling the form in.
   *
   * Two things are written with the owner's card and neither can be guessed
   * afterwards. `userId` is what every "own" scope resolves through — their
   * calendar, their visits, the notice that a client just booked *them*.
   * `isPrincipal` is what tells `domain/period-pl.ts` that the commission
   * booked to this person never left the business; without it an owner who
   * works reads a monthly profit understated by the whole cost of her own
   * work, and nothing on any screen says so.
   *
   * The other names are cards, not accounts: no `userId`, no principal mark.
   * Which of a studio's masters is the owner is answered above, by the person
   * who knows, and asking it twice is how the two answers come to disagree.
   */
  const specialistIds: string[] = [];
  if (plan.ownerWorks) {
    const [card] = await tx
      .insert(specialists)
      .values({
        organizationId: organization.id,
        userId: actor.userId,
        /*
         * The studio's own name unless the form said otherwise.
         *
         * Sign-up asks what the studio is called, so for somebody working
         * alone the two names are one thing and «Nails by Irina» in the
         * calendar is the truth rather than a placeholder. A studio of three
         * sends `ownerName`, because a client picking out of «Studio Belle»,
         * «Ana» and «Maria» would be reading a bug.
         */
        name: plan.ownerName ?? organization.name,
        cooperationType: "commission",
        isPrincipal: true,
        ...audit,
      })
      .returning({ id: specialists.id });
    specialistIds.push(card.id);
  }

  for (const name of plan.masters ?? []) {
    const [created] = await tx
      .insert(specialists)
      .values({
        organizationId: organization.id,
        name,
        cooperationType: "commission",
        ...audit,
      })
      .returning({ id: specialists.id });
    specialistIds.push(created.id);
  }

  /*
   * Where each of them works, which is the row a client's booking page depends
   * on and the one nothing used to write.
   *
   * `specialist_location` was only ever created by
   * `PUT /api/v1/specialists/[id]/locations`, two selects deep inside
   * «Онлайн-запись». A master without it keeps a rota, appears in the calendar
   * and is dropped from `publicSpecialistsFor` without a word — the studio
   * publishes a page and finds its own people missing from it.
   */
  if (specialistIds.length > 0) {
    await tx.insert(specialistLocations).values(
      specialistIds.map((specialistId) => ({
        organizationId: organization.id,
        specialistId,
        locationId: location.id,
        ...audit,
      })),
    );
  }

  /*
   * The rate, applied to everybody the same way.
   *
   * Unrestricted — no `serviceId`, no rows in `commission_rule_service` — so it
   * pays on every service including the ones added next year, which is what
   * `loadOnboarding` measures and what `selectCommissionRule` applies when a
   * visit is closed. A studio that pays differently per person edits the cards;
   * what this prevents is the studio that cannot close its first visit because
   * nobody told it a rule was required.
   */
  if (plan.commissionBasisPoints !== undefined) {
    for (const specialistId of specialistIds) {
      await tx.insert(commissionRules).values({
        organizationId: organization.id,
        specialistId,
        type: "percentage",
        basisPoints: plan.commissionBasisPoints,
        ...audit,
      });
    }
  }

  /*
   * The catalogue, named by the product and priced by the owner.
   *
   * The name comes from `domain/service-catalogue.ts` rather than from the
   * request: it is the one moment all three languages can be filled in without
   * anybody typing a service name twice, and a key the catalogue does not know
   * is refused before this transaction starts.
   */
  const serviceIds: string[] = [];
  for (const planned of plan.services ?? []) {
    const entry = catalogueEntry(planned.key);
    if (!entry) continue;
    const [created] = await tx
      .insert(services)
      .values({
        organizationId: organization.id,
        name: entry.name,
        priceMinor: planned.priceMinor,
        durationMinutes: planned.durationMinutes,
        currency: organization.currency,
        ...audit,
      })
      .returning({ id: services.id });
    serviceIds.push(created.id);
  }

  /*
   * The working week, which is two things at once: the hours a client is
   * offered free slots in, and the hours break-even is computed from. Written
   * for everybody who works here, at the address created above, from today.
   *
   * Nothing to close first — this is the first rota this organization has ever
   * had, so the overlap handling `PUT /availability/rules` needs has nothing to
   * act on.
   */
  if (plan.workweek && specialistIds.length > 0) {
    const effectiveFrom = new Date().toISOString().slice(0, 10);
    const rows = specialistIds.flatMap((specialistId) =>
      plan.workweek!.weekdays.map((weekday) => ({
        organizationId: organization.id,
        specialistId,
        locationId: location.id,
        weekday,
        startMinute: plan.workweek!.startMinute,
        endMinute: plan.workweek!.endMinute,
        effectiveFrom,
        ...audit,
      })),
    );
    if (rows.length > 0) await tx.insert(scheduleRules).values(rows);
  }

  /*
   * The rent, as the recurring row it is.
   *
   * One row with an interval rather than a payment entered twelve times: that
   * is what `domain/expense-periods.ts` reads, and what makes the month's
   * operating profit something other than the contribution margin wearing its
   * name. Starting from the first of the current month, because a studio
   * registering on the 20th pays this month's rent too.
   *
   * Named in the organization's own language — the ledger shows the name, and
   * «Rent» in a Russian ledger is a row nobody recognises as theirs.
   */
  if (plan.rentMinor !== undefined && plan.rentMinor > 0) {
    const t = getTranslator(organization.locale);
    await tx.insert(expenses).values({
      organizationId: organization.id,
      name: t("expenses.category.rent"),
      category: "rent",
      amountMinor: plan.rentMinor,
      currency: organization.currency,
      isRecurring: true,
      recurringFrom: `${new Date().toISOString().slice(0, 7)}-01`,
      ...audit,
    });
  }

  return { locationId: location.id, specialistIds, serviceIds };
}
