import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import type { AgentChannel } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";

/*
 * Synelia fork: a thread the compose path created a moment ago (it stashed the first message) has
 * nothing stored, so ChannelChat skips the mount read of its history. A channel opened without that
 * seed (reload, an old conversation from the sidebar) still reads it.
 */

const NativeResponse = globalThis.Response;
let originalFetch: typeof fetch;
let historyReads: string[] = [];
let runs = 0;
const stored: Message = {
  id: "stored",
  role: "assistant",
  content: "Stored opening",
};

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function channelFor(id: string): AgentChannel {
  return {
    id,
    name: "Fresh test",
    agentIds: ["fresh-bot"],
    threadId: `${id}-thread`,
    active: true,
    lastMessageAt: null,
  } as AgentChannel;
}

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
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
      if (url.pathname === "/api/plugins/for/fresh-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { "fresh-bot": { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: "t", runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: "t", runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        runs += 1;
        return sse([
          { type: "RUN_STARTED", threadId: "t", runId: `run-${runs}` },
          { type: "RUN_FINISHED", threadId: "t", runId: `run-${runs}` },
        ]);
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      const match = url.pathname.match(/\/threads\/([^/]+)\/messages$/);
      if (match?.[1]) {
        historyReads.push(match[1]);
        return NativeResponse.json({ messages: [stored] });
      }
      // Anything else the screen asks for is not what this test is about.
      return NativeResponse.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  historyReads = [];
  runs = 0;
});
afterAll(async () => {
  // Let React's scheduler drain the last commit before `window` goes away.
  await new Promise((resolve) => setTimeout(resolve, 100));
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function mount(channel: AgentChannel) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="fresh-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("a thread just created from home sends its first message without reading history", async () => {
  const channel = channelFor("fresh-channel");
  stashFirstMessage(channel.id, "prompt b");
  const view = mount(channel);
  await view.findByText("prompt b");
  // The seed is sent, which only happens once the join gate opened.
  await waitFor(() => expect(runs).toBe(1));
  expect(historyReads).toEqual([]);
});

test("an existing channel (reload, sidebar) still reads its history", async () => {
  const channel = channelFor("old-channel");
  const view = mount(channel);
  await view.findByText("Stored opening");
  expect(historyReads).toEqual([channel.threadId]);
});
