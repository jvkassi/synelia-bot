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

## Politique de données du pilote (décidée le 2026-10-17)
Décision de Chief Of Staff, sur délégation de Jean-Vincent (2026-10-17), pour les items 5 et 11 du gate.
- **Règle** : pendant le pilote (5 utilisateurs), données de test uniquement. Pas de données clients, pas de données personnelles ou sensibles, pas de code ni de documents clients.
- **Bandeau** : la règle est affichée en permanence dans l'app (`ui.pilotNotice`, « Pilote : données de test uniquement, pas de code ni de documents clients. ») sur l'accueil, la nouvelle conversation et sous le composeur.
- **OpenRouter** : uniquement des endpoints à rétention nulle qui n'entraînent pas sur les prompts. Chaque requête porte `provider: { data_collection: "deny", zdr: true }` (`agent-mastra/src/mastra/synelia-models.ts`). Ne pas mettre `OPENROUTER_PRIVACY=off` en pilote.
- **9router** : autorisé pour les données de test seulement, puisque sa politique de rétention n'est pas vérifiée par écrit.
- **Dépôt** : privé (`github.com/jvkassi/synelia-bot`). Aucun secret commité : scan gitleaks sur tout l'historique avant le push (seules des clés factices de tests sont détectées).

## Gate ouverture 5 utilisateurs
| # | Critère | Statut | Preuve |
|---|---|---|---|
| 1 | acquire même runId ×2 OK, autre runId 409 ; renew sur verrou perdu lève | OK — 28f3c42 | `synelia-persistence.integration.test.ts` › "acquire with the same runId twice…", "renew on a lost lock throws…" |
| 2 | `thread_run.model` = modèle qui a réellement répondu après fallback | OK — 28f3c42 | `resolveModel (gate 2…)` (5 tests) + vérif DB après run prod |
| 3 | B reçoit 404 sur threads/runs de A ; API Bots/Skills/ordinateur directe 404 | OK — 28f3c42 | `e2e.sh ownership`, `e2e.sh gate`, `synelia-pilot-gate.test.ts`, "other user: rename/delete answer 404" |
| 4 | rename/archive/delete mettent à jour `#index` | OK — 28f3c42 | "index updated immediately, not at the next run" |
| 5 | mots de passe tournés, credentials.txt supprimé, branche poussée sur remote privé | PARTIEL — décidé par Chief Of Staff (délégation de Jean-Vincent, 2026-10-17) | Rotation faite le 2026-10-17 à 13:45 UTC : basic auth Traefik `synelia`, mots de passe de jv.test et jv.test2, mot de passe Postgres, `BETTER_AUTH_SECRET` (les 71 sessions sont invalidées). Ancien basic auth refusé (401), nouveaux logins OK, `e2e.sh ownership` et `e2e.sh gate` PASS après rotation. `credentials.txt` est conservé pour l'instant (chmod 600, nouvelles valeurs uniquement) sur décision de l'Architecture Reviewer. Remote privé retenu : `github.com/jvkassi/synelia-bot`, pas encore poussé (création du dépôt en attente). |
| 6 | erreurs sans fuite (requestBodyValues + clé sk- absents du RUN_ERROR et de la DB) | OK — 28f3c42 | `synelia-error-text.test.ts` (formatter + helper du patch exécuté) |
| 7 | badge fiable (run >20 s, badge sans reload, pas de polling par message) | PARTIEL — 28f3c42 | requête unique par thread, invalidée en fin de run ; test navigateur >20 s à faire (Chief) |
| 8 | CI front verte (format:check, 6 tests cassés, lang=fr, pas d'anglais login/composer/sidebar/picker) | PARTIEL — branche `synelia/phase0-i18n` (abe9870, 61567ca, 0180b7a, 84e68fc, tests HEAD) | typecheck/format:check/build OK ; app tests : 16 échecs Synelia corrigés, 42 restants identiques à l'upstream 53a656b ; `i18n-shape.test.ts`, `network-error-message.test.ts`. Reste lint : 2 diagnostics préexistants à a627c86 (`local-intelligence.ts:347` useOptionalChain, `synelia-model.tsx:150` aria-label sur div) |
| 10 | outils : liste blanche ask*/show* (règle permanente) | OK — 3aaa235 | `synelia-pilot-gate.test.ts` › "gate 10: tools are an allowlist" (`foo_tool` refusé) |
| 11 | avant ouverture : clé d'inférence OpenRouter + ZDR sur le modèle par défaut, OU politique de données 9router vérifiée par écrit et validée par JV | OK (politique) — décidé par Chief Of Staff (délégation de Jean-Vincent, 2026-10-17) | Voir « Politique de données du pilote » ci-dessous. ZDR OpenRouter forcé dans le code (`synelia-models.ts`, `provider.data_collection=deny`, `zdr=true`, actif sauf `OPENROUTER_PRIVACY=off`). La clé OpenRouter actuelle est une clé de gestion, donc les modèles OpenRouter restent indisponibles jusqu'à l'arrivée d'une clé d'inférence. |
| 12 | coupure du flux en cours de run : le client se rattache (connect), pas de fausse erreur, pas de doublon | PARTIEL — 3aaa235 | `stream-reattach.test.ts` (détection + dédoublonnage) ; test navigateur avec coupure réelle à faire |
| 9 | déploiement refusé si arbre sale ; DEPLOYED_COMMIT depuis arbre propre | OK — 28f3c42 | `deploy/synelia/deploy.sh` |

## i18n pilote (Frontend Expert, branche synelia/phase0-i18n)
- `<html lang="fr">` ; `UiStrings = Widen<typeof fr>` (chaînes élargies), `fr satisfies UiStrings` ; test de forme pour un futur `en`.
- Textes restants en français via `ui.*` : composer, transcript, barre latérale (menu de conversation, pagination, compte), connexion, nouvelle conversation, vue conversation, sélecteur de modèle, bascule de barre latérale, défilement.
- Erreur réseau brute (« network error », « Failed to fetch ») affichée comme `ui.conversation.networkError` (affichage seulement, transport inchangé).
- Tests : assertions via `ui.*` ; Explore et `/bot` conditionnés par `pilot.*`.
- Passe 2 (branche `synelia/phase0-i18n2`) : indicateur d'attente « Le modèle réfléchit… » (`ui.conversation.thinking`, 1:1 et groupe, `role="status"` + `aria-live="polite"`, shimmer existant coupé sous `prefers-reduced-motion`), bouton « Retirer » du message en file, `aria-label` « Pièces jointes » et « Fermer les détails ».
- Passe 3 (branche `synelia/phase0-i18n3`) : panneau « Assistant de la conversation » en français (`ui.profile.*` : Privé/Public, Géré par le système, Rôle ; « Nouvelle conversation », « Ouvrir … »), `aria-label` « Nouvelle conversation » sur le `+` de la barre latérale, champ fichier caché (`aria-hidden`, `tabIndex={-1}`) derrière le bouton « Joindre un fichier ».
- Passe 4 (branche `synelia/phase0-i18n4`) : onboarding en français (`ui.onboarding.*`) ; « Réponse interrompue » masquée tant qu'un tour envoyé d'ici est en cours (`showInterrupted`, `turnsInFlight`) ; run vide (renvoi idempotent `isAlreadyAnswered`) rejoué pour afficher la réponse d'origine (`endedWithoutAnswer` + `connectAgent`, sans jamais retirer un message déjà affiché : `replayKeeps`) ; « Retirer {fichier} » sur les pièces jointes et ligne de responsabilité en français.
- Passe 4, réglages : en pilote (`pilot.hideSettingsExtras`), Approbations, Comptes connectés, Mots de passe et Galerie de composants retirés du menu et redirigés vers Général par URL (`isPilotHiddenSettingsPath`, `beforeLoad` de `settings/route.tsx`) ; Général et Mémoire en français (`ui.settings.*`, compteur « 0 sur 4 000 caractères »). Côté serveur (passe 6, voir plus bas) : `/api/passwords`, `/api/sign-in-requests` et `/api/identity/*` sont fermés ; dans `/api/approvals`, seuls `rules`, `preferences` et `team` sont fermés ; `/api/plugins` et `/api/components` sont bloqués.
- Passe 4, réglages (suite) : en pilote (`pilot.hideNotificationsSettings`), l'onglet Notifications et l'écran Appareils qu'il contient (routage des mises à jour, appareils, livraisons récentes) sont retirés du menu et redirigés vers Général par URL (même `isPilotHiddenSettingsPath`). Leurs API, `/api/delivery` et `/api/bots/routing`, sont déjà fermées par `pilot-gate.ts` (hors PILOT_ALLOWED_PREFIXES).
- Passe 4, marque et erreurs : « OpenBot » visible remplacé par `appConfig.brand.productName` (Synelia Bot en production) hors écrans admin ; page d'erreur du routeur (`defaultErrorComponent` → `RouteError`) « Une erreur est survenue. Rechargez la page. » + « Afficher le détail ».
- Passe 4, attente : composant partagé `Thinking` (accueil, conversation, groupe) ; sur l'accueil, la bulle optimiste et l'indicateur passent au-dessus du composer ; après 8 s sans premier jeton, même région `role="status"` : « Le modèle réfléchit, cela peut prendre jusqu'à 30 secondes… » (minuteur nettoyé au démontage) ; point en couleur de premier plan, opacité ≥ 0,7 (≥ 3:1 dans les deux thèmes) ; sous `prefers-reduced-motion`, le texte des lignes `tool-line-running` redevient visible (`-webkit-text-fill-color` restauré).
- Passe 4, modèles : le libellé `label` renvoyé par le serveur est affiché dans le sélecteur et sous la réponse, sinon l'id brut ; plus de préfixe fournisseur (« 9router · … ») ; aucune table id → nom côté front.
- Passe 4, test fil occupé (`thread-busy.test.ts`) : un 409 `thread_busy` est reconnu ; « Thread already running » du runner mémoire arrivait comme un flux SSE 200 vide, rattrapé par le rejeu `endedWithoutAnswer` ; depuis la passe 6 le serveur émet `RUN_STARTED` + `RUN_ERROR {code: "thread_busy"}` ; une erreur fournisseur « (HTTP 409) » reste une erreur.
- Passe 5 (branche `synelia/phase0-pwchange`), changement de mot de passe forcé : `/change-password` devient le vrai formulaire (`ChangePasswordForm`) : « Mot de passe provisoire » + aide « Celui que vous avez reçu avec votre invitation. » quand get-session renvoie `mustChangePassword` (sinon « Mot de passe actuel »), nouveau mot de passe, confirmation ; afficher/masquer par champ (`aria-pressed`) ; règles visibles avant saisie (12 caractères min., `minPasswordLength` de server/src/auth/index.ts, 128 max. par défaut Better Auth) ; erreurs par champ + résumé `role="alert"` ; codes Better Auth traduits (INVALID_PASSWORD, PASSWORD_TOO_SHORT/LONG, 429, 503, réseau) ; `authClient.changePassword({ …, revokeOtherSessions: true })` puis get-session : sans drapeau → accueil, drapeau encore présent → « …la session n'a pas été mise à jour. Reconnectez-vous. » (jamais de boucle), get-session en échec → « Réessayer ». N'appelle que change-password, get-session et sign-out.

## Deployment
| File | Why |
|---|---|
| `examples/synelia/*` (new) | Tenant package: Synelia Assistant (remote Mastra) + built-in General Assistant (via 9router). |
| `deploy/synelia/docker-compose.yml` (new) | postgres (pgvector pg16), migrate, agent-mastra, server; internal network, no host ports, no docker.sock, no computer supervisor; mem/cpu limits; Traefik labels + basicauth; secrets only in chmod-600 env files (`secrets/router9.env` referenced via env_file). |
| `.gitignore` | `agent-mastra/.mastra/` build output. |
| `server/Dockerfile` | Copies `agent-computer/src/egress.ts`, imported by the server (upstream image failed to start without it); `TENANT_PACKAGE_DIR` build arg so the app shows the Synelia brand. |

Not done in phase 0: LISTEN/NOTIFY (not used), SSE resume via Last-Event-ID, multi-user/SSO, learning.


## Passe 4 (ouverture 5 utilisateurs)

| # | Changement | Fichiers |
|---|---|---|
| 2b | Un refetch en échec de `/api/channels/:id` (données déjà là) n'efface plus le fil : bannière « Connexion interrompue… » (`synelia-reconnecting`), écran d'erreur seulement sans données | `app/src/routes/_authed/_app/channel/$channelId.tsx` |
| 3 | 404 du gate pilote : le front n'appelle plus control / published / catalogue / lifecycle quand masqués ; serveur en **allowlist** (`PILOT_ALLOWED_PREFIXES`), lectures inoffensives en 200 vide | `server/src/synelia/pilot-gate.ts`, `app/src/lib/{computers,sandboxed,components,bot-lifecycle}` |
| heartbeat | ping SSE seulement entre deux événements (frontière `\n\n`), timer nettoyé fin/erreur/cancel, test d'événement scindé | `server/src/synelia/sse-heartbeat.ts` |
| QA | `isHiddenModel` fail-closed pour `synelia-test:*` | `server/src/synelia/models.ts` |
| 2a min | `GET /api/threads/:id` renvoie `activeRunId` (run vivant du runner ou `synelia_thread_lock` non expiré) et `interrupted` ; front : « Le modèle réfléchit… » (clé `thinking` de i18n2) puis rejoue le fil à la fin, « Réponse interrompue » si le dernier message est celui de la personne sans run actif ; au démarrage les verrous non expirés sont expirés (`UPDATE … SET expires_at = now()`, ligne gardée, acquire accepte `expires_at <= now()`), testé | `server/src/app.ts`, `app/src/lib/copilot/synelia-model.tsx`, `channel-chat.tsx` |
| reattach | coupure = regex réseau seulement ; 2 tentatives connect puis bannière ; dédup incrémentale | `stream-reattach.ts`, `channel-chat.tsx` |

**Gate 13 — garde post-déploiement** : `deploy.sh` attend (≤120 s) les verrous actifs, puis `e2e.sh ownership` + `gate` ; échec → redéploie le `DEPLOYED_COMMIT` précédent, code ≠ 0.

**Checklist ouverture** : `SYNELIA_TEST_MODEL=off` sur une instance réellement ouverte (laissé actif sur konnect pour la QA ; le modèle reste masqué aux non-admins, fail-closed).

**Phase 1** : écrire `thread_event` au fil de l'eau (pas seulement en fin de run) pour qu'un redémarrage serveur ne perde plus le tour en cours.

## Incident 2026-10-17 PILOT=0 (~16 s)

**Chronologie (UTC)**
- 12:36:33 : une commande de comparaison PILOT=0/1 ajoute `SYNELIA_PILOT=0` dans `/srv/synelia-bot/.env.server` **de la prod**, puis redémarre `server`. L'audit montre que le serveur est reparti à 12:36:36 (`audit_events` `computer.policy_loaded`).
- ~12:36:49 : commande interrompue, ligne retirée, `.env.server` remis en chmod 600, `server` redémarré. L'audit montre un redémarrage à 12:36:50.
- Juste après : `e2e.sh gate` PASS, puis de nouveau PASS au déploiement 6e61a23 (garde post-déploiement).

**Cause** : la comparaison était faite directement sur l'instance de prod, avant la consigne « jamais sur la prod ».

**Audit (lecture seule, fenêtre 12:36:00–12:37:30)**
- **Traefik : access log NON activé.**
  - Commande : `docker inspect traefik-traefik-1 --format '{{json .Args}}'`. Pas de `--accesslog`, seulement `--log.level=DEBUG`. Pas de fichier d'accès dans `/var/lib/dokku/data/traefik` (seulement `acme.json`).
  - **Ni méthode, ni chemin, ni statut, ni IP par requête n'existent donc.** L'absence de trace ne prouve pas l'absence de requête.
- **Traefik DEBUG :** `docker logs traefik-traefik-1 --since 2026-10-17T12:36:00Z --until 2026-10-17T12:37:30Z | grep 'Authentication succeeded'`.
  - Le middleware `synelia-bot-auth@docker` a validé **4 requêtes** entre 12:36:33 et 12:36:49 : 12:36:36, 12:36:38 ×2, 12:36:44.
  - 0 échec d'authentification basic-auth dans la fenêtre.
  - Le basic-auth est resté actif pendant l'incident : il est porté par Traefik, indépendant de SYNELIA_PILOT.
- **Logs `server` / `agent-mastra` :** `docker compose logs <svc> --since … --until …` ne renvoie **rien**. Les conteneurs ont été recréés par les redémarrages (12:36:50) et le déploiement de 12:48, donc les logs de la fenêtre sont **perdus**.
- **Base :** comptage `created_at` dans la fenêtre sur toutes les tables publiques (bloc DO).
  - `synelia_thread_run` = 0, `synelia_thread` = 0, aucune ligne d'outil, d'approbation, de routine, d'ordinateur ou de bot.
  - 6 `audit_events` : 2 `session.signed_in` du compte de test (12:36:21 et 12:37:03, hors fenêtre de 16 s) et 4 événements de démarrage serveur (`computer.*_loaded`).
  - 2 `sessions` : connexions e2e du compte de test, hors fenêtre de 16 s.
  - **Aucun appel d'outil hors des 15 outils autorisés** n'est enregistré : aucun run n'existe dans la fenêtre.
- **Conclusion bornée :** aucun run ni écriture en base pendant la fenêtre. 4 requêtes authentifiées ont été servies sans qu'on puisse en connaître le chemin.

**Remédiation / règles**
- Toute expérience de configuration (PILOT, modèles, flags) se fait uniquement sur une instance locale ou éphémère, jamais sur synelia-bot.labs.synelia.tech.
- À décider : activer l'access log Traefik pour le routeur synelia (format JSON, sans en-têtes d'authentification). Cela touche la stack Traefik partagée, donc pas fait ici.

