import { useEffect, useState } from "react";
import { ui } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** No first token after this long: the line says the wait can last up to 30 seconds. */
export const THINKING_SLOW_AFTER_MS = 8_000;
/** A send older than this is not the wait being shown (e.g. a run the server started on its own). */
const SEND_FRESH_MS = 60_000;

/**
 * When the person last pressed send, in this tab. Module state on purpose: the home page's
 * indicator unmounts when the conversation opens (~1.5 s after send) and the conversation's own
 * indicator mounts fresh, so a delay counted from mount restarted at 0 and the long message came
 * after the first token, i.e. never. Counted from here, it is 8 s after the SEND wherever the
 * indicator happens to be drawn by then.
 */
let lastSentAt: number | null = null;

/** Called by every composer submit (home, conversation, group). */
export function noteSend(at: number = Date.now()) {
  lastSentAt = at;
}

/** ms still to wait before the long message, from the latest send (or from now without one). */
export function slowDelay(now: number = Date.now()): number {
  const since =
    lastSentAt !== null && now - lastSentAt <= SEND_FRESH_MS ? lastSentAt : now;
  return Math.max(0, THINKING_SLOW_AFTER_MS - (now - since));
}

/**
 * Synelia fork: the « Le modèle réfléchit… » line, shared by the home page (optimistic send), the
 * conversation and group chat.
 *
 * Mounted only while waiting: callers render it conditionally, so the first token (or the end of
 * the turn) unmounts it and the cleanup clears the timer. The longer text replaces the short one in
 * the SAME `role="status"` element, so a screen reader hears it once, as an update of the line it
 * already knows, not as a second region.
 */
export function Thinking({ className }: { className?: string }) {
  // Already past 8 s at mount (the conversation opened late): the long message at once.
  const [slow, setSlow] = useState(() => slowDelay() === 0);
  useEffect(() => {
    const wait = slowDelay();
    if (wait === 0) {
      setSlow(true);
      return;
    }
    const timer = setTimeout(() => setSlow(true), wait);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p
      aria-live="polite"
      className={cn(
        // Body colour and size (a reply's own `text-sm`), not muted: it has to be noticed.
        "tool-line-running synelia-thinking text-foreground text-sm",
        className,
      )}
      // `status` rather than `alert`: this is progress, not something that interrupts.
      role="status"
    >
      {slow ? ui.conversation.thinkingSlow : ui.conversation.thinking}
    </p>
  );
}
