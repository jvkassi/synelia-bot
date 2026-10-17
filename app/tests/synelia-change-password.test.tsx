import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  type ChangePasswordDeps,
  ChangePasswordForm,
} from "@/components/auth/change-password-form";
import {
  mapChangePasswordError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePasswordChange,
} from "@/lib/auth/change-password";
import { ui } from "@/lib/i18n";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** Every network call the screen makes outside the injected authClient calls. */
let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(null, { status: 599 });
  }) as unknown as typeof fetch;
});

const GOOD = "nouveau-mot-de-passe-solide";

function setup(overrides: Partial<ChangePasswordDeps> = {}) {
  const deps = {
    forced: true,
    changePassword: mock(async () => ({ error: null })),
    refreshSession: mock(async () => ({ mustChangePassword: false })),
    signOut: mock(async () => {}),
    onChanged: mock(() => {}),
    onSignedOut: mock(() => {}),
    ...overrides,
  } satisfies ChangePasswordDeps;
  const view = render(<ChangePasswordForm {...deps} />);
  const first = deps.forced
    ? ui.auth.temporaryPassword
    : ui.auth.currentPassword;
  const field = (label: string) =>
    view.getByLabelText(label) as HTMLInputElement;
  const fill = async (current: string, next: string, confirm = next) => {
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(field(first), current);
    await user.type(field(ui.auth.newPassword), next);
    await user.type(field(ui.auth.confirmPassword), confirm);
  };
  const submit = () =>
    fireEvent.click(view.getByRole("button", { name: ui.auth.submitChange }));
  return { deps, view, field, fill, submit, first };
}

test("the minimum length mirrors the server's Better Auth config", () => {
  const server = readFileSync(
    join(import.meta.dir, "../../server/src/auth/index.ts"),
    "utf8",
  );
  const configured = server.match(/minPasswordLength:\s*(\d+)/)?.[1];
  expect(Number(configured ?? 8)).toBe(PASSWORD_MIN_LENGTH);
});

test("forced change: « Mot de passe provisoire » with its help, rules before typing, focus on the first field", () => {
  const { view, field } = setup();
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
    "Changez votre mot de passe",
  );
  const first = field("Mot de passe provisoire");
  expect(document.activeElement).toBe(first);
  expect(first.type).toBe("password");
  expect(first.autocomplete).toBe("current-password");
  const help = document.getElementById(
    first.getAttribute("aria-describedby") ?? "",
  );
  expect(help?.textContent).toBe(
    "Celui que vous avez reçu avec votre invitation.",
  );
  const next = field(ui.auth.newPassword);
  expect(next.autocomplete).toBe("new-password");
  expect(field(ui.auth.confirmPassword).autocomplete).toBe("new-password");
  const rules = document.getElementById(
    next.getAttribute("aria-describedby") ?? "",
  );
  expect(rules?.textContent).toBe(
    ui.auth.passwordRules(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, true),
  );
  expect(rules?.textContent).toContain("12 caractères");
  expect(view.queryByLabelText(ui.auth.currentPassword)).toBeNull();
  // Nothing but the injected authClient calls: no /api/me, no agents.
  expect(fetched).toEqual([]);
});

test("ordinary change: « Mot de passe actuel », no invitation help", () => {
  const { view, field } = setup({ forced: false });
  const first = field("Mot de passe actuel");
  expect(first.getAttribute("aria-describedby")).toBeNull();
  expect(view.queryByText(ui.auth.temporaryPasswordHelp)).toBeNull();
});

test("show/hide toggles one field at a time, with aria-pressed and a French label", () => {
  const { view, field } = setup();
  const toggle = view.getByRole("button", {
    name: "Afficher le champ « Nouveau mot de passe »",
  });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(field(ui.auth.newPassword).type).toBe("text");
  expect(field(ui.auth.temporaryPassword).type).toBe("password");
});

test("client validation: per-field errors (aria-invalid + aria-describedby) and one alert summary", async () => {
  const { view, field, fill, submit, deps } = setup();
  await fill("provisoire-123", "court", "autre");
  submit();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(ui.auth.tooShort(12));
  expect(alert.textContent).toContain(ui.auth.mismatch);
  const next = field(ui.auth.newPassword);
  expect(next.getAttribute("aria-invalid")).toBe("true");
  const ids = (next.getAttribute("aria-describedby") ?? "").split(" ");
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(
    ui.auth.tooShort(12),
  );
  expect(document.activeElement).toBe(next);
  expect(deps.changePassword).not.toHaveBeenCalled();

  expect(
    validatePasswordChange(
      { currentPassword: GOOD, newPassword: GOOD, confirmPassword: GOOD },
      true,
    ).newPassword,
  ).toBe(ui.auth.sameAsTemporary);
  expect(
    validatePasswordChange(
      { currentPassword: GOOD, newPassword: GOOD, confirmPassword: GOOD },
      false,
    ).newPassword,
  ).toBe(ui.auth.sameAsCurrent);
  expect(
    validatePasswordChange(
      { currentPassword: "", newPassword: GOOD, confirmPassword: GOOD },
      true,
    ).currentPassword,
  ).toBe(ui.auth.temporaryRequired);
  expect(
    validatePasswordChange({
      currentPassword: "x",
      newPassword: "a".repeat(129),
      confirmPassword: "a".repeat(129),
    }).newPassword,
  ).toBe(ui.auth.tooLong(128));
});

