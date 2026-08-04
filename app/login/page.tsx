import { LoginForm } from "@/components/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="auth-shell">
      <LoginForm initialMode={params.mode === "signup" ? "signup" : "signin"} />
    </main>
  );
}
