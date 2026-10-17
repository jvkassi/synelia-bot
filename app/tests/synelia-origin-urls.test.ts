import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { apiUrl, pageUrlHasCredentials } from "@/lib/api-url";
import { client, tryClient } from "@/lib/client";

/**
 * Synelia fork: a pilot page opened as `https://user:pass@host/…` (basic auth at the proxy) broke on
 * its first call: « Request cannot be constructed from a URL that includes credentials: /api/me ».
 */
const WITH_CREDENTIALS = {
  href: "https://tester:secret@synelia-bot.example.test/channel/abc?x=1#y",
  origin: "https://synelia-bot.example.test",
};
const PLAIN = {
  href: "https://synelia-bot.example.test/channel/abc",
  origin: "https://synelia-bot.example.test",
};

test("userinfo in the page URL: the API URL is built on location.origin, without the credentials", () => {
  expect(pageUrlHasCredentials(WITH_CREDENTIALS)).toBe(true);
  const url = apiUrl("/api/me", WITH_CREDENTIALS);
  expect(url).toBe("https://synelia-bot.example.test/api/me");
  const parsed = new URL(url);
  expect(parsed.username).toBe("");
  expect(parsed.password).toBe("");
  expect(url).not.toContain("tester");
  expect(url).not.toContain("secret");
});

test("a username alone (no password) counts as credentials too", () => {
  const location = {
    href: "https://tester@synelia-bot.example.test/",
    origin: "https://synelia-bot.example.test",
  };
  expect(apiUrl("/api/me", location)).toBe(
    "https://synelia-bot.example.test/api/me",
  );
});

test("the path and its %xx escapes reach the server untouched (the gate compares the raw path)", () => {
  expect(apiUrl("/api/memory/a%3Ab%40c?cursor=x%20y", WITH_CREDENTIALS)).toBe(
    "https://synelia-bot.example.test/api/memory/a%3Ab%40c?cursor=x%20y",
  );
});

test("no userinfo: the relative path is kept byte for byte", () => {
  expect(pageUrlHasCredentials(PLAIN)).toBe(false);
  expect(apiUrl("/api/me", PLAIN)).toBe("/api/me");
});

test("never picks a host: absolute and protocol-relative inputs are returned as given", () => {
  expect(apiUrl("https://other.example/api/x", WITH_CREDENTIALS)).toBe(
    "https://other.example/api/x",
  );
  expect(apiUrl("//other.example/api/x", WITH_CREDENTIALS)).toBe(
    "//other.example/api/x",
  );
});

test("no window (SSR, server tests) or an opaque origin: the path as given", () => {
  expect(apiUrl("/api/me", null)).toBe("/api/me");
  expect(pageUrlHasCredentials(null)).toBe(false);
  expect(apiUrl("/api/me", { href: "about:blank", origin: "null" })).toBe(
    "/api/me",
  );
});

test("every raw fetch of /api in app/src goes through apiUrl (or the client that does)", () => {
  const src = join(import.meta.dir, "../src");
  const sites = [
    "lib/client.ts",
    "lib/copilot/synelia-model.tsx",
    "lib/voice/websocket.ts",
    "lib/voice/webrtc.ts",
    "lib/voice/connection.ts",
    "lib/voice/archive.ts",
    "lib/dictation/recording.ts",
    "components/channels/channel-chat.tsx",
    "components/channels/conversation-view.tsx",
    "components/channels/chat-transcript.tsx",
    "components/channels/composer/composer.tsx",
    "components/channels/composer/attachments.ts",
  ];
  for (const file of sites) {
    const text = readFileSync(join(src, file), "utf8");
    // `fetch(` followed by anything but `apiUrl(` on the same call is a relative fetch.
    const raw = [...text.matchAll(/\bfetch\(\s*(?!apiUrl\()([^\s)][^,]*)/g)]
      .map((match) => match[1])
      .filter((arg) => !arg.startsWith("input") && !arg.startsWith("this."));
    expect({ file, raw }).toEqual({ file, raw: [] });
  }
  const provider = readFileSync(join(src, "lib/copilot/provider.tsx"), "utf8");
  expect(provider).toContain('runtimeUrl={apiUrl("/api/copilotkit")}');
});

/* The browser path end to end: happy-dom at a URL with userinfo, and a fetch that refuses exactly
 * what Chrome refuses (a request URL that, resolved against the page, still carries credentials). */
const realFetch = globalThis.fetch;
const seen: string[] = [];
beforeAll(() => {
  GlobalRegistrator.register({ url: WITH_CREDENTIALS.href });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const resolved = new URL(String(input), window.location.href);
    if (resolved.username || resolved.password)
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${String(input)}`,
      );
    seen.push(String(input));
    return Response.json({ user: { id: "u1" } });
  }) as typeof fetch;
});
afterEach(() => {
  seen.length = 0;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

test("happy-dom page with userinfo: client()/tryClient() reach /api/me on the origin", async () => {
  expect(window.location.origin).toBe(WITH_CREDENTIALS.origin);
  expect(pageUrlHasCredentials()).toBe(true);
  // What the app did before: a relative fetch against that page is refused.
  await expect(fetch("/api/me")).rejects.toThrow(/includes credentials/);
  const user = await client<{ id: string }>("/api/me", "user");
  expect(user).toEqual({ id: "u1" });
  expect((await tryClient("/api/me")).ok).toBe(true);
  expect(seen).toEqual([
    "https://synelia-bot.example.test/api/me",
    "https://synelia-bot.example.test/api/me",
  ]);
});
