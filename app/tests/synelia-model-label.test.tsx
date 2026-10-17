import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  Badge,
  SyneliaModelPicker,
  type SyneliaModel,
  answerModelText,
} from "@/lib/copilot/synelia-model";
import { ui } from "@/lib/i18n";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const gemini: SyneliaModel = {
  id: "router9:gemini-2.5-flash",
  provider: "router9",
  providerLabel: "9router",
  model: "gemini-2.5-flash",
  usage: "général",
};
const sonnet: SyneliaModel = {
  id: "router9:claude-sonnet-4",
  provider: "router9",
  providerLabel: "9router",
  model: "claude-sonnet-4",
  usage: "raisonnement",
};

function withModels(models: SyneliaModel[], element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["synelia", "models"], {
    models,
    defaultModel: models[0]?.id ?? null,
  });
  return render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

test("picker: the server label when present, no provider group", () => {
  const view = withModels(
    [
      { ...gemini, label: "Rapide" },
      { ...sonnet, label: "Approfondi" },
    ],
    <SyneliaModelPicker />,
  );
  const options = [...view.container.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).toEqual([`Rapide (${ui.model.default})`, "Approfondi"]);
  expect(view.container.querySelector("optgroup")).toBeNull();
});

test("picker: without a label, the raw model id as before", () => {
  const view = withModels([gemini, sonnet], <SyneliaModelPicker />);
  const options = [...view.container.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options[0]).toStartWith("gemini-2.5-flash · général");
  expect(options[1]).toBe("claude-sonnet-4 · raisonnement");
});

test("answer footer: label when present (own or from the list), else the raw id; never « 9router · »", () => {
  expect(
    answerModelText({
      provider: "router9",
      model: "gemini-2.5-flash",
      label: "Rapide",
    }),
  ).toBe("Rapide");
  expect(
    answerModelText({ provider: "router9", model: "claude-sonnet-4" }, [
      { ...sonnet, label: "Approfondi" },
    ]),
  ).toBe("Approfondi");
  expect(
    answerModelText({ provider: "router9", model: "gemini-2.5-flash" }, [
      gemini,
    ]),
  ).toBe("gemini-2.5-flash");

  const labelled = withModels(
    [{ ...gemini, label: "Rapide" }],
    <Badge model="gemini-2.5-flash" provider="router9" />,
  );
  const footer = labelled.getByTestId("synelia-run-model").textContent ?? "";
  expect(footer).toEndWith("Rapide");
  expect(footer).not.toContain("9router");
  cleanup();
  const raw = withModels(
    [],
    <Badge model="claude-sonnet-4" provider="router9" />,
  );
  const rawFooter = raw.getByTestId("synelia-run-model").textContent ?? "";
  expect(rawFooter).toEndWith("claude-sonnet-4");
  expect(rawFooter).not.toContain("9router");
});
