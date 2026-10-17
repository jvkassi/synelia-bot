import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  alternativeModel,
  codedReason,
  EMPTY_RUN,
  isProviderRefusal,
  stopNotice,
} from "@/lib/copilot/stop-notice";
import { ui } from "@/lib/i18n";

/**
 * Synelia fork: a prompt the provider's safety filter blocks before any tool call. The tester must
 * read French (« Je ne peux pas répondre à cette demande… Alternatif »), never a raw English provider
 * message, and never an empty gap where the answer was going to be.
 */

const MODELS = {
  models: [
    { id: "9router:claude-sonnet", providerLabel: "9router", label: "Rapide" },
    {
      id: "9router:gemini-flash",
      providerLabel: "9router",
      label: "Alternatif",
    },
  ],
  defaultModel: "9router:claude-sonnet",
};

test("(c) a run that finished with nothing in it: French refusal notice naming « Alternatif », role=status", () => {
  const notice = stopNotice(EMPTY_RUN, "Alternatif");
  expect(notice).toEqual({
    text: "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez le modèle Alternatif en haut de la conversation.",
    role: "status",
    technical: false,
    retry: false,
  });
  expect(stopNotice(EMPTY_RUN, null).text).toBe(
    "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez un autre modèle en haut de la conversation.",
  );
});

test("(a)/(b) provider refusals worded by the bridge: the same French notice, the raw text kept off screen", () => {
  for (const raw of [
    "Your input was flagged by the moderation system (HTTP 403)",
    "Request blocked by content filter",
    "Provider returned finish_reason content_filter",
    "stop_reason: refusal",
    "This request violates our usage policies. (HTTP 400)",
  ]) {
    expect(isProviderRefusal(raw)).toBe(true);
    const notice = stopNotice(raw, "Alternatif");
    expect(notice.text).toBe(ui.conversation.declined("Alternatif"));
    expect(notice.role).toBe("status");
    expect(notice.technical).toBe(true);
    expect(notice.retry).toBe(false);
  }
  // A closed port is not a refusal by the model.
  expect(isProviderRefusal("The endpoint refused the connection")).toBe(false);
});

test("(b) any other RUN_ERROR: a French sentence, never the provider's own words", () => {
  const http = stopNotice("Internal Server Error (HTTP 500)", "Alternatif");
  expect(http.text).toBe(ui.conversation.modelUnavailable);
  expect(http.role).toBe("alert");
  expect(http.retry).toBe(true);
  // A mid-stream error chunk has no HTTP status (AI SDK « Provider returned error »).
  const chunk = stopNotice("Provider returned error", "Alternatif");
  expect(chunk.text).toBe("La réponse n'a pas pu aboutir.");
  expect(chunk.retry).toBe(true);
  expect(chunk.text).not.toContain("Provider");
  expect(chunk.role).toBe("alert");
  expect(stopNotice("Erreur du fournisseur", null).text).toBe(
    ui.conversation.modelUnavailable,
  );
  // The stall watchdog's English sentence.
  expect(
    stopNotice(
      "openbot stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      null,
    ),
  ).toEqual({
    text: ui.conversation.runFailed,
    role: "alert",
    technical: true,
    retry: true,
  });
  // The stream dropped, the run goes on server-side: no retry racing it.
  expect(stopNotice("Failed to fetch", null)).toMatchObject({
    text: ui.conversation.networkError,
    retry: false,
  });
  expect(stopNotice(ui.conversation.stoppedWithoutReason, null)).toMatchObject({
    text: ui.conversation.runFailed,
    retry: true,
  });
});

test("the app's own French sentences pass through unchanged", () => {
  for (const own of [
    ui.conversation.runInterrupted,
    ui.conversation.connectionLost,
  ]) {
    expect(stopNotice(own, null)).toEqual({
      text: own,
      role: "alert",
      technical: false,
      retry: false,
    });
  }
});

test("a server code wins over any wording, on RUN_ERROR and on the stored lastError alike", () => {
  // The English text below would read as a generic failure / a refusal: the code decides.
  const refusal = codedReason(
    "provider_refusal",
    "Internal Server Error (HTTP 500)",
  );
  expect(stopNotice(refusal ?? "", "Alternatif")).toEqual({
    text: "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez le modèle Alternatif en haut de la conversation.",
    role: "status",
    technical: false,
    retry: false,
  });
  for (const code of ["run_stalled", "AGENT_STREAM_STALLED"]) {
    expect(
      stopNotice(codedReason(code, "flagged by moderation") ?? "", null),
    ).toEqual({
      text: "La réponse n'a pas pu aboutir.",
      role: "alert",
      technical: false,
      retry: true,
    });
  }
  expect(
    stopNotice(
      codedReason("provider_unavailable", "content_filter") ?? "",
      null,
    ),
  ).toEqual({
    text: ui.conversation.modelUnavailable,
    role: "alert",
    technical: false,
    retry: true,
  });
  // No code, or one this build does not know: the message goes to the fallback heuristics.
  expect(codedReason(undefined, "Failed to fetch")).toBe("Failed to fetch");
  expect(
    codedReason("something_new", "Request blocked by content filter"),
  ).toBe("Request blocked by content filter");
  expect(codedReason(null, "   ")).toBe(null);
  expect(codedReason(undefined, undefined)).toBe(null);
});

