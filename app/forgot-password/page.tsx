import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { resolveLocale } from "@/lib/locale";

export default async function ForgotPasswordPage() {
  return (
    <main className="auth-shell">
      <ForgotPasswordForm locale={await resolveLocale()} />
    </main>
  );
}
