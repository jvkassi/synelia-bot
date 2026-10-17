/**
 * Synelia fork: the interface strings of the pilot screens, in one place.
 *
 * OpenBot has no i18n layer; its strings are inline English. The screens the pilot uses (sign-in,
 * onboarding, home, sidebar, conversation, model picker) read their text from here instead, so a
 * second language is one more dictionary of the same shape. The active language is French.
 */
/**
 * The shape of a dictionary: the French one with every string literal widened to `string`, so a
 * second language of the same shape typechecks while missing or extra keys still fail.
 */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : { readonly [K in keyof T]: Widen<T[K]> };

const fr = {
  /** BCP 47 tag for dates and relative times. */
  locale: "fr-FR",
  signIn: {
    title: (product: string) => `Se connecter à ${product}`,
    email: "Adresse e-mail",
    password: "Mot de passe",
    submit: "Se connecter",
    submitting: "Connexion…",
    wrongCredentials: "Adresse ou mot de passe incorrect.",
    unavailable: "Connexion impossible pour le moment.",
    or: "ou",
    companyEmail: "vous@entreprise.com",
    continueWith: (provider: string) => `Continuer avec ${provider}`,
    opening: (provider?: string) =>
      provider ? `Ouverture de ${provider}…` : "Ouverture…",
    continueWithCompany: "Continuer avec votre compte d'entreprise",
    adminSignIn: "Connexion administrateur",
    ssoRequired: "Votre organisation impose l'authentification unique (SSO).",
    noProvider: "Aucun moyen de connexion n'est configuré pour ce déploiement.",
    noIdentityProvider:
      "Aucun fournisseur d'identité n'est enregistré pour cette adresse.",
    providerFailed: (provider: string) =>
      `Impossible de lancer la connexion avec ${provider}.`,
  },
  onboarding: {
    welcome: (product: string) => `Bienvenue sur ${product}`,
    composerPoster: "Posez vos questions à votre assistant",
    saving: "Enregistrement…",
    start: "Commencer",
    next: "Continuer",
    back: "Retour",
    computerTitle: "Chaque assistant dispose de son propre ordinateur",
    rosterTitle: "Choisissez parmi nos assistants ou créez le vôtre",
    example: "Exemple",
    ownAgent: "Votre propre assistant",
    placeholderResearch: "Analyste recherche",
    placeholderData: "Analyste de données",
    placeholderSupport: "Agent support",
  },
  /** Page shown when a route throws (router defaultErrorComponent). */
  routeError: {
    message: "Une erreur est survenue. Rechargez la page.",
    showDetail: "Afficher le détail",
    hideDetail: "Masquer le détail",
  },
  /** Settings: menu, General (préférences) and Memory. */
  settings: {
    backToApp: "Retour à l'application",
    nav: {
      general: "Général",
      notifications: "Notifications",
      approvals: "Approbations",
      memory: "Mémoire",
      connectedAccounts: "Comptes connectés",
      passwords: "Mots de passe",
      componentsGallery: "Galerie de composants",
    },
    preferences: "Préférences",
    preferencesDescription: (product: string) =>
      `L'apparence et le comportement de ${product} pour vous. Les préférences de la liste des conversations suivent votre compte ; le thème est enregistré dans ce navigateur.`,
    general: "Général",
    darkTheme: "Thème sombre",
    darkThemeDescription: (product: string) =>
      `Utiliser l'apparence sombre dans tout ${product}.`,
    emphasis: "Mise en avant dans la liste",
    emphasisDescription:
      "Choisissez le nom affiché en plus grand dans la barre latérale.",
    threadTitle: "Titre de la conversation",
    agentName: "Nom de l'assistant",
    loading: "Chargement…",
    retry: "Réessayer",
    saving: "Enregistrement…",
    preview: "Aperçu de la liste des conversations",
    previewAgent: "Assistant général",
    previewTitle: "Préparer la semaine prochaine",
    standingTitle: "Instructions permanentes",
    standingDescription:
      "S'appliquent à tous les assistants, dans toutes les conversations. Le rôle d'un assistant dit ce qu'il fait ; ces instructions disent comment vous voulez que les choses soient faites, par exemple le style d'écriture ou la façon de présenter votre entreprise.",
    standingPlaceholder:
      "Nous sommes une petite équipe. Écrivez en français, avec des phrases courtes, et ne parlez jamais de « plateforme ».",
    characters: (count: number, limit: number) =>
      `${count.toLocaleString("fr-FR")} sur ${limit.toLocaleString("fr-FR")} caractères`,
    saved: "Enregistré",
    save: "Enregistrer",
    cancel: "Annuler",
    shortcuts: "Raccourcis clavier",
    hotkeys: {
      "new-chat": {
        label: "Nouvelle conversation",
        description: "Démarrer une nouvelle conversation depuis n'importe où.",
      },
    } as Record<string, { label: string; description: string }>,
    memory: {
      title: "Mémoire",
      description:
        "Ce que vos assistants savent de vous. Les faits que vous leur donnez sont partagés par tous ; ce qu'un assistant apprend reste propre à cet assistant.",
      remember: "Retenir un fait",
      rememberDescription: "Il sera connu de tous vos assistants.",
      field: "Ce que vous voulez que vos assistants sachent",
      placeholder: "Je préfère les réunions le matin.",
      submit: "Retenir",
      yours: "Vos souvenirs",
      empty: "Vous n'avez encore aucun souvenir.",
      keptInIntelligence: "Conservé dans Intelligence",
      disabled: "Désactivé",
      formedBy: (bot: string, unreviewed: boolean) =>
        `Appris par ${bot}${unreviewed ? " · à vérifier" : ""}`,
      imported: "Importé · à vérifier",
      reviewed: "Vérifié",
      yourBot: "votre assistant",
      from: (source: string) => `Depuis ${source}`,
      aConversation: "une conversation",
      read: (when: string) => `, lu le ${when}`,
      openRecord: "Ouvrir la source",
      edit: "Modifier",
      confirm: "Confirmer",
      forget: "Oublier",
      use: (content: string) => `Utiliser ce souvenir : ${content}`,
      editTitle: "Modifier le souvenir",
      fieldLabel: "Souvenir",
    },
  },
  home: {
    title: "Nouvelle conversation",
    routedHint:
      "Envoyé à l'assistant concerné. Tapez @ pour en choisir un vous-même.",
    startFailed: "Impossible de démarrer la conversation.",
    agentsUnavailable:
      "Les assistants n'ont pas pu être chargés : personne à qui envoyer ce message pour l'instant.",
    /** Start failures (lib/channels/start-error.ts), chosen from the HTTP status and code. */
    networkError: "Connexion impossible. Vérifiez votre réseau et réessayez.",
    sessionExpired: "Votre session a expiré. Reconnectez-vous pour continuer.",
    /** Link to the sign-in screen next to `sessionExpired`. */
    signInAgain: "Se reconnecter",
    accessDenied: "Accès refusé.",
    serviceUnavailable:
      "Le service est momentanément indisponible. Réessayez dans un instant.",
    errorDetail: (status: number, code?: string) =>
      `(erreur ${status}${code ? ` · ${code}` : ""})`,
    /** Resends the message that failed to start, without reloading. */
    retry: "Réessayer",
  },
  sidebar: {
    search: "Rechercher…",
    searchLabel: "Rechercher dans les conversations",
    empty: "Aucune conversation pour l'instant",
    emptyHint: "Vos conversations apparaîtront ici.",
    noMatchLoaded: "Aucune conversation chargée ne correspond",
    noMatch: "Aucune conversation ne correspond",
    loadOlder:
      "Chargez les conversations plus anciennes pour chercher plus loin.",
    nothingNamed: (term: string) => `Rien ne s'appelle « ${term} ».`,
    olderFailed: "Impossible de charger les conversations plus anciennes.",
    loadingOlder: "Chargement des conversations plus anciennes…",
    retryOlder: "Réessayer de charger les conversations plus anciennes",
    loadOlderButton: "Charger les conversations plus anciennes",
    untitled: "Nouvelle conversation",
    pin: "Épingler la conversation",
    unpin: "Désépingler la conversation",
    delete: "Supprimer la conversation…",
    deleteTitle: (name: string) => `Supprimer ${name} ?`,
    deleteDescription:
      "La conversation n'apparaîtra plus pour aucun de ses participants.",
    cancel: "Annuler",
    deleting: "Suppression…",
    confirmDelete: "Supprimer",
  },
  /** Pilot data rule, shown permanently on home, new conversation and under the composer. */
  pilotNotice:
    "Pilote : données de test uniquement, pas de code ni de documents clients.",
  conversation: {
    reconnecting:
      "Connexion interrompue… nouvelle tentative. Si rien ne revient, rechargez la page.",
    connectionLost:
      "Connexion perdue. Rechargez la page pour retrouver la réponse.",
    runInProgress: "Réponse en cours…",
    runInterrupted: "Réponse interrompue. Renvoyez votre message.",
    fallbackTitle: "Conversation",
    askAnything: "Posez votre question",
    chooseBot: "Choisir un assistant…",
    addBot: "Ajouter un autre assistant…",
    noBots: "Aucun assistant trouvé.",
    startFailed: "Impossible de démarrer la conversation.",
    newChat: "Nouvelle conversation",
    modelUnavailable:
      "Ce modèle est indisponible pour le moment, choisissez-en un autre.",
    stoppedWithoutReason: "L'assistant s'est arrêté sans donner de raison.",
    /**
     * The provider declined (content filter, moderation, Anthropic `refusal`) or the run finished with
     * nothing in it. `model`: the label of another available model, « Alternatif » first. The picker
     * sits in the conversation's header bar (routes/_authed/_app/channel/$channelId.tsx), hence
     * « en haut de la conversation ».
     */
    declined: (model: string | null) =>
      model
        ? `Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez le modèle ${model} en haut de la conversation.`
        : "Je ne peux pas répondre à cette demande. Reformulez-la, ou essayez un autre modèle en haut de la conversation.",
    /** Any other failure of the run (stall included); offered with « Réessayer ». */
    runFailed: "La réponse n'a pas pu aboutir.",
    sessionExpired: "Votre session a expiré. Reconnectez-vous pour continuer.",
    signInAgain: "Se reconnecter",
    runFailedNoRetry:
      "La réponse n'a pas pu aboutir. Écrivez un nouveau message pour reprendre.",
    /** Runs the failed turn again on the message already sent. */
    retry: "Réessayer",
    retrying: "Nouvelle tentative…",
    networkError:
      "Connexion interrompue, la réponse continue d’être générée. Rechargez la page pour l’afficher.",
    loading: "Chargement de la conversation",
    queued: "En attente",
    /** The indicator between sending and the first token (1:1 and group transcripts). */
    thinking: "Le modèle réfléchit…",
    /** Shown in the same status line when no first token came after 8 s. */
    thinkingSlow: "Le modèle réfléchit, cela peut prendre jusqu'à 30 secondes…",
    remove: "Retirer",
    /** A responsibility's turn, drawn as one compact line (chat-transcript.tsx). */
    responsibilityRan: "Responsabilité exécutée.",
    trigger: "Déclencheur :",
    details: "Détails",
    removeQueued: (description: string) =>
      `Retirer le message en attente : ${description}`,
    attachment: "Pièce jointe",
    attachmentNamed: (filename: string) => `Pièce jointe : ${filename}`,
    untitledFile: "Fichier sans nom",
    attachmentUnavailable: "Cette pièce jointe n'est pas disponible.",
    fileUnavailable: (filename: string) => `${filename} n'est pas disponible.`,
    open: (label: string) => `Ouvrir ${label}`,
    close: "Fermer",
    closeDetails: "Fermer les détails",
    coworker: "Assistant de la conversation",
    computer: "Ordinateur",
    loadFailed: "Impossible de charger cette conversation.",
  },
  /** The coworker details panel (agent-profile.tsx). */
  profile: {
    private: "Privé",
    public: "Public",
    systemOwned: "Géré par le système",
    role: "Rôle",
  },
  composer: {
    message: "Message",
    send: "Envoyer le message",
    queue: "Mettre en file d'attente",
    stop: "Arrêter le Bot",
    showCall: "Afficher l'appel vocal",
    startCall: "Démarrer un appel vocal",
    callAgent: "Appeler cet assistant",
    callNeedsHttps:
      "Les appels vocaux nécessitent HTTPS (ou localhost) et un micro.",
    attach: "Joindre un fichier",
    attachments: "Pièces jointes",
    /** The × on a staged attachment chip: « Retirer » (`conversation.remove`) plus the file name. */
    removeFile: (name: string) => `Retirer ${name}`,
    moreOptionsUnavailable: "Autres options du message indisponibles",
  },
  newConversation: {
    /** Label of the recipient field (« To: » upstream). */
    to: "À :",
    agentNotFound: "Assistant introuvable.",
    coworkersFailed: "Impossible de charger les assistants.",
    coworkerFailed: "Impossible de charger l'assistant.",
    botUnavailable:
      "Cet assistant ne vous est pas accessible. Il n'est peut-être pas publié, pas partagé avec vous, ou pas encore décrit.",
    remove: (name: string) => `Retirer ${name}`,
    startFailed: "Impossible de démarrer la conversation.",
  },
  account: {
    admin: "Administration",
    settings: "Paramètres",
    logOut: "Se déconnecter",
  },
  layout: {
    toggleSidebar: "Afficher ou masquer la barre latérale",
    hideSidebar: "Masquer la barre latérale",
    showSidebar: "Afficher la barre latérale",
    sidebar: "Barre latérale",
    sidebarDescription: "Affiche la barre latérale mobile.",
    scrollToEnd: "Aller à la fin",
    scrollToStart: "Aller au début",
  },
  model: {
    label: "Modèle",
    title: "Modèle utilisé par l'assistant",
    default: "défaut",
    loadFailed: "Impossible de charger les modèles",
  },
  /** Synelia fork: the admin area (sidebar chrome and People). */
  adminArea: {
    backToApp: "Retour à l'application",
    overview: "Vue d'ensemble",
    groups: {
      reach: "Ce que les assistants peuvent atteindre",
      do: "Ce que les assistants peuvent faire",
      access: "Qui peut entrer",
      happened: "Ce qui s'est passé",
    },
    nav: {
      credentials: "Identifiants",
      boundaries: "Limites",
      approvals: "Approbations",
      computers: "Ordinateurs",
      plugins: "Plugins",
      skills: "Compétences",
      components: "Composants d'interface",
      playground: "Bac à sable",
      people: "Membres",
      identityProviders: "Fournisseurs d'identité",
      audit: "Journal d'audit",
    },
    people: {
      title: "Membres",
      description:
        "Toutes les personnes qui se sont connectées. Les administrateurs accèdent à ces écrans ; les autres discutent avec les assistants.",
      sectionTitle: "Qui est là",
      sectionDescription:
        "Une adresse listée dans INITIAL_ADMIN_EMAILS est administratrice quoi qu'indique cet écran : elle ne peut pas être modifiée ici.",
      searchLabel: "Rechercher des membres",
      searchPlaceholder: "Rechercher par nom ou adresse",
      loadFailed: "Impossible de charger les membres.",
      noMatch: (query: string) => `Personne ne correspond à « ${query} ».`,
      empty:
        "Personne ne s'est encore connecté. Les membres apparaissent ici après leur première connexion.",
      lastSignedIn: (date: string) => `dernière connexion le ${date}`,
      neverSignedIn: "jamais connecté",
      noProvider: "aucun fournisseur",
      accessRemoved: "Accès retiré",
      adminByConfiguration: "Administrateur par configuration",
      stopComputers: "Arrêter les ordinateurs",
      stopped: (stopped: number, failed: number) =>
        `${stopped} ordinateur${stopped > 1 ? "s" : ""} arrêté${stopped > 1 ? "s" : ""}${failed > 0 ? `, ${failed} n'ont pas pu l'être` : ""}. Leurs disques sont conservés.`,
      remove: "Retirer l'accès",
      restore: "Rétablir l'accès",
      administrator: (email: string) => `Administrateur : ${email}`,
      loading: "Chargement…",
      showMore: "Afficher plus",
      updateFailed: "Impossible de modifier ce membre.",
      /** A role/access call the pilot server answers 404. */
      pilotUnavailable: "Action indisponible pendant le pilote.",
      /** Shown, and referenced by aria-describedby, when a pilot flag disables a control. */
      editDisabledInPilot:
        "Modification désactivée pendant le pilote. Les changements de rôle passent par l'équipe d'exploitation.",
    },
  },
  /** Synelia fork: what this deployment lets the person use (`GET /api/admin/enterprise/me`). */
  capabilities: {
    loadFailed: "Impossible de charger les autorisations de ce déploiement.",
  },
  /** Synelia fork: forced password change at first login (form owned by the Frontend Expert). */
  auth: {
    changePasswordTitle: "Changez votre mot de passe",
    changePasswordRequired:
      "Pour continuer, choisissez un nouveau mot de passe.",
    currentPassword: "Mot de passe actuel",
    /** Forced change (`mustChangePassword`): the first field is the invitation's password. */
    temporaryPassword: "Mot de passe provisoire",
    temporaryPasswordHelp: "Celui que vous avez reçu avec votre invitation.",
    newPassword: "Nouveau mot de passe",
    confirmPassword: "Confirmez le nouveau mot de passe",
    /** Show/hide toggle of one field (`aria-pressed` says which state it is in). */
    showPassword: (field: string) => `Afficher le champ « ${field} »`,
    passwordRules: (min: number, max: number, temporary: boolean) =>
      `Au moins ${min} caractères (${max} au maximum), différent du mot de passe ${temporary ? "provisoire" : "actuel"}.`,
    errorSummary: "Le mot de passe n'a pas été changé :",
    currentRequired: "Saisissez votre mot de passe actuel.",
    temporaryRequired: "Saisissez votre mot de passe provisoire.",
    invalidCurrent: "Mot de passe actuel incorrect.",
    invalidTemporary: "Mot de passe provisoire incorrect.",
    tooShort: (min: number) =>
      `Le nouveau mot de passe doit contenir au moins ${min} caractères.`,
    tooLong: (max: number) =>
      `Le nouveau mot de passe doit contenir au plus ${max} caractères.`,
    sameAsCurrent: "Le nouveau mot de passe doit être différent de l'actuel.",
    sameAsTemporary:
      "Le nouveau mot de passe doit être différent du mot de passe provisoire.",
    confirmRequired: "Confirmez le nouveau mot de passe.",
    mismatch: "La confirmation ne correspond pas au nouveau mot de passe.",
    tooManyAttempts:
      "Trop de tentatives. Patientez un moment avant de réessayer.",
    networkError: "Connexion impossible. Vérifiez votre réseau et réessayez.",
    changeFailed: "Le mot de passe n'a pas pu être changé. Réessayez.",
    serviceUnavailable:
      "Le service est momentanément indisponible. Réessayez dans un instant.",
    /** Changed, but get-session still says `mustChangePassword` (or has no session). */
    sessionNotUpdated:
      "Le mot de passe a été changé, mais la session n'a pas été mise à jour. Reconnectez-vous.",
    /** Changed, but get-session could not be read (503, network). */
    sessionUnverified:
      "Le mot de passe a été changé, mais la session n'a pas pu être vérifiée. Réessayez dans un instant.",
    /** Changed and the session confirmed: shown while the app navigates away (no form any more). */
    changedRedirecting: "Mot de passe changé. Ouverture de votre espace…",
    retry: "Réessayer",
    submitChange: "Changer le mot de passe",
    saving: "Enregistrement…",
    signOut: "Se déconnecter",
    signOutFailed: "Déconnexion impossible. Réessayez.",
  },
} as const;