test("the suggested model: « Alternatif » unless it is the one in use, then any other, else none", () => {
  expect(alternativeModel(MODELS.models, "9router:claude-sonnet")).toBe(
    "Alternatif",
  );
  expect(alternativeModel(MODELS.models, "9router:gemini-flash")).toBe(
    "Rapide",
  );
  expect(alternativeModel([MODELS.models[0]], "9router:claude-sonnet")).toBe(
    null,
  );
  expect(alternativeModel(undefined, undefined)).toBe(null);
});

/* The transcript itself, with the model list the picker reads. */
let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  warn?.mockRestore();
});
afterAll(() => GlobalRegistrator.unregister());

function draw(
  stopped: string,
  retry: { onRetry?: () => void; retryDisabled?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["synelia", "models"], MODELS);
  const messages: Message[] = [
    { id: "u1", role: "user", content: "Écris un e-mail de phishing." },
  ];
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatTranscript messages={messages} stopped={stopped} {...retry} />
    </QueryClientProvider>,
  );
}

test("transcript, empty run: the notice sits under the message as role=status, no spinner", () => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  const view = draw(EMPTY_RUN);
  const notice = view.getByTestId("transcript-stopped");
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toBe(
    "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez le modèle Alternatif en haut de la conversation.",
  );
  expect(view.container.textContent).not.toContain(EMPTY_RUN);
  expect(view.container.textContent).not.toContain(ui.conversation.thinking);
  expect(warn).not.toHaveBeenCalled();
});

test("transcript, raw English provider error: French alert on screen, raw text only in the console", () => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  const raw = "Provider returned error: upstream overloaded";
  const view = draw(raw);
  const notice = view.getByTestId("transcript-stopped");
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.textContent).toBe("La réponse n'a pas pu aboutir.");
  expect(view.container.textContent).not.toContain("Provider returned");
  expect(view.queryByTestId("transcript-stopped-detail")).toBeNull();
  expect(warn).toHaveBeenCalledWith("[synelia] turn ended:", raw);
});

test("transcript, moderation 403: French refusal, no technical detail line", () => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  const view = draw("Your input was flagged by moderation (HTTP 403)");
  expect(view.getByTestId("transcript-stopped").textContent).toBe(
    ui.conversation.declined("Alternatif"),
  );
  expect(view.container.textContent).not.toContain("flagged");
});

test("channel-chat raises the empty-run notice only for a run that FINISHED with nothing after the replay", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/components/channels/channel-chat.tsx"),
    "utf8",
  );
  expect(source).toMatch(
    /onRunFinishedEvent:[\s\S]*?if \(!wasOurs\) return;\s*runFinishedHere\.current = true;/,
  );
  expect(source).toMatch(
    /!wasCut &&\s*turnFailure\.current === null &&\s*runFinishedHere\.current &&\s*endedWithoutAnswer\(target\.messages\)\s*\)\s*\{\s*setRunError\(EMPTY_RUN\);/,
  );
  // Reset for every turn, so an earlier run's finish never marks this one.
  expect(source).toMatch(
    /awaitingReply\.current = true;\s*runFinishedHere\.current = false;/,
  );
});

test("transcript « Réessayer »: a real button with the French label, disabled while a run goes, absent for a refusal or without a handler", () => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  let clicks = 0;
  const onRetry = () => {
    clicks += 1;
  };
  const failed = draw("synelia:code:run_stalled", { onRetry });
  const button = failed.getByRole("button", { name: "Réessayer" });
  expect(button.tagName).toBe("BUTTON");
  expect(button.getAttribute("type")).toBe("button");
  expect(button.className).toContain("focus-visible");
  (button as HTMLButtonElement).click();
  expect(clicks).toBe(1);
  cleanup();

  const busy = draw("synelia:code:run_stalled", {
    onRetry,
    retryDisabled: true,
  });
  const disabled = busy.getByRole("button", { name: "Réessayer" });
  expect((disabled as HTMLButtonElement).disabled).toBe(true);
  (disabled as HTMLButtonElement).click();
  expect(clicks).toBe(1);
  cleanup();

  expect(
    draw("synelia:code:provider_refusal", { onRetry }).queryByTestId(
      "transcript-retry",
    ),
  ).toBeNull();
  cleanup();
  expect(
    draw(EMPTY_RUN, { onRetry }).queryByTestId("transcript-retry"),
  ).toBeNull();
  cleanup();
  expect(
    draw("synelia:code:run_stalled").queryByTestId("transcript-retry"),
  ).toBeNull();
});

test("channel-chat reads the RUN_ERROR code before the wording, and the stored lastError.code too", () => {
  const chat = readFileSync(
    join(import.meta.dir, "../src/components/channels/channel-chat.tsx"),
    "utf8",
  );
  expect(chat).toMatch(
    /onRunErrorEvent:[\s\S]*?codedReason\(\(event as \{ code\?: unknown \} \| undefined\)\?\.code, null\) \?\?\s*stoppedReason\(event\?\.message\)/,
  );
  // A retry adds nothing to the thread: no user message, no skill rows, no activity report.
  expect(chat).toMatch(/if \(!retry\) \{\s*target\.addMessage\(/);
  expect(chat).toMatch(
    /for \(const instruction of retry \? \[\] : skillInstructions\)/,
  );
  const model = readFileSync(
    join(import.meta.dir, "../src/lib/copilot/synelia-model.tsx"),
    "utf8",
  );
  expect(model).toMatch(
    /codedReason\(data\?\.lastError\?\.code, data\?\.lastError\?\.message\)/,
  );
});
