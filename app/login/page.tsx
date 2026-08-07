import { LoginForm } from "@/components/login-form";
import { resolveLocale } from "@/lib/locale";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : undefined;
  return (
    <main className="auth-shell">
      <LoginForm
        initialMode={params.mode === "signup" ? "signup" : "signin"}
        locale={await resolveLocale()}
        next={next}
      />
    </main>
  );
}
