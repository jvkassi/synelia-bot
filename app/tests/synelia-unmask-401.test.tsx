import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * Synelia fork: the server masks its 401s as 403 + x-synelia-status: 401 behind the basic-auth proxy.
 * Only that pair is a 401 again, for every client (global fetch wrapper, Better Auth client,
 * client()); a real 403 stays a 403 and is never read as "signed out".
 */
beforeAll(() =>
  GlobalRegistrator.register({ url: "https://synelia-bot.example.test/sign" }),
);
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const ORIGIN = "https://synelia-bot.example.test";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  url = `${ORIGIN}/api/me`,
) {
  const response = Response.json(body, { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
const masked = (body: unknown = { error: "Unauthorized" }, url?: string) =>
  answer(403, body, { "x-synelia-status": "401" }, url);
const passwordChange = () =>
  answer(403, {
    error: "Changez votre mot de passe",
    code: "password_change_required",
  });

test("withUnmasking: same-origin masked 401 → 401 (body, headers, url kept)", async () => {
  const { withUnmasking } = await import("@/lib/unmask-fetch");
  const f = withUnmasking(
    (async () => masked()) as unknown as typeof fetch,
    () => ORIGIN,
  );
  const response = await f("/api/me");
  expect(response.status).toBe(401);
  expect(response.url).toBe(`${ORIGIN}/api/me`);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("withUnmasking: a real 403 (password change), a cross-origin marker and a 200 are untouched", async () => {
  const { withUnmasking } = await import("@/lib/unmask-fetch");
  const real = passwordChange();
  expect(
    await withUnmasking((async () => real) as never, () => ORIGIN)("/api/me"),
  ).toBe(real);
  const foreign = masked(undefined, "https://other.example/api/x");
  expect(
    await withUnmasking((async () => foreign) as never, () => ORIGIN)("x"),
  ).toBe(foreign);
  const ok = answer(200, {});
  expect(
    await withUnmasking((async () => ok) as never, () => ORIGIN)("/api/me"),
  ).toBe(ok);
});

test("installUnmaskingFetch wraps once (idempotent) — what CopilotKit's runtime fetch and raw fetches go through", async () => {
  const { installUnmaskingFetch } = await import("@/lib/unmask-fetch");
  const target = {
    fetch: (async () => masked(undefined, "")) as unknown as typeof fetch,
  } as typeof globalThis;
  installUnmaskingFetch(target);
  const once = target.fetch;
  installUnmaskingFetch(target);
  expect(target.fetch).toBe(once);
  expect((await target.fetch("/api/copilotkit/agent/a/run")).status).toBe(401);
});

test("currentUser: masked 401 reads 'signed out' (null); a real 403 password_change_required throws, not signed out", async () => {
  const { currentUserQueryOptions } = await import("@/lib/auth/queries");
  const queryFn = currentUserQueryOptions().queryFn as () => Promise<unknown>;
  globalThis.fetch = (async () => masked()) as unknown as typeof fetch;
  expect(await queryFn()).toBeNull();
  globalThis.fetch = (async () => passwordChange()) as unknown as typeof fetch;
  const error = (await queryFn().catch((e) => e)) as {
    status?: number;
    code?: string;
  };
  expect(error.status).toBe(403);
  expect(error.code).toBe("password_change_required");
});

test("client(): a real 403 keeps its status and code; the masked one surfaces as 401", async () => {
  const { client } = await import("@/lib/client");
  globalThis.fetch = (async () => passwordChange()) as unknown as typeof fetch;
  const real = (await client("/api/memory", "memories").catch((e) => e)) as {
    status: number;
    code?: string;
  };
  expect(real.status).toBe(403);
  expect(real.code).toBe("password_change_required");
  globalThis.fetch = (async () => masked()) as unknown as typeof fetch;
  const unauth = (await client("/api/memory", "memories").catch((e) => e)) as {
    status: number;
  };
  expect(unauth.status).toBe(401);
});

test("Better Auth client: a masked wrong-password answer comes back as a 401 error", async () => {
  const { authClient } = await import("@/lib/auth/client");
  globalThis.fetch = (async () =>
    masked(
      {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      },
      `${location.origin}/api/auth/sign-in/email`,
    )) as unknown as typeof fetch;
  const result = (await authClient.signIn.email({
    email: "x@example.test",
    password: "wrong-password-123",
  })) as { error?: { status?: number } | null };
  expect(result.error?.status).toBe(401);
});

test("sign-in screen: wrong password (masked 401) shows the French message", async () => {
  const { Route } = await import("@/routes/sign");
  const { authKeys } = await import("@/lib/auth/queries");
  const { ui } = await import("@/lib/i18n");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.providers(), {
    providers: [],
    sso: false,
    ssoRequired: false,
    passwordLogin: true,
  });
  globalThis.fetch = (async () =>
    masked(
      {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      },
      `${location.origin}/api/auth/sign-in/email`,
    )) as unknown as typeof fetch;
  const Screen = Route.options.component as () => React.ReactElement;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Screen />
    </QueryClientProvider>,
  );
  fireEvent.change(view.getByPlaceholderText(ui.signIn.email), {
    target: { value: "x@example.test" },
  });
  fireEvent.change(view.getByPlaceholderText(ui.signIn.password), {
    target: { value: "wrong-password-123" },
  });
  fireEvent.submit(
    view
      .getByPlaceholderText(ui.signIn.password)
      .closest("form") as HTMLFormElement,
  );
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toBe(
      ui.signIn.wrongCredentials,
    ),
  );
  expect(ui.signIn.wrongCredentials).toBe("Adresse ou mot de passe incorrect.");
});

test("apiFetch (direct fetches: model picker, attachments, voice, dictation, HEAD probe): masked → 401, real 403 stays", async () => {
  const { apiFetch } = await import("@/lib/api-fetch");
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return masked();
  }) as unknown as typeof fetch;
  expect((await apiFetch("/api/synelia/threads/t/models")).status).toBe(401);
  expect(seen[0]).toBe("/api/synelia/threads/t/models"); // clean page URL: relative kept
  globalThis.fetch = (async () => passwordChange()) as unknown as typeof fetch;
  const real = await apiFetch("/api/attachments/x", { method: "HEAD" });
  expect(real.status).toBe(403);
  expect(real.headers.get("x-synelia-status")).toBeNull();
});
