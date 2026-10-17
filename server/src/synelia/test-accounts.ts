/**
 * Synelia fork: accounts excluded from pilot metrics. SYNELIA_TEST_ACCOUNTS is a comma-separated
 * list of emails (case-insensitive), e.g. "jv.e2e@synelia.tech,jv.test@synelia.tech". Request logs
 * mark their lines `"test": true`; metric queries filter them out (see CHANGES.md).
 */
export function testAccounts(
  raw: string | undefined = process.env.SYNELIA_TEST_ACCOUNTS,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isTestAccount(
  email: string | undefined | null,
  list: Set<string> = testAccounts(),
): boolean {
  return Boolean(email) && list.has((email as string).toLowerCase());
}
