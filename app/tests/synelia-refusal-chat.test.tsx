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

let runAnswer: (
  input: RunAgentInput,
  index: number,
) => Response | Promise<Response>;
let runs: number;
let connects: number;
let bodies: RunAgentInput[];
/** What GET /api/threads/:id and the join replay report (the reload path). */
let storedLastError: Record<string, unknown> | null;
let joinMessages: unknown[];
/** Synelia fork (item 6): what GET /api/threads/:id says about this thread, and whether reattach fails. */
let threadKnown: boolean;
let connectFails: boolean;
/**
 * pass10b: what GET /api/threads/:id reports as `lastUserMessageId`. "echo" = the last user message
 * of the last run POST (the message reached the server and is stored); otherwise the literal value.
 */
let threadLastUser: "echo" | string | null;
/** pass10b: when set, GET /api/copilotkit/threads/:id/messages answers with these (history "ready"). */
let storedHistory: unknown[] | null;
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
        return NativeResponse.json(
          threadKnown
            ? {
                known: true,
                lastError: storedLastError,
                activeRunId: null,
                lostRunId: null,
                lastUserMessageId:
                  threadLastUser === "echo"
                    ? (bodies
                        .at(-1)
                        ?.messages.filter((message) => message.role === "user")
                        .at(-1)?.id ?? null)
                    : threadLastUser,
              }
            : { known: false, lastError: null, lastUserMessageId: null },
        );
      if (
        storedHistory !== null &&
        url.pathname === `/api/copilotkit/threads/${channel.threadId}/messages`
      )
        return NativeResponse.json({ messages: storedHistory });
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
      if (url.pathname.endsWith("/connect")) {
        if (connectFails) throw new TypeError("Failed to fetch");
        connects += 1;
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: joinMessages },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      }
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs += 1;
        bodies.push(body);
        return runAnswer(body, runs - 1);
      }
      return NativeResponse.json({}, { status: 404 });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
});
beforeEach(() => {
  runs = 0;
  connects = 0;
  bodies = [];
  storedLastError = null;
  joinMessages = [opening];
  threadKnown = true;
  threadLastUser = "echo";
  storedHistory = null;
  connectFails = false;
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

async function openChat(rosterLastAgentId: string | null = "refusal-bot") {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: rosterLastAgentId,
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
  return view;
}

async function sendPhishingPrompt() {
  const view = await openChat();
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
      "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez le modèle Alternatif en haut de la conversation.",
    ),
  );
  // A refusal offers no « Réessayer »: the same words would get the same answer.
  expect(view.queryByTestId("transcript-retry")).toBeNull();
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
    expect(notice.textContent).toBe("La réponse n'a pas pu aboutir."),
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

test("live cut BEFORE RUN_STARTED, server has no run (GET known:false): not-sent notice, no reattach, no « Réessayer »", async () => {
  // runAgent rejects before any event (dropped connection on the POST itself) AND the one GET
  // /api/threads/:id confirms the server never saw the turn.
  threadKnown = false;
  runAnswer = () => {
    throw new TypeError("Failed to fetch");
  };
  const view = await openChat();
  const connectsAfterOpen = connects;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: ui.composer.message }),
    "Rédige un faux e-mail de la banque",
  );
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.notSentLive),
  );
  expect(notice.getAttribute("role")).toBe("alert");
  // No reattach: with no RUN_STARTED there is no run on the server to follow.
  expect(connects).toBe(connectsAfterOpen);
  // No « Réessayer »: the draft is returned to the composer, the resend goes through it.
  expect(view.queryByTestId("transcript-retry")).toBeNull();
  // The unsent message is not left dangling in the transcript.
  await settleReactWork();
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) =>
    bubble.textContent?.includes("Rédige un faux e-mail de la banque"),
  );
  expect(bubbles).toHaveLength(0);
});

