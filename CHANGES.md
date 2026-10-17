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
| `server/src/persistence/local-intelligence.ts`, `server/src/app.ts` | `GET /api/synelia/runs/:runId` and `GET /api/synelia/messages/:messageId/model` (owner-only) → provider/model/status of the stored run that wrote an answer. |
| `app/src/lib/copilot/synelia-model.tsx`, `app/src/lib/copilot/provider.tsx`, `app/src/components/channels/chat-transcript.tsx` | "provider · model" under each answer (conversation transcript; `renderCustomMessages` for CopilotChat pages). |
| `app/index.html` | Title "Synelia Bot". |

## Pilot UI (French, reduced surface)
| File | Why |
|---|---|
| `app/src/lib/i18n/index.ts` (new) | No i18n in OpenBot: pilot strings centralised in one French dictionary (same shape for English later) + `pilot` flags. |
| `app/src/routes/sign.tsx`, `routes/_authed/onboarding.tsx`, `routes/_authed/_app/index.tsx`, `components/app-sidebar/app-sidebar.tsx`, `routes/_authed/_app/channel/$channelId.tsx`, `routes/_authed/_app/channel/new.tsx`, `routes/_authed/_app/bot.tsx`, `components/channels/composer/composer.tsx`, `lib/copilot/stopped-turn.ts`, `lib/copilot/synelia-model.tsx` | French strings ("conversation", not "channel"); home shows only new conversation + model picker + history; "Explore agents", Bots/Skills nav and computer/roster onboarding steps hidden by flags (not deleted). Model picker also on home and new-conversation pages. "Watch the computer" control hidden (no computers). |
| `app/src/lib/relative-time.ts` | Relative times ("il y a 2 minutes") in the pilot locale, not the browser's. |
| `app/src/routes/_authed/admin/learning.tsx`, `routes/_authed/admin/index.tsx`, `components/admin/admin-sidebar.tsx` | Learning (Intelligence feature) redirected to /admin, links removed; route kept for upstream merges. |
| `patches/@ag-ui%2Fmastra@1.1.6.patch`, `package.json`, `bun.lock`, `server/Dockerfile` | bun patch of the Mastra AG-UI bridge: RUN_ERROR message built from the provider error (message / nested error / responseBody message + HTTP status, never headers) instead of `[object Object]`; so the stored run events and the UI carry the same sentence. |

