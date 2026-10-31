import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { resolveLocale } from "@/lib/locale";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <AuthShell>
      <ResetPasswordForm
        token={params.token}
        linkError={params.error}
        locale={await resolveLocale()}
      />
    </AuthShell>
  );
}
