"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, type FormEvent } from "react";

import { canManageRole, type MemberRole } from "@/domain/rbac";
import { getErrorMessage, type AppLocale } from "@/i18n/messages";
import { getTranslator, type MessageKey } from "@/i18n/t";

export type TeamMember = {
  /** The membership, not the account — removing one never touches the other. */
  id: string;
  user_id: string;
  email: string;
  role: string;
  /**
   * Whether the catalogue knows this account as a specialist. A master without
   * that link sees an empty calendar and cannot be booked, and this screen is
   * where the gap becomes visible — see `app/app/specialists/page.tsx` for the
   * control that closes it.
   */
  has_specialist_card?: boolean;
};

type InvitationRow = {
  id: string;
  email: string;
  role: string;
  status: "pending" | "expired" | "accepted" | "revoked";
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
};

/**
 * How long an accepted invitation stays on the list after it was accepted.
 *
 * It used to disappear the moment it was accepted, because the table only ever
 * showed pending and expired rows. That left the owner with no answer to the
 * one question they come to this screen with — did the person I invited get in
 * — beyond noticing that a row they half-remember is gone. A week is long
 * enough for that answer to still be there when they look, and short enough
 * that the table does not turn into a log.
 */
const ACCEPTED_VISIBLE_DAYS = 7;

type Step = "idle" | "link-ready" | "sent";

