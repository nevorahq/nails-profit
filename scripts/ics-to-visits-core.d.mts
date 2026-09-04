/**
 * Types for the calendar converter, so the integration test that runs a feed
 * all the way into a costed visit is checked like the rest of the suite.
 *
 * The module itself stays plain JavaScript, like every other core in this
 * directory: the owner runs it with `node scripts/…` against a file they just
 * downloaded, and a migration tool that needs a build step first is a tool that
 * gets skipped in favour of retyping the visits by hand.
 */
export type IcsProperty = Readonly<{
  name: string;
  params: Record<string, string>;
  value: string;
}>;

export type WallTime = Readonly<{
  year: number;
  month: number;
  day: number;
  /** Minutes from local midnight, so arithmetic never touches a clock string. */
  minutes: number;
}>;

export type IcsEvent = Readonly<{
  uid: string;
  summary: string;
  description: string;
  location: string;
  status: string;
  recurring: boolean;
  allDay: boolean;
  start: Date | null;
  durationMinutes: number | null;
}>;

export type TitleParts = Readonly<{ client: string; service: string }>;

export type ReadOptions = Readonly<{
  order?: "client-service" | "service-client";
  services?: ReadonlySet<string> | null;
  specialist?: string;
}>;

export type RowOptions = ReadOptions &
  Readonly<{ timeZone?: string; from?: Date | null; to?: Date | null }>;

export type SkippedCounts = Readonly<{
  cancelled: number;
  recurring: number;
  allDay: number;
  undated: number;
  outOfRange: number;
}>;

export type RowsResult = Readonly<{
  rows: string[][];
  skipped: SkippedCounts;
  missingSpecialist: number;
  missingService: number;
}>;

export type FeedReport = Readonly<{
  total: number;
  cancelled: number;
  recurring: number;
  allDay: number;
  withDescription: number;
  earliest: Date | null;
  latest: Date | null;
  titles: readonly Readonly<{ summary: string; count: number }>[];
  descriptions: readonly string[];
}>;

export declare const VISIT_HEADERS: readonly string[];

export declare function unfoldLines(text: string): string[];
export declare function parseContentLine(line: string): IcsProperty | null;
export declare function unescapeText(value: string): string;

export declare function instantToWall(instant: Date, timeZone: string): WallTime;
export declare function wallTimeToInstant(wall: WallTime, timeZone: string): Date;
export declare function propertyToInstant(property: IcsProperty, studioZone: string): Date | null;
export declare function parseIcsDuration(value: string): number | null;
export declare function formatWall(wall: WallTime): string;

export declare function parseIcs(text: string, studioZone?: string): IcsEvent[];
export declare function selectEvents(
  events: readonly IcsEvent[],
  options?: Readonly<{ from?: Date | null; to?: Date | null }>,
): { kept: IcsEvent[]; skipped: SkippedCounts };
export declare function eventsToRows(events: readonly IcsEvent[], options?: RowOptions): RowsResult;

export declare function readLabelled(description: string): Partial<
  Record<"client" | "service" | "specialist", string>
>;
export declare function splitTitle(summary: string, options?: ReadOptions): TitleParts;
export declare function normalizeName(value: string): string;
export declare function readEvent(
  event: IcsEvent,
  options?: ReadOptions,
): Readonly<{ client: string; service: string; specialist: string }>;

export declare function looksLikeFormula(value: string): boolean;
export declare function escapeCsvCell(value: string, delimiter?: string): string;
export declare function toCsv(rows: readonly (readonly string[])[], delimiter?: string): string;
export declare function inspect(events: readonly IcsEvent[], limit?: number): FeedReport;
