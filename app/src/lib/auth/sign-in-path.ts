/**
 * Synelia fork: the sign-in screen (routes/sign.tsx `createFileRoute("/sign")`). It takes no return
 * path: after a password sign-in it goes to "/" (`window.location.assign("/")`), so links here carry
 * none. Reached with a full page load, not a router navigation: `/sign`'s `beforeLoad` redirects to
 * "/" while a stale cached user is still in the query cache, which is exactly the expired-session case.
 */
export const SIGN_IN_PATH = "/sign";
