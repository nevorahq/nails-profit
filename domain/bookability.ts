/**
 * Whether a client could pick this master on the studio's own page, and what is
 * missing when they could not.
 *
 * Two rows have to exist before anybody appears in online booking, and they are
 * written on two different screens: a `specialist_location` tying them to an
 * address, and `schedule_rule` hours for that pair. `publicSpecialistsFor`
 * joins on the first and `assignableSpecialist` refuses «not_at_location»
 * without it, so an unassigned master is bookable nowhere — not, as the staff
 * calendar reads it, everywhere.
 *
 * The studio's own checklist used to ask both questions as «хоть кто-то»: it
 * was satisfied when one published address had somebody on it and one master
 * anywhere had hours. A studio of three where one woman's week was filled read
 * «Всё готово: клиент может открыть страницу и записаться», and the other two
 * were invisible to every client — which is the failure a studio actually has,
 * and the one nothing named.
 *
 * Not a blocker, and that is deliberate: a studio may keep somebody out of
 * online booking on purpose — a trainee, a master who only takes regulars by
 * phone. The answer is a sentence naming them, not a refusal.
 */
export type Bookability =
  /** A client can reach them at a published address. */
  | "bookable"
  /** Nobody has said which address they work at. */
  | "no_address"
  /** They have an address and no hours in it. */
  | "no_hours";

export function bookabilityOf(
  input: Readonly<{
    /** Addresses a client can actually open — active and published. */
    publishedLocationIds: readonly string[];
    /** Where this master is assigned, published or not. */
    assignedLocationIds: readonly string[];
    /** Where this master has rota hours, published or not. */
    rotaLocationIds: readonly string[];
  }>,
): Bookability {
  const published = new Set(input.publishedLocationIds);
  const assignedHere = input.assignedLocationIds.filter((id) => published.has(id));
  if (assignedHere.length === 0) return "no_address";

  const rota = new Set(input.rotaLocationIds);
  return assignedHere.some((id) => rota.has(id)) ? "bookable" : "no_hours";
}

/**
 * The masters a client cannot reach, in the order they were given.
 *
 * Answers nothing when there is no published address at all: that studio has
 * not opened its page yet, and saying that nobody can be booked would be an
 * accusation where the existing «опубликуйте адрес» is an instruction.
 */
export function unbookableAmong<T>(
  people: readonly T[],
  publishedLocationIds: readonly string[],
  facts: (person: T) => Readonly<{ assignedLocationIds: readonly string[]; rotaLocationIds: readonly string[] }>,
): readonly T[] {
  if (publishedLocationIds.length === 0) return [];
  return people.filter(
    (person) => bookabilityOf({ publishedLocationIds, ...facts(person) }) !== "bookable",
  );
}