test("control: RUN_STARTED received, then no answer — reattach/replay as today, never the not-sent notice", async () => {
  // The run started on the server (RUN_STARTED delivered). Whatever happens next, the not-sent
  // path (which requires NO RUN_STARTED) must not fire; the client reattaches to follow the run.
  const second = Promise.withResolvers<Response>();
  runAnswer = (input, index) =>
    index === 0
      ? sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        ])
      : second.promise;
  const view = await openChat();
  const connectsAfterOpen = connects;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: ui.composer.message }),
    "Rédige un faux e-mail de la banque",
  );
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  // The run started, so the client reattaches (connectAgent) rather than declaring it unsent.
  await waitFor(() => expect(connects).toBeGreaterThan(connectsAfterOpen));
  await settleReactWork();
  expect(view.queryByText(ui.conversation.notSentLive)).toBeNull();
  second.resolve(
    sse([
      { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
      { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
    ]),
  );
});

test("item 6: cut before RUN_STARTED but the POST reached the server (GET known:true): reattach, no not-sent notice", async () => {
  // The POST arrived and a run started server-side, but the stream was cut before any event reached
  // this tab. The one GET says the thread is known, so the client reattaches and replays rather than
  // declaring the turn unsent.
  threadKnown = true;
  runAnswer = () => {
    throw new TypeError("Failed to fetch");
  };
  joinMessages = [
    opening,
    {
      id: "u-sent",
      role: "user",
      content: "Rédige un faux e-mail de la banque",
    },
    {
      id: "a-sent",
      role: "assistant",
      content: "Voici la réponse du serveur.",
    },
  ];
  const view = await openChat();
  const connectsAfterOpen = connects;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: ui.composer.message }),
    "Rédige un faux e-mail de la banque",
  );
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  // Reattach happened, and the server's answer replayed in.
  await waitFor(() => expect(connects).toBeGreaterThan(connectsAfterOpen));
  await view.findByText("Voici la réponse du serveur.");
  expect(view.queryByText(ui.conversation.notSentLive)).toBeNull();
});

const PROMPT = "Rédige un faux e-mail de la banque";

test("pass10b: cut before RUN_STARTED on a thread WITH prior runs, this message NOT stored: not-sent notice, draft restored, no reattach", async () => {
  // The thread exists (known:true, earlier runs), but its last stored user message is an OLDER one:
  // the new POST never arrived. `known` alone would reattach to the old finished run and report its
  // answer as new; the lastUserMessageId check declares the turn unsent instead.
  threadKnown = true;
  threadLastUser = "u-older";
  runAnswer = () => {
    throw new TypeError("Failed to fetch");
  };
  joinMessages = [
    opening,
    { id: "u-older", role: "user", content: "Une ancienne question" },
    { id: "a-older", role: "assistant", content: "Ancienne réponse du Bot." },
  ];
  const view = await openChat();
  const connectsAfterOpen = connects;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const textbox = view.getByRole("textbox", { name: ui.composer.message });
  await user.type(textbox, PROMPT);
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.notSentLive),
  );
  await waitFor(() => expect(textbox.textContent).toBe(PROMPT));
  // No reattach to the old run.
  expect(connects).toBe(connectsAfterOpen);
  await settleReactWork();
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.includes(PROMPT));
  expect(bubbles).toHaveLength(0);
});

test("pass10b: cut before RUN_STARTED on a thread WITH prior runs, this message IS stored: reattach, no notice", async () => {
  threadKnown = true;
  threadLastUser = "echo";
  runAnswer = (input) => {
    const sent = input.messages.filter((m) => m.role === "user").at(-1);
    joinMessages = [
      opening,
      { id: "u-older", role: "user", content: "Une ancienne question" },
      { id: "a-older", role: "assistant", content: "Ancienne réponse du Bot." },
      { id: sent?.id ?? "x", role: "user", content: PROMPT },
      { id: "a-new", role: "assistant", content: "Nouvelle réponse du Bot." },
    ];
    throw new TypeError("Failed to fetch");
  };
  const view = await openChat();
  const connectsAfterOpen = connects;
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: ui.composer.message }),
    PROMPT,
  );
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  await waitFor(() => expect(connects).toBeGreaterThan(connectsAfterOpen));
  await view.findByText("Nouvelle réponse du Bot.");
  await settleReactWork();
  expect(view.queryByText(ui.conversation.notSentLive)).toBeNull();
});

