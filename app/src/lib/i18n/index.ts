/**
 * Synelia fork: the interface strings of the pilot screens, in one place.
 *
 * OpenBot has no i18n layer; its strings are inline English. The screens the pilot uses (sign-in,
 * onboarding, home, sidebar, conversation, model picker) read their text from here instead, so a
 * second language is one more dictionary of the same shape. The active language is French.
 */
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
  },
  onboarding: {
    welcome: (product: string) => `Bienvenue sur ${product}`,
    composerPoster: "Posez vos questions à votre assistant",
    saving: "Enregistrement…",
    start: "Commencer",
    next: "Continuer",
    back: "Retour",
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
  },
  /** Pilot data rule, shown permanently on home, new conversation and under the composer. */
  pilotNotice:
    "Pilote : données de test uniquement, pas de code ni de documents clients.",
  conversation: {
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
  },
  model: {
    label: "Modèle",
    title: "Modèle utilisé par l'assistant",
    default: "défaut",
  },
} as const;

export type UiStrings = typeof fr;

/** The strings in the active language. */
export const ui: UiStrings = fr;

/**
 * What the pilot hides: entries outside phase 0 (agent catalogue, Bots and Skills pages, the
 * onboarding steps about computers and rosters). Flags rather than deletions, so upstream merges
 * stay easy and phase 1 can turn them back on.
 */
export const pilot = {
  hideExploreAgents: true,
  hideBotsAndSkillsNav: true,
  shortOnboarding: true,
  /** No computer supervisor in this deployment: the "watch the computer" control is hidden. */
  hideComputerControls: true,
  hideBotPage: true,
  /** Voice calls are outside the pilot (their API answers 404). */
  hideVoice: true,
} as const;
