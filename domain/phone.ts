/**
 * Phone normalization to E.164, spec LOC-005: "Телефон хранится в E.164; ввод
 * допускает локальный формат с выбором страны."
 *
 * Deliberately not a full libphonenumber. The pilot is Moldova with Romania
 * next (roadmap Release C), and a 200 kB dependency to validate two dialling
 * plans would fail the roadmap's own rule about adding weight without measured
 * need. The shape is kept narrow so swapping in a real library later changes one
 * module.
 */

export type SupportedRegion = "MD" | "RO";

type DiallingPlan = Readonly<{
  callingCode: string;
  /** Length of the subscriber number, after the trunk zero is dropped. */
  nationalLength: number;
}>;

const PLANS: Record<SupportedRegion, DiallingPlan> = {
  MD: { callingCode: "373", nationalLength: 8 },
  RO: { callingCode: "40", nationalLength: 9 },
};

export class InvalidPhoneError extends Error {
  constructor(readonly value: string) {
    super(`"${value}" is not a valid phone number`);
    this.name = "InvalidPhoneError";
  }
}

/**
 * Returns E.164 (`+37360123456`) or null when the input cannot be read as a
 * number for the given region. Null rather than throwing: a client record is
 * allowed to have no phone, and a typo should be a field error, not a crash.
 */
export function normalizePhone(input: string, region: SupportedRegion = "MD"): string | null {
  const plan = PLANS[region];
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Everything a human might type between digits: spaces, dashes, dots,
  // brackets and a non-breaking space pasted from a web page.
  const cleaned = trimmed.replace(/[\s ().-]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const digits = cleaned.replace(/^\+/, "");

  // Already international, with or without the plus.
  for (const candidate of Object.values(PLANS)) {
    if (digits.startsWith(candidate.callingCode)) {
      const national = digits.slice(candidate.callingCode.length);
      if (national.length === candidate.nationalLength && !national.startsWith("0")) {
        return `+${candidate.callingCode}${national}`;
      }
    }
  }

  // Local form: an optional trunk zero followed by the subscriber number.
  const national = digits.replace(/^0/, "");
  if (national.length !== plan.nationalLength) return null;
  return `+${plan.callingCode}${national}`;
}

/** True when the two inputs denote the same subscriber. */
export function samePhone(a: string, b: string, region: SupportedRegion = "MD"): boolean {
  const left = normalizePhone(a, region);
  const right = normalizePhone(b, region);
  return left !== null && left === right;
}