test("pass10b: reopening a conversation whose last message is the person's own shows NO not-sent notice (reopen notice deferred to P1)", async () => {
  // The roster's last line is the person's (lastMessageAgentId null) and the stored transcript ends on
  // a user message: exactly what a tab closed mid-run or a tools-only answer leaves. pass10 shows
  // nothing here; the reopen notice returns in P1 once the server records the Bot reply itself.
  joinMessages = [
    opening,
    { id: "u-last", role: "user", content: "Ma dernière question" },
    // The server finished and stored the answer, but the browser never reported it to the roster
    // (tab closed before RUN_FINISHED): the case 4dae74ed wrongly flagged « non envoyé ».
    {
      id: "a-last",
      role: "assistant",
      content: "Réponse stockée par le serveur.",
    },
  ];
  storedHistory = joinMessages;
  const view = await openChat(null);
  await view.findByText("Réponse stockée par le serveur.");
  await settleReactWork();
  expect(view.queryByText(ui.conversation.notSentLive)).toBeNull();
  expect(view.container.textContent ?? "").not.toContain("pas été envoyé");
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

test("item 7: after a not-sent turn the draft returns to the composer and a resend leaves exactly ONE user bubble", async () => {
  threadKnown = false;
  let call = 0;
  runAnswer = (input) => {
    call += 1;
    if (call === 1) throw new TypeError("Failed to fetch");
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "Voici." },
      { type: "TEXT_MESSAGE_END", messageId: "a1" },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  const view = await openChat();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const textbox = view.getByRole("textbox", {
    name: ui.composer.message,
  });
  await user.type(textbox, "Rédige un faux e-mail de la banque");
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(1));
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.notSentLive),
  );
  // The draft came back to the composer (a contentEditable): the words are in the box again.
  await waitFor(() =>
    expect(textbox.textContent).toBe("Rédige un faux e-mail de la banque"),
  );
  // Resend: this time it goes through.
  await user.click(view.getByRole("button", { name: ui.composer.send }));
  await waitFor(() => expect(runs).toBe(2));
  await view.findByText("Voici.");
  await settleReactWork();
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) =>
    bubble.textContent?.includes("Rédige un faux e-mail de la banque"),
  );
  expect(bubbles).toHaveLength(1);
});

function userMessages(input: RunAgentInput) {
  return input.messages.filter((message) => message.role === "user");
}

test("server code wins over wording: provider_refusal on RUN_ERROR draws the refusal, no retry", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      // English text that the heuristics would read as a generic failure.
      { type: "RUN_ERROR", message: "Something odd", code: "provider_refusal" },
    ]);
  const view = await sendPhishingPrompt();
  const notice = await view.findByTestId("transcript-stopped");
  await waitFor(() =>
    expect(notice.textContent).toBe(ui.conversation.declined("Alternatif")),
  );
  expect(notice.getAttribute("role")).toBe("status");
  expect(view.queryByTestId("transcript-retry")).toBeNull();
});

