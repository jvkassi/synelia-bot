import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  type BetterAuthError,
  mapChangePasswordError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordChangeInput,
  type PasswordField,
  type PasswordFieldErrors,
  validatePasswordChange,
} from "@/lib/auth/change-password";
import { ui } from "@/lib/i18n";

export type ChangePasswordDeps = {
  /**
   * get-session's `user.mustChangePassword`: the first field is then the temporary password from
   * the invitation (label, help text and errors say so).
   */
  forced: boolean;
  /** `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })`. */
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions: true;
  }) => Promise<{ error?: BetterAuthError | null }>;
  /**
   * Re-reads get-session (the only read the gate allows) once the change went through. Null: no
   * session any more. Throws (with `status`) when get-session itself fails, e.g. a 503.
   */
  refreshSession: () => Promise<{ mustChangePassword?: boolean | null } | null>;
  signOut: () => Promise<void>;
  onChanged: () => void;
  onSignedOut: () => void;
};

const FIELDS: {
  name: PasswordField;
  label: (forced: boolean) => string;
  autoComplete: "current-password" | "new-password";
}[] = [
  {
    name: "currentPassword",
    label: (forced) =>
      forced ? ui.auth.temporaryPassword : ui.auth.currentPassword,
    autoComplete: "current-password",
  },
  {
    name: "newPassword",
    label: () => ui.auth.newPassword,
    autoComplete: "new-password",
  },
  {
    name: "confirmPassword",
    label: () => ui.auth.confirmPassword,
    autoComplete: "new-password",
  },
];

/**
 * Synelia fork: the forced password change. Calls nothing but change-password, get-session and
 * sign-out, the three endpoints password-change-gate.ts lets through while the flag is set.
 */
