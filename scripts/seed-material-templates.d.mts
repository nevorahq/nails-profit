/**
 * Types for the template seeding command, so the test that runs its validation
 * over the shipped catalogue is checked like the rest of the suite.
 *
 * The module itself stays plain JavaScript, like every other operator script
 * here: it has to run under `node scripts/…` with no build step, because a
 * command that needs the app compiled first is a command nobody runs during a
 * deploy.
 */
export type SeedTemplate = Readonly<{
  slug: string;
  brand: string | null;
  name: Readonly<Record<string, string>>;
  systemKey: string | null;
  category: string;
  packageSize: number | null;
  baseUnit: string;
  kind: string;
  isCore: boolean;
  profiles: readonly string[];
  sortOrder: number;
}>;

/** Mirrors `toMilliUnits` in domain/units.ts. */
export declare function toMilliUnits(quantity: number | null): number | null;

/** Every problem in the file, named by slug; empty when the catalogue is sound. */
export declare function validate(templates: readonly SeedTemplate[]): string[];

export declare function urlVariablesFor(argv: readonly string[]): string[];
