import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { isPilotHiddenAdminPath, PILOT_ADMIN_HOME } from "@/lib/i18n";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
    // Synelia fork: only People is in the pilot; any other admin URL lands there.
    if (isPilotHiddenAdminPath(location.pathname))
      throw redirect({ to: PILOT_ADMIN_HOME });
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarShell width="300px">
      <AdminSidebar />
      <main className="flex-1">
        <Outlet />
      </main>
    </SidebarShell>
  );
}