export type UiStrings = Widen<typeof fr>;

/** The strings in the active language. */
export const ui: UiStrings = fr satisfies UiStrings;

/**
 * What the pilot hides: entries outside phase 0 (agent catalogue, Bots and Skills pages, the
 * onboarding steps about computers and rosters). Flags rather than deletions, so upstream merges
 * stay easy and phase 1 can turn them back on.
 */
/**
 * Pilot switches are ON in every build. Under `bun test` (NODE_ENV=test) they are OFF so the
 * upstream suites test upstream behaviour; `SYNELIA_PILOT=1 bun test` turns them back on. Vite
 * exposes neither variable to the bundle, so a build can never switch them off.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env;
const PILOT_ON = env?.NODE_ENV !== "test" || env?.SYNELIA_PILOT === "1";
/** Pilot server allows POST /api/admin/people/:id/role. */
const PILOT_PEOPLE_ROLE = false;
/** Pilot server allows POST /api/admin/people/:id/access. */
const PILOT_PEOPLE_ACCESS = false;

export const pilot = {
  hideExploreAgents: PILOT_ON,
  hideBotsAndSkillsNav: PILOT_ON,
  shortOnboarding: PILOT_ON,
  /** No computer supervisor in this deployment: the "watch the computer" control is hidden. */
  hideComputerControls: PILOT_ON,
  /**
   * Same reason: the chat never offers the browser, navigate or computer tools, whatever
   * `GET /api/admin/enterprise/me` answers (an unresolved switch would otherwise read as allowed).
   */
  hideComputerTools: PILOT_ON,
  hideBotPage: PILOT_ON,
  /** Voice calls are outside the pilot (their API answers 404). */
  hideVoice: PILOT_ON,
  /** Settings tabs outside the pilot (approvals, connected accounts, passwords, gallery). */
  hideSettingsExtras: PILOT_ON,
  /**
   * Settings > Notifications (update routing, devices, recent deliveries) is outside the pilot:
   * `/api/delivery` and `/api/bots/routing` answer 404 there.
   */
  hideNotificationsSettings: PILOT_ON,
  /** Admin area: only People in the pilot; every other admin screen's API is closed. */
  hideAdminExtras: PILOT_ON,
  /** Bots, Skills, Routines, team Bots and groups: redirected home (their APIs answer 404). */
  hideOutsideRoutes: PILOT_ON,
  /**
   * People actions, matched to the server's pilot allowlist for POST /api/admin/people/:id/role
   * and /access: flip PILOT_PEOPLE_ROLE / PILOT_PEOPLE_ACCESS below. Always on outside the pilot.
   */
  adminPeopleRoleEnabled: !PILOT_ON || PILOT_PEOPLE_ROLE,
  adminPeopleAccessEnabled: !PILOT_ON || PILOT_PEOPLE_ACCESS,
} as const;

