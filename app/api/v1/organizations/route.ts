import { asc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { auth } from "@/lib/auth";
import { apiError, requestId } from "@/lib/http";

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  type: z.enum(["solo", "studio"]),
  currency: z.enum(["MDL", "EUR"]).default("MDL"),
  locale: z.enum(["ru", "ro", "en"]).default("ru"),
});

async function currentUser() {
  return auth.api.getSession({ headers: await headers() });
}

export async function GET(request: Request) {
  const id = requestId(request);
  const session = await currentUser();
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      type: organizations.type,
      currency: organizations.currency,
      locale: organizations.locale,
      timezone: organizations.timezone,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, session.user.id))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));

  return NextResponse.json({ data: rows, requestId: id }, { headers: { "x-request-id": id } });
}

export async function POST(request: Request) {
  const id = requestId(request);
  const session = await currentUser();
  if (!session) return apiError(401, "UNAUTHENTICATED", "Authentication is required", id);

  const body = await request.json().catch(() => null);
  const parsed = createOrganizationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", issues: parsed.error.issues }, requestId: id },
      { status: 422, headers: { "x-request-id": id } },
    );
  }

  const organization = await db.transaction(async (tx) => {
    // "One organization per user" is an MVP product policy, not a domain
    // invariant — Studio orgs will need several memberships per user later, so
    // this is serialized with a lock rather than frozen into a unique index.
    // Without it, concurrent requests each see an empty membership set and
    // every one of them creates an organization.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${session.user.id}, 0))`);

    const existing = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id))
      .limit(1);
    if (existing.length > 0) return null;

    const [created] = await tx
      .insert(organizations)
      .values({ ...parsed.data, timezone: "Europe/Chisinau" })
      .returning();

    await tx.insert(memberships).values({
      organizationId: created.id,
      userId: session.user.id,
      role: "owner",
    });
    return created;
  });

  if (!organization) {
    return apiError(409, "MEMBERSHIP_EXISTS", "User already belongs to an organization", id);
  }

  return NextResponse.json(
    { data: organization, requestId: id },
    { status: 201, headers: { "x-request-id": id } },
  );
}
