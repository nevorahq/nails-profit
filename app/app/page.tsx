import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { auth } from "@/lib/auth";
import { WorkspaceSetup } from "@/components/workspace-setup";

export default async function AppPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const [membership] = await db
    .select({ organization: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, session.user.id))
    // Without an explicit order the active workspace can change between renders.
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);

  if (!membership) {
    return <WorkspaceSetup name={session.user.name} />;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">Studio Ledger</span>
          <h1>{membership.organization.name}</h1>
        </div>
        <span className="role-badge">{membership.role}</span>
      </header>
      <section className="empty-state">
        <span className="step-number">01</span>
        <h2>Добавьте первую услугу</h2>
        <p>Следующий инкремент соединит услугу, материалы и объяснимый результат расчёта.</p>
        <button className="primary-button" disabled>
          Добавить услугу — скоро
        </button>
      </section>
    </main>
  );
}
