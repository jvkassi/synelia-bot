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
| `server/src/config.ts` | `OPENBOT_PERSISTENCE=postgres` mode (refuses stray `INTELLIGENCE_*`); `OPENBOT_PASSWORD_LOGIN` auth option. |
| `server/src/intelligence-client.ts` | Returns the local stand-in in postgres mode. |
| `server/src/copilot.ts` | Runtime built with `runner: PostgresAgentRunner` (no `intelligence`, no licence token) → SSE mode; learning off; request-user middleware (401 without session, 404 on foreign threads). |
| `server/src/index.ts` | Headless/routine turns use the Postgres runner; Intelligence entitlement/banner check skipped; password bootstrap user. |

## Login
| File | Why |
|---|---|
| `server/src/auth/index.ts` | Better Auth `emailAndPassword` (sign-up disabled, min 12 chars) when `OPENBOT_PASSWORD_LOGIN=true`. |
| `server/src/auth/bootstrap-password-user.ts` (new) | Creates the operator account from `OPENBOT_BOOTSTRAP_USER_*` at boot (idempotent, never rotates). |
| `app/src/lib/auth/queries.ts`, `app/src/routes/sign.tsx` | Sign-in screen shows an email/password form when the server allows it. |

## Models (config, not code)
| File | Why |
|---|---|
| `agent-mastra/src/mastra/synelia-models.ts` (new) | Providers `openrouter` (OPENROUTER_API_KEY) and `router9` (ROUTER9_BASE_URL/KEY), each disabled when unset; allowlist `SYNELIA_MODELS=provider:model@usage,…` + `SYNELIA_DEFAULT_MODEL`; single factory → OpenAI-compatible chat client; OpenRouter requests carry `provider: {data_collection: "deny", zdr: true}`. |
| `agent-mastra/src/mastra/index.ts` | Model picked per run from the "Synelia model" AG-UI context entry (`SYNELIA_MODELS_MODE=on`); `/synelia/models` route (behind the agent token). |
| `agent-mastra/Dockerfile.synelia`, `agent-mastra/bun.lock` (new) | Pinned install, telemetry off, non-root. |
| `server/src/app.ts` | `/api/synelia/models` (signed-in only, proxies Mastra's list: ids + labels, never keys); `passwordLogin` capability. |
| `app/src/lib/copilot/synelia-model.tsx` (new), `app/src/lib/copilot/provider.tsx`, `app/src/routes/_authed/_app/bot.tsx`, `app/src/routes/_authed/_app/channel/$channelId.tsx` | Model picker (grouped by provider, usage label, default marked), choice sent with every run. |

## Deployment
| File | Why |
|---|---|
| `examples/synelia/*` (new) | Tenant package: Synelia Assistant (remote Mastra) + built-in General Assistant (via 9router). |
| `deploy/synelia/docker-compose.yml` (new) | postgres (pgvector pg16), migrate, agent-mastra, server; internal network, no host ports, no docker.sock, no computer supervisor; mem/cpu limits; Traefik labels + basicauth; secrets only in chmod-600 env files (`secrets/router9.env` referenced via env_file). |
| `.gitignore` | `agent-mastra/.mastra/` build output. |

Not done in phase 0: LISTEN/NOTIFY (not used), SSE resume via Last-Event-ID, multi-user/SSO, learning.
