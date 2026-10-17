/**
 * Synelia fork: accounts excluded from pilot metrics and from the forced password change.
 * SYNELIA_TEST_ACCOUNTS is a comma-separated list of USER IDS (stable across email changes), e.g.
 * "aghsLBA9…,yJU4R2Vf…". Request logs mark their lines `"test": true`; metric queries filter them.
 */
export function testAccounts(
  raw: string | undefined = process.env.SYNELIA_TEST_ACCOUNTS,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function isTestAccount(
  userId: string | undefined | null,
  list: Set<string> = testAccounts(),
): boolean {
  return Boolean(userId) && list.has(userId as string);
}
