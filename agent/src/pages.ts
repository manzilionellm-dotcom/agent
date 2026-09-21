import { config } from "./config.js";

/**
 * Les trois pages publiques que Google exige avant de publier un écran de
 * consentement OAuth : accueil, confidentialité, conditions.
 *
 * Elles sont servies par l'orchestrateur, sur l'adresse qui porte déjà le
 * webhook WhatsApp, plutôt que par un hébergement à part. Trois raisons :
 * le domaine et le tunnel existent déjà, il n'y a rien de plus à déployer,
 * et une politique de confidentialité hébergée ailleurs finit toujours par
 * décrire un logiciel qui a changé depuis.
 *
 * Leur contenu doit rester VRAI. Une politique qui tairait l'envoi des
 * messages à un fournisseur de modèle serait fausse, et c'est précisément
 * ce que ce document est censé dire.
 */

const CSS = `
:root { color-scheme: light dark; --fg:#111; --muted:#555; --bg:#fff; --line:#e5e5e5; --accent:#0b5; }
@media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#a0a0a0; --bg:#131313; --line:#2a2a2a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
h1 { font-size: 1.7rem; line-height:1.25; margin: 0 0 .35rem; letter-spacing:-.01em; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .5rem; }
p, li { color: var(--fg); }
.sub { color: var(--muted); margin: 0 0 2.5rem; }
.date { color: var(--muted); font-size: .85rem; }
ul { padding-left: 1.1rem; }
li { margin: .3rem 0; }
a { color: inherit; text-decoration-color: var(--muted); text-underline-offset: 3px; }
nav { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 1.25rem; font-size: .9rem; }
nav a { margin-right: 1.25rem; color: var(--muted); }
code { background: color-mix(in srgb, var(--fg) 8%, transparent); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
`;

/**
 * Balise de validation Google Search Console. Google exige que le domaine
 * listé dans « Domaines autorisés » de l'écran OAuth lui appartienne
 * prouvablement. La validation par balise se fait ici, sans enregistrement
 * DNS — utile quand le domaine, le tunnel et le serveur sont administrés
 * depuis trois interfaces différentes à une heure du matin.
 */
