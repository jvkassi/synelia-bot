/**
 * Synelia fork: who an untagged home message goes to in the pilot, without asking `POST /api/route`.
 *
 * The pilot has one Bot people talk to (synelia-assistant); the tenant package also ships OpenBot's
 * built-in General Assistant, so the roster has two entries and the old "one candidate" shortcut
 * never fired. Routing then cost one LLM call (~3.3 s measured on konnect) before the channel was
 * even created, and was one more thing that could fail. In the pilot the recipient is fixed.
 * Returns undefined outside the pilot (route as upstream does) or when nobody fits.
 */
export const PILOT_AGENT_ID = "synelia-assistant";

export function pilotRecipient(
  agents: readonly { id: string }[] | undefined,
  pilotOn: boolean,
  fallbackId: string | undefined,
): string | undefined {
  if (!pilotOn) return undefined;
  return agents?.find((agent) => agent.id === PILOT_AGENT_ID)?.id ?? fallbackId;
}
