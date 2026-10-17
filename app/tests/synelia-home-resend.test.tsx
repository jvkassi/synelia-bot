import "./home-fallback-routing.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { describeStartError } from "@/lib/channels/start-error";
import { ui } from "@/lib/i18n";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/*
 * Synelia fork, retest of 6466669: after a finished conversation the person goes back to `/` and
 * sends again. The second start must reach POST /api/channels like the first, and a start that
 * fails (here a proxy page with no JSON body, the shape that used to read « Could not start a
 * channel ») must say why in French, offer « Réessayer », and leave nothing that needs a reload.
 */

beforeAll(() => GlobalRegistrator.register());
const originalFetch = global.fetch;
const originalWarn = console.warn;
afterEach(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function agent(id: string, visibility: "public" | "private"): AgentProfile {
  return {
    id,
    avatarSeed: id,
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    name: id,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility,
  };
}

function makeQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    agent("synelia-assistant", "public"),
    agent("general-assistant", "public"),
  ]);
  return queryClient;
}

function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function send(view: ReturnType<typeof renderHome>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    await view.findByRole("textbox", { name: ui.composer.message }),
    text,
  );
  await user.click(await view.findByRole("button", { name: ui.composer.send }));
  return user;
}

type Mode = "ok" | "proxy-502";

function installFetch(state: { mode: Mode; starts: string[][] }) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/route")
        return Response.json({
          agentId: "synelia-assistant",
          fallback: false,
          name: "synelia-assistant",
          reason: "matched",
          viaMention: false,
        });
      if (url === "/api/channels" && init?.method === "POST") {
        if (state.mode === "proxy-502")
          return new Response("Bad Gateway", {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        const body = JSON.parse(String(init.body)) as { agentIds: string[] };
        state.starts.push(body.agentIds);
        const n = state.starts.length;
        return Response.json(
          {
            channel: {
              agentIds: body.agentIds,
              busy: false,
              id: `channel-${n}`,
              lastMessage: null,
              lastMessageAt: null,
              participantIds: body.agentIds,
              pinned: false,
              threadId: `thread-${n}`,
              title: null,
              unread: false,
            },
          },
          { status: 201 },
        );
      }
      // The roster refetch after a create; empty is enough here.
      if (url.startsWith("/api/channels"))
        return Response.json({ channels: [], nextCursor: null });
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

test("second send from home after a finished conversation starts a new channel", async () => {
  const state = { mode: "ok" as Mode, starts: [] as string[][] };
  installFetch(state);
  const queryClient = makeQueryClient();

  // Conversation a: started from home; the app then leaves `/`.
  const first = renderHome(queryClient);
  await send(first, "prompt a");
  await waitFor(() => expect(state.starts).toHaveLength(1));
  first.unmount();

  // Back on `/` with the same cache (mutation and channel queries from conversation a).
  const second = renderHome(queryClient);
  expect(second.queryByRole("alert")).toBeNull();
  expect(second.queryByTestId("synelia-optimistic-send")).toBeNull();
  await send(second, "prompt b");
  await waitFor(() => expect(state.starts).toHaveLength(2));
  expect(second.queryByRole("alert")).toBeNull();
});

test("a failed start says why in French, offers Réessayer, and resends without reload", async () => {
  console.warn = () => undefined;
  const state = { mode: "proxy-502" as Mode, starts: [] as string[][] };
  installFetch(state);
  const view = renderHome(makeQueryClient());

  const user = await send(view, "prompt b");
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(ui.home.serviceUnavailable);
  expect(alert.textContent).toContain("502");
  expect(alert.textContent).not.toContain("Could not start a channel");
  // Nothing left hanging: no optimistic bubble, the words are back in the box.
  expect(view.queryByTestId("synelia-optimistic-send")).toBeNull();
  expect(
    view.getByRole("textbox", { name: ui.composer.message }).textContent,
  ).toBe("prompt b");

  state.mode = "ok";
  await user.click(view.getByRole("button", { name: ui.home.retry }));
  await waitFor(() => expect(state.starts).toEqual([["synelia-assistant"]]));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("a failed start leaves the composer able to send again by itself", async () => {
  console.warn = () => undefined;
  const state = { mode: "proxy-502" as Mode, starts: [] as string[][] };
  installFetch(state);
  const view = renderHome(makeQueryClient());

  const user = await send(view, "prompt b");
  await view.findByRole("alert");
  state.mode = "ok";
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(state.starts).toHaveLength(1));
});

test("describeStartError words each failure from its status and code", () => {
  const http = (status: number, code?: string) =>
    Object.assign(new Error("Impossible de démarrer la conversation."), {
      status,
      ...(code ? { code } : {}),
    });
  expect(describeStartError(http(502))).toBe(
    `${ui.home.serviceUnavailable} (erreur 502)`,
  );
  expect(describeStartError(http(404))).toBe(
    `${ui.home.serviceUnavailable} (erreur 404)`,
  );
  expect(describeStartError(http(503, "session_unavailable"))).toBe(
    `${ui.home.serviceUnavailable} (erreur 503 · session_unavailable)`,
  );
  expect(describeStartError(http(403))).toBe(
    `${ui.home.accessDenied} (erreur 403)`,
  );
  expect(describeStartError(http(403, "password_change_required"))).toBe(
    ui.auth.changePasswordRequired,
  );
  expect(describeStartError(http(401))).toBe(
    `${ui.home.sessionExpired} (erreur 401)`,
  );
  expect(describeStartError(new TypeError("Failed to fetch"))).toBe(
    ui.home.networkError,
  );
  expect(
    describeStartError(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ),
  ).toBe(ui.home.networkError);
  expect(describeStartError(new Error("boom"))).toBe(ui.home.startFailed);
});