## Phase 0 hardening pass (gate before opening to 5 users)
| File | Why |
|---|---|
| `server/src/synelia/pilot-gate.ts` (new), `server/src/app.ts` | Server twin of the UI `pilot` flags (`SYNELIA_PILOT`, on by default): `/api/bots`, `/api/team-bots`, `/api/plugins/*` (Skills, MCP, connections, Composio, grants), `/api/computers`, `/api/host-access`, `/api/sandboxed`, `/api/agent-tools`, `/api/demonstrations`, `/api/routines`, `/api/responsibilities`, `/api/proactive`, `/api/voice`, `/api/components`, `/api/groups`, `/api/delivery`, `/api/events`, `/api/admin/learning`, and every non-GET `/api/agents*` answer 404. `GET /bot` redirects home. Tools outside the pilot (`computer_*`, `report_refusal`, `generateSandboxedUi`) are removed from the run input before the Bot sees them. |
| `server/src/persistence/local-intelligence.ts` | Lock acquire idempotent for the same runId; renew throws a 409 `PlatformRequestError` when 0 rows (keepLease stops the turn); thread change events (rename/archive/delete/title); `lastRunError`; title set once from the first user message of the first non-failed run (markdown stripped, ~60 chars), never over an existing name; `message_ids` written per run; `threadMessageModels` (badge map, owner-checked). |
| `server/src/persistence/schema.ts` | `synelia_thread_run.message_ids text[]` + GIN index + one-time backfill from events. |
| `server/src/persistence/postgres-runner.ts`, `server/src/synelia/models.ts` (new) | Stored provider/model = the one that really answered (allowlist + availability + default, same rule as Mastra), not the browser header; index follows store change events; pilot tool filter. |
| `server/src/copilot.ts` | Rename/archive/delete of a thread answered in SSE mode (the runtime returns 422 without Intelligence), owner-only, 404 otherwise. |
| `server/src/app.ts` | `GET /api/threads/:id` (local mode) → `{known, lastError}` under the owner rule; `GET /api/synelia/threads/:id/models` badge map. |
| `server/src/auth/bootstrap-password-user.ts` | Extra operator accounts `OPENBOT_BOOTSTRAP_USER_2_*`..`_9_*` (test account B for ownership checks). |
| `toolkit/src/headless-tools.ts`, `patches/@ag-ui%2Fmastra@1.1.6.patch` | One error rule in both places: provider words + `(HTTP n)`, `sk-…` redacted, the error object is never serialised (no requestBodyValues/url/headers), generic "Erreur du fournisseur" otherwise. |
| `agent-mastra/src/mastra/synelia-models.ts`, `index.ts` | `available` per model (OpenRouter key probed via `/key`: a management/provisioning key is unavailable); default and fallback only among available models. |
| `app/src/lib/copilot/synelia-model.tsx`, `components/channels/channel-chat.tsx`, `chat-transcript.tsx` | Unavailable models hidden; new conversation starts on the default; badge = one read per thread, disabled during a run, refreshed when it ends, last message of each run, aria-label; provider failure shown as "Ce modèle est indisponible pour le moment, choisissez-en un autre." with the technical line below; stored error redrawn after reload; resending the restored draft after a failure replaces the failed message instead of duplicating it. |
| `app/src/routes/_authed/_app/bot.tsx`, `lib/i18n/index.ts` | `/bot` redirected home under the pilot (`hideBotPage`). |
| `deploy/synelia/deploy.sh` (new) | Refuses to deploy a dirty tree; writes DEPLOYED_COMMIT and a chmod-600 bundle only from a clean commit. |
| tests | `server/tests/synelia-persistence.integration.test.ts` (needs `SYNELIA_TEST_DATABASE_URL`), `server/tests/synelia-pilot-gate.test.ts`, `toolkit/tests/synelia-error-text.test.ts`; e2e `e2e.sh ownership` and `e2e.sh gate` (outside the repo, /workspace/synelia-grokbot). |

## Pass 3: long runs, reattach, pilot tightening
| File | Why |
|---|---|
| `server/src/http-server.ts`, `server/src/synelia/sse-heartbeat.ts` (new) | Root cause of "network error" ~10-17 s into long runs: Bun.serve `idleTimeout` (10 s) closed the AG-UI stream while the model was silent (reproduced directly against the server container, not Traefik). `/api/copilotkit/*` gets `server.timeout(req, 0)`, and every `text/event-stream` response carries `: ping` every 5 s (`no-transform`, `X-Accel-Buffering: no`). |
| `app/src/lib/copilot/stream-reattach.ts` (new), `components/channels/channel-chat.tsx` | A transport cut mid-run is not shown as an error: the client reattaches with `connectAgent` (replay + follow to RUN_FINISHED/RUN_ERROR) and deduplicates messages by id. |
| `server/src/synelia/pilot-gate.ts` | Tools: ALLOWLIST (ask*/show* known names only), everything else removed. |
| `toolkit/src/headless-tools.ts`, patch `@ag-ui/mastra` | Redaction also for `glpat-…`, `Bearer …`, `token=` / `access_token=` / `private_token=`. |
| `agent-mastra/src/mastra/synelia-models.ts`, `server/src/synelia/models.ts`, `server/src/app.ts`, `server/src/copilot.ts`, `server/src/persistence/{postgres-runner,request-user}.ts` | Hidden QA model `synelia-test:always-fails` (SYNELIA_TEST_MODEL=on): always HTTP 401; listed and honoured for admins only (others get the default). QA: sign in as an admin account, pick "Test QA · always-fails · échec forcé (admin)" in the model picker, send any message. |
| `app/src/lib/voice/archive.ts`, `channel-chat.tsx`, `lib/i18n/index.ts` (keys only) | Voice hidden under the pilot: no fetch, no widget, no voice notices. |
| `routes/_authed/_app/index.tsx`, `channel/new.tsx`, `channel-chat.tsx` | Permanent notice "Pilote : données de test uniquement, pas de code ni de documents clients." (home, new conversation, under the composer). |
| tests | `server/tests/synelia-sse-heartbeat.test.ts`, allowlist test with `foo_tool`, redaction tests, hidden-model test, `app/src/lib/copilot/stream-reattach.test.ts`; e2e `sselong.sh` (>60 s run through Traefik). |