export function ChangePasswordForm(deps: ChangePasswordDeps) {
  const id = useId();
  const [values, setValues] = useState<PasswordChangeInput>({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [shown, setShown] = useState<Record<PasswordField, boolean>>({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  });
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  /** The `role="alert"` summary: field errors, or a refusal that is about no field. */
  const [summary, setSummary] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /**
   * The password IS changed but the session does not show it: `stale` (flag still set or no
   * session; only signing in again helps, never a loop back to this page) or `unverified`
   * (get-session failed; asking it again may be enough). The form is not offered again: the
   * temporary password no longer works.
   */
  const [after, setAfter] = useState<"stale" | "unverified" | null>(null);
  /**
   * Changed AND get-session shows the flag lifted: `onChanged` has been called and the app is on its
   * way out of this screen. The form is never offered again from here (see `submit`'s `finally`):
   * navigation to `/` still has to read /api/me before it lands, and for that whole time the screen
   * used to show the form again, re-enabled and relabelled.
   */
  const [succeeded, setSucceeded] = useState(false);
  /**
   * `forced` as it was when the change was submitted. Better Auth refetches get-session on its own
   * after /change-password (its `$sessionSignal` matcher, better-auth client/config.mjs:76), so the
   * prop flips to false mid-submit and the labels would switch from « provisoire » to « actuel ».
   */
  const forcedAtSubmit = useRef<boolean | null>(null);
  const inputs = useRef<
    Partial<Record<PasswordField, HTMLInputElement | null>>
  >({});

  useEffect(() => {
    inputs.current.currentPassword?.focus();
  }, []);

  const rulesId = `${id}-rules`;
  const temporaryHelpId = `${id}-temporary-help`;
  const forced =
    (pending || succeeded) && forcedAtSubmit.current !== null
      ? forcedAtSubmit.current
      : deps.forced;
  const errorId = (name: PasswordField) => `${id}-${name}-error`;

  const fail = (next: PasswordFieldErrors, extra?: string) => {
    setErrors(next);
    const listed = FIELDS.flatMap((field) =>
      next[field.name] ? [next[field.name] as string] : [],
    );
    setSummary(extra && !listed.includes(extra) ? [...listed, extra] : listed);
    const first = FIELDS.find((field) => next[field.name]);
    if (first) inputs.current[first.name]?.focus();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const invalid = validatePasswordChange(values, forced);
    if (Object.keys(invalid).length > 0) {
      fail(invalid);
      return;
    }
    setErrors({});
    setSummary([]);
    forcedAtSubmit.current = forced;
    setPending(true);
    let done = false;
    try {
      const result = await deps.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        const mapped = mapChangePasswordError(result.error, forced);
        fail(
          mapped.field ? { [mapped.field]: mapped.message } : {},
          mapped.message,
        );
        return;
      }
      done = await confirmSession();
    } catch (error) {
      fail({}, mapChangePasswordError(error, forced).message);
    } finally {
      // Success stays pending until this screen unmounts: re-enabling here is what made the form
      // flash back while the app navigated to `/` (and on to /onboarding).
      if (!done) setPending(false);
    }
  }

  /**
   * After a successful change: only a session without the flag goes home. True when it did, so the
   * caller keeps the screen in its success state instead of handing the form back.
   */
  async function confirmSession(): Promise<boolean> {
    let session: Awaited<ReturnType<ChangePasswordDeps["refreshSession"]>>;
    try {
      session = await deps.refreshSession();
    } catch {
      setAfter("unverified");
      return false;
    }
    if (!session || session.mustChangePassword) {
      setAfter("stale");
      return false;
    }
    setAfter(null);
    setSucceeded(true);
    deps.onChanged();
    return true;
  }

  async function retrySession() {
    setPending(true);
    let done = false;
    try {
      done = await confirmSession();
    } finally {
      if (!done) setPending(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await deps.signOut();
      deps.onSignedOut();
    } catch {
      setSummary([ui.auth.signOutFailed]);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center p-6"
      data-testid="change-password"
    >
      <h1 className="text-2xl font-medium tracking-tight">
        {ui.auth.changePasswordTitle}
      </h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {ui.auth.changePasswordRequired}
      </p>
      {succeeded ? (
        <p
          aria-live="polite"
          className="mt-6 text-muted-foreground text-sm"
          role="status"
        >
          {ui.auth.changedRedirecting}
        </p>
      ) : after ? (
        <div
          className="mt-6 rounded-lg border border-destructive/40 p-3 text-destructive text-sm"
          role="alert"
        >
          <p>
            {after === "stale"
              ? ui.auth.sessionNotUpdated
              : ui.auth.sessionUnverified}
          </p>
          {summary.includes(ui.auth.signOutFailed) ? (
            <p className="mt-1">{ui.auth.signOutFailed}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            {after === "unverified" ? (
              <Button
                disabled={pending}
                onClick={retrySession}
                size="sm"
                type="button"
              >
                {pending ? ui.auth.saving : ui.auth.retry}
              </Button>
            ) : null}
            <Button
              disabled={signingOut}
              onClick={signOut}
              size="sm"
              type="button"
              variant={after === "stale" ? "default" : "outline"}
            >
              {ui.auth.signOut}
            </Button>
          </div>
        </div>
      ) : (
        <form className="mt-6" noValidate onSubmit={submit}>
          {summary.length > 0 ? (
            <div
              className="mb-4 rounded-lg border border-destructive/40 p-3 text-destructive text-sm"
              role="alert"
            >
              <p className="font-medium">{ui.auth.errorSummary}</p>
              <ul className="mt-1 ml-4 list-disc">
                {summary.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <FieldGroup className="gap-4">
            {FIELDS.map((field) => {
              const inputId = `${id}-${field.name}`;
              const error = errors[field.name];
              const describedBy = [
                field.name === "currentPassword" && forced
                  ? temporaryHelpId
                  : null,
                field.name === "newPassword" ? rulesId : null,
                error ? errorId(field.name) : null,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <Field data-invalid={error ? true : undefined} key={field.name}>
                  <FieldLabel htmlFor={inputId}>
                    {field.label(forced)}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      aria-describedby={describedBy || undefined}
                      aria-invalid={error ? true : undefined}
                      autoComplete={field.autoComplete}
                      disabled={pending}
                      id={inputId}
                      name={field.name}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.name]: event.target.value,
                        }))
                      }
                      ref={(element) => {
                        inputs.current[field.name] = element;
                      }}
                      type={shown[field.name] ? "text" : "password"}
                      value={values[field.name]}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label={ui.auth.showPassword(field.label(forced))}
                        aria-pressed={shown[field.name]}
                        onClick={() =>
                          setShown((current) => ({
                            ...current,
                            [field.name]: !current[field.name],
                          }))
                        }
                        size="icon-xs"
                      >
                        {shown[field.name] ? (
                          <IconEyeOff aria-hidden />
                        ) : (
                          <IconEye aria-hidden />
                        )}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {field.name === "currentPassword" && forced ? (
                    <p
                      className="text-muted-foreground text-sm"
                      id={temporaryHelpId}
                    >
                      {ui.auth.temporaryPasswordHelp}
                    </p>
                  ) : null}
                  {field.name === "newPassword" ? (
                    <p className="text-muted-foreground text-sm" id={rulesId}>
                      {ui.auth.passwordRules(
                        PASSWORD_MIN_LENGTH,
                        PASSWORD_MAX_LENGTH,
                        forced,
                      )}
                    </p>
                  ) : null}
                  {error ? (
                    <p
                      className="text-destructive text-sm"
                      id={errorId(field.name)}
                    >
                      {error}
                    </p>
                  ) : null}
                </Field>
              );
            })}
          </FieldGroup>
          <Button className="mt-6 w-full" disabled={pending} type="submit">
            {pending ? ui.auth.saving : ui.auth.submitChange}
          </Button>
        </form>
      )}
      {after || succeeded ? null : (
        <Button
          className="mt-3 self-center"
          disabled={signingOut || pending}
          onClick={signOut}
          type="button"
          variant="link"
        >
          {ui.auth.signOut}
        </Button>
      )}
    </main>
  );
}