test("Better Auth error codes, in French", () => {
  expect(
    mapChangePasswordError({ code: "INVALID_PASSWORD", status: 400 }, true),
  ).toEqual({
    field: "currentPassword",
    message: "Mot de passe provisoire incorrect.",
  });
  expect(
    mapChangePasswordError({ code: "INVALID_PASSWORD", status: 400 }, false),
  ).toEqual({
    field: "currentPassword",
    message: "Mot de passe actuel incorrect.",
  });
  expect(
    mapChangePasswordError({ code: "PASSWORD_TOO_SHORT", status: 400 }),
  ).toEqual({ field: "newPassword", message: ui.auth.tooShort(12) });
  expect(
    mapChangePasswordError({ code: "PASSWORD_TOO_LONG", status: 400 }),
  ).toEqual({ field: "newPassword", message: ui.auth.tooLong(128) });
  expect(mapChangePasswordError(new TypeError("Failed to fetch")).message).toBe(
    ui.auth.networkError,
  );
  expect(mapChangePasswordError({ status: 0 }).message).toBe(
    ui.auth.networkError,
  );
  expect(mapChangePasswordError({ status: 503 }).message).toBe(
    ui.auth.serviceUnavailable,
  );
  expect(mapChangePasswordError({ status: 429 }).message).toBe(
    ui.auth.tooManyAttempts,
  );
  expect(
    mapChangePasswordError({
      code: "CREDENTIAL_ACCOUNT_NOT_FOUND",
      status: 400,
    }).message,
  ).toBe(ui.auth.changeFailed);
});

for (const forced of [true, false]) {
  test(`server refuses the current password (forced: ${forced}): shown on the first field`, async () => {
    const { view, field, fill, submit, first } = setup({
      forced,
      changePassword: mock(async () => ({
        error: {
          code: "INVALID_PASSWORD",
          message: "Invalid password",
          status: 400,
        },
      })),
    });
    await fill("mauvais", GOOD);
    submit();
    const expected = forced
      ? "Mot de passe provisoire incorrect."
      : "Mot de passe actuel incorrect.";
    expect((await view.findByRole("alert")).textContent).toContain(expected);
    expect(field(first).getAttribute("aria-invalid")).toBe("true");
  });
}

test("pending: button disabled with « Enregistrement… »; success refetches the session then goes home", async () => {
  const gate = Promise.withResolvers<{ error: null }>();
  const { view, fill, submit, deps } = setup({
    changePassword: mock(() => gate.promise),
  });
  await fill("provisoire-123", GOOD);
  submit();
  const saving = await view.findByRole("button", { name: "Enregistrement…" });
  expect((saving as HTMLButtonElement).disabled).toBe(true);
  gate.resolve({ error: null });
  await waitFor(() => expect(deps.onChanged).toHaveBeenCalledTimes(1));
  expect(deps.changePassword).toHaveBeenCalledWith({
    currentPassword: "provisoire-123",
    newPassword: GOOD,
    revokeOtherSessions: true,
  });
  expect(deps.refreshSession).toHaveBeenCalledTimes(1);
});

test("changed but get-session still says mustChangePassword: an alert to sign in again, never back to the form", async () => {
  const { view, fill, submit, deps } = setup({
    refreshSession: mock(async () => ({ mustChangePassword: true })),
  });
  await fill("provisoire-123", GOOD);
  submit();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(
    "Le mot de passe a été changé, mais la session n'a pas été mise à jour. Reconnectez-vous.",
  );
  expect(deps.onChanged).not.toHaveBeenCalled();
  expect(view.queryByRole("button", { name: ui.auth.submitChange })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: ui.auth.signOut }));
  await waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
});

test("changed but get-session answers 503: retry message, and a retry that succeeds goes home", async () => {
  let calls = 0;
  const { view, fill, submit, deps } = setup({
    refreshSession: mock(async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      return { mustChangePassword: false };
    }),
  });
  await fill("provisoire-123", GOOD);
  submit();
  expect((await view.findByRole("alert")).textContent).toContain(
    ui.auth.sessionUnverified,
  );
  expect(deps.onChanged).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: ui.auth.retry }));
  await waitFor(() => expect(deps.onChanged).toHaveBeenCalledTimes(1));
});

test("change-password itself answers 503 or the network drops: generic messages, form kept", async () => {
  const { view, fill, submit } = setup({
    changePassword: mock(async () => ({
      error: { status: 503, statusText: "Service Unavailable" },
    })),
  });
  await fill("provisoire-123", GOOD);
  submit();
  expect((await view.findByRole("alert")).textContent).toContain(
    ui.auth.serviceUnavailable,
  );
  cleanup();
  const dropped = setup({
    changePassword: mock(async () => {
      throw new TypeError("Failed to fetch");
    }),
  });
  await dropped.fill("provisoire-123", GOOD);
  dropped.submit();
  expect((await dropped.view.findByRole("alert")).textContent).toContain(
    ui.auth.networkError,
  );
  expect(
    dropped.view.getByRole("button", { name: ui.auth.submitChange }),
  ).toBeTruthy();
});

test("« Se déconnecter » signs out and leaves", async () => {
  const { view, deps } = setup();
  fireEvent.click(view.getByRole("button", { name: "Se déconnecter" }));
  await waitFor(() => expect(deps.onSignedOut).toHaveBeenCalledTimes(1));
  expect(deps.signOut).toHaveBeenCalledTimes(1);
});
