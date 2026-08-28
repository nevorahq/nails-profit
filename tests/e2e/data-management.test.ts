import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  auditEvents,
  clients,
  financialSnapshots,
  importJobs,
  invitations,
  memberships,
  organizations,
  specialists,
  visits,
} from "@/db/schema";
import { dataOf, signIn } from "../helpers/api";
import { adminDb, closeTestConnections, resetDatabase } from "../helpers/database";
import { createCanonicalStudio, type Studio } from "../helpers/studio";

describe("Owner data export and erasure", () => {
  let studio: Studio;
  let clientId: string;

  beforeAll(async () => {
    await resetDatabase();
    studio = await createCanonicalStudio("privacy-owner@example.test", "Privacy Studio");

    clientId = dataOf<{ id: string }>(
      await studio.owner.post("/api/v1/clients", {
        name: "Private Client",
        phone: "+37369000123",
        email: "private-client@example.test",
      }),
    ).id;

    await adminDb
      .update(clients)
      .set({
        locale: "ro",
        termsVersion: "2026-08-01",
        privacyVersion: "2026-08-01",
        consentedAt: new Date("2026-08-01T12:00:00.000Z"),
      })
      .where(eq(clients.id, clientId));

    await studio.owner.post("/api/v1/visits", {
      service_id: studio.serviceId,
      specialist_id: studio.specialistId,
      client_id: clientId,
      actual_duration_minutes: 90,
    });

    await studio.owner.post("/api/v1/invitations", {
      email: "invited-person@example.test",
      role: "manager",
    });

    const importForm = new FormData();
    importForm.set("entity", "client");
    importForm.set(
      "file",
      new File(
        ["Имя;Телефон;Email\r\nImported Person;+37369000456;imported@example.test"],
        "private-clients.csv",
        { type: "text/csv" },
      ),
    );
    await studio.owner.post("/api/v1/imports", importForm);
  });

  afterAll(async () => {
    await closeTestConnections();
  });

  test("export contains all domain data and no invitation credential hash", async () => {
    const response = await studio.owner.get("/api/v1/organizations/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);

    const exported = dataOf<{
      members: { email: string }[];
      clients: { id: string; email: string | null }[];
      visits: { clientId: string | null }[];
      financial_snapshots: unknown[];
      import_jobs: { sourceText: string | null }[];
    }>(response);

    expect(exported.members).toContainEqual(expect.objectContaining({ email: studio.owner.email }));
    expect(exported.clients).toContainEqual(
      expect.objectContaining({ id: clientId, email: "private-client@example.test" }),
    );
    expect(exported.visits).toContainEqual(expect.objectContaining({ clientId }));
    expect(exported.financial_snapshots).toHaveLength(1);
    expect(exported.import_jobs[0].sourceText).toContain("Imported Person");
    expect(JSON.stringify(response.body)).not.toMatch(/tokenHash|token_hash/);
  });

  test("erasure removes PII and access while retaining financial history", async () => {
    const response = await studio.owner.post("/api/v1/organizations/delete", {
      confirmation_name: "Privacy Studio",
    });
    expect(response.status).toBe(200);

    const [organization] = await adminDb
      .select()
      .from(organizations)
      .where(eq(organizations.id, studio.organizationId));
    const clientRows = await adminDb.select().from(clients).where(eq(clients.organizationId, studio.organizationId));
    const specialistRows = await adminDb
      .select()
      .from(specialists)
      .where(eq(specialists.organizationId, studio.organizationId));
    const invitationRows = await adminDb
      .select()
      .from(invitations)
      .where(eq(invitations.organizationId, studio.organizationId));
    const jobRows = await adminDb
      .select()
      .from(importJobs)
      .where(eq(importJobs.organizationId, studio.organizationId));
    const memberRows = await adminDb
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, studio.organizationId));
    const visitRows = await adminDb.select().from(visits).where(eq(visits.organizationId, studio.organizationId));
    const snapshotRows = await adminDb
      .select()
      .from(financialSnapshots)
      .where(eq(financialSnapshots.organizationId, studio.organizationId));
    const eventRows = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, studio.organizationId));

    expect(organization.deletedAt).toBeInstanceOf(Date);
    expect(organization.name).not.toContain("Privacy Studio");
    expect(clientRows).toHaveLength(1);
    expect(clientRows[0]).toMatchObject({
      normalizedPhone: null,
      email: null,
      locale: null,
      termsVersion: null,
      privacyVersion: null,
      consentedAt: null,
    });
    expect(clientRows[0].name).not.toContain("Private Client");
    expect(clientRows[0].anonymizedAt).toBeInstanceOf(Date);
    expect(clientRows[0].archivedAt).toBeInstanceOf(Date);
    expect(specialistRows[0].name).not.toBe("Мастер");
    expect(specialistRows[0].userId).toBeNull();
    expect(invitationRows[0].status).toBe("revoked");
    expect(invitationRows[0].email).not.toContain("invited-person");
    expect(jobRows[0]).toMatchObject({ fileName: "deleted-import.csv", sourceText: null, issues: [] });
    expect(memberRows).toHaveLength(0);
    expect(visitRows).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);

    const auditJson = JSON.stringify(eventRows);
    expect(auditJson).not.toMatch(/Private Client|private-client@|invited-person@|Мастер/);
    expect(eventRows.at(-1)?.eventType).toBe("organization.deleted");
  });

  test("a deleted studio stays unreachable when the same account signs in again", async () => {
    /*
     * The account outlives the studio, and that is the part the interface has
     * to be honest about rather than the part that is unsafe. Erasure removes
     * every membership, so the login still works and lands on «создайте
     * студию» — what it must never do is hand the old data back.
     *
     * Checked with a genuinely fresh session, not the cookie held before the
     * deletion: a stale session failing proves nothing about the next login.
     */
    const returning = await signIn("privacy-owner@example.test");

    expect((await returning.get("/api/v1/services")).status).toBe(404);
    expect((await returning.get("/api/v1/visits")).status).toBe(404);
    expect((await returning.get("/api/v1/onboarding")).status).toBe(404);
  });
});