## Gate ouverture 5 utilisateurs
| # | Critère | Statut | Preuve |
|---|---|---|---|
| 1 | acquire même runId ×2 OK, autre runId 409 ; renew sur verrou perdu lève | OK — 28f3c42 | `synelia-persistence.integration.test.ts` › "acquire with the same runId twice…", "renew on a lost lock throws…" |
| 2 | `thread_run.model` = modèle qui a réellement répondu après fallback | OK — 28f3c42 | `resolveModel (gate 2…)` (5 tests) + vérif DB après run prod |
| 3 | B reçoit 404 sur threads/runs de A ; API Bots/Skills/ordinateur directe 404 | OK — 28f3c42 | `e2e.sh ownership`, `e2e.sh gate`, `synelia-pilot-gate.test.ts`, "other user: rename/delete answer 404" |
| 4 | rename/archive/delete mettent à jour `#index` | OK — 28f3c42 | "index updated immediately, not at the next run" |
| 5 | mots de passe tournés, credentials.txt supprimé, branche poussée sur remote privé | OUVERT | — |
| 6 | erreurs sans fuite (requestBodyValues + clé sk- absents du RUN_ERROR et de la DB) | OK — 28f3c42 | `synelia-error-text.test.ts` (formatter + helper du patch exécuté) |
| 7 | badge fiable (run >20 s, badge sans reload, pas de polling par message) | PARTIEL — 28f3c42 | requête unique par thread, invalidée en fin de run ; test navigateur >20 s à faire (Chief) |
| 8 | CI front verte (format:check, 6 tests cassés, lang=fr, pas d'anglais login/composer/sidebar/picker) | OUVERT (Frontend Expert) | — |
| 10 | outils : liste blanche ask*/show* (règle permanente) | OK — PASS3_HASH | `synelia-pilot-gate.test.ts` › "gate 10: tools are an allowlist" (`foo_tool` refusé) |
| 11 | avant ouverture : clé d'inférence OpenRouter + ZDR sur le modèle par défaut, OU politique de données 9router vérifiée par écrit et validée par JV | OUVERT | — |
| 12 | coupure du flux en cours de run : le client se rattache (connect), pas de fausse erreur, pas de doublon | PARTIEL — PASS3_HASH | `stream-reattach.test.ts` (détection + dédoublonnage) ; test navigateur avec coupure réelle à faire |
| 9 | déploiement refusé si arbre sale ; DEPLOYED_COMMIT depuis arbre propre | OK — 28f3c42 | `deploy/synelia/deploy.sh` |

## Deployment
| File | Why |
|---|---|
| `examples/synelia/*` (new) | Tenant package: Synelia Assistant (remote Mastra) + built-in General Assistant (via 9router). |
| `deploy/synelia/docker-compose.yml` (new) | postgres (pgvector pg16), migrate, agent-mastra, server; internal network, no host ports, no docker.sock, no computer supervisor; mem/cpu limits; Traefik labels + basicauth; secrets only in chmod-600 env files (`secrets/router9.env` referenced via env_file). |
| `.gitignore` | `agent-mastra/.mastra/` build output. |
| `server/Dockerfile` | Copies `agent-computer/src/egress.ts`, imported by the server (upstream image failed to start without it); `TENANT_PACKAGE_DIR` build arg so the app shows the Synelia brand. |

Not done in phase 0: LISTEN/NOTIFY (not used), SSE resume via Last-Event-ID, multi-user/SSO, learning.
