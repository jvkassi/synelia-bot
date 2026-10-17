import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { channelHistoryNotice } from "../src/components/channels/channel-chat";
import {
  readThreadMessages,
  type StoredThread,
} from "../src/lib/copilot/thread-messages";
import { ui } from "../src/lib/i18n";

function HistoryNoticeProbe({
  lastMessageAt,
}: {
  lastMessageAt: string | null;
}) {
  const [thread, setThread] = useState<StoredThread | null>(null);

  useEffect(() => {
    void readThreadMessages("thread-1", "agent-1").then(setThread);
  }, []);

  if (!thread) return null;
  const notice = channelHistoryNotice({
    restoring: false,
    messageCount: thread.messages.length,
    lastMessageAt,
    historyAvailability: thread.availability,
    historyReadFailed: thread.availability === "unavailable",
    unreadable: thread.unreadable,
  });
  return createElement(
    "div",
    { "data-testid": "history-read" },
    notice ? createElement("p", { role: "status" }, notice) : null,
  );
}

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

async function withFetch(handler: FetchHandler, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, {
    preconnect: original.preconnect,
  });
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

describe("channel history notice", () => {
  test("failed history retrieval does not claim the CopilotKit project changed", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      unreadable: 0,
    });

    expect(notice).toContain("temporarily unavailable");
    expect(notice).not.toContain("different CopilotKit project");
    expect(notice).not.toContain("fresh history");
  });

  test("unreadable empty history reports holes without project-change wording", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "ready",
      unreadable: 1,
    });

    expect(notice).toContain("One earlier message could not be read");
    expect(notice).not.toContain("different CopilotKit project");
  });

  test("a malformed successful history response renders the unavailable notice", async () => {
    await withFetch(
      async () => Response.json({ messages: "not an array" }),
      async () => {
        const view = render(
          createElement(HistoryNoticeProbe, {
            lastMessageAt: "2026-09-08T12:00:00.000Z",
          }),
        );

        expect((await view.findByRole("status")).textContent).toContain(
          "Earlier messages are temporarily unavailable",
        );
        expect(view.queryByText(/different CopilotKit project/)).toBeNull();
      },
    );
  });

  test("an explicit empty history response renders no notice", async () => {
    await withFetch(
      async () => Response.json({ messages: [] }),
      async () => {
        const view = render(
          createElement(HistoryNoticeProbe, {
            lastMessageAt: "2026-09-08T12:00:00.000Z",
          }),
        );

        await view.findByTestId("history-read");
        expect(view.queryByRole("status")).toBeNull();
      },
    );
  });

  test("a malformed successful history response keeps the unavailable notice visible", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      historyReadFailed: true,
      unreadable: 0,
    });

    expect(notice).toContain("temporarily unavailable");
    expect(notice).not.toContain("different CopilotKit project");
  });

  test("valid empty history in a used channel has no project-change notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
      }),
    ).toBeNull();
  });
  test("a failed history read remains visible over an existing transcript", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 3,
        lastMessageAt: null,
        historyAvailability: "unavailable",
        unreadable: 1,
        historyReadFailed: true,
      }),
    ).toContain("temporarily unavailable");
  });

  test("reopen first-message-lost: roster line is the person's, nothing loaded — not sent (plain)", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: false,
      }),
    ).toBe(ui.conversation.notSentReopenPlain);
  });

  test("reopen thread-with-earlier-runs: roster line is the person's, history ends on a Bot answer — not sent", () => {
    // There ARE stored messages (earlier runs), but the person's newest message is newer than all of
    // them (it reached the roster, no run persisted it), so the loaded transcript ends on an answer.
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 4,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: false,
      }),
    ).toBe(ui.conversation.notSentReopenPlain);
  });

  test("restorable variant is used when the message is restorable", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: false,
        lastMessageRestorable: true,
      }),
    ).toBe(ui.conversation.notSentReopenRestored);
  });

  test("sent and still in the transcript (lastLoadedIsUser): no not-sent notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 1,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: true,
      }),
    ).toBeNull();
  });

  test("the roster's last line is a Bot answer (lastMessageByUser false): no not-sent notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 2,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: false,
        lastLoadedIsUser: false,
      }),
    ).toBeNull();
  });

  test("history unreachable wins over not-sent: we cannot claim it was not sent when we cannot read", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "unavailable",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: false,
      }),
    ).toContain("temporarily unavailable");
  });

  test("never used (lastMessageAt null): no not-sent notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: null,
        historyAvailability: "ready",
        unreadable: 0,
        lastMessageByUser: true,
        lastLoadedIsUser: false,
      }),
    ).toBeNull();
  });
});
