import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who the current CopilotKit request is for, carried to the runner.
 *
 * The open runtime's `AgentRunner.run()` receives the thread and the agent but not the request, so
 * the person is set here by a middleware in front of the runtime handler (see `mountCopilotRuntime`)
 * and read by `PostgresAgentRunner` to own threads and filter listings.
 */
export const requestUser = new AsyncLocalStorage<{ id: string; name: string }>();
