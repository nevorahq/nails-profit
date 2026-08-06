import postgres from "postgres";

/**
 * The connection every operator job needs, and the refusal when it is the wrong
 * one.
 *
 * These jobs ask questions about the whole deployment — how many bookings exist,
 * what is due to be sent, which holds have expired — and they run as a role that
 * can see across tenants. The application's role cannot: every tenant table
 * carries `FORCE ROW LEVEL SECURITY` and a policy keyed on
 * `app.current_organization_id`, so with no organization set, `select * from
 * booking` returns nothing at all.
 *
 * Which is the whole problem. Nothing errors. The query succeeds, the rows come
 * back empty, and `ops:booking-metrics` prints `bookings_total: 0` with a
 * NOT_READY verdict — indistinguishable from a pilot where nobody booked
 * anything. That report is Gate 7 evidence. A tool that answers "zero" when it
 * means "I was not allowed to look" is worse than one that refuses to run.
 *
 * So the connection is checked before it is used. Not by the role's name, which
 * differs per deployment, but by the property that actually matters: whether
 * this role sees past the tenant policies at all.
 */

/**
 * Which variable to read, in order, and what to say when none is set.
 *
 * The order is per job: the pilot CLI keeps its own operator URL separate from
 * the migration one, and the reports accept either. `DATABASE_URL` is still
 * accepted last — a small deployment may legitimately run everything as one
 * privileged role — because the check below is what makes accepting it safe.
 */
export function operatorUrlFrom(env, variables) {
  for (const variable of variables) {
    const url = env[variable];
    if (typeof url === "string" && url.trim() !== "") return { url, variable };
  }

  const named =
    variables.length === 1
      ? variables[0]
      : `${variables.slice(0, -1).join(", ")} or ${variables.at(-1)}`;

  return { error: `Set ${named}: this job reads across every organization and needs a role that can` };
}

/**
 * The verdict on a connection, from what the database says about the role.
 *
 * `rolbypassrls` and superuser are the only two ways a role sees rows a forced
 * policy would otherwise hide, and neither attribute is inherited through role
 * membership — `current_user`, after any `SET ROLE`, is the role that actually
 * applies. Anything else is the application's own role, or one just like it,
 * and it cannot answer a question about every tenant.
 */
export function crossTenantRefusal(role, variable) {
  if (role.superuser || role.bypassrls) return null;

  return (
    `${variable} points at "${role.name}", a role the tenant policies apply to. ` +
    "It would not fail — it would return no rows at all, and this job would report " +
    "zero as if that were the answer. Use the migration or operator role " +
    "(MIGRATION_DATABASE_URL), or grant BYPASSRLS to this one."
  );
}

/**
 * Opens the connection and refuses to hand it back if it cannot see across
 * tenants. `connect` is injected so that the refusal can be tested without a
 * database, which is most of the reason it is a parameter.
 */
export async function openOperatorConnection(
  env,
  variables = ["MIGRATION_DATABASE_URL", "DATABASE_URL"],
  connect = (url) => postgres(url, { max: 1, prepare: false }),
) {
  const chosen = operatorUrlFrom(env, variables);
  if (chosen.error) throw new Error(chosen.error);

  const sql = connect(chosen.url);

  let rows;
  try {
    rows = await sql`
      select current_user as name,
             current_setting('is_superuser') = 'on' as superuser,
             coalesce((select rolbypassrls from pg_roles where rolname = current_user), false)
               as bypassrls
    `;
  } catch (error) {
    await sql.end();
    throw error;
  }

  const refusal = crossTenantRefusal(rows[0], chosen.variable);
  if (refusal) {
    await sql.end();
    throw new Error(refusal);
  }

  return sql;
}
