import {
  IconArrowLeft,
  IconBuildingBank,
  IconChecks,
  IconCode,
  IconDeviceDesktop,
  IconFileText,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { pilot, ui } from "@/lib/i18n";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same four groups, in the same order, as the admin index.
 *
 * A rail that lists ten things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same ten links is worse than either ordering.
 */
const GROUPS: {
  label: string;
  items: {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
    /** Synelia fork: the only entries left in the pilot (every other admin API is closed). */
    inPilot?: true;
  }[];
}[] = [
  {
    label: ui.adminArea.groups.reach,
    items: [
      {
        title: ui.adminArea.nav.credentials,
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: ui.adminArea.nav.boundaries,
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: ui.adminArea.nav.approvals,
        icon: IconChecks,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: ui.adminArea.nav.computers,
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: ui.adminArea.groups.do,
    items: [
      {
        title: ui.adminArea.nav.plugins,
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: ui.adminArea.nav.skills,
        icon: IconFileText,
        linkOptions: { to: "/admin/skills" },
      },
      // Synelia fork: Automatic Learning needs CopilotKit Intelligence; not linked here.
      {
        title: ui.adminArea.nav.components,
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: ui.adminArea.nav.playground,
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: ui.adminArea.groups.access,
    items: [
      {
        title: ui.adminArea.nav.people,
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
        inPilot: true,
      },
      {
        title: ui.adminArea.nav.identityProviders,
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    label: ui.adminArea.groups.happened,
    items: [
      {
        title: ui.adminArea.nav.audit,
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

/** Synelia fork: in the pilot, only the `inPilot` entries, and no group left empty. */
function visibleGroups() {
  if (!pilot.hideAdminExtras) return GROUPS;
  return GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.inPilot),
  })).filter((group) => group.items.length > 0);
}

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/*
       * Pinned to the same height as the app sidebar's header. Left to itself this one is 60px
       * against the app's 45px — `p-2` around a `size="lg"` button rather than a fixed height — so
       * the nav list started lower here and the sidebar appeared to shift on the way into Admin.
       *
       * The button takes its default height rather than `h-full`. `h-full` resolves against the
       * parent, which in the app sidebar is a flex row holding a second control and here is not, so
       * the same class produces two different heights.
       */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  {ui.adminArea.backToApp}
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Synelia fork: /admin itself lands on People in the pilot, so no Overview there. */}
        {pilot.hideAdminExtras ? null : (
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                {/*
                 * `activeOptions.exact`, because /admin is a prefix of every other route here and
                 * would otherwise light up on all of them.
                 */}
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...adminLinkOptions}
                      activeOptions={{ exact: true }}
                      activeProps={{ className: "bg-foreground/5" }}
                      {...props}
                    >
                      {ui.adminArea.overview}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
        {visibleGroups().map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-px">
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    render={(props) => (
                      <Link
                        {...item.linkOptions}
                        activeProps={{ className: "bg-foreground/5" }}
                        {...props}
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