test("« Réessayer »: one new run on the same user message, no duplicate in the thread or on screen", async () => {
  const second = Promise.withResolvers<Response>();
  runAnswer = (input, index) =>
    index === 0
      ? sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          { type: "RUN_ERROR", message: "x", code: "run_stalled" },
        ])
      : second.promise;
  const view = await sendPhishingPrompt();
  const retry = (await view.findByTestId(
    "transcript-retry",
  )) as HTMLButtonElement;
  expect(retry.tagName).toBe("BUTTON");
  expect(retry.textContent).toBe("Réessayer");
  expect(retry.disabled).toBe(false);
  expect(view.getByTestId("transcript-stopped").textContent).toBe(
    "La réponse n'a pas pu aboutir.",
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(retry);
  await waitFor(() => expect(runs).toBe(2));
  // While the retry runs: no enabled « Réessayer » anywhere (the failed notice is gone).
  const during = view.queryByTestId(
    "transcript-retry",
  ) as HTMLButtonElement | null;
  expect(during === null || during.disabled).toBe(true);
  // The same message, by id, exactly once in each run's input.
  const [first, again] = bodies as [RunAgentInput, RunAgentInput];
  expect(userMessages(first)).toHaveLength(1);
  expect(userMessages(again)).toHaveLength(1);
  expect(userMessages(again)[0]?.id).toBe(userMessages(first)[0]?.id);
  expect(again.messages.map((message) => message.id)).toEqual(
    first.messages.map((message) => message.id),
  );
  second.resolve(
    sse([
      { type: "RUN_STARTED", threadId: again.threadId, runId: again.runId },
      { type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "Non." },
      { type: "TEXT_MESSAGE_END", messageId: "a2" },
      { type: "RUN_FINISHED", threadId: again.threadId, runId: again.runId },
    ]),
  );
  await view.findByText("Non.");
  await settleReactWork();
  // One bubble. (The composer also holds the words: on a failed send it hands the draft back,
  // which is upstream behaviour and not part of the transcript.)
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.includes(PROMPT));
  expect(bubbles).toHaveLength(1);
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
  expect(runs).toBe(2);
});

test("provider_unavailable code: the model-unavailable sentence, with « Réessayer »", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_ERROR", message: "boom", code: "provider_unavailable" },
    ]);
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.modelUnavailable,
    ),
  );
  expect(view.getByTestId("transcript-retry")).toBeTruthy();
});

test("Stop: no notice and no « Réessayer » afterwards", async () => {
  runAnswer = () => new Promise<Response>(() => {});
  const view = await sendPhishingPrompt();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: ui.composer.stop }));
  await settleReactWork();
  expect(view.queryByTestId("transcript-retry")).toBeNull();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

test("« Réessayer » after a partial answer: the half-written reply and its tool call are dropped, the run restarts from the user message", async () => {
  const second = Promise.withResolvers<Response>();
  runAnswer = (input, index) =>
    index === 0
      ? sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "partial",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "partial",
            delta: "Voici le début d'une répo",
          },
          {
            type: "TOOL_CALL_START",
            toolCallId: "call-1",
            toolCallName: "search",
            parentMessageId: "partial",
          },
          { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{}" },
          { type: "TOOL_CALL_END", toolCallId: "call-1" },
          {
            type: "TOOL_CALL_RESULT",
            messageId: "tool-result-1",
            toolCallId: "call-1",
            content: "rien",
            role: "tool",
          },
          { type: "RUN_ERROR", message: "x", code: "run_stalled" },
        ])
      : second.promise;
  const view = await sendPhishingPrompt();
  await view.findByText("Voici le début d'une répo");
  const retry = (await view.findByTestId(
    "transcript-retry",
  )) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(retry);
  await waitFor(() => expect(runs).toBe(2));
  const [first, again] = bodies as [RunAgentInput, RunAgentInput];
  // Everything up to and including the person's message, same ids, nothing after it.
  expect(again.messages.map((message) => message.id)).toEqual(
    first.messages.map((message) => message.id),
  );
  expect(again.messages.at(-1)?.role).toBe("user");
  expect(again.messages.some((message) => message.id === "partial")).toBe(
    false,
  );
  expect(again.messages.some((message) => message.id === "tool-result-1")).toBe(
    false,
  );
  expect(userMessages(again)).toHaveLength(1);
  // The partial bubble left the screen as the retry started.
  await waitFor(() =>
    expect(view.queryByText("Voici le début d'une répo")).toBeNull(),
  );
  second.resolve(
    sse([
      { type: "RUN_STARTED", threadId: again.threadId, runId: again.runId },
      { type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "Non." },
      { type: "TEXT_MESSAGE_END", messageId: "a2" },
      { type: "RUN_FINISHED", threadId: again.threadId, runId: again.runId },
    ]),
  );
  await view.findByText("Non.");
  await settleReactWork();
  expect(view.queryByText("Voici le début d'une répo")).toBeNull();
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.includes(PROMPT));
  expect(bubbles).toHaveLength(1);
  expect(runs).toBe(2);
});

