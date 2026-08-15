/**
 * Where a material — and each of its purchase prices — came from, epic E3.1 §F5.
 *
 * Provenance is not decoration. The costing engine gives one number per visit
 * and the owner has to decide whether to trust it; "this price is what you
 * typed" and "this price arrived in a pasted block of 40 rows" are different
 * claims about that number. So the source is stored per material *and* per
 * price version, because a template-created material whose price was later
 * pasted is neither purely one nor the other.
 */
export const materialDataSources = ["manual", "template", "bulk_paste", "import"] as const;
export type MaterialDataSource = (typeof materialDataSources)[number];

/**
 * Whether a material stands for one purchasable package or a group of them.
 *
 * An `aggregate` is the owner's answer to a catalogue they will never finish
 * typing: one row for "coloured gel polish" priced at the average they pay,
 * instead of thirty bottles they would have to keep priced individually.
 *
 * Deliberately inert in the arithmetic. The costing engine reads a package
 * price and a package size and does not ask what the row means — an aggregate
 * whose average is 185 MDL per 8 ml costs exactly what an SKU with those
 * numbers costs. The distinction exists so the interface can say what the row
 * is and so a later analysis can tell an estimate from a measurement; making it
 * a second code path would be inventing a parallel costing engine for no
 * difference in the result.
 */
export const materialKinds = ["sku", "aggregate"] as const;
export type MaterialKind = (typeof materialKinds)[number];

/**
 * The kinds of work a template belongs to, used to pre-fill Fast Setup.
 *
 * A template can carry several: gloves are needed for all three, and a list
 * that made the owner pick a single profile would hide half their materials.
 */
export const materialProfiles = ["manicure", "pedicure", "extension"] as const;
export type MaterialProfile = (typeof materialProfiles)[number];

export function isMaterialProfile(value: string): value is MaterialProfile {
  return (materialProfiles as readonly string[]).includes(value);
}
