import { useEffect, useState } from "react";
import { ui } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** No first token after this long: the line says the wait can last up to 30 seconds. */
export const THINKING_SLOW_AFTER_MS = 8_000;

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
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), THINKING_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p
      aria-live="polite"
      className={cn(
        "tool-line-running synelia-thinking text-muted-foreground text-sm",
        className,
      )}
      // `status` rather than `alert`: this is progress, not something that interrupts.
      role="status"
    >
      {slow ? ui.conversation.thinkingSlow : ui.conversation.thinking}
    </p>
  );
}