## Passe 5

**Commande de référence des tests** (une seule, depuis chaque paquet) : `cd app && bun test`, `cd server && bun test`, `cd toolkit && bun test`.
- Résultats : app 42 échecs, mêmes noms qu'en amont (53a656b) ; server 99 ; toolkit 0.
- Les drapeaux `pilot` du front sont coupés sous `bun test` (NODE_ENV=test) et réactivés par `SYNELIA_PILOT=1`. Ils sont toujours actifs dans un build.

| Point | Changement |
|---|---|
| 2a | `useStoredRunError` expose toujours `activeRunId`. Erreur stockée seulement si la personne a parlé en dernier. « Réponse interrompue » uniquement sur `lostRunId` (verrou expiré sans `synelia_thread_run`). Le champ `interrupted` est supprimé côté serveur. `serverRunStep` gère l'indicateur, le bouton Stop (`/agent/:id/stop/:thread` avec `runId`) puis un seul rejeu en fin de run |
| idempotence | 409 / « already running » traité comme « déjà en cours » : le statut est rafraîchi, pas d'erreur. Un renvoi d'un message déjà traité par un run terminé renvoie un run vide (`isAlreadyAnswered`) |
| 404 | `GET /api/components/for-agent/*` : 200 `{components:[]}` côté serveur, requête désactivée en pilote côté front. Le gate journalise `pilot_blocked <METHODE> <préfixe>`, que `deploy.sh` affiche après le garde |
| deploy.sh | `active_locks` fermé par défaut : en cas d'erreur psql, ERR, attente complète de 120 s puis avertissement |
| accueil | message et « Le modèle réfléchit… » affichés dès l'envoi. En pilote avec un seul Bot, pas d'appel à `route` |
| bannière | `/api/channels/:id` est relu toutes les 5 s tant qu'il est en erreur, donc la bannière disparaît dès que ça revient. Échec final : `ui.conversation.connectionLost` |
| panneau | conservé (traduit, 5eeeb64). Seul le bouton « Ouvrir {nom} » est masqué en pilote |
| 404 (suite) | `GET /api/plugins/for/*` : 200 `{tools:[],skills:[]}` en pilote, requête front désactivée (vue par le test navigateur : 10 × 404) |
| bannière hors ligne | la bannière de reconnexion suit aussi `online`/`offline` (hors ligne, React Query se met en pause sans erreur) |
| test navigateur | `ui/browser-e2e.mjs` (compte dédié `jv.e2e@synelia.tech`, identifiants uniquement dans `e2e-browser.env` en chmod 600) |