export function TeamManager({
  members,
  canManage,
  locale,
  canPreview = false,
  currentUserId,
  currentRole,
}: {
  members: TeamMember[];
  canManage: boolean;
  locale: AppLocale;
  /** Whether to offer "посмотреть как" beside each colleague. Owners only. */
  canPreview?: boolean;
  /** The signed-in member, so their own row offers no removal. */
  currentUserId: string;
  currentRole: MemberRole;
}) {
  const t = getTranslator(locale);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  /**
   * Ending someone's part in the studio. Their account survives — this removes
   * the membership, archives the specialist row and ends their sessions, which
   * is the difference between "больше не работает здесь" and "перестал
   * существовать". The server decides all of it again; see
   * `app/api/v1/memberships/[id]/route.ts`.
   */
  async function removeMember(membershipId: string) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/v1/memberships/${membershipId}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code;
      setError(getErrorMessage(code, body?.error?.message ?? t("team.removeFailed"), locale));
      setConfirmRemove(null);
      setPending(false);
      return;
    }

    setConfirmRemove(null);
    setPending(false);
    router.refresh();
  }

  /**
   * Opening a colleague's view. Not a sign-in: the owner's session is left
   * exactly as it is and only the rendering context changes, which is the whole
   * difference between this and typing the master's password — that would take
   * the owner's own session with it, because a browser holds one session per
   * origin.
   */
  async function enterPreview(userId: string) {
    setPreviewing(userId);
    setError(null);

    const response = await fetch("/api/v1/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member_user_id: userId }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("team.previewFailed"));
      setPreviewing(null);
      return;
    }

    router.push("/app");
    router.refresh();
  }

  const [step, setStep] = useState<Step>("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(canManage);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const loadFailed = t("team.invitationLoadFailed");

  useEffect(() => {
    if (!canManage) return;
    let ignore = false;
    void fetchInvitations(loadFailed)
      .then((rows) => {
        if (!ignore) setInvitations(rows);
      })
      .catch((cause: unknown) => {
        if (!ignore) setError(cause instanceof Error ? cause.message : loadFailed);
      })
      .finally(() => {
        if (!ignore) setInvitationsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [canManage, loadFailed]);

  /**
   * Whoever accepts an invitation does it in their own browser, so nothing
   * here hears about it. Without this the table keeps saying "ожидает" for as
   * long as the tab stays open — which for a screen an owner leaves open while
   * waiting for exactly that answer is the whole time it matters.
   *
   * Coming back to the tab is the moment they are asking again, so that is when
   * it is re-read. `router.refresh()` covers the members table above, which is
   * rendered on the server and is where the new colleague actually appears.
   */
  useEffect(() => {
    if (!canManage) return;
    function sync() {
      if (document.visibilityState !== "visible") return;
      void fetchInvitations(loadFailed)
        .then(setInvitations)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : loadFailed));
      router.refresh();
    }
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [canManage, loadFailed, router]);

  async function reloadInvitations() {
    try {
      setInvitations(await fetchInvitations(loadFailed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : loadFailed);
    }
  }

  function reset() {
    setStep("idle");
    setError(null);
    setInviteToken(null);
    setInviteLink(null);
    setInvitedEmail(null);
    setCopied(false);
    formRef.current?.reset();
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/v1/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        role: data.get("role"),
      }),
    });

    setPending(false);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("team.inviteFailed"));
      return;
    }

    const body = (await response.json()) as { data: { token: string; email: string } };
    const link = `${window.location.origin}/join?token=${encodeURIComponent(body.data.token)}`;
    setInviteToken(body.data.token);
    setInviteLink(link);
    setInvitedEmail(body.data.email);
    setStep("link-ready");
    await reloadInvitations();
  }

  async function send() {
    if (!inviteToken) return;
    setPending(true);
    setError(null);

    const response = await fetch("/api/v1/invitations/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken }),
    });

    setPending(false);

    if (!response.ok) {
      // "Не удалось отправить письмо" was all this said, for every cause there
      // is — including the two that are the owner's to act on: the link is
      // there to copy, and somebody has to fix the configuration.
      const body = await response.json().catch(() => null);
      setError(getErrorMessage(body?.error?.code, t("team.sendFailed"), locale));
      return;
    }

    setStep("sent");
  }

  async function copy() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function revoke(id: string) {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/invitations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? t("team.revokeFailed"));
      setPending(false);
      setConfirmRevoke(null);
      return;
    }
    await reloadInvitations();
    setConfirmRevoke(null);
    setPending(false);
  }

  /*
   * An accepted invitation states that this person joined, so it belongs on the
   * screen only while that is still true. Removing a colleague leaves the row
   * itself alone — it is the record of how they got in, and the audit event
   * points at it — but here it would read as a member who is missing from the
   * members table directly above.
   *
   * Matched on the address rather than on who accepted it: invitation emails
   * are stored normalized, so this needs no new field in the response.
   */
  const memberEmails = new Set(members.map((member) => member.email.trim().toLowerCase()));
  const stillTrue = invitations.filter(
    (invitation) => invitation.status !== "accepted" || memberEmails.has(invitation.email),
  );

  /*
   * One row per address — the newest one. Inviting somebody a second time
   * leaves both rows behind, and a table showing an address twice makes the
   * owner work out which of the two is the live one. The latest invitation is
   * the only one that can still be acted on, and it is the answer to "что с
   * этим человеком сейчас"; the earlier rows stay in the database as the
   * history they are.
   */
  const latestByEmail = new Map<string, InvitationRow>();
  for (const invitation of stillTrue) {
    const previous = latestByEmail.get(invitation.email);
    if (!previous || createdAt(invitation) > createdAt(previous)) {
      latestByEmail.set(invitation.email, invitation);
    }
  }
  const visibleInvitations = [...latestByEmail.values()].sort(
    (left, right) => createdAt(left) - createdAt(right),
  );

  // One actions column, shared by both controls: a manager gets removal without
  // preview, an owner gets both, and everyone else gets no column at all.
  const showActions = canPreview || canManage;

  return (
    <section className="panel">
      <h2>{t("team.membersTitle")}</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>{t("team.inviteRole")}</th>
            {showActions && <th>{t("team.invitationActions")}</th>}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            /*
             * Nobody removes themselves, and a manager may not remove an owner
             * — section 6.1's «кроме Owner», read here from the same function
             * the endpoint reads it from. Both are refused server-side too;
             * this only keeps the screen from offering what would be refused.
             */
            const removable =
              canManage &&
              m.user_id !== currentUserId &&
              canManageRole(currentRole, m.role as MemberRole);

            return (
              <tr key={m.user_id}>
                <td>{m.email}</td>
                <td>
                  {t(`roles.${m.role}` as MessageKey)}
                  {/*
                    Stated in words, not by colour alone: a master with no card
                    in the catalogue signs in to an empty calendar and cannot be
                    booked, and nothing else on this screen would say so.
                  */}
                  {m.role === "master" && m.has_specialist_card === false && (
                    <span className="badge-warning">{t("team.noSpecialistCard")}</span>
                  )}
                </td>
                {showActions && (
                  <td>
                    {/*
                      No preview beside another owner: preview may only ever
                      narrow what a request can do, and one owner wearing
                      another's view would be the single case that does not.
                      `POST /api/v1/preview` refuses it too.
                    */}
                    {canPreview && m.role !== "owner" && (
                      <button
                        className="inline-action"
                        type="button"
                        disabled={previewing !== null || pending}
                        onClick={() => enterPreview(m.user_id)}
                      >
                        {previewing === m.user_id ? t("preview.entering") : t("team.previewAction")}
                      </button>
                    )}
                    {removable &&
                      (confirmRemove === m.id ? (
                        <>
                          <button
                            className="inline-action danger"
                            type="button"
                            disabled={pending}
                            onClick={() => removeMember(m.id)}
                          >
                            {t("team.removeConfirm")}
                          </button>
                          <button
                            className="inline-action"
                            type="button"
                            disabled={pending}
                            onClick={() => setConfirmRemove(null)}
                          >
                            {t("common.cancel")}
                          </button>
                        </>
                      ) : (
                        <button
                          className="inline-action danger"
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirmRemove(m.id)}
                        >
                          {t("team.remove")}
                        </button>
                      ))}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {canManage && (
        <p className="muted" style={{ marginTop: "12rem", fontSize: "13rem" }}>
          {t("team.removeHint")}
        </p>
      )}

      {canManage && members.some((m) => m.role === "master" && m.has_specialist_card === false) && (
        <p className="warning-banner">{t("team.noSpecialistCardHint")}</p>
      )}

      {!canManage && (
        <p className="muted" style={{ marginTop: "16rem" }}>
          {t("team.noAccess")}
        </p>
      )}

      {canManage && (
        <>
          <h2 style={{ marginTop: "28rem" }}>{t("team.pendingTitle")}</h2>
          {invitationsLoading ? (
            <p className="muted">{t("team.pendingLoading")}</p>
          ) : visibleInvitations.length === 0 ? (
            <p className="muted">{t("team.pendingNone")}</p>
          ) : (
            <table className="data-table invitations-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>{t("team.inviteRole")}</th>
                  <th>{t("team.invitationStatus")}</th>
                  <th>{t("team.createdAt")}</th>
                  <th>{t("team.expiresAt")}</th>
                  <th>{t("team.acceptedAt")}</th>
                  <th>{t("team.invitationActions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleInvitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{t(`roles.${invitation.role}` as MessageKey)}</td>
                    <td>
                      <span
                        className={
                          invitation.status === "expired"
                            ? "badge-warning"
                            : invitation.status === "accepted"
                              ? "badge-done"
                              : "badge-accent"
                        }
                      >
                        {t(`team.status.${invitation.status}` as MessageKey)}
                      </span>
                    </td>
                    <td>{new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(invitation.created_at))}</td>
                    <td>
                      {invitation.status === "accepted"
                        ? "—"
                        : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(invitation.expires_at))}
                    </td>
                    <td>
                      {invitation.accepted_at
                        ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(invitation.accepted_at))
                        : "—"}
                    </td>
                    <td>
                      {invitation.status === "accepted" ? (
                        "—"
                      ) : confirmRevoke === invitation.id ? (
                        <>
                          <button className="inline-action danger" type="button" disabled={pending} onClick={() => revoke(invitation.id)}>
                            {t("team.revokeConfirm")}
                          </button>
                          <button className="inline-action" type="button" disabled={pending} onClick={() => setConfirmRevoke(null)}>
                            {t("common.cancel")}
                          </button>
                        </>
                      ) : (
                        <button className="inline-action danger" type="button" disabled={pending} onClick={() => setConfirmRevoke(invitation.id)}>
                          {t("team.revoke")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ marginTop: "28rem" }}>{t("team.inviteTitle")}</h2>

          <form className="inline-form" ref={formRef} onSubmit={generate}>
            <label>
              {t("team.inviteEmail")}
              <input
                name="email"
                type="email"
                required
                placeholder="master@example.com"
                readOnly={step === "link-ready"}
              />
            </label>
            <label>
              {t("team.inviteRole")}
              <select name="role" defaultValue="master" disabled={step === "link-ready"}>
                <option value="master">{t("roles.master")}</option>
                <option value="manager">{t("roles.manager")}</option>
                <option value="analyst">{t("roles.analyst")}</option>
              </select>
            </label>

            {step !== "link-ready" ? (
              <button className="primary-button" type="submit" disabled={pending}>
                {pending ? t("common.saving") : t("team.generateLink")}
              </button>
            ) : (
              <div style={{ display: "flex", gap: "8rem" }}>
                <button
                  className="primary-button"
                  type="button"
                  onClick={send}
                  disabled={pending}
                >
                  {pending ? t("common.saving") : t("team.inviteButton")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={reset}
                  disabled={pending}
                >
                  ✕
                </button>
              </div>
            )}
          </form>

          {step === "link-ready" && inviteLink && (
            <div style={{ marginTop: "16rem" }}>
              <p className="muted" style={{ fontSize: "13rem", marginBottom: "8rem" }}>
                {t("team.linkHint")}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "8rem",
                  alignItems: "center",
                }}
              >
                <code
                  style={{
                    flex: 1,
                    padding: "8rem 12rem",
                    background: "var(--surface-strong)",
                    borderRadius: "8rem",
                    fontSize: "12rem",
                    wordBreak: "break-all",
                    lineHeight: 1.5,
                  }}
                >
                  {inviteLink}
                </code>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={copy}
                  title={t("team.copyLink")}
                  style={{ flexShrink: 0, padding: "8rem 10rem" }}
                >
                  {copied ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M2 8l4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-7A1.5 1.5 0 001 3.5v7A1.5 1.5 0 002.5 12H4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === "sent" && invitedEmail && (
            <div className="panel" style={{ marginTop: "16rem" }}>
              <p style={{ fontWeight: 700, marginBottom: "8rem" }}>
                ✓ {t("team.inviteSent", { email: invitedEmail })}
              </p>
              <p className="muted" style={{ fontSize: "13rem", marginBottom: "12rem" }}>
                {t("team.inviteHint")}
              </p>
              <button
                className="secondary-button"
                type="button"
                onClick={reset}
                style={{ fontSize: "13rem" }}
              >
                {t("team.generateLink")}
              </button>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert" style={{ marginTop: "12rem" }}>
              {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}

async function fetchInvitations(fallback: string): Promise<InvitationRow[]> {
  const response = await fetch("/api/v1/invitations");
  if (!response.ok) throw new Error(fallback);
  const body = (await response.json()) as { data: InvitationRow[] };
  // Filtered on arrival rather than during render: the cutoff is read from the
  // clock, and a render that consults the clock is not a function of its props.
  return body.data.filter(worthShowing);
}

/**
 * Which invitations belong on the owner's screen: everything still open, plus
 * the ones taken up recently — see `ACCEPTED_VISIBLE_DAYS`. Revoked rows are
 * left out because the owner is the one who revoked them.
 */
function createdAt(invitation: InvitationRow): number {
  return new Date(invitation.created_at).getTime();
}

function worthShowing(invitation: InvitationRow): boolean {
  if (invitation.status === "pending" || invitation.status === "expired") return true;
  if (invitation.status !== "accepted") return false;
  // A row accepted before the column was filled in still counts as news; only a
  // dated one can be judged too old to keep.
  if (!invitation.accepted_at) return true;
  const age = Date.now() - new Date(invitation.accepted_at).getTime();
  return age <= ACCEPTED_VISIBLE_DAYS * 24 * 60 * 60 * 1000;
}
