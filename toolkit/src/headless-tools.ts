import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type Tool,
  type ToolCall,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { withApprovalContext } from "./continuation";
import type { AuditInitiator } from "./initiator";

/** Client tools supplied by OpenBot when the caller has no browser. */
export type HeadlessTool = {
  definition: Tool;
  /**
   * Executed when called but never offered to the model. For a tool the Bot does not hold, so a
   * call it makes anyway gets a governed refusal rather than going unanswered.
   */
  hidden?: boolean;
  execute(
    args: unknown,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<unknown>;
};

/** Where a suspended run's waiting details ride on its AG-UI interrupt. */
export const OPENBOT_WAITING_METADATA = "openbotWaiting";

export type HeadlessWaiting = {
  kind: string;
  requestId?: string;
  [key: string]: unknown;
};

/** A durable request remains open; continuing the Bot would invent a human answer. */
export class HeadlessToolSuspension extends Error {
  constructor(
    message: string,
    readonly waiting: HeadlessWaiting,
  ) {
    super(message);
    this.name = "HeadlessToolSuspension";
  }
}

const MAX_TOOL_SEGMENTS = 30;

/**
 * Executes AG-UI client tools inside the Intelligence run. Backend results are
 * forwarded unchanged; only newly emitted unanswered calls can be executed.
 */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(
    private readonly tools: HeadlessTool[],
    private readonly initiator?: AuditInitiator,
  ) {
    super();
    const names = tools.map((tool) => tool.definition.name);
    if (new Set(names).size !== names.length)
      throw new Error("Headless tool names must be unique.");
  }

  run(
    originalInput: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      const tools = new Map(
        this.tools.map((tool) => [tool.definition.name, tool]),
      );
      const executed = new Set<string>();
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        let request: RunAgentInput = {
          ...originalInput,
          tools: [
            ...originalInput.tools.filter((tool) => !tools.has(tool.name)),
            ...this.tools
              .filter((tool) => !tool.hidden)
              .map((tool) => tool.definition),
          ],
        };
        for (let segment = 0; segment <= MAX_TOOL_SEGMENTS; segment += 1) {
          if (subscriber.closed) return;
          const historical = new Set(
            request.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          const emitted = new Set<string>();
          let messages = request.messages;
          let state = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new InvocationTransport(next, request),
            ).subscribe({
              next: ({
                event,
                messages: updatedMessages,
                state: updatedState,
              }) => {
                messages = updatedMessages;
                state = updatedState;
                if (event.type === EventType.TOOL_CALL_START)
                  emitted.add(String(event.toolCallId));
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                  for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    for (const call of message.toolCalls ?? []) {
                      if (!historical.has(call.id)) emitted.add(call.id);
                    }
                  }
                }
                if (event.type === EventType.RUN_FINISHED) {
                  terminal = event as RunFinishedEvent;
                  return;
                }
                if (event.type === EventType.RUN_STARTED) {
                  if (started) return;
                  started = true;
                }
                if (event.type === EventType.RUN_ERROR) failed = true;
                subscriber.next(event);
              },
              error: reject,
              complete: resolve,
            });
          });
          if (subscriber.closed || failed) return;
          if (!terminal)
            throw new Error(
              "The headless agent ended without a terminal event.",
            );
          const answered = new Set(
            messages.flatMap((message) =>
              message.role === "tool" ? [message.toolCallId] : [],
            ),
          );
          const pending: ToolCall[] = messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).filter(
                  (call) =>
                    emitted.has(call.id) &&
                    !historical.has(call.id) &&
                    !answered.has(call.id) &&
                    !executed.has(call.id),
                )
              : [],
          );
          const owned = pending.filter(
            (call) =>
              tools.has(call.function.name) ||
              call.function.name.startsWith("computer_"),
          );
          if (owned.length === 0) {
            subscriber.next(terminal);
            return;
          }
          if (segment === MAX_TOOL_SEGMENTS)
            throw new Error(
              "The headless tool continuation limit was reached.",
            );
          const results = new Map<string, string>();
          for (const call of owned) {
            if (subscriber.closed) return;
            executed.add(call.id);
            let content: string;
            let error: string | undefined;
            try {
              const tool = tools.get(call.function.name);
              if (!tool)
                throw new Error(
                  `The tool ${call.function.name} is unavailable for this headless turn.`,
                );
              const args: unknown = JSON.parse(call.function.arguments || "{}");
              const continuation = {
                runId: request.runId,
                threadId: request.threadId,
                toolCallId: call.id,
                toolName: call.function.name,
                args,
                messages,
                state,
                context: request.context,
                forwardedProps: request.forwardedProps,
                initiator: this.initiator,
              };
              const result = await withApprovalContext(continuation, () =>
                tool.execute(args, {
                  toolCallId: call.id,
                  signal: controller.signal,
                }),
              );
              content =
                typeof result === "string" ? result : JSON.stringify(result);
              if (content === undefined)
                throw new Error(
                  `The tool ${call.function.name} returned no result.`,
                );
            } catch (failure) {
              if (failure instanceof HeadlessToolSuspension) {
                failure.waiting.continuation ??= {
                  runId: request.runId,
                  threadId: request.threadId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  args: JSON.parse(call.function.arguments || "{}"),
                  messages,
                  state,
                  context: request.context,
                  forwardedProps: request.forwardedProps,
                  initiator: this.initiator,
                };
                subscriber.next({
                  type: EventType.CUSTOM,
                  name: "openbot.headless.waiting",
                  value: {
                    ...failure.waiting,
                    message: failure.message,
                    toolCallId: call.id,
                  },
                });
                subscriber.next({
                  ...terminal,
                  outcome: {
                    type: "interrupt",
                    interrupts: [
                      {
                        id: call.id,
                        toolCallId: call.id,
                        reason: "human_input",
                        message: failure.message,
                        metadata: { openbotWaiting: failure.waiting },
                      },
                    ],
                  },
                });
                return;
              }
              error =
                failure instanceof Error ? failure.message : String(failure);
              content = JSON.stringify({ ok: false, error });
            }
            if (subscriber.closed) return;
            const message: Message = {
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: call.id,
              content,
              ...(error ? { error } : {}),
            };
            messages = [...messages, message];
            results.set(call.id, content);
            // AG-UI 1.0's TOOL_CALL_RESULT has no `error` field and validation strips one; the
            // refusal travels in `content`, and on the tool message, which keeps `error`.
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: call.id,
              role: "tool",
              content,
            });
          }
          const interrupts =
            terminal.outcome?.type === "interrupt"
              ? terminal.outcome.interrupts
              : [];
          const unresolved = interrupts.filter(
            (interrupt) => !results.has(interrupt.toolCallId ?? interrupt.id),
          );
          if (owned.length !== pending.length || unresolved.length > 0) {
            subscriber.next(
              unresolved.length > 0
                ? {
                    ...terminal,
                    outcome: { type: "interrupt", interrupts: unresolved },
                  }
                : terminal,
            );
            return;
          }
          request = {
            ...request,
            messages,
            state,
            resume:
              interrupts.length > 0
                ? interrupts.map((interrupt) => ({
                    interruptId: interrupt.id,
                    status: "resolved" as const,
                    payload: results.get(interrupt.toolCallId ?? interrupt.id),
                  }))
                : undefined,
          };
        }
      };
      // Observable teardown owns cancellation; both asynchronous exits are observed.
      work().then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (subscriber.closed) return;
          subscriber.next({
            type: EventType.RUN_ERROR,
            code: "OPENBOT_HEADLESS_TOOL_ERROR",
            // Synelia fork: a remote Bot's failure often arrives as a plain object (an AI SDK
            // APICallError serialised by the bridge), which String() turns into "[object Object]".
            message: describeRunError(error),
          });
          subscriber.complete();
        },
      );
      return () => {
        controller.abort();
        subscription?.unsubscribe();
      };
    });
  }
}

