import { ResetPasswordForm } from "@/components/reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="auth-shell">
      <ResetPasswordForm token={params.token} linkError={params.error} />
    </main>
  );
}
