# Les atouts « façon Grok bots » : ce qui est là, ce qui ne s'applique pas

Lionel a versé quatre listes de « secrets » (Grok bots, SEO viral 2026,
SEO + vitesse, architecture multi-bots). Ce document dit, point par point,
ce que Manzi Junior en fait. Trois catégories : **ajouté** (code de ce
dépôt), **déjà là** (existait avant), **sans objet** (décrit le produit
Grok lui-même, ou une méthode que Google sanctionne).

## Ajouté

| Atout | Où | Comment ça se voit |
|---|---|---|
| Webhooks entrants (« préfère les webhooks aux routines ») | `agent/src/crochets.ts`, route `POST /hook/<nom>` | Panel → Crochets. Sur WhatsApp : « quand Stripe reçoit un paiement, préviens-moi ». Mode notifier (appel isolé, sans outil) ou mission. Secret haché, affiché une fois. |
| Journal des refus (« une preuve pour chaque action bloquée ») | `agent/src/refus.ts`, outil `signaler_refus` | Panel → Refus. Un « je n'ai pas pu » sans preuve est posé d'office et affiché en rouge : c'est un échec du bot, pas un refus. |
| Routines : pas plus d'une fois par heure sans « quand même » ; 50 exécutions gardées par mission | `scheduler.ts` (`setSchedule`, `purgerExecutions`) | Le bot refuse « toutes les 5 minutes » en chiffrant le coût et propose un crochet. |
| Veille de dépense (« un bot Usage qui ralentit les autres ») | `scheduler.ts` (`veillerDepense`), `openaiCompat.ts` (`setRalenti`) | Message WhatsApp au seuil (5 $ par défaut), réflexion éco forcée au double. « alerte à 10 », « alerte off ». Panel → Plafond. |
| Plusieurs comptes par site (perso / pro) | `vault.ts` (clé `site, compte`), `browser login{compte}` | Page /vault, champ « Nom du compte ». « connecte-toi à Gmail avec mon compte pro ». |
| Règles absolues en langage naturel (approbations, interdits) | `personality.ts` (`BOT_REGLES`) | « à partir de maintenant, jamais d'envoi de mail sans mon OK ». Panel → Personnalité → Règles absolues. Elles priment sur « exécute sans demander ». |
| Plan écrit avant d'agir, API plutôt que navigateur la deuxième fois, apprendre le style des corrections, tester une fois avant de planifier | consignes dans `channels/chat.ts` | Comportement, pas un bouton. |
| Savoir SEO / GEO / vitesse 2026 (50 points, dont 5 marqués « à ne pas faire ») | `seo-geo.ts` (`SAVOIR_SEO_2026`) | Injecté dans `site_seo_geo`, `seo_daily` et l'atelier dev quand la demande parle de site ou de SEO. |

## Déjà là

Skills réutilisables (Compétences), routines planifiées (`schedule_mission`),
mémoire visible et corrigeable (panel → Mémoire), fichiers partagés `/work`
entre le bot et ses sous-agents, agents durables et délégation
(`create_agent`, `assign_task`), preuves par capture d'écran, coffre qui tape
les mots de passe sans que le bot les voie, approbations OUI-XXXX, routeur qui
garde le code chez DeepSeek, inspecteur quotidien, pas de secret dans les
descriptions (caviardage de la boîte noire).

## Sans objet, et pourquoi

- **Bots multiples partageant un ordinateur, templates, dupliquer, cacher,
  Marketplace, group chats, Peekaboo (Mac), Agent Cookie, Tailscale** :
  fonctions du produit Grok. Manzi Junior est un seul bot sur ton serveur ;
  son navigateur reste connecté d'une fois sur l'autre, et le tien (PC) est
  joignable par `BROWSER_CDP_URL`.
- **Router le trafic par ton PC pour contourner des blocages d'IP** : le
  navigateur de ton PC est déjà utilisable via CDP pour les sites qui
  refusent un serveur ; rien n'est codé pour tromper un site.
- **Domaines expirés en 301, fausses dates de mise à jour, avis « tiers »
  qui sont les tiens, burner domains, faux engagement** : inscrits dans la
  politique anti-spam de Google (abus de domaine expiré, abus de réputation
  de site). Le bot les connaît pour les refuser en une ligne et proposer
  l'équivalent propre.
- **Teach a task (enregistrement d'écran)** : pas d'enregistreur d'écran ;
  l'équivalent est une compétence dictée (« à partir de maintenant, quand…
  fais… ») ou une tâche faite une fois sur /screen puis décrite.