### Fichier d'identifiants e2e

`e2e.sh`, `ui/browser-e2e.mjs` et le garde de `deploy.sh` lisent **uniquement** `/workspace/synelia-grokbot/e2e.env` (chmod 600 exigé, aucun repli sur un autre fichier). Modèle sans valeurs : `e2e.env.example`. Variables :
- `E2E_URL`
- `E2E_BASIC_USER`, `E2E_BASIC_PASSWORD` : basic auth Traefik.
- `E2E_A_EMAIL`, `E2E_A_PASSWORD` : compte A, admin.
- `E2E_B_EMAIL`, `E2E_B_PASSWORD` : compte B, non admin.
- `E2E_BROWSER_EMAIL`, `E2E_BROWSER_PASSWORD` : compte du test navigateur.
- `E2E_BROWSER_BASIC_USER`, `E2E_BROWSER_BASIC_PASSWORD` : optionnels ; à défaut, ceux de `E2E_BASIC_*`.

En cas d'absence ou d'invalidité, les outils sortent en code 3 avec « e2e.env missing/invalid ». `deploy.sh` refuse alors de déployer (`e2e.sh check-env`) avant de toucher konnect, et ne fait pas de rollback silencieux si l'erreur survient pendant le garde.

Coupure réseau pendant un run : après 2 reconnexions sans fin de run, la page relit l'état du fil et rejoue le fil une fois. « Connexion perdue… » ne s'affiche que si ce rejeu échoue (test navigateur (c) : le message s'affichait alors que la réponse était complète).

## Logs persistants et comptes de test

- **Docker** : pilote `local` (7 × 20 Mo par conteneur, compressés) pour postgres, migrate, agent-mastra et server. Les logs survivent aux redémarrages et `docker compose logs` fonctionne toujours.
- **Journal des requêtes** : `server/src/synelia/request-log.ts`, activé par `SYNELIA_REQUEST_LOG_DIR=/app/logs`, monté sur `/srv/synelia-bot/logs` (chmod 750, propriétaire `openbot`).
  - Un fichier par jour, `requests-YYYY-MM-DD.jsonl` ; 7 jours conservés.
  - Champs : `ts`, `method`, `path` (sans query string), `status`, `durationMs`, `userId`, `threadId` (si le chemin en porte un), `test`.
  - Jamais de corps, d'en-têtes, de cookies ni de jetons.
- **Comptes de test** : `SYNELIA_TEST_ACCOUNTS` (**userId** séparés par des virgules, dans `.env.server` ; plus les emails depuis la passe 6).
  - Leurs lignes de journal portent `"test": true` ; les métriques du pilote filtrent ces lignes (`select(.test != true)`).
  - Les rôles admin ne viennent que de `INITIAL_ADMIN_EMAILS` (jv.e2e est `user`, vérifié).
  - Valeur sur konnect : les ids de jv.e2e, jv.test et jv.test2.

## Access log Traefik : proposition NON appliquée

**Constat (lecture seule)**
- `traefik-traefik-1` (traefik 3.4.4) est démarré par **Dokku** (`com.docker.compose.project.config_files=/tmp/dokku-…-cmd-traefik-start…`).
- Sa configuration statique est uniquement en arguments CLI, générés par le plugin Dokku : pas de fichier traefik.yml.
- `/usr/bin/dokku` existe, mais aucun conteneur `dokku` ne tourne, donc `dokku traefik:report` échoue.
- Il n'existe ni label par routeur ni configuration dynamique pour activer l'access log. `accessLog` est une option statique.
- L'activer veut donc dire modifier le démarrage de Traefik géré par Dokku, puis **recréer le conteneur Traefik partagé** (coupure courte pour Jitsi, n8n, WAHA et les autres).
- Ce n'est pas un changement « additif minimal » sur un fichier sauvegardable. Je ne l'ai pas fait, malgré l'accord de principe.

**Changement proposé, à appliquer par JV ou le Chief dans la fenêtre Dokku/Traefik**
1. Arguments statiques à ajouter (via la configuration Dokku traefik, ou le template de démarrage) :
   ```
   --accesslog=true
   --accesslog.format=json
   --accesslog.filepath=/data/access.log
   --accesslog.fields.defaultmode=keep
   --accesslog.fields.names.RequestAddr=drop
   --accesslog.fields.headers.defaultmode=drop
   --entrypoints.https.observability.accessLogs=false
   --entrypoints.http.observability.accessLogs=false
   ```
   - **Gardés** : `ClientHost` (IP du client, utile pour les 401 basicauth) et `RequestPath`. **Supprimés** : `RequestAddr` et tous les en-têtes.
   - `RequestPath` peut contenir la query string. Acceptable : l'app ne met aucun secret en query string. Vérifié par grep des URL `client(`/`fetch(`/`WebSocket` de `app/src` (passe 6) : seules des valeurs non secrètes (`agentId`, `days`, `limit`, `hidden`, `q`, `kind`/`ref`, `returnTo`, `botId`, `channelId`, `format=csv`) ; aucun `token`, `key`, `password`, `secret` ni `code` ; les WebSocket n'ont pas de query.
   - **Traefik 3.4.4 confirmé** (≥ 3.1) : les options `observability.accessLogs` par routeur et par point d'entrée sont valides.
   - Tous les en-têtes sont supprimés, donc jamais d'`Authorization`.
   - Les points d'entrée sont désactivés par défaut : les autres stacks ne journalisent rien de plus.
2. Label à ajouter sur `server` dans `deploy/synelia/docker-compose.yml` :
   `traefik.http.routers.synelia-bot.observability.accesslogs=true`
3. Rotation : `/var/lib/dokku/data/traefik/access.log` via logrotate (`daily`, `rotate 7`, `copytruncate`).
4. Vérification avant et après : statut HTTP de Jitsi (meet.synelia.tech), n8n-webhook, WAHA et synelia-bot identique ; `access.log` ne contient que `RouterName=synelia-bot@docker`.

## Passe 6 : changement de mot de passe forcé, testeurs, thread_busy, libellés, latence

**Changement de mot de passe forcé à la première connexion**
- Colonne `users.must_change_password` (migration Drizzle `0057`, défaut `false`). Mise à `true` pour les comptes créés par le bootstrap (`OPENBOT_BOOTSTRAP_USER*` et `SYNELIA_TESTER_*`) ; il n'existe pas d'autre création de compte par mot de passe (inscription désactivée).
- **Un seul middleware global** : `server/src/synelia/password-change-gate.ts`, monté sur `/api/*` après le handler Better Auth et le pilot gate, avant toutes les routes (y compris `/api/copilotkit` runtime et SSE). Tant que le drapeau est vrai : 403 `{ "error": "Vous devez changer votre mot de passe.", "code": "password_change_required" }`.
  - Liste blanche : `/api/auth/get-session`, `/api/auth/change-password`, `/api/auth/sign-out`.
  - **Les endpoints Better Auth (`GET`/`POST /api/auth/*`, y compris `update-user`) répondent avant ce middleware et le contournent.** `update-user` ne peut pas toucher au drapeau (`input: false`).
  - Les comptes de `SYNELIA_TEST_ACCOUNTS` sont exemptés.
- **Contrat pour le formulaire (Frontend Expert)** :
  - `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })` ;
  - en cas de succès, le serveur remet `must_change_password` à `false` (hook `after` sur `/change-password`) ;
  - `GET /api/auth/get-session` renvoie `user.mustChangePassword`.
- Front (stub seulement) : un 403 `password_change_required` (garde `_authed` sur `/api/me`, et `onError` global des caches React Query) mène à `/change-password` (`app/src/routes/change-password.tsx`, page minimale). Nouvelles clés : `ui.auth.changePasswordTitle`, `ui.auth.changePasswordRequired`.
- Tests : `server/tests/synelia-must-change-password.test.ts`, `app/src/lib/auth/password-change.test.ts`. Gate e2e : `e2e.sh pwchange <email>` → `deploy/synelia/check-password-gate.sh`.

**Testeurs** : `deploy/synelia/add-tester.sh <email>` / `remove-tester.sh <email>` (depuis le poste opérateur, `HOST=konnect`).
- `add-tester` : compte app (rôle `user`, `must_change_password=true`) via `SYNELIA_TESTER_<SLUG>_EMAIL/_PASSWORD` dans `.env.server`, créé par le bootstrap au redémarrage ; entrée basicauth **bcrypt** séparée, nommée d'après le testeur, ajoutée à `BASICAUTH_USERS` dans `.env`. Sauvegarde de `.env`/`.env.server` dans `backup/` avant, chmod 600 après. Ne recrée que le conteneur `server` et vérifie que les autres conteneurs n'ont pas bougé. Les deux secrets vont uniquement dans `secrets/testers/<email>.txt` (chmod 600, jamais écrasé, jamais affiché).
- `remove-tester` : retire les entrées (après sauvegarde), supprime le compte (`DELETE FROM users`, cascade), supprime le fichier de secrets, recrée seulement `server`.

**Risque résiduel accepté (Architecture Reviewer)**
- Le journal applicatif couvre les requêtes authentifiées avec `userId` ; depuis la passe 6 il est monté en tête de `createApp`, donc `/api/auth/*` (connexions, 401 applicatifs) y figure aussi, sans corps ; sous `/api/auth`, seul le premier segment est journalisé (`/api/auth/sign-in`), jamais un jeton de chemin (`reset-password/:token`).
- Les 401 basicauth et les refus au niveau Traefik restent invisibles jusqu'à la fenêtre Traefik de JV (proposition d'access log ci-dessus).
- Option : déplacer le basicauth dans le serveur (middleware Hono), ce qui rendrait ces refus visibles dans le journal applicatif sans toucher Traefik.

