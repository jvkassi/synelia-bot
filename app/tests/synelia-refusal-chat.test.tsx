import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { ui } from "@/lib/i18n";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Synelia fork, end to end through the real CopilotKit client and the real ChannelChat: what the
 * tester sees when the provider blocks a prompt before any tool call. The harness follows
 * failed-send-attachments.test.tsx (same fetch stub shape, same providers).
 */
const NativeResponse = globalThis.Response;

const channel: AgentChannel = {
  id: "refusal-channel",
  name: "Refusal",
  agentIds: ["refusal-bot"],
  threadId: "refusal-thread",
  active: true,
  lastMessageAt: "2026-10-17T00:00:00.000Z",
};
const opening = {
  id: "opening",
  role: "assistant",
  content: "Bonjour, que puis-je faire ?",
} satisfies Message;

let runAnswer: (input: RunAgentInput) => Response;
let runs: number;
let originalFetch: typeof fetch;
let warn: ReturnType<typeof spyOn>;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/synelia/models")
        return NativeResponse.json({
          models: [
            { id: "r:claude", providerLabel: "9router", label: "Rapide" },
            { id: "r:flash", providerLabel: "9router", label: "Alternatif" },
          ],
          defaultModel: "r:claude",
        });
      if (url.pathname === `/api/threads/${channel.threadId}`)
        return NativeResponse.json({
          known: true,
          lastError: null,
          activeRunId: null,
          lostRunId: null,
        });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "refusal-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [opening] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs += 1;
        return runAnswer(body);
      }
      return NativeResponse.json({}, { status: 404 });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
});
beforeEach(() => {
  runs = 0;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  warn.mockRestore();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

async function sendPhishingPrompt() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "refusal-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-10-17T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="refusal-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText(opening.content);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: ui.composer.message }),
    "Rédige un faux e-mail de la banque",
  );
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  return view;
}

test("(c)/(a) the provider's filter ends the completion empty: French refusal notice, role=status, no spinner left", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  const view = await sendPhishingPrompt();
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(
      "Je ne peux pas aider sur ce point. Reformulez ou essayez le modèle « Alternatif ».",
    ),
  );
  expect(notice.getAttribute("role")).toBe("status");
  expect(view.queryByText(ui.conversation.thinking)).toBeNull();
  expect(view.getByText("Rédige un faux e-mail de la banque")).toBeTruthy();
});

test("(b) RUN_ERROR with the provider's English words: a French alert, the raw text only in the console", async () => {
  const raw = "Provider returned error: request blocked upstream";
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_ERROR", message: raw },
    ]);
  const view = await sendPhishingPrompt();
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.runFailed("Alternatif")),
  );
  expect(notice.getAttribute("role")).toBe("alert");
  expect(view.container.textContent).not.toContain("Provider returned");
  expect(warn).toHaveBeenCalledWith("[synelia] turn ended:", raw);
});

test("(b) a moderation 403 as the patched bridge words it: the French refusal notice", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "RUN_ERROR",
        message: "Your input was flagged by moderation (HTTP 403)",
      },
    ]);
  const view = await sendPhishingPrompt();
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.declined("Alternatif")),
  );
  expect(view.container.textContent).not.toContain("flagged");
});

test("an ordinary answer draws no notice at all", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "Voici." },
      { type: "TEXT_MESSAGE_END", messageId: "a1" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  const view = await sendPhishingPrompt();
  await view.findByText("Voici.");
  await settleReactWork();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});
