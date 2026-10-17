import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { authClient } from "@/lib/auth/client";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { queryClient } from "@/query-client";

/**
 * Synelia fork: where a 403 password_change_required lands (the `_authed` gate and the query
 * client's `onError`, lib/auth/password-change.ts). Outside `_authed` on purpose: that gate reads
 * /api/me, which the server refuses while the change is pending. This screen calls only
 * change-password, get-session and sign-out (server/src/synelia/password-change-gate.ts).
 */
export const Route = createFileRoute("/change-password")({
  component: ChangePasswordScreen,
});

function ChangePasswordScreen() {
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  // get-session, the one read the gate allows. Until it answers, the forced wording: arriving here
  // is what the gate does to somebody whose flag is set.
  const session = authClient.useSession();
  const flag = (
    session.data?.user as { mustChangePassword?: boolean | null } | undefined
  )?.mustChangePassword;
  return (
    <ChangePasswordForm
      forced={flag !== false}
      changePassword={(input) =>
        authClient.changePassword(input) as Promise<{
          error?: { code?: string; message?: string; status?: number } | null;
        }>
      }
      onChanged={() => {
        // The session changed (other sessions revoked, flag lifted): nothing cached before it,
        // including the refused /api/me, may answer for the new one.
        queryClient.clear();
        void navigate({ to: "/" });
      }}
      onSignedOut={() => void navigate({ to: "/sign" })}
      refreshSession={async () => {
        const { data, error } = await authClient.getSession({
          query: { disableCookieCache: true },
        });
        // A 503 (or any refusal) from get-session is not "no session": the form says so and
        // offers to ask again instead of claiming the session is gone.
        if (error)
          throw Object.assign(new Error(error.message ?? "get-session"), {
            status: error.status,
          });
        if (!data) return null;
        return {
          mustChangePassword: (
            data.user as { mustChangePassword?: boolean | null }
          ).mustChangePassword,
        };
      }}
      signOut={async () => {
        await signOut.mutateAsync();
      }}
    />
  );
}