**thread_busy de bout en bout (serveur)**
- Chemin verrou : le runtime répond son propre 409 `{ "error": "Thread lock denied" }` ; `threadBusyBody` (`copilot.ts`) réécrit tout 409 de `/api/copilotkit/*` en `{ "error": "Thread is busy.", "code": "thread_busy" }`.
- Chemin en mémoire : le « Thread already running » de l'`InMemoryAgentRunner` partait après le 200 SSE, donc le navigateur recevait un flux vide. `PostgresAgentRunner` émet maintenant `RUN_STARTED` puis `RUN_ERROR` avec `code: "thread_busy"` dans le flux (même schéma que `isAlreadyAnswered`).
- `toolkit/src/copilotkit/thread-lock.ts` (409 → `null`) est le chemin des hand-offs en arrière-plan (réessai), pas une réponse HTTP au navigateur : laissé tel quel. Test front : Frontend Expert.

**Libellés de modèles** : `label` dans `agent-mastra/src/mastra/synelia-models.ts` (`Rapide` pour Gemini Flash, `Approfondi` pour Claude Sonnet, sinon l'usage configuré ; jamais le fournisseur) ; transmis par `/api/synelia/models`, ajouté à `/api/synelia/runs/:id` et `/api/synelia/threads/:id/models`. Le sélecteur et le pied de réponse l'affichent quand il est présent (style : Frontend Expert).

**Pilot gate** : `/api/identity`, `/api/passwords`, `/api/sign-in-requests` retirés de `PILOT_ALLOWED_PREFIXES` (comptes connectés, mots de passe/identifiants ; aucun des 15 outils autorisés ne les appelle, `sign-in-tool.tsx` n'est pas dans la liste). `/api/approvals` reste ouvert pour les décisions en cours de run (`/decision`, `/questions/*/respond`, `/computer/*`) ; seuls `/api/approvals/rules`, `/preferences` et `/team` sont fermés. La galerie de composants (`/api/components`) était déjà fermée. `e2e.sh gate` : ces routes répondent 404, et `POST /api/approvals/:id/decision` ne reçoit pas le 404 du pilot gate.

**Mesures de latence** : `run_timing` dans `requests-*.jsonl` (et `synelia_timing` sur stdout) par run, nombres et ids seulement : `routeMs`, `prepMs`, `firstEventMs`, `firstTextMs`, `sinceArrivalFirstTextMs`, `totalMs`, `tools`, `messages`, `contextBytes`, `inputBytes`. Côté Mastra, `synelia_timing {kind:"provider_call"}` : `sinceAgentRequestMs`, `headersMs`, `firstChunkMs`, `requestBytes`.
