/**
 * Les sections du panneau — une seule liste, lue à deux endroits.
 *
 * Le menu du panneau est construit à partir d'elle, et le bot ne peut
 * désigner que ce qui y figure. Avant, il décrivait la page en devinant :
 * le 23 septembre il a envoyé Lionel vers une « section 8kjj », un champ
 * « username » et un bouton Google « Relancer la connexion » — rien de tout
 * ça n'existe. Un agent à qui on interdit de dire « je ne sais pas » finit
 * par combler les trous ; la réponse n'est pas de le laisser deviner mieux,
 * c'est de lui donner la vraie liste et d'envoyer le lien directement au bon
 * endroit.
 */

export const SECTIONS = {
  diagnostic: { titre: "Diagnostic", pour: "sa santé sur 100, les problèmes trouvés chaque jour par l'inspecteur, et quoi faire pour chacun" },
  boitenoire: { titre: "Boîte noire", pour: "l'enregistrement de tout ce qu'il a fait, travail par travail, étape par étape, avec durées, coûts et erreurs" },
  personnalite: { titre: "Personnalité", pour: "son nom, son caractère, sa façon de réfléchir, tes consignes" },
  voix: { titre: "Voix", pour: "les réponses en note vocale" },
  navigateur: { titre: "Navigateur", pour: "ouvrir un site dans son navigateur, s'y connecter, voir ses sessions" },
  memoire: { titre: "Mémoire", pour: "voir et effacer ce qu'il sait de toi" },
  competences: { titre: "Compétences", pour: "les méthodes que tu lui as apprises" },
  rappels: { titre: "Rappels", pour: "rappels et tâches planifiées" },
  declencheurs: { titre: "E-mails", pour: "la surveillance de la boîte mail" },
  images: { titre: "Images", pour: "la création d'images" },
  services: { titre: "Services", pour: "les clés d'API : modèles, GitHub, Vercel, recherche — chaque carte a « Modifier » et « Tester la clé »" },
  formulaire: { titre: "Ajouter", pour: "ajouter un service ou coller une clé" },
  depense: { titre: "Dépense", pour: "qui a coûté quoi" },
  acces: { titre: "Accès", pour: "créer ou changer le mot de passe du panneau" },
  approbations: { titre: "Approbations", pour: "couper ou remettre les demandes OUI-XXXX" },
  plafond: { titre: "Plafond", pour: "le plafond de dépense par jour" },
} as const;

export type SectionId = keyof typeof SECTIONS;
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

export function estSection(s: string): s is SectionId {
  return s in SECTIONS;
}

/** Le menu du haut du panneau. */
export function menuPanneau(): string {
  return SECTION_IDS.map((id) => `<a href="#${id}">${SECTIONS[id].titre}</a>`).join("");
}
