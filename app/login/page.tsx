import { LoginForm } from "@/components/login-form";
import { resolveLocale } from "@/lib/locale";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="auth-shell">
      <LoginForm
        initialMode={params.mode === "signup" ? "signup" : "signin"}
        locale={await resolveLocale()}
      />
    </main>
  );
}