function verification(): string {
  const v = config().GOOGLE_SITE_VERIFICATION;
  return v ? `<meta name="google-site-verification" content="${v.replace(/"/g, "&quot;")}">` : "";
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Manzi Junior</title>
<meta name="robots" content="noindex">
${verification()}
<style>${CSS}</style></head><body><main>${body}
<nav><a href="/">Accueil</a><a href="/privacy">Confidentialité</a><a href="/terms">Conditions</a></nav>
</main></body></html>`;
}

/** L'adresse de contact publique : celle du dépôt, à défaut celle des rapports. */
function contact(): string {
  const c = config();
  return c.REPORT_TO_EMAIL || c.GIT_AUTHOR_EMAIL;
}

const UPDATED = "22 septembre 2026";

export function homePage(): string {
  return page(
    "Accueil",
    `<h1>Manzi Junior</h1>
<p class="sub">Assistant personnel privé, à un seul utilisateur.</p>

<p>Manzi Junior est un agent logiciel que son propriétaire commande par WhatsApp. Il exécute des tâches
qu'on lui confie explicitement : faire une veille, rédiger et publier un article, comparer des offres,
relire une boîte mail et préparer des réponses.</p>

<h2>Ce qu'il fait avec un compte Google</h2>
<p>Avec l'autorisation de son propriétaire, il lit les messages de sa boîte Gmail pour les lui résumer,
prépare des brouillons de réponse, et consulte son agenda. Un envoi d'e-mail lui demande une confirmation
explicite, message par message.</p>

<h2>Pour qui</h2>
<p>Cette application n'est ni distribuée, ni vendue, ni ouverte à l'inscription. Elle sert un seul compte,
celui de son propriétaire, sur son propre serveur.</p>

<p class="date">Contact : ${contact()}</p>`,
  );
}

export function privacyPage(): string {
  return page(
    "Confidentialité",
    `<h1>Politique de confidentialité</h1>
<p class="sub">Mise à jour le ${UPDATED}</p>

<h2>Qui traite les données</h2>
<p>Manzi Junior est exploité par une personne physique, pour son usage personnel, sur un serveur privé qu'elle
administre. Il n'y a pas d'autre utilisateur et aucune inscription n'est possible.</p>

<h2>Quelles données</h2>
<ul>
<li><strong>Google (Gmail, Agenda)</strong> — expéditeur, objet, date et corps des messages consultés ; titre,
date et lieu des événements. Uniquement après autorisation OAuth donnée par le propriétaire du compte.</li>
<li><strong>WhatsApp</strong> — le contenu des messages échangés avec l'agent, y compris les pièces jointes
envoyées volontairement.</li>
<li><strong>Pages web</strong> consultées sur demande explicite.</li>
</ul>

<h2>À quoi elles servent</h2>
<p>Uniquement à exécuter la tâche demandée : résumer, classer, rédiger un brouillon, retrouver une information.
Aucune autre finalité. Aucune publicité, aucun profilage, aucune revente, aucun partage avec un tiers à des
fins commerciales — ni aujourd'hui, ni plus tard.</p>

<h2>Sous-traitants</h2>
<p>Le texte à traiter est transmis à un fournisseur de modèle de langage pour y être analysé : <strong>Anthropic</strong>
et <strong>DeepSeek</strong>, selon la tâche. C'est inhérent au fonctionnement de l'outil et c'est le seul
transfert qui ait lieu. Ces fournisseurs traitent la requête et la renvoient ; leurs conditions respectives
s'appliquent à ce traitement.</p>

<h2>Conservation</h2>
<p>Les données restent sur le serveur du propriétaire, dans une base PostgreSQL non exposée à Internet.
Les sauvegardes sont conservées 14 jours puis écrasées. Rien n'est stocké chez un tiers en dehors du
traitement décrit ci-dessus.</p>

<h2>Retirer l'accès</h2>
<p>L'accès Google se révoque à tout moment sur
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, avec effet immédiat :
le jeton devient invalide et l'application ne peut plus rien lire. Pour la suppression des données déjà
enregistrées, écrire à ${contact()} ; elles sont effacées sous 30 jours.</p>

<h2>Usage limité (Google API Services)</h2>
<p>L'utilisation des données reçues des API Google respecte la
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
y compris ses exigences d'usage limité. Ces données ne servent qu'aux fonctions décrites ici, ne sont pas
transférées à des tiers sauf pour le traitement indiqué ci-dessus, ne sont pas utilisées pour de la publicité,
et aucun humain ne les lit — à l'exception du propriétaire du compte lui-même.</p>

<p class="date">Contact : ${contact()}</p>`,
  );
}

export function termsPage(): string {
  return page(
    "Conditions",
    `<h1>Conditions d'utilisation</h1>
<p class="sub">Mise à jour le ${UPDATED}</p>

<h2>Objet</h2>
<p>Manzi Junior est un outil personnel, utilisé par son seul propriétaire. Ces conditions encadrent cet usage.
L'application n'est pas proposée au public : aucune inscription, aucun compte tiers, aucun service vendu.</p>

<h2>Utilisation</h2>
<p>L'agent n'agit que sur ordre explicite de son propriétaire. Les actions irréversibles — envoyer un e-mail,
publier une page, créer une ressource — demandent une confirmation séparée avant d'être exécutées.</p>

<h2>Absence de garantie</h2>
<p>L'outil est fourni tel quel, sans garantie d'exactitude ni de disponibilité. Un agent logiciel peut se
tromper : les résultats sont à vérifier avant toute décision qui compte. La responsabilité de son propriétaire
ne peut être engagée pour un usage qu'il fait lui-même de son propre outil.</p>

<h2>Évolution</h2>
<p>Ces conditions peuvent changer en même temps que l'outil. La date en haut de page fait foi.</p>

<p class="date">Contact : ${contact()}</p>`,
  );
}
