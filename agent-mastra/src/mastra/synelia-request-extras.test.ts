import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { requestExtras, withRequestExtras } from "./synelia-models";

test("only router9 Gemini Flash ('Réflexion') gets reasoning_effort low", () => {
  expect(requestExtras("router9", "gemini/gemini-3.8-flash")).toEqual({
    reasoning_effort: "low",
  });
  expect(requestExtras("router9", "cc/claude-sonnet-5-5")).toEqual({});
  expect(requestExtras("openrouter", "deepseek/deepseek-v4.1-flash")).toEqual(
    {},
  );
});

test("the outgoing Chat Completions body built by the provider carries reasoning_effort", async () => {
  let sent: Record<string, unknown> | undefined;
  const capture = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;
  const model = createOpenAI({
    baseURL: "http://router9.test/v1",
    apiKey: "k",
    fetch: withRequestExtras(
      capture,
      requestExtras("router9", "gemini/gemini-3.8-flash"),
    ),
  }).chat("gemini/gemini-3.8-flash");
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as never);
  expect(sent?.reasoning_effort).toBe("low");
  expect(sent?.model).toBe("gemini/gemini-3.8-flash");
});

test("labels: Claude Sonnet is 'Rapide', Gemini Flash is 'Réflexion', never a provider name", async () => {
  const { modelLabel } = await import("./synelia-models");
  expect(modelLabel("cc/claude-sonnet-5-5", "rapide")).toBe("Rapide");
  expect(modelLabel("gemini/gemini-3.8-flash", "reflexion")).toBe("Réflexion");
  expect(modelLabel("z-ai/glm-5.3", "raisonnement")).toBe("Raisonnement");
});
