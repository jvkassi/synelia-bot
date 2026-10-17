import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiUrl, pageUrlHasCredentials } from "@/lib/api-url";
import { tryClient, unmaskStatus } from "@/lib/client";

/**
 * Synelia fork, pass 9 (Chief's Chrome retest of 2ad297d5):
 *  1. Chrome strips userinfo from `location.href` but keeps it in `document.baseURI`, which is what a
 *     relative fetch resolves against → apiUrl must look at baseURI too.
 *  2. The server masks its 401s as 403 + `x-synelia-status: 401` (a raw 401 makes Chrome evict the
 *     basic-auth credentials → Traefik prompt loop); the client restores the 401.
 */
const CHROME_CRED_PAGE = {
  href: "https://synelia-bot.example.test/", // what Chrome 155 reports
  origin: "https://synelia-bot.example.test",
  baseURI: "https://tester:secret@synelia-bot.example.test/", // what fetch resolves against
};

test("Chrome shape: href clean, baseURI with userinfo → still detected, URL built on origin", () => {
  expect(pageUrlHasCredentials(CHROME_CRED_PAGE)).toBe(true);
  expect(apiUrl("/api/me", CHROME_CRED_PAGE)).toBe(
    "https://synelia-bot.example.test/api/me",
  );
  expect(apiUrl("/api/me", CHROME_CRED_PAGE)).not.toContain("secret");
});

test("clean href and clean baseURI → relative path kept", () => {
  const plain = { ...CHROME_CRED_PAGE, baseURI: CHROME_CRED_PAGE.href };
  expect(pageUrlHasCredentials(plain)).toBe(false);
  expect(apiUrl("/api/me", plain)).toBe("/api/me");
});

test("unmaskStatus: 403 + x-synelia-status: 401 becomes a 401 with the same body and headers", async () => {
  const masked = new Response('{"error":"Unauthorized"}', {
    status: 403,
    headers: { "content-type": "application/json", "x-synelia-status": "401" },
  });
  const restored = unmaskStatus(masked);
  expect(restored.status).toBe(401);
  expect(restored.headers.get("content-type")).toBe("application/json");
  expect(await restored.json()).toEqual({ error: "Unauthorized" });
});

test("unmaskStatus: a real 403 (no marker) and other statuses are left alone", () => {
  const forbidden = new Response("{}", {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  expect(unmaskStatus(forbidden)).toBe(forbidden);
  const ok = new Response("{}", { status: 200 });
  expect(unmaskStatus(ok)).toBe(ok);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("tryClient('/api/me') sees 401 for the masked answer, so currentUser still reads 'signed out'", async () => {
  globalThis.fetch = (async () =>
    new Response('{"error":"Unauthorized"}', {
      status: 403,
      headers: { "x-synelia-status": "401" },
    })) as unknown as typeof fetch;
  expect((await tryClient("/api/me")).status).toBe(401);
});

test("index.html reloads a credentialed address without its userinfo before any module runs", () => {
  const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
  const strip = html.indexOf("document.baseURI");
  const moduleTag = html.indexOf('type="module"');
  expect(strip).toBeGreaterThan(-1);
  expect(strip).toBeLessThan(moduleTag);
  expect(html).toContain(
    "location.replace(location.origin + location.pathname + location.search + location.hash)",
  );
  // The detection regex used inline, exercised on the shapes that matter.
  const source = /if \((\/.*?\/i)\.test\(document\.baseURI\)/.exec(html)?.[1];
  expect(source).toBeDefined();
  const re = new Function(`return ${source}`)() as RegExp;
  expect(re.test("https://tester:secret@host.test/x")).toBe(true);
  expect(re.test("https://tester@host.test/")).toBe(true);
  expect(re.test("https://host.test/a@b")).toBe(false);
  expect(re.test("https://host.test/?q=a@b")).toBe(false);
  expect(re.test("https://host.test/#x@y")).toBe(false);
});
