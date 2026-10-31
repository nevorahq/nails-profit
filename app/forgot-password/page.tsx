import { AuthShell } from "@/components/auth-shell";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { resolveLocale } from "@/lib/locale";

export default async function ForgotPasswordPage() {
  return (
    <AuthShell>
      <ForgotPasswordForm locale={await resolveLocale()} />
    </AuthShell>
  );
}
