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
  home: {
    title: "Nouvelle conversation",
    routedHint:
      "Envoyé à l'assistant concerné. Tapez @ pour en choisir un vous-même.",
    startFailed: "Impossible de démarrer la conversation.",
    agentsUnavailable:
      "Les assistants n'ont pas pu être chargés : personne à qui envoyer ce message pour l'instant.",
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
    networkError:
      "Connexion interrompue, la réponse continue d’être générée. Rechargez la page pour l’afficher.",
    loading: "Chargement de la conversation",
    queued: "En attente",
    /** The indicator between sending and the first token (1:1 and group transcripts). */
    thinking: "Le modèle réfléchit…",
    remove: "Retirer",
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
    moreOptionsUnavailable: "Autres options du message indisponibles",
  },
  newConversation: {
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

export const pilot = {
  hideExploreAgents: PILOT_ON,
  hideBotsAndSkillsNav: PILOT_ON,
  shortOnboarding: PILOT_ON,
  /** No computer supervisor in this deployment: the "watch the computer" control is hidden. */
  hideComputerControls: PILOT_ON,
  hideBotPage: PILOT_ON,
  /** Voice calls are outside the pilot (their API answers 404). */
  hideVoice: PILOT_ON,
} as const;