function httpRefusal(
  status: number,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

test("HTTP 401 on the run: the session-expired sentence, no « Réessayer »", async () => {
  runAnswer = httpRefusal(401, { error: "Sign in to use this deployment." });
  const view = await sendPhishingPrompt();
  const link = (await view.findByRole("link", {
    name: "Se reconnecter",
  })) as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("/sign");
  expect(view.getByTestId("transcript-stopped").textContent).toBe(
    "Votre session a expiré. Reconnectez-vous pour continuer.",
  );
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.home.sessionExpired,
    ),
  );
  expect(view.getByTestId("transcript-stopped").getAttribute("role")).toBe(
    "alert",
  );
  expect(view.queryByTestId("transcript-retry")).toBeNull();
});

test("masked 401 (403 + x-synelia-status: 401): the session-expired sentence, never « modèle indisponible »", async () => {
  runAnswer = httpRefusal(
    403,
    { error: "Sign in to use this deployment." },
    { "x-synelia-status": "401" },
  );
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.home.sessionExpired,
    ),
  );
  expect(view.container.textContent).not.toContain(
    ui.conversation.modelUnavailable,
  );
  expect(view.queryByTestId("transcript-retry")).toBeNull();
});

test("plain 403 (password_change_required): not the session sentence, keeps the usual failure handling", async () => {
  runAnswer = httpRefusal(403, {
    error: "Vous devez changer votre mot de passe.",
    code: "password_change_required",
  });
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.runFailed,
    ),
  );
  expect(view.container.textContent).not.toContain(ui.home.sessionExpired);
  expect(view.container.textContent).not.toContain(
    ui.conversation.modelUnavailable,
  );
});

test("evidence: the run's HTTP error does not carry the response headers (CopilotKit 1.77 / @ag-ui/client)", async () => {
  runAnswer = httpRefusal(
    403,
    { error: "some other body" },
    { "x-synelia-status": "401" },
  );
  const view = await sendPhishingPrompt();
  await view.findByTestId("transcript-stopped");
  // A masked 401 whose body is not one of the server's 401 bodies is NOT recognised today: the
  // header never reaches our code. Recorded so a runtime upgrade that exposes it shows up here.
  expect(view.getByTestId("transcript-stopped").textContent).toBe(
    ui.conversation.runFailed,
  );
  expect(String(warn.mock.calls.at(-1)?.[1])).toContain("HTTP 403");
});

const NO_RETRY_TEXT =
  "La réponse n'a pas pu aboutir. Écrivez un nouveau message pour reprendre.";

test("live RUN_ERROR with metadata.retryable: false (a side-effect tool ran): no « Réessayer », the new-message sentence", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "RUN_ERROR",
        message: "x",
        code: "run_stalled",
        metadata: { retryable: false },
      },
    ]);
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      NO_RETRY_TEXT,
    ),
  );
  expect(view.getByTestId("transcript-stopped").getAttribute("role")).toBe(
    "alert",
  );
  expect(view.queryByTestId("transcript-retry")).toBeNull();
});

test("reload: lastError.retryable false from GET /api/threads/:id draws the same sentence, no « Réessayer »", async () => {
  joinMessages = [
    opening,
    { id: "u-stored", role: "user", content: "Envoie le rapport" },
  ];
  storedLastError = {
    message: "Provider returned error",
    code: "run_stalled",
    retryable: false,
  };
  const view = await openChat();
  await view.findByText("Envoie le rapport");
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      NO_RETRY_TEXT,
    ),
  );
  expect(view.queryByTestId("transcript-retry")).toBeNull();
  expect(runs).toBe(0);
});

test("reload: the same stored error without retryable keeps « Réessayer »", async () => {
  joinMessages = [
    opening,
    { id: "u-stored", role: "user", content: "Envoie le rapport" },
  ];
  storedLastError = { message: "Provider returned error", code: "run_stalled" };
  const view = await openChat();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.runFailed,
    ),
  );
  expect(view.getByTestId("transcript-retry")).toBeTruthy();
});