/** Admin routes the pilot keeps; every other one lands on People. */
export const PILOT_ADMIN_HOME = "/admin/people";

/** App routes outside the pilot: a direct hit lands on home. */
export const PILOT_HIDDEN_APP_ROUTES = [
  "/bots",
  "/skills",
  "/routines",
  "/team-bots",
  "/group",
] as const;

/** Settings routes the pilot closes; a direct hit lands on General. */
export const PILOT_HIDDEN_SETTINGS = [
  "/settings/approvals",
  "/settings/connected-accounts",
  "/settings/passwords",
  "/settings/components-gallery",
] as const;

/** Notifications and the devices it lists (devices have no route of their own). */
export const PILOT_HIDDEN_NOTIFICATION_SETTINGS = [
  "/settings/notifications",
] as const;

const under = (pathname: string, prefixes: readonly string[]) =>
  prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export function isPilotHiddenSettingsPath(pathname: string): boolean {
  return (
    (pilot.hideSettingsExtras && under(pathname, PILOT_HIDDEN_SETTINGS)) ||
    (pilot.hideNotificationsSettings &&
      under(pathname, PILOT_HIDDEN_NOTIFICATION_SETTINGS))
  );
}

/** Synelia fork: an admin path the pilot hides (everything but People). */
export function isPilotHiddenAdminPath(pathname: string): boolean {
  return (
    pilot.hideAdminExtras &&
    under(pathname, ["/admin"]) &&
    !under(pathname, [PILOT_ADMIN_HOME])
  );
}

/** Synelia fork: an app path outside the pilot (Bots, Skills, Routines, team Bots, groups). */
export function isPilotHiddenAppPath(pathname: string): boolean {
  return pilot.hideOutsideRoutes && under(pathname, PILOT_HIDDEN_APP_ROUTES);
}
