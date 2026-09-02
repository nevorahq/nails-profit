import { request as newRequest, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

/** What `browser.newContext({ storageState })` accepts, as Playwright types it. */
type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

/**
 * A studio, built over HTTP so a browser test can start at the screen it is
 * about to test.
 *
 * `tests/helpers/studio.ts` does the same thing for the vitest suites, but it
 * cannot be reused here: it imports the route modules and calls them in
 * process, and Playwright drives a server that is a separate process with its
 * own connections. So the setup enters where the browser enters — sign-up over
 * Better Auth's own endpoint, then the same `/api/v1` calls an owner's clicks
 * would make. Nothing is written straight to the database, which means a seed
 * that stops working is a product that stopped working.
 *
 * Every fixture is disposable: each test gets its own studio, its own accounts
 * and its own e-mail addresses, so the suite can run fully parallel against one
 * database without two tests sharing a row.
 */
export const PASSWORD = "orchid-lacquer-42-crown";

/** UTC everywhere: a local date in the fixture is then the date in the URL. */
export const TIMEZONE = "UTC";

export const CANONICAL = {
  servicePriceMinor: 60_000,
  serviceDurationMinutes: 90,
  commissionBasisPoints: 4_000,
} as const;

/**
 * One namespace per test, per project, per worker.
 *
 * Playwright runs the same file under `chromium` and `mobile-chromium`, in
 * parallel, and both would otherwise sign up the same address — an account
 * collision that reads as an authentication bug rather than as two tests
 * colliding.
 */
export function uniqueSuffix(testInfo: TestInfo): string {
  return `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

type Json = Record<string, unknown>;

/** An API client carrying one account's session cookie. */
export type Account = Readonly<{
  email: string;
  request: APIRequestContext;
  /** Handed to `browser.newContext({ storageState })` to open the app signed in. */
  storageState: () => Promise<StorageState>;
  post: <T>(path: string, body?: Json, headers?: Record<string, string>) => Promise<T>;
  put: <T>(path: string, body?: Json) => Promise<T>;
  patch: <T>(path: string, body?: Json) => Promise<T>;
  get: <T>(path: string) => Promise<T>;
  dispose: () => Promise<void>;
}>;

type Envelope<T> = Readonly<{ data?: T; error?: { code: string; message: string } }>;

async function unwrap<T>(response: { status: () => number; text: () => Promise<string> }, path: string): Promise<T> {
  const raw = await response.text();
  let body: Envelope<T> | null;
  try {
    body = raw ? (JSON.parse(raw) as Envelope<T>) : null;
  } catch {
    throw new Error(`${path} answered ${response.status()} with non-JSON: ${raw.slice(0, 200)}`);
  }
  if (body?.error) {
    throw new Error(`${path} answered ${response.status()} ${body.error.code}: ${body.error.message}`);
  }
  if (body?.data === undefined) {
    throw new Error(`${path} answered ${response.status()} without data: ${raw.slice(0, 200)}`);
  }
  return body.data;
}

/**
 * Registers an account and keeps its session.
 *
 * `legalAccepted` is required by the Better Auth configuration rather than by
 * this helper: the product cannot create an account without it, so neither can
 * the fixture.
 */
export async function signUp(
  baseURL: string,
  options: Readonly<{ email: string; name?: string }>,
): Promise<Account> {
  const context = await newRequest.newContext({ baseURL });
  const response = await context.post("/api/auth/sign-up/email", {
    data: {
      email: options.email,
      password: PASSWORD,
      name: options.name ?? "Playwright Owner",
      legalAccepted: true,
    },
  });

  if (response.status() >= 400) {
    throw new Error(`sign-up for ${options.email} failed: ${response.status()} ${await response.text()}`);
  }

  const call = async <T>(
    method: "post" | "put" | "patch",
    path: string,
    body?: Json,
    headers?: Record<string, string>,
  ) => unwrap<T>(await context[method](path, { data: body ?? {}, headers }), path);

  return {
    email: options.email,
    request: context,
    storageState: () => context.storageState(),
    post: (path, body, headers) => call("post", path, body, headers),
    put: (path, body) => call("put", path, body),
    patch: (path, body) => call("patch", path, body),
    get: async <T>(path: string) => unwrap<T>(await context.get(path), path),
    dispose: () => context.dispose(),
  };
}

export type Studio = Readonly<{
  owner: Account;
  organizationId: string;
  locationId: string;
  serviceId: string;
  /** The specialist the master account is linked to. */
  specialistId: string;
  specialistName: string;
  master: Account;
  /** A second specialist with no account, for scope tests. */
  colleagueId: string;
  colleagueName: string;
  slug: string;
}>;

/**
 * The studio the browser tests share: one location, one service, two
 * specialists — one of them an account that can sign in as a Master — and a
 * rota wide enough that no test has to think about opening hours.
 *
 * Confirmation is manual, because the screens under test are the ones a studio
 * sees when a request is waiting: instant confirmation has no request to answer.
 */
export async function seedStudio(
  baseURL: string,
  testInfo: TestInfo,
  options: Readonly<{ confirmationMode?: "instant" | "manual" }> = {},
): Promise<Studio> {
  const suffix = uniqueSuffix(testInfo);
  const owner = await signUp(baseURL, { email: `pw-owner-${suffix}@example.com`, name: "Owner Olsen" });

  const organization = await owner.post<{ id: string }>("/api/v1/organizations", {
    name: `PW Studio ${suffix}`.slice(0, 60),
    type: "studio",
    currency: "MDL",
    // English, so the assertions read the same strings the dictionary ships
    // rather than a translation that may be revised.
    locale: "en",
  });

  const slug = `pw-${suffix}`.slice(0, 40);
  // Published, because the only thing that produces a request waiting on an
  // answer is a client booking online: a staff-created appointment is confirmed
  // by the act of creating it (`confirmationMode: "instant"` in the bookings
  // endpoint). A fixture that skipped the public page could not reach the
  // screens this suite is about.
  await owner.patch("/api/v1/organizations/settings", { slug, booking_access: "public" });

  const location = await owner.post<{ id: string }>("/api/v1/locations", {
    name: "Central",
    slug: "central",
    address: "10 Test Street",
    timezone: TIMEZONE,
  });

  await owner.put(`/api/v1/locations/${location.id}/booking-settings`, {
    public_status: "published",
    confirmation_mode: options.confirmationMode ?? "manual",
    min_lead_minutes: 0,
    max_advance_days: 90,
    confirmation_ttl_minutes: 1_440,
  });

  const service = await owner.post<{ id: string }>("/api/v1/services", {
    name: { en: "Manicure with coating" },
    price_minor: CANONICAL.servicePriceMinor,
    duration_minutes: CANONICAL.serviceDurationMinutes,
  });

  // The Master is invited the way the product invites: an invitation issued by
  // the owner and accepted by an account with that address. Their specialist
  // card is then created carrying `user_id`, which is the link every "own
  // calendar" narrowing in `lib/booking-access.ts` reads.
  const masterEmail = `pw-master-${suffix}@example.com`;
  const invitation = await owner.post<{ token: string }>("/api/v1/invitations", {
    email: masterEmail,
    role: "master",
  });
  const master = await signUp(baseURL, { email: masterEmail, name: "Mara Master" });
  await master.post("/api/v1/invitations/accept", { token: invitation.token });

  // Accepting an invitation answers with the organization and the role, not
  // with the account's own id — so it is read from the session, which is where
  // the browser reads it too.
  const session = (await (await master.request.get("/api/auth/get-session")).json()) as {
    user?: { id?: string };
  };
  const masterUserId = session.user?.id;
  if (!masterUserId) throw new Error("the invited master has no session to link a specialist card to");

  const specialistName = "Mara Master";
  const specialist = await owner.post<{ id: string }>("/api/v1/specialists", {
    name: specialistName,
    user_id: masterUserId,
    default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
  });

  const colleagueName = "Cora Colleague";
  const colleague = await owner.post<{ id: string }>("/api/v1/specialists", {
    name: colleagueName,
    default_rule: { type: "percentage", basis_points: CANONICAL.commissionBasisPoints },
  });

  for (const id of [specialist.id, colleague.id]) {
    await owner.put(`/api/v1/specialists/${id}/locations`, { location_ids: [location.id] });
    await owner.put("/api/v1/availability/rules", {
      specialist_id: id,
      location_id: location.id,
      effective_from: isoDate(daysFromToday(-1)),
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "08:00", end: "20:00" })),
    });
  }

  return {
    owner,
    organizationId: organization.id,
    locationId: location.id,
    serviceId: service.id,
    specialistId: specialist.id,
    specialistName,
    master,
    colleagueId: colleague.id,
    colleagueName,
    slug,
  };
}

export async function disposeStudio(studio: Studio) {
  await Promise.all([studio.owner.dispose(), studio.master.dispose()]);
}

/** A date `offset` days from today, in UTC — the fixture's location zone. */
export function daysFromToday(offset: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

/**
 * A client's address, unique per caller.
 *
 * The public endpoints limit anonymous callers by forwarded address
 * (`callerKey` in `lib/rate-limit.ts`): twenty holds in ten minutes, ten
 * bookings in an hour. Every test in this suite calls from 127.0.0.1, so
 * without this they share one client's allowance and the suite starts refusing
 * itself halfway through — a 429 that says nothing about the product. One
 * address per simulated client is also what actually happens in the world.
 */
export function clientAddress(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `203.0.${octet()}.${octet()}`;
}

/**
 * Gives one browser its own client address, on this origin only.
 *
 * `setExtraHTTPHeaders` would put the header on every request the page makes,
 * including the cross-origin analytics scripts — where an unexpected header
 * fails the CORS preflight and fills the console with errors that have nothing
 * to do with the test. Routing is the narrow version: the studio's own origin
 * gets the address, everything else is left exactly as the browser sent it.
 */
export async function useClientAddress(page: Page, baseURL: string, address = clientAddress()) {
  const origin = new URL(baseURL).origin;
  await page.route("**/*", async (route, request) => {
    if (!request.url().startsWith(origin)) return route.continue();
    return route.continue({ headers: { ...request.headers(), "x-forwarded-for": address } });
  });
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** An instant at `HH:MM` UTC on the given day, which the fixture reads as local. */
export function atTime(date: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const instant = new Date(date);
  instant.setUTCHours(hours, minutes, 0, 0);
  return instant;
}

/**
 * A client asking for a time, from outside: the flow behind «клиент отправил
 * запрос мастеру».
 *
 * Three calls, the same three the public page makes — read the free slots, hold
 * one, then turn the hold into a request. The hold is what makes the request
 * honest: without it two clients could be sold the same ten o'clock, and the
 * booking endpoint refuses a request that does not carry one.
 *
 * Returns a `pending_confirmation` booking whenever the location confirms
 * manually, which is what puts a row in the studio's bell.
 */
/**
 * Moves an appointment to an hour ago, over the studio's own endpoint.
 *
 * A visit cannot be closed before its appointment has started — the product
 * refuses it, because closing one days ahead books revenue for work nobody has
 * had — and a browser test cannot wait until tomorrow to click the button. So
 * the studio does what a studio can do on any day it works: it moves the
 * appointment to a time that has passed. Nothing is written behind the
 * product's back here either.
 *
 * Returns the new start, because the day it now sits on is the day the calendar
 * shows it on.
 */
export async function moveIntoThePast(studio: Studio, bookingId: string): Promise<Date> {
  const startsAt = new Date(Date.now() - 60 * 60_000);
  startsAt.setUTCSeconds(0, 0);
  await studio.owner.post(`/api/v1/bookings/${bookingId}/reschedule`, {
    starts_at: startsAt.toISOString(),
  });
  return startsAt;
}

export async function requestAppointmentAsClient(
  baseURL: string,
  studio: Studio,
  options: Readonly<{ date: Date; specialistId?: string; name?: string; afterTime?: string }> = {
    date: daysFromToday(1),
  },
): Promise<{ id: string; status: string }> {
  const anonymous = await newRequest.newContext({
    baseURL,
    extraHTTPHeaders: { "x-forwarded-for": clientAddress() },
  });
  try {
    const day = isoDate(options.date);
    const specialist = options.specialistId ?? studio.specialistId;
    const availability = await unwrap<{ slots: { starts_at: string; specialist_id: string }[] }>(
      await anonymous.get(
        `/api/v1/public/booking/${studio.slug}/availability?location_id=${studio.locationId}` +
          `&service_id=${studio.serviceId}&specialist_id=${specialist}&date=${day}`,
      ),
      "public availability",
    );

    // A slot after `afterTime` when the caller needs two requests on one day to
    // be distinguishable on the screen.
    const slot = options.afterTime
      ? availability.slots.find((candidate) => candidate.starts_at >= `${day}T${options.afterTime}`)
      : availability.slots[0];
    if (!slot) throw new Error(`no free slot on ${day} for specialist ${specialist}`);

    const hold = await unwrap<{ hold_token: string }>(
      await anonymous.post(`/api/v1/public/booking/${studio.slug}/holds`, {
        data: {
          location_id: studio.locationId,
          service_id: studio.serviceId,
          add_on_ids: [],
          specialist_id: slot.specialist_id,
          starts_at: slot.starts_at,
        },
      }),
      "public hold",
    );

    return await unwrap<{ id: string; status: string }>(
      await anonymous.post(`/api/v1/public/booking/${studio.slug}/bookings`, {
        data: {
          hold_token: hold.hold_token,
          service_id: studio.serviceId,
          add_on_ids: [],
          name: options.name ?? "Client Chase",
          phone: `+373 69 ${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
          email: `pw-client-${Math.random().toString(36).slice(2, 8)}@example.com`,
          locale: "en",
          legal_accepted: true,
        },
        headers: { "idempotency-key": `pw-public-${Math.random().toString(36).slice(2)}-${Date.now()}` },
      }),
      "public booking",
    );
  } finally {
    await anonymous.dispose();
  }
}

/**
 * Books an appointment as the studio would from its own calendar.
 *
 * The idempotency key is required by the endpoint, not optional politeness: a
 * booking without one is refused, the same way a double-clicked form is stopped
 * from making two appointments.
 */
export async function bookAppointment(
  actor: Account,
  studio: Studio,
  options: Readonly<{ startsAt: Date; specialistId?: string; clientId?: string | null }>,
): Promise<{ id: string; status: string; version: number }> {
  return actor.post<{ id: string; status: string; version: number }>(
    "/api/v1/bookings",
    {
      location_id: studio.locationId,
      specialist_id: options.specialistId ?? studio.specialistId,
      service_id: studio.serviceId,
      starts_at: options.startsAt.toISOString(),
      ...(options.clientId ? { client_id: options.clientId } : {}),
    },
    { "idempotency-key": `pw-${Math.random().toString(36).slice(2)}-${Date.now()}` },
  );
}
