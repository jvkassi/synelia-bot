import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isRedirect,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authKeys } from "@/lib/auth/queries";
import { pilot, ui } from "@/lib/i18n";
import { type Person, peopleKeys } from "@/lib/people/queries";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";

/*
 * Synelia fork, before the first admin account: in the pilot the admin area is People only and
 * read-only, and the app routes outside phase 0 land home. Pilot flags are OFF under `bun test`, so
 * each test switches them on and puts them back.
 */

type Flags = {
  hideAdminExtras: boolean;
  hideOutsideRoutes: boolean;
  hideComputerControls: boolean;
  adminPeopleRoleEnabled: boolean;
  adminPeopleAccessEnabled: boolean;
};
const flags = pilot as unknown as Flags;
const saved: Flags = { ...flags };

function pilotOn() {
  Object.assign(flags, {
    hideAdminExtras: true,
    hideOutsideRoutes: true,
    hideComputerControls: true,
    adminPeopleRoleEnabled: false,
    adminPeopleAccessEnabled: false,
  } satisfies Flags);
}

beforeAll(() => GlobalRegistrator.register());
const originalFetch = global.fetch;
afterEach(() => {
  Object.assign(flags, saved);
  global.fetch = originalFetch;
  queryClient.clear();
  cleanup();
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});

function inRouter(node: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: node }),
    history: createMemoryHistory({ initialEntries: ["/admin/people"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Runs a route's `beforeLoad` and returns where it redirects, or null. */
async function redirectOf(
  beforeLoad: unknown,
  pathname: string,
): Promise<string | null> {
  const context = {
    queryClient: { ensureQueryData: async () => ({ role: "admin" }) },
  };
  try {
    await (beforeLoad as (input: unknown) => unknown)({
      context,
      location: { pathname },
    });
    return null;
  } catch (thrown) {
    if (isRedirect(thrown))
      return (thrown as { options: { to: string } }).options.to;
    throw thrown;
  }
}

test("pilot: the admin sidebar shows only People, in French", async () => {
  pilotOn();
  const view = inRouter(() => (
    <SidebarProvider>
      <AdminSidebar />
    </SidebarProvider>
  ));
  const links = (await view.findAllByRole("link")).map(
    (link) => link.textContent,
  );
  expect(links).toEqual([ui.adminArea.backToApp, ui.adminArea.nav.people]);
  expect(view.queryByText(ui.adminArea.groups.access)).not.toBeNull();
  expect(view.queryByText(ui.adminArea.overview)).toBeNull();
});

test("outside the pilot the admin sidebar keeps every entry", async () => {
  const view = inRouter(() => (
    <SidebarProvider>
      <AdminSidebar />
    </SidebarProvider>
  ));
  const links = await view.findAllByRole("link");
  expect(links.length).toBe(13);
});

test("pilot: a hidden admin URL lands on People; People itself stays", async () => {
  pilotOn();
  const beforeLoad = AdminRoute.options.beforeLoad;
  for (const path of [
    "/admin",
    "/admin/plugins",
    "/admin/credentials",
    "/admin/computers",
    "/admin/learning",
  ])
    expect(await redirectOf(beforeLoad, path)).toBe("/admin/people");
  expect(await redirectOf(beforeLoad, "/admin/people")).toBeNull();
  Object.assign(flags, saved);
  expect(await redirectOf(beforeLoad, "/admin/plugins")).toBeNull();
});

test("pilot: Bots, Skills, Routines, team Bots and groups land home", async () => {
  pilotOn();
  const beforeLoad = AppRoute.options.beforeLoad;
  for (const path of [
    "/bots",
    "/bots/some-bot/memory",
    "/skills",
    "/routines",
    "/team-bots",
    "/group/abc",
  ])
    expect(await redirectOf(beforeLoad, path)).toBe("/");
  for (const path of ["/", "/channel/new", "/channel/abc", "/groups-like"])
    expect(await redirectOf(beforeLoad, path)).toBeNull();
  Object.assign(flags, saved);
  expect(await redirectOf(beforeLoad, "/bots")).toBeNull();
});

function person(overrides: Partial<Person> & { id: string }): Person {
  return {
    email: `${overrides.id}@synelia.tech`,
    name: null,
    image: null,
    role: "user",
    providers: [],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
    ...overrides,
  };
}

function renderPeople() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "me",
    email: "me@synelia.tech",
    name: "Moi",
    image: null,
    role: "admin",
    onboarding: null,
  } as never);
  const page = {
    people: [person({ id: "me", role: "admin" }), person({ id: "ama" })],
    nextCursor: null,
  };
  queryClient.setQueryData(peopleKeys.list(""), {
    pages: [page],
    pageParams: [""],
  });
  // Only the list read is expected on load (GET /api/admin/people, no path segment after it).
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "/api/admin/people") throw new Error(`Unexpected: ${url}`);
      return Response.json(page);
    },
    { preconnect: originalFetch.preconnect },
  );
  const Page = PeopleRoute.options.component as () => ReactNode;
  return inRouter(() => <Page />);
}

test("pilot: People is French, read-only, and has no computers action", async () => {
  pilotOn();
  const view = renderPeople();
  const t = ui.adminArea.people;
  await view.findByRole("switch", {
    name: t.administrator("ama@synelia.tech"),
  });
  expect(view.getByRole("textbox", { name: t.searchLabel })).toBeTruthy();
  expect(view.getByText(t.sectionTitle)).toBeTruthy();
  expect(view.queryByText(t.stopComputers)).toBeNull();
  expect(view.queryByText("Stop computers")).toBeNull();

  const note = view.getByText(t.editDisabledInPilot);
  const role = view.getByRole("switch", {
    name: t.administrator("ama@synelia.tech"),
  });
  expect(
    role.hasAttribute("disabled") ||
      role.getAttribute("aria-disabled") === "true" ||
      role.hasAttribute("data-disabled"),
  ).toBe(true);
  expect(role.getAttribute("aria-describedby")).toBe(note.id);

  const access = view.getAllByRole("button", { name: t.remove });
  expect(access.length).toBe(2);
  for (const button of access) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(note.id);
  }
});

test("outside the pilot People keeps its actions enabled", async () => {
  const view = renderPeople();
  const t = ui.adminArea.people;
  await view.findByRole("switch", {
    name: t.administrator("ama@synelia.tech"),
  });
  expect(view.queryByText(t.editDisabledInPilot)).toBeNull();
  expect(view.getAllByText(t.stopComputers).length).toBe(2);
  const role = view.getByRole("switch", {
    name: t.administrator("ama@synelia.tech"),
  });
  expect(role.hasAttribute("disabled")).toBe(false);
});

test("pilot: a role change the server answers 404 reads « Action indisponible pendant le pilote. »", async () => {
  pilotOn();
  // The one-line flip, as if the front opened it before the server did.
  flags.adminPeopleRoleEnabled = true;
  const view = renderPeople();
  const t = ui.adminArea.people;
  const listFetch = global.fetch;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/role"))
        return Response.json({ error: "Not found" }, { status: 404 });
      return listFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const role = await view.findByRole("switch", {
    name: t.administrator("ama@synelia.tech"),
  });
  role.click();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(t.pilotUnavailable);
});
