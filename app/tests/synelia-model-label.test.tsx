import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  Badge,
  MessageModelLabel,
  SyneliaThreadModels,
  THREAD_MODELS_SETTLE_MS,
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

describe("label under a reply after a reload (thread badge map)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mount(
    answers: (() => Response)[],
    models: SyneliaModel[] = [],
    running = false,
  ) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return (next as () => Response)();
    }) as unknown as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retryDelay: 10 } },
    });
    queryClient.setQueryData(["synelia", "models"], {
      models,
      defaultModel: models[0]?.id ?? null,
    });
    const tree = (isRunning: boolean) => (
      <QueryClientProvider client={queryClient}>
        <SyneliaThreadModels running={isRunning} threadId="t1">
          <MessageModelLabel messageId="a1" />
        </SyneliaThreadModels>
      </QueryClientProvider>
    );
    const view = render(tree(running));
    return { view, calls, rerun: (r: boolean) => view.rerender(tree(r)) };
  }

  test("on load (no run going), the map is read once and the server's label is shown", async () => {
    const { view, calls } = mount([
      () =>
        Response.json({
          a1: {
            provider: "router9",
            model: "gemini-2.5-flash",
            label: "Rapide",
          },
        }),
    ]);
    await waitFor(() =>
      expect(view.getByTestId("synelia-run-model").textContent).toEndWith(
        "Rapide",
      ),
    );
    expect(calls).toEqual(["/api/synelia/threads/t1/models"]);
  });

  test("an entry without label falls back to the model list", async () => {
    const { view } = mount(
      [
        () =>
          Response.json({
            a1: { provider: "router9", model: "claude-sonnet-4" },
          }),
      ],
      [{ ...sonnet, label: "Approfondi" }],
    );
    await waitFor(() =>
      expect(view.getByTestId("synelia-run-model").textContent).toEndWith(
        "Approfondi",
      ),
    );
  });

  test("a failed first read is asked again, not cached as an empty map", async () => {
    const { view, calls } = mount([
      () => new Response("unavailable", { status: 503 }),
      () =>
        Response.json({
          a1: {
            provider: "router9",
            model: "gemini-2.5-flash",
            label: "Rapide",
          },
        }),
    ]);
    await waitFor(() =>
      expect(view.getByTestId("synelia-run-model").textContent).toEndWith(
        "Rapide",
      ),
    );
    expect(calls.length).toBe(2);
  });

  test("a run that just ended and is not stored yet: read again once it is", async () => {
    const { view, calls, rerun } = mount(
      [
        // Read at the end of the run: not stored yet.
        () => Response.json({}),
        // Read again THREAD_MODELS_SETTLE_MS later: stored.
        () =>
          Response.json({
            a1: {
              provider: "router9",
              model: "gemini-2.5-flash",
              label: "Rapide",
            },
          }),
      ],
      [],
      true,
    );
    expect(calls).toEqual([]);
    rerun(false);
    await waitFor(
      () =>
        expect(view.getByTestId("synelia-run-model").textContent).toEndWith(
          "Rapide",
        ),
      { timeout: THREAD_MODELS_SETTLE_MS + 1_500 },
    );
    expect(calls.length).toBe(2);
  });
});
