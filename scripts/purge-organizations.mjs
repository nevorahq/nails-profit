#!/usr/bin/env node

/**
 * The delete the product does not have.
 *
 * «Удалить данные организации» anonymizes: the name becomes «Удалённая
 * организация …», `deleted_at` is set, memberships go, and the row stays —
 * because the financial tables reference it with ON DELETE RESTRICT and section
 * 15.3 wants exactly that. Deleting the account afterwards removes the person
 * and leaves the studio behind with `created_by` nulled.
 *
 * Correct for a studio that leaves, useless for a database being tested from
 * registration again: the slug is still taken, the address is still taken, and
 * every report still counts an organization nobody can reach. This is the
 * operator-side counterpart — rows actually removed, in the order the live
 * foreign keys allow, inside one transaction that is rolled back unless
 * `--apply` says otherwise.
 *
 *   node scripts/purge-organizations.mjs                 # what would go
 *   node scripts/purge-organizations.mjs --apply --users # and it goes
 *   node scripts/purge-organizations.mjs --orphan-users  # and the accounts
 *                                                        # left behind by an
 *                                                        # earlier one
 */

import { existsSync } from "node:fs";

import { openOperatorConnection } from "./ops-connection.mjs";
import {
  USAGE,
  databaseName,
  deleteOrder,
  formatCounts,
  parseOptions,
  plural,
  resolveTarget,
} from "./purge-organizations-core.mjs";

// Run by a person at a checkout, where the URLs live in `.env` — the same
// reason `migrate-down.mjs` loads it and the scheduled jobs do not.
if (existsSync(".env")) process.loadEnvFile(".env");

/** Thrown to roll back the rehearsal. Not an error; the only way out of a transaction that worked. */
class Rehearsal extends Error {}

/** Every table that carries a tenant, asked of the database rather than remembered. */
async function tenantTables(sql) {
  const rows = await sql`
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'organization_id'
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname
  `;
  return rows.map((row) => row.table_name);
}

async function foreignKeys(sql) {
  const rows = await sql`
    select child.relname as child, parent.relname as parent
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace n on n.oid = child.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
  `;
  return rows.map((row) => ({ child: row.child, parent: row.parent }));
}

async function selectOrganizations(sql, options) {
  if (options.scope === "ids") {
    return sql`select id, name, deleted_at from organization where id in ${sql(options.organizationIds)}`;
  }
  if (options.scope === "all") {
    return sql`select id, name, deleted_at from organization order by created_at`;
  }
  return sql`select id, name, deleted_at from organization where deleted_at is not null order by deleted_at`;
}

/**
 * Who to consider deleting afterwards, collected before the memberships go.
 *
 * An anonymized organization has no memberships left — the delete route removed
 * them — so the only remaining thread back to its owner is `created_by`, which
 * survives until the account itself is deleted. Both are read, and neither is
 * acted on here: a candidate is only deleted below if no membership anywhere
 * else still holds them.
 */
async function peopleBehind(sql, ids) {
  const rows = await sql`
    select user_id as id from membership where organization_id in ${sql(ids)}
    union
    select created_by as id from organization where id in ${sql(ids)} and created_by is not null
    union
    select updated_by as id from organization where id in ${sql(ids)} and updated_by is not null
  `;
  return rows.map((row) => row.id);
}

