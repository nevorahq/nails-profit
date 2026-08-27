import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { JoinAccept, JoinSwitchAccount } from "@/components/join-actions";
import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { normalizeInvitationEmail } from "@/domain/invitation";
import { getTranslator, type MessageKey, type Translate } from "@/i18n/t";
import { auth } from "@/lib/auth";
import { previewInvitation, type InvitationPreview } from "@/lib/invitation-preview";
import { resolveLocale } from "@/lib/locale";

/**
 * The invitation screen, resolved on the server before it is drawn.
 *
 * The version this replaces was a client component that knew nothing about the
 * invitation it was showing: it drew one button, "принять и войти", and learned
 * what was actually true from whichever error `POST accept` returned. For the
 * common case — a person who has no account yet — that button did not accept
 * anything. It sent a request that could only fail with 401, bounced to the
 * sign-up form, and left the invitation pending; accepting it meant coming back
 * to the link afterwards and pressing the same button a second time. Most
 * people do not, and the owner's screen keeps saying "ожидает" forever.
 *
 * So the state is decided here, once, and the screen offers the single action
 * that state allows. A guest is asked to create an account, not to accept
 * something they cannot yet accept. A live invitation offers acceptance. Every
 * dead end — expired, revoked, already used, wrong account, already a member —
 * says which one it is, because "недействительная или истёкшая ссылка" told a
 * person neither what happened nor what to do next.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const invitation = token ? await previewInvitation(token) : null;

  // The invitee has no locale of their own to read: no organization, and
  // possibly no account. The inviting studio's language is the better guess
  // than the browser's, and it is the language they will work in.
  const locale = invitation?.locale ?? (await resolveLocale());
  const t = getTranslator(locale);

  const joinPath = `/join?token=${encodeURIComponent(token)}`;
  const signInHref = `/login?next=${encodeURIComponent(joinPath)}`;
  const signUpHref = `/login?mode=signup&next=${encodeURIComponent(joinPath)}`;

  if (!invitation) {
    return (
      <Card title={t("join.invalidTitle")}>
        <p className="muted">{t("join.invalidHint")}</p>
      </Card>
    );
  }

  if (invitation.status === "expired" || invitation.status === "revoked") {
    return (
      <Card title={t(invitation.status === "expired" ? "join.expiredTitle" : "join.revokedTitle")}>
        <Summary invitation={invitation} t={t} />
        <p className="muted">
          {t(invitation.status === "expired" ? "join.expiredHint" : "join.revokedHint")}
        </p>
      </Card>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });

  /*
   * What this account already belongs to, read before the invitation's own
   * status is acted on. The order matters for one person: the one who accepted
   * this very link. Deciding "accepted" first showed them the notice written
   * for a stranger holding a used link — "войдите в аккаунт, который её
   * принял" — while they were sitting in it.
   */
  const [membership] = session
    ? await db
        .select({ organizationId: memberships.organizationId, organizationName: organizations.name })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
        .where(eq(memberships.userId, session.user.id))
        .limit(1)
    : [];

  const acceptedByThisAccount =
    invitation.status === "accepted" &&
    session !== null &&
    normalizeInvitationEmail(session.user.email) === invitation.email &&
    membership !== undefined;

  if (invitation.status === "accepted" && !acceptedByThisAccount) {
    return (
      <Card title={t("join.acceptedTitle")}>
        <Summary invitation={invitation} t={t} />
        <p className="muted" style={{ marginBottom: "20rem" }}>
          {t("join.acceptedHint")}
        </p>
        <a className="primary-button" href={session ? "/app" : signInHref} style={centeredButton}>
          {session ? t("join.goToApp") : t("join.loginButton")}
        </a>
      </Card>
    );
  }

  if (!session) {
    return (
      <Card title={t("join.title")}>
        <Summary invitation={invitation} t={t} />
        <a className="primary-button" href={signUpHref} style={centeredButton}>
          {t("join.createAccount")}
        </a>
        <a className="switch-button" href={signInHref}>
          {t("join.haveAccount")}
        </a>
      </Card>
    );
  }

  /*
   * Checked in the same order the server checks it, so the screen and the
   * endpoint can never disagree about which refusal comes first: the address
   * the invitation was issued for, and only then whether this account is free
   * to join anything.
   */
  if (normalizeInvitationEmail(session.user.email) !== invitation.email) {
    return (
      <Card title={t("join.wrongAccountTitle")}>
        <div className="warning-banner">
          {t("join.wrongAccount", { invited: invitation.email, current: session.user.email })}
        </div>
        <JoinSwitchAccount token={token} locale={locale} />
      </Card>
    );
  }

  if (membership) {
    const sameOrganization = membership.organizationId === invitation.organizationId;
    return (
      <Card title={t("join.alreadyMemberTitle")}>
        <div className="warning-banner">
          {sameOrganization
            ? t("join.alreadyMemberSame", { org: membership.organizationName })
            : t("join.alreadyMemberOther", { org: membership.organizationName })}
        </div>
        <a className="primary-button" href="/app" style={centeredButton}>
          {t("join.goToApp")}
        </a>
      </Card>
    );
  }

  return (
    <Card title={t("join.title")}>
      <Summary invitation={invitation} t={t} />
      <JoinAccept token={token} locale={locale} />
    </Card>
  );
}

const centeredButton = { display: "block", textAlign: "center" } as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1 style={{ fontSize: "22rem", fontWeight: 750, marginBottom: "12rem" }}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** Which studio, which role, which address — the three facts a decision needs. */
function Summary({ invitation, t }: { invitation: InvitationPreview; t: Translate }) {
  return (
    <div style={{ marginBottom: "20rem" }}>
      <p style={{ marginBottom: "6rem" }}>
        {t("join.invitedTo", {
          org: invitation.organizationName,
          role: t(`roles.${invitation.role}` as MessageKey),
        })}
      </p>
      <p className="muted">{t("join.invitedEmail", { email: invitation.email })}</p>
    </div>
  );
}
