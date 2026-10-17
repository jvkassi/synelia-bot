/**
 * Synelia fork: create the operator-provided email/password account at boot.
 *
 * Sign-up is disabled (auth/index.ts), so the only accounts are the ones an operator names here:
 *   OPENBOT_BOOTSTRAP_USER_EMAIL, OPENBOT_BOOTSTRAP_USER_NAME, OPENBOT_BOOTSTRAP_USER_PASSWORD
 * kept in the deployment's env file (chmod 600). Created through Better Auth's internal adapter so
 * the `databaseHooks.user.create` hooks run as for any sign-in (domain check, role seeding from
 * INITIAL_ADMIN_EMAILS). An existing credential is left alone: a restart never rotates a password.
 */
import type { createAuth } from "./index";

type BetterAuthInstance = ReturnType<typeof createAuth>;

export async function bootstrapPasswordUser(
  auth: BetterAuthInstance,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const email = environment.OPENBOT_BOOTSTRAP_USER_EMAIL?.trim().toLowerCase();
  const password = environment.OPENBOT_BOOTSTRAP_USER_PASSWORD;
  if (!email || !password) return;
  const name = environment.OPENBOT_BOOTSTRAP_USER_NAME?.trim() || email;
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });
  if (found?.accounts?.some((account) => account.providerId === "credential")) {
    return;
  }
  const user =
    found?.user ??
    (await context.internalAdapter.createUser(
      { email, name, emailVerified: true },
      { method: "admin" },
    ));
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    issuer: "credential",
    accountId: user.id,
    password: await context.password.hash(password),
  });
  console.log(JSON.stringify({ type: "synelia-bootstrap-user-created", email }));
}
