import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { isPilotHiddenAppPath } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app")({
  // Synelia fork: Bots, Skills, Routines, team Bots and groups are outside the pilot (their APIs
  // answer 404); a direct URL lands home, like `/bot` does.
  beforeLoad: ({ location }) => {
    if (isPilotHiddenAppPath(location.pathname)) throw redirect({ to: "/" });
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="340px">
      <AppSidebar />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <SelfHostBanner />
        <Outlet />
      </main>
    </SidebarShell>
  );
}
