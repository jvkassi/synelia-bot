import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeRunError, redactSecrets } from "../src/headless-tools";

const KEY = "sk-or-v1-abcdef0123456789";
const leaky = {
  statusCode: 401,
  url: "https://openrouter.ai/api/v1/chat/completions",
  requestBodyValues: { messages: [{ role: "user", content: "secret prompt" }] },
  responseHeaders: { authorization: `Bearer ${KEY}` },
  responseBody: JSON.stringify({
    error: { message: `User not found for key ${KEY}` },
  }),
};

test("redactSecrets masks sk- keys", () => {
  expect(redactSecrets(`token ${KEY} end`)).toBe("token sk-*** end");
});

test("redactSecrets masks GitLab tokens, Bearer values and token query parameters", () => {
  expect(redactSecrets("bad glpat-AbC_123-xyz789 here")).toBe(
    "bad glpat-*** here",
  );
  expect(redactSecrets("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe(
    "Authorization: Bearer ***",
  );
  expect(
    redactSecrets(
      "GET https://gitlab.x/api/v4/projects?private_token=abc123&per_page=5",
    ),
  ).toBe("GET https://gitlab.x/api/v4/projects?private_token=***&per_page=5");
  expect(redactSecrets("u?access_token=zz9&token=qq1")).toBe(
    "u?access_token=***&token=***",
  );
});

test("describeRunError: provider words + HTTP code, no key, no request body, no url", () => {
  const text = describeRunError(leaky);
  expect(text).toBe("User not found for key sk-*** (HTTP 401)");
  for (const bad of [
    KEY,
    "secret prompt",
    "openrouter.ai",
    "requestBodyValues",
    "Bearer",
  ])
    expect(text).not.toContain(bad);
});

test("describeRunError: object with nothing usable is never serialised", () => {
  const text = describeRunError({
    statusCode: 500,
    requestBodyValues: { apiKey: KEY },
  });
  expect(text).toBe("Erreur du fournisseur (HTTP 500)");
});

test("the Mastra bridge patch applies the same rule (no JSON.stringify fallback, redaction)", () => {
  const patch = readFileSync(
    `${import.meta.dir}/../../patches/@ag-ui%2Fmastra@1.1.6.patch`,
    "utf8",
  );
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .join("\n");
  expect(added).toContain("sk-***");
  expect(added).not.toContain("JSON.stringify(e).slice");
  // Execute the patched helper itself on the leaky error.
  const source = added.match(
    /function __syneliaErrorMessage[\s\S]*?return"Erreur du fournisseur"\+s\}/,
  )?.[0];
  expect(source).toBeDefined();
  const fn = new Function(`${source}; return __syneliaErrorMessage;`)() as (
    e: unknown,
  ) => string;
  expect(fn(leaky)).toBe(describeRunError(leaky));
  expect(fn({ statusCode: 500, requestBodyValues: { apiKey: KEY } })).toBe(
    "Erreur du fournisseur (HTTP 500)",
  );
});
