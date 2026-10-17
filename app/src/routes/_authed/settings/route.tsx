import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { isPilotHiddenSettingsPath } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings")({
  // Synelia fork: tabs outside the pilot are not reachable by URL either; General instead.
  beforeLoad: ({ location }) => {
    if (isPilotHiddenSettingsPath(location.pathname))
      throw redirect({ to: "/settings" });
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarShell width="300px">
      <SettingsSidebar />
      <main className="flex-1">
        <Outlet />
      </main>
    </SidebarShell>
  );
}