test("live RUN_ERROR without retryable (or true): unchanged, « Réessayer » offered", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_ERROR", message: "x", code: "run_stalled", retryable: true },
    ]);
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.runFailed,
    ),
  );
  expect(view.getByTestId("transcript-retry")).toBeTruthy();
});

test("evidence: a TOP-LEVEL retryable on RUN_ERROR is stripped by @ag-ui/client before our code sees it", async () => {
  runAnswer = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "RUN_ERROR",
        message: "x",
        code: "run_stalled",
        retryable: false,
      },
    ]);
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.runFailed,
    ),
  );
  // Still offered: the field never arrived. The server must send it in `metadata`.
  expect(view.getByTestId("transcript-retry")).toBeTruthy();
});

function answer(input: RunAgentInput, text: string, end: unknown) {
  return sse([
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "TEXT_MESSAGE_START", messageId: "born", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "born", delta: text },
    { type: "TEXT_MESSAGE_END", messageId: "born" },
    end,
  ]);
}

test("provider_refusal RUN_ERROR after streamed text: the run's assistant output is removed, only the French refusal stays", async () => {
  runAnswer = (input) =>
    answer(input, "Bien sûr, voici un modèle d'e-mail", {
      type: "RUN_ERROR",
      message: "blocked",
      code: "provider_refusal",
    });
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.declined("Alternatif"),
    ),
  );
  await waitFor(() =>
    expect(view.queryByText("Bien sûr, voici un modèle d'e-mail")).toBeNull(),
  );
  expect(view.getByTestId("transcript-stopped").getAttribute("role")).toBe(
    "status",
  );
  expect(view.queryByTestId("transcript-retry")).toBeNull();
  // The person's message and the earlier history stay.
  expect(view.getByText(opening.content)).toBeTruthy();
  const bubbles = [
    ...view.container.querySelectorAll('[data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.includes(PROMPT));
  expect(bubbles).toHaveLength(1);
});

const ANTHROPIC_REFUSAL =
  "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To request an adjustment pursuant to our Cyber Verification Program based on how you use Claude, fill out https://claude.com/form/cyber-use-case?token=x";

test("old server: a FINISHED run whose only text is Anthropic's refusal opening is removed and replaced by the French refusal", async () => {
  runAnswer = (input) =>
    answer(input, ANTHROPIC_REFUSAL, {
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    });
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.declined("Alternatif"),
    ),
  );
  await waitFor(() =>
    expect(view.container.textContent).not.toContain("violative"),
  );
  expect(view.getByTestId("transcript-stopped").getAttribute("role")).toBe(
    "status",
  );
  expect(runs).toBe(1);
});

test("old server: the other Anthropic opening (« was blocked under Anthropic's Usage Policy ») is handled the same", async () => {
  runAnswer = (input) =>
    answer(input, "This request was blocked under Anthropic's Usage Policy.", {
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    });
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.declined("Alternatif"),
    ),
  );
  expect(view.container.textContent).not.toContain("Usage Policy");
});

test("a normal answer that merely mentions Anthropic's Usage Policy is never hidden", async () => {
  const normal =
    "Selon la politique d'usage, ceci est autorisé. This request was blocked under Anthropic's Usage Policy n'apparaît qu'en citation.";
  runAnswer = (input) =>
    answer(input, normal, {
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    });
  const view = await sendPhishingPrompt();
  await view.findByText(normal);
  await settleReactWork();
  expect(view.getByText(normal)).toBeTruthy();
  expect(view.queryByTestId("transcript-stopped")).toBeNull();
});

test("masked 401 carrying code session_expired (unknown body): recognised by the code, with « Se reconnecter »", async () => {
  runAnswer = httpRefusal(
    403,
    { error: "Corps inattendu", code: "session_expired" },
    { "x-synelia-status": "401" },
  );
  const view = await sendPhishingPrompt();
  await waitFor(() =>
    expect(view.getByTestId("transcript-stopped").textContent).toBe(
      ui.conversation.sessionExpired,
    ),
  );
  expect(
    view.getByRole("link", { name: "Se reconnecter" }).getAttribute("href"),
  ).toBe("/sign");
  expect(view.queryByTestId("transcript-retry")).toBeNull();
});
