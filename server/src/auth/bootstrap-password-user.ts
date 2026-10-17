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

/**
 * The first account reads OPENBOT_BOOTSTRAP_USER_*, the next ones OPENBOT_BOOTSTRAP_USER_2_* ..
 * OPENBOT_BOOTSTRAP_USER_9_* (pilot: a handful of operator-named accounts, no public sign-up).
 */
export async function bootstrapPasswordUser(
  auth: BetterAuthInstance,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  for (const suffix of ["", "_2", "_3", "_4", "_5", "_6", "_7", "_8", "_9"]) {
    const email = environment[`OPENBOT_BOOTSTRAP_USER${suffix}_EMAIL`]?.trim().toLowerCase();
    const password = environment[`OPENBOT_BOOTSTRAP_USER${suffix}_PASSWORD`];
    if (!email || !password) continue;
    const name = environment[`OPENBOT_BOOTSTRAP_USER${suffix}_NAME`]?.trim() || email;
    await bootstrapOne(auth, email, password, name);
  }
}

async function bootstrapOne(
  auth: BetterAuthInstance,
  email: string,
  password: string,
  name: string,
): Promise<void> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });
  const betterAuthEntry = Bun.resolveSync("better-auth", import.meta.dir);
  // Better Auth's sign-in only accepts a credential account whose issuer is the local one
  // (`local:credential`); it is built by the library's own helper rather than spelled here.
  const { createLocalAccountIssuer } = (await import(
    Bun.resolveSync("@better-auth/core/db", betterAuthEntry)
  )) as { createLocalAccountIssuer: (providerId: string) => string };
  const issuer = createLocalAccountIssuer("credential");
  if (
    found?.accounts?.some(
      (account) => account.providerId === "credential" && account.issuer === issuer,
    )
  ) {
    return;
  }
  // `createUser` runs OpenBot's `validateUserInfo`, which Better Auth only allows inside an endpoint
  // context. A boot task has no request, so it opens one around the call. `@better-auth/core` is
  // resolved from better-auth's own install: it is not a direct dependency of the server.
  const { runWithEndpointContext } = (await import(
    Bun.resolveSync("@better-auth/core/context", betterAuthEntry)
  )) as {
    runWithEndpointContext: <T>(context: unknown, fn: () => Promise<T>) => Promise<T>;
  };
  const user =
    found?.user ??
    (await runWithEndpointContext({ context }, () =>
      context.internalAdapter.createUser(
        { email, name, emailVerified: true },
        { method: "admin" },
      ),
    ));
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    issuer,
    accountId: user.id,
    password: await context.password.hash(password),
  });
  console.log(JSON.stringify({ type: "synelia-bootstrap-user-created", email }));
}
