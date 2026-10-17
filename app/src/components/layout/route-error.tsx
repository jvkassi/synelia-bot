import type { ErrorComponentProps } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ui } from "@/lib/i18n";

/**
 * Replaces TanStack Router's built-in error screen ("Something went wrong!" / "Show Error"), which
 * is English and unstyled. The technical message stays one click away, hidden by default.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const [open, setOpen] = useState(false);
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return (
    <div className="flex flex-col gap-3 p-6" role="alert">
      <p className="font-medium text-foreground">{ui.routeError.message}</p>
      {detail ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            size="sm"
            variant="outline"
          >
            {open ? ui.routeError.hideDetail : ui.routeError.showDetail}
          </Button>
          {open ? (
            <pre className="max-w-full overflow-auto rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
              <code>{detail}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
