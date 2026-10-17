# Synelia Bot — phase 0 changes (branch `synelia/phase0`, base OpenBot 53a656b, v0.2.0, MIT)

Goal: run OpenBot without CopilotKit Intelligence (or any hosted service except the LLM providers),
on konnect behind Traefik + basicauth, with a Mastra Bot answering through OpenRouter / 9router.

## Persistence without Intelligence (ThreadStore / MemoryStore / LearningStore)
| File | Why |
|---|---|
| `server/src/persistence/schema.ts` (new) | DDL for `synelia_thread`, `synelia_thread_run` (events, messages snapshot, provider, model), `synelia_thread_lock`. Created at boot with `IF NOT EXISTS`, upstream Drizzle journal untouched. |
| `server/src/persistence/local-intelligence.ts` (new) | Postgres stand-in for the `CopilotKitIntelligence` methods OpenBot calls: threads, messages, locks. `getRuntimeEntitlements` answers "not entitled", so memory uses OpenBot's own tables (MemoryStore = local). Learning = stub (LearningStore). jsonb written via `::text::jsonb`. |
| `server/src/persistence/postgres-runner.ts` (new) | `InMemoryAgentRunner` (open CopilotKit runtime, SSE) made durable: persists every run, rehydrates threads after reload/restart, owner checks, per-user thread list, records provider/model per run. |
| `server/src/persistence/request-user.ts` (new) | AsyncLocalStorage carrying the signed-in person to the runner. |
| `server/src/config.ts` | `OPENBOT_PERSISTENCE=postgres` mode (refuses stray `INTELLIGENCE_*`); `OPENBOT_PASSWORD_LOGIN` auth option, counted as an identity provider by the single-user guard. |
| `server/src/intelligence-client.ts` | Returns the local stand-in in postgres mode. |
| `server/src/copilot.ts` | Runtime built with `runner: PostgresAgentRunner` (no `intelligence`, no licence token) → SSE mode; learning off; request-user middleware (401 without session, 404 on foreign threads). |
| `server/src/index.ts` | Headless/routine turns use the Postgres runner; Intelligence entitlement/banner check skipped; password bootstrap user. |

## Login
| File | Why |
|---|---|
| `server/src/auth/index.ts` | Better Auth `emailAndPassword` (sign-up disabled, min 12 chars) when `OPENBOT_PASSWORD_LOGIN=true`. |
| `server/src/auth/bootstrap-password-user.ts` (new) | Creates the operator account from `OPENBOT_BOOTSTRAP_USER_*` at boot (idempotent, never rotates), inside a Better Auth endpoint context (needed by `validateUserInfo`) and with Better Auth's local credential issuer. |
| `app/src/lib/auth/queries.ts`, `app/src/routes/sign.tsx` | Sign-in screen shows an email/password form when the server allows it. |

## Models (config, not code)
| File | Why |
|---|---|
| `agent-mastra/src/mastra/synelia-models.ts` (new) | Providers `openrouter` (OPENROUTER_API_KEY) and `router9` (ROUTER9_BASE_URL/KEY), each disabled when unset; allowlist `SYNELIA_MODELS=provider:model@usage,…` + `SYNELIA_DEFAULT_MODEL`; single factory → OpenAI-compatible chat client; OpenRouter requests carry `provider: {data_collection: "deny", zdr: true}`. |
| `agent-mastra/src/mastra/index.ts` | Model picked per run from the "Synelia model" AG-UI context entry (`SYNELIA_MODELS_MODE=on`); `/synelia/models` route (behind the agent token). |
| `agent-mastra/Dockerfile.synelia`, `agent-mastra/bun.lock` (new) | Pinned install, telemetry off, non-root. |
| `server/src/app.ts` | `/api/synelia/models` (signed-in only, proxies Mastra's list: ids + labels, never keys); `passwordLogin` capability. |
| `app/src/lib/copilot/synelia-model.tsx` (new), `app/src/lib/copilot/provider.tsx`, `app/src/routes/_authed/_app/bot.tsx`, `app/src/routes/_authed/_app/channel/$channelId.tsx` | Model picker (grouped by provider, usage label, default marked), choice sent with every run. |

## Errors and per-answer model
| File | Why |
|---|---|
| `toolkit/src/headless-tools.ts` | `describeRunError`: RUN_ERROR carries the provider's own message (AI SDK `responseBody` / `message`, HTTP status) instead of `[object Object]`; never headers or request bodies. |
| `server/src/persistence/local-intelligence.ts`, `server/src/app.ts` | `GET /api/synelia/runs/:runId` (owner-only) → provider/model/status of a stored run. |
| `app/src/lib/copilot/synelia-model.tsx`, `app/src/lib/copilot/provider.tsx` | `renderCustomMessages` renderer: "provider · model" under the last assistant message of each run. |
| `app/index.html` | Title "Synelia Bot". |

## Pilot UI (French, reduced surface)
| File | Why |
|---|---|
| `app/src/lib/i18n/index.ts` (new) | No i18n in OpenBot: pilot strings centralised in one French dictionary (same shape for English later) + `pilot` flags. |
| `app/src/routes/sign.tsx`, `routes/_authed/onboarding.tsx`, `routes/_authed/_app/index.tsx`, `components/app-sidebar/app-sidebar.tsx`, `routes/_authed/_app/channel/$channelId.tsx`, `routes/_authed/_app/channel/new.tsx`, `routes/_authed/_app/bot.tsx`, `components/channels/composer/composer.tsx`, `lib/copilot/stopped-turn.ts`, `lib/copilot/synelia-model.tsx` | French strings ("conversation", not "channel"); home shows only new conversation + model picker + history; "Explore agents", Bots/Skills nav and computer/roster onboarding steps hidden by flags (not deleted). Model picker also on home and new-conversation pages. |
| `app/src/routes/_authed/admin/learning.tsx`, `routes/_authed/admin/index.tsx`, `components/admin/admin-sidebar.tsx` | Learning (Intelligence feature) redirected to /admin, links removed; route kept for upstream merges. |
| `patches/@ag-ui%2Fmastra@1.1.6.patch`, `package.json`, `bun.lock`, `server/Dockerfile` | bun patch of the Mastra AG-UI bridge: RUN_ERROR message built from the provider error (message / nested error / responseBody message + HTTP status, never headers) instead of `[object Object]`; so the stored run events and the UI carry the same sentence. |

## Deployment
| File | Why |
|---|---|
| `examples/synelia/*` (new) | Tenant package: Synelia Assistant (remote Mastra) + built-in General Assistant (via 9router). |
| `deploy/synelia/docker-compose.yml` (new) | postgres (pgvector pg16), migrate, agent-mastra, server; internal network, no host ports, no docker.sock, no computer supervisor; mem/cpu limits; Traefik labels + basicauth; secrets only in chmod-600 env files (`secrets/router9.env` referenced via env_file). |
| `.gitignore` | `agent-mastra/.mastra/` build output. |
| `server/Dockerfile` | Copies `agent-computer/src/egress.ts`, imported by the server (upstream image failed to start without it); `TENANT_PACKAGE_DIR` build arg so the app shows the Synelia brand. |

Not done in phase 0: LISTEN/NOTIFY (not used), SSE resume via Last-Event-ID, multi-user/SSO, learning.
