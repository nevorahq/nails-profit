#!/usr/bin/env node

/**
 * What is stuck at sms.md right now, and nothing else.
 *
 * Their message list shows everything the account ever sent, mixed together and
 * newest first. During the incident this exists for, the useful facts were four
 * rows out of eight and the thing that mattered was which carrier they shared —
 * visible only after reading every row. This prints the four.
 *
 * Read-only: it lists messages and reads the balance. It sends nothing, and it
 * cannot — the token's `messages:send` scope is never used here.
 *
 *   npm run ops:smsmd-stuck                 # anything waiting over 15 minutes
 *   npm run ops:smsmd-stuck -- --minutes 60
 *   npm run ops:smsmd-stuck -- --json       # for a check that reads output
 *
 * Exit code 0 when nothing is stuck, 1 when something is, 2 when the script
 * could not find out — so a scheduled run distinguishes "the route is fine"
 * from "nobody answered the door".
 */

import { existsSync } from "node:fs";

import { buildStuckReport, DEFAULT_STUCK_MINUTES } from "./smsmd-stuck-core.mjs";

// Run by a person at a checkout, where the token lives in `.env` — the same
// place `migrate-down.mjs` looks for its URLs.
if (existsSync(".env")) process.loadEnvFile(".env");

const API_BASE = "https://api.sms.md/v3";
/** Their maximum page; one page is far more than an account under diagnosis has. */
const PER_PAGE = 100;

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function readJson(path, token) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "x-api-token": token } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : `http_${response.status}`;
    throw new Error(`${path} refused: ${code}`);
  }
  return body;
}

function line(label, value) {
  return `${label.padEnd(22)}${value}`;
}

async function main() {
  const token = process.env.SMSMD_API_TOKEN;
  if (!token) throw new Error("SMSMD_API_TOKEN is required (put it in .env)");

  const minutes = Number(argument("minutes", DEFAULT_STUCK_MINUTES));
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--minutes must be a number");

  const listed = await readJson(`/messages?perPage=${PER_PAGE}`, token);
  const report = buildStuckReport(listed?.data ?? [], { now: new Date(), minutes });

  /*
   * Asked for but never required. `account:read` is a scope a token may not
   * have, and a missing balance is not a reason to withhold the finding the
   * operator actually came for.
   */
  let balance = null;
  try {
    const read = await readJson("/account/balance", token);
    balance = `${read?.data?.balance} ${read?.data?.currency}`;
  } catch {
    balance = "недоступен (нет скоупа account:read)";
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...report, balance }, null, 2));
  } else if (report.stuck_messages === 0) {
    console.log(
      `Застрявших нет: ${report.messages_examined} сообщений проверено, ` +
        `порог ${minutes} мин. Баланс: ${balance}.`,
    );
  } else {
    console.log(line("Застряло:", `${report.stuck_messages} сообщений, ${report.stuck_segments} сегментов`));
    console.log(line("Старейшему:", `${report.oldest_age_minutes} мин`));
    console.log(line("По маршрутам:", JSON.stringify(report.stuck_by_carrier)));
    if (report.single_carrier_affected) {
      // The one sentence a support ticket should open with.
      console.log(
        line("Диагноз:", `встал ровно один маршрут — «${report.single_carrier_affected}», остальные возят`),
      );
    }
    console.log(line("Баланс:", balance));
    console.log("");
    for (const message of report.messages) {
      console.log(
        `  ${message.id}  ${message.created_at.slice(5, 19).replace("T", " ")}  ` +
          `${String(message.age_minutes).padStart(5)} мин  ${message.to.padEnd(13)} ` +
          `${message.carrier.padEnd(14)} ${String(message.segments).padStart(2)} сегм.  ` +
          `${message.status}${message.untouched ? "  (ни одного изменения)" : ""}`,
      );
    }
  }

  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: npm run ops:smsmd-stuck -- [--minutes 15] [--json]");
    process.exitCode = 2;
  });
}
