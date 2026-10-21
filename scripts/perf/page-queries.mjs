// Seeds a studio on a running server, opens every signed-in page and reports how many
// statements each one sent to the database and how long it took.
//
// The server must be started with DB_QUERY_LOG pointing at a file (see TESTING.md,
// «Задержки и число запросов»). Statements are attributed to a page by the time window of
// its request, so requests are made one at a time with a pause between them.
//
//   BASE_URL=http://localhost:3200 DB_QUERY_LOG=/tmp/q.log node scripts/perf/page-queries.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3200";
const LOG = process.env.DB_QUERY_LOG;
const OUT = process.env.PERF_OUT;
const RUNS = Number(process.env.PERF_RUNS ?? 3);
const VISITS = Number(process.env.PERF_VISITS ?? 60);
const PASSWORD = "orchid-lacquer-42-crown";
const suffix = Date.now().toString(36);

if (!LOG) {
  console.error("DB_QUERY_LOG must name the file the server writes its statements to");
  process.exit(1);
}

const context = await request.newContext({ baseURL: BASE });
const call = async (method, path, data) => {
  const response = await context[method](path, { data: data ?? {} });
  const text = await response.text();
  if (response.status() >= 400) throw new Error(`${method} ${path} ${response.status()} ${text.slice(0, 200)}`);
  const body = text ? JSON.parse(text) : null;
  return body?.data ?? body;
};

const signUp = await context.post("/api/auth/sign-up/email", {
  data: { email: `perf-${suffix}@example.com`, password: PASSWORD, name: "Perf Owner", legalAccepted: true },
});
if (signUp.status() >= 400) throw new Error(`sign-up failed: ${await signUp.text()}`);

await call("post", "/api/v1/organizations", { name: `Perf ${suffix}`, type: "studio", currency: "MDL", locale: "ru", timezone: "UTC" });
const slug = `perf-${suffix}`;
await call("patch", "/api/v1/organizations/settings", { slug, booking_access: "public" });
const location = await call("post", "/api/v1/locations", { name: "Central", slug: "central", address: "10 Test", timezone: "UTC" });
await call("put", `/api/v1/locations/${location.id}/booking-settings`, {
  public_status: "published", confirmation_mode: "instant", min_lead_minutes: 0, max_advance_days: 90, confirmation_ttl_minutes: 1440,
});

const catalogue = [["Manicure", 60000, 90], ["Pedicure", 70000, 90], ["Brows", 40000, 45], ["Lashes", 90000, 120]];
const services = [];
for (const [name, price, minutes] of catalogue) {
  services.push(await call("post", "/api/v1/services", { name: { ru: name }, price_minor: price, duration_minutes: minutes }));
}
await call("post", "/api/v1/organizations/setup", {
  services: services.map((service, index) => ({ id: service.id, price_minor: catalogue[index][1], duration_minutes: catalogue[index][2] })),
});

const specialists = [];
for (const name of ["Anna", "Olga", "Mara", "Cora"]) {
  const specialist = await call("post", "/api/v1/specialists", { name, default_rule: { type: "percentage", basis_points: 4000 } });
  await call("put", `/api/v1/specialists/${specialist.id}/locations`, { location_ids: [location.id] });
  await call("put", "/api/v1/availability/rules", {
    specialist_id: specialist.id,
    location_id: location.id,
    effective_from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "08:00", end: "20:00" })),
  });
  specialists.push(specialist);
}
const clients = [];
for (let i = 0; i < 25; i += 1) clients.push(await call("post", "/api/v1/clients", { name: `Client ${i}`, phone: `+3736000${1000 + i}` }));
for (let i = 0; i < VISITS; i += 1) {
  await call("post", "/api/v1/visits", { specialist_id: specialists[i % 4].id, service_id: services[i % 4].id, client_id: clients[i % 25].id });
}
for (const name of ["Rent", "Polish", "Ads"]) {
  await call("post", "/api/v1/expenses", { name, category: "rent", amount_minor: 50000, spent_on: new Date().toISOString().slice(0, 10) });
}

const cookie = (await context.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const pages = [
  "/app", "/app/calendar", "/app/visits", "/app/visits/new", "/app/clients", `/app/clients/${clients[0].id}`,
  "/app/services", "/app/specialists", "/app/expenses", "/app/reports/month", "/app/reports/services",
  "/app/reports/payouts", "/app/settings", "/app/more", `/book/${slug}`, "/login", "/terms",
  `/api/v1/public/booking/${slug}/availability?location_id=${location.id}&date=${tomorrow}`,
];
// What a visitor with no session sees: these must not reach the database at all.
const anonymousPages = ["/", "/login", "/terms", "/privacy"];

const samples = [];
const visits = [...pages.map((path) => ({ path, anonymous: false })), ...anonymousPages.map((path) => ({ path, anonymous: true }))];
for (const { path, anonymous } of visits) {
  for (let run = 0; run < RUNS; run += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const from = Date.now();
    const started = performance.now();
    const response = await fetch(BASE + path, {
      headers: { ...(anonymous ? {} : { cookie }), "x-forwarded-for": `203.0.113.${1 + Math.floor(Math.random() * 250)}` },
      redirect: "manual",
    });
    const body = await response.arrayBuffer();
    samples.push({ path: path.split("?")[0].replace(/[0-9a-f-]{36}/, ":id") + (anonymous ? " (anon)" : ""), run, status: response.status, ms: Math.round(performance.now() - started), bytes: body.byteLength, from, to: Date.now() });
  }
}

const log = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const path of new Set(samples.map((sample) => sample.path))) {
  // The first request of a page is dropped: it pays for compilation and cold caches.
  const own = samples.filter((sample) => sample.path === path).slice(1);
  const counted = own.map((sample) => {
    const inside = log.filter((entry) => entry.t >= sample.from - 50 && entry.t <= sample.to + 50);
    const statements = inside.filter((entry) => entry.kind === "q").length;
    const transactions = inside.filter((entry) => entry.kind === "tx").length;
    return { statements, transactions };
  });
  rows.push({
    path,
    status: own[0].status,
    statements: median(counted.map((c) => c.statements)),
    transactions: median(counted.map((c) => c.transactions)),
    ms: median(own.map((sample) => sample.ms)),
  });
}

console.log(`${"page".padEnd(34)} ${"status".padStart(6)} ${"stmts".padStart(6)} ${"tx".padStart(4)} ${"ms".padStart(7)}`);
for (const row of rows) {
  console.log(`${row.path.padEnd(34)} ${String(row.status).padStart(6)} ${String(row.statements).padStart(6)} ${String(row.transactions).padStart(4)} ${String(row.ms).padStart(7)}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 2));
await context.dispose();