/** AG-UI accumulation reads transport history, so seed each continuation explicitly. */
class InvocationTransport extends AbstractAgent {
  constructor(
    private readonly transport: AbstractAgent,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) {
    return this.transport.run(input);
  }
}

/** Synelia fork: API keys never leave in an error text (OpenRouter / OpenAI style `sk-...`). */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***").slice(0, 300);
}

/**
 * Synelia fork: the technical sentence for a failed run, whatever shape the failure arrived in.
 *
 * THE SAME RULE as `__syneliaErrorMessage` in patches/@ag-ui%2Fmastra@1.1.6.patch (the Mastra
 * bridge cannot import this module; keep the two in step): the provider's own words
 * (`responseBody` error message), else `message`, else a nested `error`/`cause`, plus "(HTTP n)".
 * Secrets redacted; the object itself is never serialised, so `requestBodyValues`, `url` and
 * headers cannot leak. Nothing usable → a generic sentence. The UI puts the French "model
 * unavailable" line above it; this text is what synelia_thread_run stores.
 */
export function describeRunError(error: unknown, depth = 0): string {
  if (error == null) return "Erreur du fournisseur";
  if (typeof error === "string") return redactSecrets(error);
  if (typeof error !== "object" || depth > 3) return "Erreur du fournisseur";
  const record = error as Record<string, unknown>;
  const status =
    typeof record.statusCode === "number" ? ` (HTTP ${record.statusCode})` : "";
  if (typeof record.responseBody === "string") {
    try {
      const body = JSON.parse(record.responseBody) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const said =
        typeof body.error === "string"
          ? body.error
          : typeof body.error?.message === "string"
            ? body.error.message
            : typeof body.message === "string"
              ? body.message
              : undefined;
      if (said) return `${redactSecrets(said)}${status}`;
    } catch {
      // Not JSON: fall through to the message.
    }
  }
  if (
    typeof record.message === "string" &&
    record.message.trim() &&
    record.message !== "[object Object]"
  ) {
    return `${redactSecrets(record.message)}${status}`;
  }
  if ("error" in record && record.error && record.error !== error)
    return describeRunError(record.error, depth + 1);
  if ("cause" in record && record.cause && record.cause !== error)
    return describeRunError(record.cause, depth + 1);
  return `Erreur du fournisseur${status}`;
}
