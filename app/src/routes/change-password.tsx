import { createFileRoute } from "@tanstack/react-router";
import { ui } from "@/lib/i18n";

/**
 * Synelia fork: STUB. Where a 403 password_change_required lands. The form itself is the Frontend
 * Expert's (authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })).
 */
export const Route = createFileRoute("/change-password")({
  component: ChangePasswordStub,
});

function ChangePasswordStub() {
  return (
    <main className="mx-auto max-w-md p-6" data-testid="change-password">
      <h1 className="font-semibold text-xl">{ui.auth.changePasswordTitle}</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {ui.auth.changePasswordRequired}
      </p>
    </main>
  );
}