async function main() {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    console.error(`\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const target = resolveTarget(process.env, options);
  if (target.error) {
    console.error(target.error);
    process.exitCode = 2;
    return;
  }

  const sql = await openOperatorConnection(process.env, [target.variable]);
  console.log(`Database: ${databaseName(target.url)} (${target.variable})`);

  try {
    const organizations = await selectOrganizations(sql, options);
    if (organizations.length === 0 && !options.orphanUsers) {
      console.log("No organization matches. Nothing to do.");
      return;
    }

    if (organizations.length === 0) {
      console.log("\nNo organization matches — the accounts below are the whole of it.");
    } else {
      console.log(`\nOrganizations (${organizations.length}):`);
      for (const organization of organizations) {
        const state = organization.deleted_at ? "deleted" : "LIVE";
        console.log(`  ${organization.id}  ${state.padEnd(7)}  ${organization.name}`);
      }

      const live = organizations.filter((organization) => !organization.deleted_at);
      if (live.length > 0 && options.scope !== "deleted") {
        console.log(
          `\n${live.length} of these are still live — their owners can still sign in and see this data.`,
        );
      }
    }

    const ids = organizations.map((organization) => organization.id);
    const candidates = options.users && ids.length > 0 ? await peopleBehind(sql, ids) : [];

    const tables = await tenantTables(sql);
    const { order, cycle } = deleteOrder(tables, await foreignKeys(sql));
    if (cycle.length > 0) {
      throw new Error(
        `These tables reference each other in a cycle and cannot be ordered: ${cycle.join(", ")}. ` +
          "Break it by nulling one of the references before deleting.",
      );
    }

    const counts = {};
    let removedUsers = 0;
    let orphans = { removed: 0, recent: 0 };

    try {
      await sql.begin(async (tx) => {
        if (ids.length > 0) {
          for (const table of order) {
            const result = await tx`delete from ${tx(table)} where organization_id in ${tx(ids)}`;
            counts[table] = result.count;
          }

          const organizationResult = await tx`delete from organization where id in ${tx(ids)}`;
          counts.organization = organizationResult.count;
        }

        // Only the people this leaves with nothing. Somebody who runs a second
        // studio keeps their account, which is the same judgement the account
        // delete route makes when it refuses an owner.
        if (candidates.length > 0) {
          const userResult = await tx`
            delete from "user"
            where id in ${tx(candidates)}
              and not exists (select 1 from membership where membership.user_id = "user".id)
          `;
          removedUsers = userResult.count;
        }

        /*
         * Everybody else with nothing, and the one number that keeps this
         * honest.
         *
         * `--users` can only reach the people it can prove belong to the
         * organizations above — through a membership, or `created_by` while it
         * still holds a name. After a studio has been anonymized and its owner
         * has deleted their account, neither thread is left, and the accounts
         * that registered and never got as far as a first studio were never on
         * that thread at all. This flag takes them by the only property they
         * share: no membership anywhere.
         *
         * Which is also why the count of the last day is printed. A signup
         * halfway through onboarding is, from here, indistinguishable from an
         * owner who left months ago — the row looks the same. On a database
         * with real registrations a non-zero `recent` is a person, not a
         * leftover, and this is the last moment anybody can tell.
         */
        if (options.orphanUsers) {
          const [seen] = await tx`
            select count(*)::int as total,
                   count(*) filter (where created_at > now() - interval '24 hours')::int as recent
            from "user"
            where not exists (select 1 from membership where membership.user_id = "user".id)
          `;

          const orphanResult = await tx`
            delete from "user"
            where not exists (select 1 from membership where membership.user_id = "user".id)
          `;

          orphans = { removed: orphanResult.count, recent: seen.recent };
        }

        if (!options.apply) throw new Rehearsal();
      });
    } catch (error) {
      if (!(error instanceof Rehearsal)) throw error;
    }

    const verb = options.apply ? "Deleted" : "Would delete";
    const total = Object.values(counts).reduce((sum, rows) => sum + rows, 0);
    console.log(`\n${verb} ${total} rows:`);
    console.log(formatCounts(counts));

    if (options.users) {
      console.log(`\n${verb} ${plural(removedUsers, "account")} this purge left without a membership.`);
    }
    if (options.orphanUsers) {
      console.log(`\n${verb} ${plural(orphans.removed, "account")} with no membership anywhere.`);
      if (orphans.recent > 0) {
        console.log(
          `  ${orphans.recent} of them registered in the last 24 hours — that is what somebody mid-onboarding looks like.`,
        );
      }
    }

    if (!options.apply) {
      console.log("\nRolled back — this was a rehearsal. Add --apply to keep it.");
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
