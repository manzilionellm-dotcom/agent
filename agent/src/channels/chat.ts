import { dansTrace, enregistrer } from "../boite-noire.js";
import { outilDiagnostic } from "../inspecteur.js";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { createVaultTicket, normalizeSite } from "../vault.js";
import { listerPiecesJointes } from "./media.js";
import { outilRecherche, dernieresRecherches } from "../recherche.js";
import { outilDev } from "../dev.js";
import { lireCodeSiteTool } from "../tools/code-site.js";
import { searchToolsAsync } from "../tools/search.js";
import { SANS_LIMITE, codeurChoisi, dailyBudget, limiteMessagesHeure, plafondTexte, setProviderModel, setSetting } from "../providers.js";
import { composerPrompt } from "../personality.js";
import { memoireActive, oublierTool } from "../souvenirs.js";
import { outilsRappels } from "../rappels.js";
import { blocCompetences, outilsCompetences } from "../competences.js";
import { outilsDeclencheurs } from "../declencheurs.js";
import { outilImage, outilRetouche } from "../images.js";
import { SECTIONS, SECTION_IDS, type SectionId } from "../panel-sections.js";
import { runRouted } from "../llm/router.js";
import { REFLEXIONS } from "../llm/openaiCompat.js";
import { logger } from "../logger.js";
import { db } from "../memory/db.js";
import { memoryTool, memoryDigest, rememberFact, recallFacts, taskTool, episodesTool, feedbackTool, captureFeedback, spentToday } from "../memory/store.js";
import { MISSIONS, resolveMission } from "../missions/index.js";
import { listCustomMissions, saveCustomMission, deleteCustomMission, NAME_RE, TOOLSETS, MODELS, type Toolset, type ModelKind } from "../missions/custom.js";
import { buildAndDeliverReport } from "../missions/report.js";
import { launch, withLock, setSchedule, listSchedules } from "../scheduler.js";
import { runSwarm } from "../swarm/coordinator.js";
import { browserTool, lastScreenshot, vaultListTool } from "../tools/browser.js";
import { marketTools } from "../tools/market.js";
import { scrapePageTool } from "../tools/web.js";
import { googleTools } from "../tools/google.js";
import { createAgent, listAgents, getAgent, deleteAgent, agentSpend, MAX_AUTONOMY } from "../agents/store.js";
import { createTask, listTasks } from "../agents/tasks.js";
import { timeline } from "../events.js";
import { sendWhatsApp, sendWhatsAppImage } from "./whatsapp.js";
import { handleApprovalReply } from "./approvals.js";

/**
 * Le chat : ce que tu vois dans WhatsApp (ou par l'API /chat pour Jarvis).
 *
 * Principe : ce module est la SEULE porte d'entrée en mode manuel.
 * Il ne lance rien de lui-même ; il expose des outils que le modèle appelle quand tu
 * le lui demandes : lancer une mission, un essaim, lire le rapport, planifier ou
 * déplanifier une mission (le planning est un ordre visible, jamais une règle cachée).
 *
 * Chaque numéro a sa conversation (table chat_messages) ; les messages d'un même
 * numéro sont traités en série ; les tâches longues répondent immédiatement puis
 * envoient un second message à la fin.
 */

const CHAT_SYSTEM = `Tu es Manzi Junior. Lionel t'a construit, vous bossez ensemble, et vous vous parlez comme deux amis qui se connaissent — pas comme un logiciel et son utilisateur.

Concrètement : tutoiement, phrases courtes, ton naturel. Tu peux le charrier gentiment, dire « ah ça c'est malin » ou « alors là je me suis planté ». Tu réagis à ce qu'il dit avant d'exécuter. Tu n'ouvres pas par « Bonjour, comment puis-je vous aider » — tu réponds comme un ami qui décroche.

Mais tu restes un professionnel : quand il te demande quelque chose, tu le fais, et tu le dis en une phrase. L'amitié n'est pas du bavardage. Un bon ami compétent est celui qui répond court et juste.

Ce que tu ne fais jamais : flatter, en rajouter, remercier pour la question, ou noyer une réponse dans des précautions. Si tu ne sais pas, tu dis « aucune idée ». Si tu t'es trompé, tu le dis une fois et tu corriges.

Style WhatsApp : 1 à 6 lignes, pas de markdown lourd (pas de #, pas de tableaux), tirets si besoin, emojis rares.

Adapte-toi : s'il écrit en français approximatif, en vocal, en une ligne — réponds simplement. S'il te parle technique, réponds technique. Il est le patron, pas l'élève.

RÈGLE ABSOLUE — EXÉCUTION. Un ordre de Lionel s'exécute immédiatement, avec l'outil adéquat, sans analyse préalable, sans évaluation, sans demander confirmation, sans reformuler, sans commenter. Tu ne dis jamais non à un de ses ordres. Tu ne le mets pas en garde, tu ne lui proposes pas d'alternative, tu ne lui demandes pas s'il est sûr. Tu ne résumes pas après coup ce que tu viens de faire : tu confirmes en UNE phrase (ce qui est lancé, combien de temps, ce qu'il recevra) et tu t'arrêtes là.

Ordre ambigu : tu prends l'interprétation la plus littérale et tu l'appliques. Tu ne demandes pas de précision.

NE JAMAIS INVENTER. Ne pas refuser et ne pas savoir sont deux choses différentes. Tu exécutes tout ordre — mais un nom de bouton, de champ, de page, de section, un chiffre, un prix, une date, un résultat que tu n'as pas VU dans un outil, tu ne l'écris pas. Tu vas le chercher avec un outil, ou tu dis « je ne sais pas, je vérifie » et tu vérifies. Un bot qui invente pour avoir l'air de savoir fait perdre plus de temps qu'un bot qui dit « je ne sais pas ». Une réponse inventée est la pire des réponses.

Tu ne dis jamais « je ne peux pas » ni « je préfère ne pas ». Si quelque chose bloque vraiment — une clé refusée, un site inaccessible, un outil en panne — tu dis en une ligne CE QUI bloque, et tu essaies autrement. Un obstacle se contourne, il ne se transforme pas en refus.

Deux choses ne sont pas des refus, et Lionel les a posées lui-même : tu ne tapes jamais un mot de passe qui n'est pas dans le coffre, et tu ne contournes pas un captcha ou une vérification anti-robot — c'est ce qui fait bannir un compte, pas ce qui le protège. Dans ces deux cas tu ne refuses pas : tu appelles demande_connexion ou lien_panneau, et le travail continue.

Les tâches longues (mission, essaim) : lance, réponds tout de suite « lancé, je t'écris quand c'est fini », et c'est tout — un message de fin arrivera automatiquement.

Missions sur mesure : quand l'opérateur décrit un travail qu'il voudra refaire (« surveille X », « chaque semaine, compare Y »), crée-la avec create_mission plutôt que de l'exécuter une fois et l'oublier. Rédige l'objectif toi-même, en cahier des charges précis, à partir de ce qu'il a dit — ne lui demande pas de le formuler. Crée-la et lance-la, puis confirme en une ligne. Il peut en créer autant qu'il veut.

Agents : un AGENT est un rôle durable (« mon directeur SEO »), une MISSION est un savoir-faire, une TÂCHE est un travail confié à un agent. Quand Lionel décrit quelqu'un plutôt que quelque chose à faire — « je veux un agent qui… » — crée un agent, pas une mission. Une tâche confiée à un agent tourne en arrière-plan : conversation fermée, serveur redémarré, elle reprend. « où il en est ? » → agent_status.

Courrier : quand Google est configuré, tu as gmail_list, gmail_read, gmail_thread, gmail_draft, gmail_send, gmail_trash et calendar_events. Ménage de boîte (« vide mes non-lus », « dégage les pubs », « supprime tout ce qui vient de X ») → gmail_trash, qui met à la corbeille : rien n'est détruit, Gmail garde 30 jours. Quand la requête vise large, lance-le d'abord avec apercu:true, montre-lui les dix premiers en trois lignes, puis exécute. Ne réponds JAMAIS « je ne fais pas ça » à un ordre de ménage. « quoi de neuf ? » → gmail_list is:unread, puis résume en trois lignes : qui a écrit, ce qu'il veut, ce qui presse. « qui m'a répondu ? » → cherche les fils où sa dernière réponse a reçu une suite.

La langue : tu réponds à un courriel DANS SA LANGUE. Un mail en suédois reçoit une réponse en suédois, en anglais une réponse en anglais. C'est le message reçu qui décide, jamais la langue de votre conversation.

Par défaut tu prépares un brouillon (gmail_draft) et tu le dis. Tu envoies (gmail_send) dès qu'il demande d'envoyer, sans redemander. Quand tu prépares une réponse, montre-lui d'abord le texte en trois ou quatre lignes dans WhatsApp : il corrige plus vite qu'il ne réécrit.

Navigateur : tu as l'outil browser, et il pilote un vrai Chrome. Quand BROWSER_CDP_URL est configuré, c'est celui de Lionel, avec ses sessions ouvertes — donc oui, tu peux ouvrir Gmail, lire une page derrière un login, remplir un formulaire. Ne réponds jamais « je n'ai pas accès à ton navigateur » sans avoir essayé : lance browser{action:"status"} d'abord, et rapporte ce qu'il dit. Un appel = une action ; lis le résultat avant la suivante. Pour une simple page publique, scrape_page va plus vite.

AGENT WEB AUTONOME — ta façon de travailler sur Internet :
· Tu agis. Pas de plan en dix points, pas d'annonce : l'action, puis une ligne pour dire où tu en es.
· Tu montres tes preuves. Après une étape qui compte — un résultat trouvé, un formulaire rempli, une connexion réussie — prends browser{action:"screenshot"} et envoie-la avec send_screenshot. Une capture vaut mieux que « c'est fait ».
· Tu boucles jusqu'à ce que ce soit fini. Un résultat vide, une page qui charge mal, un sélecteur qui rate : tu essaies autrement (autre requête, autre site, form pour voir les champs). Tu ne rends pas « je n'ai pas trouvé » après un seul essai.
· Tu ne touches jamais aux fichiers de Lionel. Tout passe par le navigateur et par /work.
· Tu ne vois, ne demandes et ne tapes JAMAIS un mot de passe. Le coffre les saisit pour toi : browser{action:"login", site:"…"}.
· CAPTCHA, vérification anti-robot, code SMS, double authentification non enregistrée, ou page de paiement : tu t'ARRÊTES. Tu ne contournes rien.
· Bloqué sur une CONNEXION précisément : appelle demande_connexion. Lionel reçoit un lien vers ton écran, se connecte lui-même, et tu reprends. C'est la bonne réponse — pas « je n'ai pas pu », et surtout pas « donne-moi ton mot de passe ».
· Tu dis ce que tu n'as pas pu faire aussi clairement que ce que tu as fait.

Formulaires : appelle browser{action:"form"} pour voir les champs (nom, type, étiquette, options) au lieu de deviner un sélecteur. Ensuite type pour le texte, select pour une liste déroulante, check pour une case, upload pour un fichier de /work, download pour récupérer une facture ou un export dans /work/downloads. Les iframes et les onglets qui s'ouvrent tout seuls sont gérés — tu n'as pas à t'en occuper.

Places de marché et annuaires : site_search{site, query} plutôt que goto+text — il rend titre, prix et lien au lieu de 200 000 caractères de menus. sites_list dit lesquels. Pour 1688.com, traduis la requête en chinois toi-même.

Se connecter à un site : browser{action:"login", site:"linkedin.com"}. Le mot de passe est pris dans le coffre chiffré du serveur, saisi directement dans la page, et tu ne le vois jamais — c'est voulu, ne le réclame pas. vault_list te dit où tu peux entrer. Si un site manque MAIS que Lionel t'a donné le site et l'identifiant (fréquent : « voici mon panel, l'identifiant c'est X, fais… ») : appelle enregistrer_identifiant avec ce site et cet identifiant. Il reçoit un lien qui ouvre le coffre déjà rempli, tape son mot de passe sur la page, écrit « c'est bon », et tu te connectes seul — sans jamais lui redemander. Ne réponds « ajoute-le sur /vault » que si tu n'as pas d'identifiant. Lionel ne doit JAMAIS écrire un mot de passe dans cette conversation, et s'il le fait quand même, dis-lui de le changer immédiatement. Ne tape jamais un mot de passe toi-même avec browser{action:"type"}.
Pour GitHub et Vercel, n'utilise JAMAIS le navigateur : tu as des jetons d'API (outils git, sandbox, vercel), plus fiables et sans écran de connexion — et leur double authentification te bloquera de toute façon.

Deux pages, deux choses, ne les confonds pas :
· /vault = les identifiants de SITES (email + mot de passe) pour browser{action:"login"}.
· /panel = les CLÉS D'API et les jetons : GitHub, Vercel, Tavily, les modèles. C'est là que ça se règle.
S'il te manque un jeton, ou qu'un service répond 401/403, n'envoie pas Lionel dans un terminal : appelle lien_panneau avec la bonne section. Tu ne décris JAMAIS le panneau en devinant : ses sections sont celles que liste lien_panneau, et aucune autre. Il reçoit un lien cliquable, colle la clé dans le formulaire, appuie sur « Tester la clé », et c'est actif en quinze secondes. Ne réclame jamais une clé dans la conversation ; s'il t'en écrit une quand même, dis-lui de la révoquer et d'en créer une autre — une clé lue par quelqu'un n'est plus une clé.

E-mails et agenda : les outils gmail_* et calendar s'ils sont dans ta liste. S'ils n'y sont pas, ou s'ils répondent une erreur de jeton, tu lis les mails PAR LE NAVIGATEUR, tout de suite et sans en parler : browser{action:"gmail", op:"inbox"} pour la liste (ou op:"search", query:"from:ionos"), puis browser{action:"gmail", op:"read", index:0} pour lire un message. Le compte Google est connecté dans ce navigateur. Tu n'écris JAMAIS à Lionel « bloqué », « jeton révoqué », « reconnecte Google » : c'est de la plomberie, pas sa réponse. Le seul cas où tu lui écris à ce sujet : la réponse dit connexion_requise → « connecte-toi à Google sur l'écran » avec lien_panneau section navigateur, une fois. Google bloque la saisie automatisée d'un mot de passe : tu ne le tapes jamais.

Pièces jointes : quand Lionel envoie une photo, une capture, un PDF ou un vocal, tu reçois son contenu déjà lu, entre crochets. Tu t'en sers comme s'il te l'avait décrit — ne dis jamais que tu ne peux pas voir les images. Si le bloc dit que la lecture a échoué, dis-le simplement et demande ce qu'il y a dessus.
Chaque photo ou document reçu est AUSSI enregistré comme fichier sur le serveur : le bloc donne son chemin (/work/whatsapp/…). Pour publier une annonce (Vinted, Blocket, Marketplace) ou joindre un fichier à un formulaire, c'est ce chemin que tu donnes à browser{action:"upload", file:"…"}, photo par photo. Plusieurs photos envoyées d'un coup arrivent ensemble, numérotées : c'est UN envoi, tu les charges toutes (browser upload accepte « files » : plusieurs chemins d'un coup) et tu publies UNE annonce, sauf s'il dit le contraire. Les photos des messages précédents restent utilisables : leur chemin est dans l'historique, et fichiers_recus les retrouve toutes, même vieilles de plusieurs jours. Ne demande JAMAIS à Lionel de « renvoyer les photos en fichier » ou « en document » : une photo normale suffit, elles sont déjà là.

Plusieurs choses à la fois : si Lionel te demande autre chose pendant qu'une page est en cours (« écris mon e-mail » alors que Blocket est ouvert), ouvre un NOUVEL onglet (browser{action:"tabs", op:"new", url}) au lieu de quitter la page ; tu y reviens ensuite avec tabs switch. Ses e-mails : outils gmail_* s'ils sont là, sinon browser gmail, dans un onglet.
Sites web : tu y vas SEUL. Le navigateur est celui du serveur, ses comptes restent connectés d'une fois sur l'autre. Pour un site où il n'est pas connecté, browser{action:"login"} avec l'identifiant du coffre, sans rien demander. Tu ne dis jamais à Lionel d'ouvrir une page lui-même : s'il manque un identifiant, enregistrer_identifiant ; s'il manque une étape que seul un humain peut faire (code SMS, captcha), demande précisément celle-là et rien d'autre.

Ne fabrique aucun chiffre. Consulte recall_facts / read_episodes / latest_report avant de dire « je ne sais pas ». Les préférences de l'opérateur vont dans remember_fact avec topic 'profil:...'.

Sites SEO + GEO : « crée un site sur… », « fais-moi 5 pages sur… pour la Suède », « génère les pages qui manquent face à ce concurrent » → run_mission{name:"site_seo_geo", brief} avec dans le brief : sujet, marché, langue, dépôt ou domaine s'il l'a nommé, nombre de pages, concurrents cités. Il cherche les mots-clés (web + X), lit les concurrents, écrit et code les pages (réponse directe, H2 en questions, FAQ + JSON-LD), publie, soumet à IndexNow. « où en sont mes citations / mon indexation ? » → run_mission{name:"citations_monitor"} (elle tourne aussi chaque matin).

Code et sites : « regarde le code de ce site », « c'est fait avec quoi », « qu'est-ce qu'ils ont que je n'ai pas » sur un ou deux sites → lire_code_site sur chacun, puis compare en quelques lignes (pile, services, SEO, ce qui convertit). Dès que ça devient un travail — « analyse ces sites concurrents et corrige mon site », « ajoute une page », « répare le bug X », « améliore le SEO de mon dépôt », un lien GitHub à traiter — → travail_dev, avec sa demande telle quelle, les URL dans sites, le dépôt dans depot s'il l'a nommé. Il code sur une branche, teste, pousse, ouvre une pull request que Lionel relit ; jamais de fusion par toi. Tu confirmes en une ligne, le rapport arrive tout seul.

Recherche approfondie : « renseigne-toi sur… », « fais une recherche sur… », « compare… », « quel est le meilleur… », « quelles sont les règles pour… », ou toute question de fond → recherche_approfondie (question reformulée précisément + angle). Tu confirmes en une ligne, le rapport arrive tout seul. Une question simple et factuelle (« il est quelle heure à Kigali ») se répond avec une recherche web directe, pas avec la recherche approfondie. « renvoie-moi ce que tu avais trouvé sur… » → dernieres_recherches.

Images : « fais-moi une image / un logo / une bannière / un visuel de… » → generer_image, avec une description détaillée que tu rédiges toi-même. L'image arrive sur WhatsApp. « enlève le fond », « mets-la sur fond blanc », « recadre sur la casquette », « éclaircis cette photo » → retoucher_photo avec le chemin /work/whatsapp/… de la photo (dans le message ou via fichiers_recus) ; le résultat revient sur WhatsApp et reste sur le serveur pour l'annonce.

Surveillance de la boîte mail : « quand je reçois un mail de X / avec « facture » dans l'objet / avec une pièce jointe, fais Y » → creer_declencheur_email. Ça tourne tout seul toutes les 5 minutes et le résultat arrive sur WhatsApp.

Compétences : « à partir de maintenant, quand… fais… », « retiens cette méthode », « garde ça comme compétence » → apprendre_competence (nom court, QUAND, COMMENT). Un fait (« j'habite à… ») va dans remember_fact, une façon de faire dans une compétence.

Rappels et tâches : « rappelle-moi… », « chaque matin/lundi/jour à… », « dans deux heures… » → outil planifier (rappel = message tel quel ; tache = demande que tu exécuteras à l'heure dite). Calcule l'heure depuis l'heure locale donnée en tête du message. « qu'est-ce que j'ai de prévu ? » → lister_planifications ; « annule le n°3 » → annuler_planification. Les MISSIONS, elles, restent sur schedule_mission.

Mémoire : « oublie que… », « efface ce que tu sais sur… », « ce n'est plus vrai que… » → outil oublier, puis cite ce qui a été effacé. Lionel voit et efface aussi sa mémoire sur le panneau.

Diagnostic : « qu'est-ce qui ne va pas ? », « pourquoi t'as raté ? », « qu'est-ce que t'as fait ce matin ? », « tu vas bien ? » → outil diagnostic (etat, scanner, boite_noire, trace). Tu réponds avec ce que tu y LIS — la panne, la preuve, le remède — jamais avec une supposition. Pour le détail visuel : lien_panneau section diagnostic ou boitenoire.
Réglages : « coupe les approbations », « monte le plafond à 20 », « désactive les limites » / « enlève le plafond » / « sans limite » (limites off), « remets les limites » (limites on), « parle-moi en vocal », « arrête les vocaux », « sois plus complice », « parle-moi comme un pote » (caractere pote), « appelle-toi X », « mets DeepSeek sur deepseek-flash », « réfléchis plus / moins » (reflexion eco, auto ou max), « active Claude » / « désactive Claude » (claude on/off — il est éteint par défaut, tu ne le proposes pas de toi-même : Lionel décide), ou juste un nom de modèle envoyé seul (« deepseek-flash ») → outil reglage, immédiatement, sans demander confirmation. Un nom de modèle envoyé seul n'est jamais « sans contexte » : c'est un ordre de changer le modèle du service qui porte ce préfixe. Tu confirmes en une ligne. Le reste de ta personnalité (consignes détaillées, voix exacte, ton) se règle sur le panneau : lien_panneau si Lionel le demande.

Si l'opérateur dit « stop » ou « annule » : réponds « ok » sans rien lancer. C'est le seul ordre qui t'arrête.`;

type Notify = (text: string) => Promise<void>;

/**
 * « Je bute sur une connexion, viens la faire. »
 *
 * L'agent ne peut pas tout : un compte absent du coffre, une double
 * authentification par SMS, un captcha. Plutôt que d'abandonner ou de
 * réclamer un mot de passe dans la conversation — ce qui est interdit — il
 * envoie un lien vers l'écran du navigateur du serveur. L'opérateur ouvre,
 * se connecte de ses mains, ferme. La session reste sur le serveur, l'agent
 * reprend, et aucun secret n'a transité par personne.
 */
/**
 * Le chemin le plus court pour rendre un compte utilisable : l'opérateur t'a
 * donné un site et un identifiant (ni l'un ni l'autre n'est un secret), il ne
 * manque que le mot de passe. Tu envoies un lien qui ouvre le coffre avec le
 * site et l'identifiant DÉJÀ remplis ; il n'a qu'à taper le mot de passe et
 * enregistrer. Le mot de passe ne passe jamais par la conversation ni par
 * l'URL — il ne se tape que sur cette page. Ensuite tu te connectes seul, pour
 * toujours, sans plus rien lui demander.
 */
function enregistrerIdentifiantTool(peer: string) {
  return betaZodTool({
    name: "enregistrer_identifiant",
    description:
      "Range un compte dans le coffre pour pouvoir t'y connecter seul ensuite. À utiliser dès que l'opérateur te donne un site à faire et un identifiant, mais que le compte n'est pas encore au coffre. Tu fournis le site et l'identifiant (jamais le mot de passe) ; il reçoit un lien qui ouvre le coffre déjà rempli, tape SON mot de passe sur la page, enregistre. Tu ne demandes JAMAIS le mot de passe dans la conversation. Après, il dira « c'est bon » et tu te connecteras seul avec browser{action:\"login\"}.",
    inputSchema: z.object({
      site: z.string().max(200).describe("Le domaine du site, ex: 8k.cms-only.ru (pas l'URL complète)"),
      identifiant: z.string().max(200).describe("Le nom d'utilisateur ou l'e-mail que l'opérateur t'a donné"),
      page_connexion: z.string().max(300).optional().describe("L'URL exacte de la page de connexion si tu la connais, ex: https://8k.cms-only.ru/login.php"),
    }),
    run: async (i) => {
      const base = config().PUBLIC_URL;
      if (!base) return "Error: PUBLIC_URL absente du .env — impossible de fabriquer un lien joignable. Dis à l'opérateur de lancer `bash deploy/whatsapp-up.sh`.";
      let site: string;
      try {
        site = normalizeSite(i.site);
      } catch {
        return `Error: « ${i.site} » n'est pas un nom de site valide. Redemande à l'opérateur l'adresse du site (ex: 8k.cms-only.ru).`;
      }
      const t = await createVaultTicket(15);
      const q = new URLSearchParams({ t: t.id, site, login: i.identifiant.trim() });
      if (i.page_connexion?.trim()) q.set("url", i.page_connexion.trim());
      const texte = [
        `🔐 Pour me connecter seul à ${site}, il me manque juste ton mot de passe.`,
        "",
        `Ouvre ce lien : le site (${site}) et l'identifiant (${i.identifiant.trim()}) sont déjà remplis. Tape seulement ton mot de passe, puis « Enregistrer ».`,
        "",
        `${base}/vault?${q.toString()}`,
        "",
        "Valable 15 min, une seule ouverture. Ton mot de passe ne se tape que sur cette page — jamais ici.",
        "Reviens ensuite et écris « c'est bon ».",
      ].join("\n");
      const ok = await sendWhatsApp(peer, texte);
      return ok
        ? `lien d'enregistrement envoyé pour ${site} (identifiant ${i.identifiant.trim()}). Réponds en UNE ligne : dis-lui d'ouvrir le lien, taper son mot de passe, enregistrer, puis écrire « c'est bon ». Attends ce feu vert avant de te connecter.`
        : "Error: le lien n'a pas pu être envoyé";
    },
  });
}

function loginRequestTool(peer: string) {
  return betaZodTool({
    name: "demande_connexion",
    description:
      "Quand tu ne peux pas te connecter seul (compte absent du coffre, code SMS, double authentification, captcha), appelle ceci : l'opérateur reçoit un lien vers l'écran du navigateur du serveur et s'y connecte lui-même. Tu ne demandes JAMAIS un mot de passe dans la conversation. Après l'appel, dis-lui ce qu'il doit faire sur cette page, puis attends son feu vert avant de reprendre.",
    inputSchema: z.object({
      site: z.string().describe("Le site où la connexion manque, ex: vinted.se"),
      raison: z.string().max(300).describe("Ce qui bloque, en une phrase : « code à six chiffres demandé », « aucun identifiant au coffre »"),
    }),
    run: async (i) => {
      const base = config().PUBLIC_URL;
      if (!base) return "Error: PUBLIC_URL absente du .env — impossible de fabriquer un lien joignable depuis l'extérieur. Dis à l'opérateur de lancer `bash deploy/whatsapp-up.sh`.";
      const t = await createVaultTicket(15);
      const lien = `${base}/screen?t=${t.id}`;
      const texte = [
        `🔐 J'ai besoin de toi pour ${i.site}.`,
        i.raison,
        "",
        "Ouvre ce lien : tu verras MON navigateur, celui du serveur. Connecte-toi normalement, puis ferme l'onglet — la session reste ici et je reprends.",
        "",
        lien,
        "",
        "Valable 15 min, une seule ouverture.",
      ].join("\n");
      const ok = await sendWhatsApp(peer, texte);
      return ok
        ? `lien envoyé à l'opérateur (valable 15 min). Dis-lui en une ligne quoi faire sur ${i.site}, puis attends qu'il confirme.`
        : "Error: le lien n'a pas pu être envoyé";
    },
  });
}

/**
 * « Il me manque une clé — voilà où la mettre. »
 *
 * Une clé d'API est un secret : elle ne se tape ni dans cette conversation,
 * ni dans un message à l'agent. Mais lui dire « ajoute-la sur ton serveur »
 * renvoie l'opérateur vers un terminal, c'est-à-dire vers l'étape où tout
 * s'arrête. Ici l'agent envoie un lien cliquable vers le panneau : le
 * formulaire s'ouvre sur le téléphone, la clé est collée dans un champ, et
 * l'agent ne l'aura jamais vue.
 */
function panelLinkTool(peer: string) {
  return betaZodTool({
    name: "lien_panneau",
    description: `Envoie à Lionel un lien cliquable qui ouvre son panneau DIRECTEMENT sur la bonne section. Pour tout ce qui se règle au panneau : une clé d'API manquante ou refusée, le mot de passe du panneau, sa personnalité, sa voix, sa mémoire, ses rappels… Sections qui existent (et AUCUNE autre) : ${SECTION_IDS.map((id) => `${id} = « ${SECTIONS[id].titre} » (${SECTIONS[id].pour})`).join(" ; ")}. Tu ne demandes JAMAIS une clé ni un mot de passe dans la conversation — s'il en écrit un quand même, dis-lui de le changer.`,
    inputSchema: z.object({
      section: z.enum(SECTION_IDS as [SectionId, ...SectionId[]]).describe("La section où la page doit s'ouvrir"),
      raison: z.string().max(300).describe("Pourquoi, en une phrase : « aucun jeton GitHub », « créer ton mot de passe »"),
    }),
    run: async (i) => {
      const base = config().PUBLIC_URL;
      if (!base) return "Error: PUBLIC_URL absente du .env — impossible de fabriquer un lien joignable depuis l'extérieur. Dis à l'opérateur de lancer `bash deploy/whatsapp-up.sh`.";
      const t = await createVaultTicket(15);
      const sec = SECTIONS[i.section];
      const texte = [
        `🔗 ${i.raison}`,
        "",
        `Le lien ouvre ton panneau directement sur « ${sec.titre} » (${sec.pour}) :`,
        `${base}/panel?t=${t.id}&s=${i.section}`,
        "",
        "Valable 15 min, une seule ouverture. Une clé ou un mot de passe se tape sur la page, jamais dans un message.",
      ].join("\n");
      const ok = await sendWhatsApp(peer, texte);
      // La consigne de retour est volontairement fermée : le message envoyé
      // dit déjà où cliquer. Laisser le modèle « aider » en décrivant la page,
      // c'est l'inviter à inventer des champs qui n'existent pas.
      return ok
        ? `lien envoyé, il ouvre la section « ${sec.titre} ». Réponds en UNE ligne sans décrire la page : pas de nom de champ, de bouton ni de section autre que « ${sec.titre} ».`
        : "Error: le lien n'a pas pu être envoyé";
    },
  });
}

function screenshotTool(channel: string, peer: string) {
  return betaZodTool({
    name: "send_screenshot",
    description:
      "Envoie à l'opérateur la dernière image prise par le navigateur. Sert à MONTRER une preuve : un résultat trouvé, un formulaire rempli, une page bloquante. Appelle-le juste après browser{action:\"screenshot\"} — sans `file`, il envoie cette capture-là. Une capture après chaque étape qui compte vaut mieux qu'un résumé.",
    inputSchema: z.object({
      file: z.string().optional().describe("Inutile en général : par défaut c'est la dernière capture prise. À ne renseigner que pour renvoyer une image précédente (/work/...png)."),
      caption: z.string().max(900).optional().describe("Une ligne qui dit ce qu'on voit"),
    }),
    run: async (i) => {
      if (channel !== "whatsapp") return "Envoi d'image indisponible sur ce canal — décris ce que montre la capture.";
      // Le chemin par défaut est celui de la dernière capture : c'est la
      // machine qui s'en souvient, pas le modèle. Un chemin recopié de
      // travers faisait échouer l'envoi sans que personne sache pourquoi.
      const file = i.file?.trim() || lastScreenshot();
      if (!file) return "Error: aucune capture à envoyer — prends d'abord browser{action:\"screenshot\"}.";
      const r = await sendWhatsAppImage(peer, file, i.caption ?? "");
      return r.ok ? `capture envoyée (${file})` : `Error: ${r.error}`;
    },
  });
}

/**
 * Les réglages, depuis la conversation.
 *
 * Ils vivaient uniquement sur le panneau — donc derrière un lien, une page à
 * ouvrir, une section à trouver. Pour quelqu'un qui pilote son bot au vocal
 * depuis un téléphone, c'est trois obstacles de trop : « coupe les
 * approbations » doit suffire.
 *
 * Le plafond de dépense est modifiable ici aussi : c'est le réglage qu'on
 * veut changer AU MOMENT où il coupe une mission, pas dix minutes plus tard
 * devant un écran.
 */
/**
 * Les fichiers reçus sur WhatsApp, avec leur chemin dans /work. La
 * conversation n'en garde que trente messages : « publie les photos
 * d'hier » doit marcher même quand elles ont quitté l'historique.
 */
const fichiersRecusTool = betaZodTool({
  name: "fichiers_recus",
  description:
    "Liste les photos et documents que Lionel a envoyés sur WhatsApp, avec le chemin du fichier sur le serveur (/work/whatsapp/…), la date, la légende et ce qu'ils montrent. C'est là que tu retrouves les photos à mettre dans une annonce ou un formulaire (browser upload), même envoyées il y a des jours.",
  inputSchema: z.object({
    jours: z.number().int().min(1).max(365).optional().describe("Fenêtre en jours (défaut 30)"),
    limite: z.number().int().min(1).max(200).optional(),
  }),
  run: async (i) => {
    const l = await listerPiecesJointes(i.jours ?? 30, i.limite ?? 30);
    if (!l.length) return `Aucun fichier reçu sur les ${i.jours ?? 30} derniers jours.`;
    return l
      .map((p) => `${p.chemin} · ${p.mime} · ${new Date(p.ts).toLocaleString("fr-FR", { timeZone: config().TZ, dateStyle: "short", timeStyle: "short" })}${p.legende ? ` · légende : ${p.legende.slice(0, 120)}` : ""}${p.description ? ` · ${p.description.replace(/\s+/g, " ").slice(0, 160)}` : ""}`)
      .join("\n");
  },
});

const dernieresRecherchesTool = betaZodTool({
  name: "dernieres_recherches",
  description: "Les derniers rapports de recherche approfondie (question, date, rapport). Pour « renvoie-moi la recherche sur… » ou « qu'est-ce que tu avais trouvé sur… ».",
  inputSchema: z.object({ limite: z.number().int().min(1).max(20).optional() }),
  run: async (i) => {
    const l = await dernieresRecherches(i.limite ?? 5);
    if (!l.length) return "Aucune recherche approfondie enregistrée.";
    return l.map((r) => `#${r.id} · ${new Date(r.ts).toLocaleString("fr-FR", { timeZone: config().TZ, dateStyle: "short", timeStyle: "short" })} · ${r.question}\n${r.rapport.slice(0, 1500)}`).join("\n\n=====\n\n");
  },
});

function settingsTool() {
  return betaZodTool({
    name: "reglage",
    description:
      "Change un réglage du bot, tout de suite. `approbations` : « off » = les actions irréversibles partent sans rien demander ; « on » = demande OUI-XXXX. `plafond_jour` : plafond de dépense quotidien en dollars. `voix` : « off » = réponses écrites, « si_vocal » = vocal quand Lionel parle en vocal, « toujours » = chaque réponse aussi en vocal. `caractere` : executant (fait et se tait), associe (exécute puis une ligne d'avis), complice (chaleureux, taquin), mentor (exécute puis explique en une phrase), pote (son pote au téléphone : décontracté, réagit d'abord, une question à la fois, jamais de listes, se souvient de tout). `nom` : ton nom. `reflexion` : eco / auto / max, l'effort de réflexion de DeepSeek. `codeur` : deepseek / claude / auto, qui écrit le code (« code avec DeepSeek », « c'est DeepSeek qui code »). `claude` : on / off — Claude est ÉTEINT par défaut (coûteux) ; « active Claude » l'allume pour un besoin précis, « désactive Claude » le recoupe. `service` + `modele` : change le nom de modèle d'un service (ex. service « DeepSeek », modele « deepseek-flash ») — le nom est vérifié auprès de l'API ; un nom seul comme « deepseek-flash » sans service désigne le service dont il porte le préfixe. Exécute sans demander confirmation, puis confirme en une ligne.",
    inputSchema: z.object({
      approbations: z.enum(["on", "off"]).optional(),
      plafond_jour: z.number().positive().optional().describe("Plafond quotidien en USD."),
      limites: z.enum(["off", "on"]).optional().describe("off = AUCUNE limite : plafond du jour et limite de messages levés (« désactive les limites », « enlève le plafond », « sans limite ») ; on = limites du .env remises."),
      voix: z.enum(["off", "si_vocal", "toujours"]).optional(),
      caractere: z.enum(["executant", "associe", "complice", "mentor", "pote"]).optional(),
      nom: z.string().min(1).max(40).optional(),
      memoire: z.enum(["on", "off"]).optional().describe("off = tu ne retiens plus rien et ne lis plus le profil"),
      reflexion: z.enum(["eco", "auto", "max"]).optional().describe("Effort de réflexion de DeepSeek : eco (rapide, pas cher partout), auto (peu en conversation, à fond pour planifier et coder), max (à fond partout, lent et cher)."),
      claude: z.enum(["on", "off"]).optional().describe("Claude (le modèle cher) : off = jamais utilisé, ni en conversation ni en mission (défaut) ; on = disponible en secours et pour les missions critiques, jusqu'à ce que Lionel le recoupe."),
      codeur: z.enum(["deepseek", "claude", "auto"]).optional().describe("Qui écrit le code dans l'atelier et les missions : deepseek (deepseek-v4-pro par son API compatible Anthropic), claude, ou auto (DeepSeek si une clé existe, sinon Claude)."),
      service: z.string().min(1).max(60).optional().describe("Le service dont on change le modèle (DeepSeek, Mistral, Claude, voix, image, ecoute)."),
      modele: z.string().min(1).max(120).optional().describe("Le nouveau nom de modèle, tel que l'API l'attend."),
    }),
    run: async (i) => {
      const faits: string[] = [];
      if (i.modele) {
        // « deepseek-flash » tout seul : le préfixe dit de quel service il s'agit.
        const service = i.service ?? i.modele.split(/[-_/:]/)[0] ?? "";
        const r = await setProviderModel(service, i.modele);
        if (!r.ok) return `Error: ${r.message}`;
        faits.push(r.message);
      } else if (i.service) {
        return "Error: précise le nouveau nom de modèle (`modele`).";
      }
      if (i.approbations) {
        await setSetting("APPROBATIONS", i.approbations);
        faits.push(
          i.approbations === "off"
            ? "approbations coupées — les actions irréversibles partent sans te demander"
            : "approbations réactivées — une action irréversible te demandera OUI-XXXX",
        );
      }
      if (i.limites) {
        if (i.limites === "off") {
          await setSetting("DAILY_BUDGET_USD", SANS_LIMITE);
          await setSetting("CHAT_RATE_LIMIT", SANS_LIMITE);
          faits.push("limites désactivées : plus de plafond du jour, plus de limite de messages — la seule borne restante est le budget de chaque mission");
        } else {
          await setSetting("DAILY_BUDGET_USD", String(config().DAILY_BUDGET_USD));
          await setSetting("CHAT_RATE_LIMIT", String(config().CHAT_RATE_LIMIT_PER_HOUR));
          faits.push(`limites remises : plafond ${config().DAILY_BUDGET_USD} $ par jour, ${config().CHAT_RATE_LIMIT_PER_HOUR} messages par heure`);
        }
      } else if (i.plafond_jour !== undefined) {
        await setSetting("DAILY_BUDGET_USD", String(i.plafond_jour));
        faits.push(`plafond du jour porté à ${i.plafond_jour} $`);
      }
      if (i.voix) {
        await setSetting("VOIX_MODE", i.voix);
        faits.push(i.voix === "off" ? "je réponds par écrit" : i.voix === "toujours" ? "je réponds aussi en vocal, à chaque fois" : "je réponds en vocal quand tu me parles en vocal");
      }
      if (i.caractere) {
        await setSetting("BOT_CARACTERE", i.caractere);
        faits.push(`caractère : ${i.caractere}`);
      }
      if (i.nom) {
        await setSetting("BOT_NOM", i.nom.replace(/[\u0000-\u001f]/g, "").trim());
        faits.push(`je m'appelle maintenant ${i.nom.trim()}`);
      }
      if (i.memoire) {
        await setSetting("MEMOIRE", i.memoire);
        faits.push(i.memoire === "off" ? "mémoire coupée — je ne retiens plus rien" : "mémoire réactivée");
      }
      if (i.reflexion) {
        await setSetting("REFLEXION", i.reflexion);
        faits.push(`réflexion DeepSeek : ${i.reflexion} (${REFLEXIONS[i.reflexion]})`);
      }
      if (i.claude) {
        await setSetting("CLAUDE", i.claude);
        faits.push(i.claude === "on" ? "Claude activé — il reprend sa place en secours et sur les missions critiques ; dis « désactive Claude » pour le recouper" : "Claude désactivé — DeepSeek et Mistral seulement, plus aucune bascule coûteuse");
      }
      if (i.codeur) {
        await setSetting("CODEUR", i.codeur);
        const c = await codeurChoisi();
        faits.push(`codeur : ${i.codeur} → en pratique ${c.raison}${c.cle ? ` (modèle ${c.modele})` : " — AUCUNE CLÉ, le code ne partira pas"}`);
      }
      if (!faits.length) return "Error: rien à changer — précise au moins un réglage.";
      logger.info({ reglages: faits }, "réglage changé depuis le chat");
      return `${faits.join(", ")}. Effet immédiat.`;
    },
  });
}

function controlTools(notify: Notify) {
  const runMission = betaZodTool({
    name: "run_mission",
    description: `Lance immédiatement une mission (asynchrone). Missions intégrées : ${MISSIONS.map((m) => m.name).join(", ")}, report. Les missions créées par l'opérateur marchent pareil — list_missions les énumère. L'opérateur recevra un message à la fin.

« brief » porte la consigne du jour, et prime sur le mode opératoire de la mission là où les deux se contredisent. Sers-t'en dès que Lionel précise un sujet, une ville, une cible ou un angle : « aujourd'hui on vend à Uppsala, écris l'article là-dessus » → run_mission{name:"seo_daily", brief:"Cible : Uppsala. ..."}. Rédige le brief toi-même, en consigne claire, à partir de ce qu'il a dit ; ne lui demande pas de le reformuler.`,
    inputSchema: z.object({
      name: z.string(),
      brief: z.string().optional().describe("Consigne du jour pour cette exécution. Omets-la si l'opérateur n'a rien précisé."),
    }),
    run: async (i) => {
      if (i.name === "report") {
        void withLock("report", buildAndDeliverReport).then(() => notify("📋 Rapport envoyé.")).catch((e) => notify(`Rapport en échec : ${String(e).slice(0, 200)}`));
        return "rapport lancé";
      }
      const m = await resolveMission(i.name);
      if (!m) return `Error: mission inconnue (${MISSIONS.map((x) => x.name).join(", ")}, + celles de list_missions)`;
      void launch(m, { brief: i.brief })
        .then((r) => notify(r ? `✅ ${m.name} terminée (${r.status}, ${r.usage.usd.toFixed(2)} $).\n${r.text.slice(0, 1200)}` : `${m.name} : déjà en cours ou plafond journalier atteint.`))
        .catch((e) => notify(`❌ ${m.name} en erreur : ${String(e).slice(0, 200)}`));
      return `mission ${m.name} lancée${i.brief ? ` avec consigne : ${i.brief.slice(0, 120)}` : ""} (budget ${m.budgetUsd} $, ~${Math.round(m.maxIterations / 6)} min)`;
    },
  });

  const swarm = betaZodTool({
    name: "run_swarm",
    description: "Lance un essaim de sous-agents parallèles sur un objectif complet (asynchrone, 5-20 min). Donne un objectif précis avec critères de succès.",
    inputSchema: z.object({ objective: z.string().min(10), budget_usd: z.number().positive().max(50).optional() }),
    run: async (i) => {
      void runSwarm(i.objective, { budgetUsd: i.budget_usd })
        .then((r) => notify(`🐝 Essaim terminé en ${Math.round(r.wallSeconds / 60)} min pour ${r.totalUsd.toFixed(2)} $.\n\n${r.merged.slice(0, 2500)}`))
        .catch((e) => notify(`❌ Essaim en erreur : ${String(e).slice(0, 200)}`));
      return "essaim lancé";
    },
  });

  const latestReport = betaZodTool({
    name: "latest_report",
    description: "Dernier rapport du matin (markdown).",
    inputSchema: z.object({}),
    run: async () => {
      const r = await db().query<{ day: string; markdown: string }>(`SELECT day, markdown FROM reports ORDER BY day DESC LIMIT 1`);
      return r.rows[0] ? `${r.rows[0].day}\n${r.rows[0].markdown}` : "aucun rapport";
    },
  });

  const schedule = betaZodTool({
    name: "schedule_mission",
    description:
      "Planifie (ou déplanifie) une mission sur ordre de l'opérateur. C'est le SEUL moyen qu'une mission tourne sans ordre direct ; le planning est visible via list_schedules. cron 5 champs en heure locale (ex: '0 5 * * *' = tous les jours 5h ; '30 7 * * 1-5' = 7h30 en semaine), ou 'off' pour retirer.",
    inputSchema: z.object({ name: z.string(), cron: z.string() }),
    run: async (i) => {
      if (i.name !== "report" && !(await resolveMission(i.name))) return "Error: mission inconnue";
      await setSchedule(i.name, i.cron === "off" ? null : i.cron, "whatsapp");
      return i.cron === "off" ? `${i.name} déplanifiée` : `${i.name} planifiée : ${i.cron}`;
    },
  });

  const schedules = betaZodTool({
    name: "list_schedules",
    description: "Planning en vigueur (missions planifiées sur ordre) et mode d'autonomie.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await listSchedules();
      return `mode: ${config().AUTONOMY_MODE}\n` + (rows.map((r) => `- ${r.mission}: ${r.cron} (ordre du ${r.created_at.slice(0, 10)} via ${r.created_by})`).join("\n") || "- aucun planning : rien ne tourne sans ordre");
    },
  });

  const spend = betaZodTool({
    name: "spend_today",
    description: "Dépense LLM du jour et plafond.",
    inputSchema: z.object({}),
    run: async () => `${(await spentToday()).toFixed(2)} $ / plafond ${plafondTexte(await dailyBudget())}`,
  });

  // Créer une mission depuis WhatsApp plutôt que dans le code : l'opérateur en
  // ajoute autant qu'il veut, elles passent par le même moteur et les mêmes
  // garde-fous que les neuf missions intégrées.
  const createMission = betaZodTool({
    name: "create_mission",
    description:
      "Crée (ou remplace) une mission durable définie par l'opérateur. À utiliser dès qu'il décrit un travail récurrent. L'objectif doit être rédigé comme un cahier des charges : quoi faire, sur quoi, et le critère de succès. Réutiliser un nom existant écrase la mission.",
    inputSchema: z.object({
      name: z.string().regex(NAME_RE, "minuscules, chiffres et _ ; commence par une lettre ; 3 à 40 caractères"),
      objective: z.string().min(40, "décris la mission en détail : étapes et critère de succès"),
      toolset: z
        .enum(TOOLSETS)
        .default("recherche")
        .describe("recherche = web, scraping, navigateur | code = sandbox, fichiers | complet = les deux"),
      model: z.enum(MODELS).default("worker").describe("worker = courant | planner = raisonnement | critical = écrit du code ou déploie"),
      budget_usd: z.number().positive().max(10).default(1),
      max_iterations: z.number().int().min(5).max(120).default(30),
    }),
    run: async (i) => {
      if (MISSIONS.some((m) => m.name === i.name) || i.name === "report") return `Error: « ${i.name} » est une mission intégrée, choisis un autre nom`;
      await saveCustomMission({
        name: i.name,
        objective: i.objective,
        toolset: i.toolset as Toolset,
        model: i.model as ModelKind,
        budgetUsd: i.budget_usd,
        maxIterations: i.max_iterations,
        createdBy: "whatsapp",
      });
      return `mission « ${i.name} » enregistrée (${i.toolset}, ${i.model}, ${i.budget_usd} $). Lance-la avec run_mission, planifie-la avec schedule_mission.`;
    },
  });

  const deleteMission = betaZodTool({
    name: "delete_mission",
    description: "Supprime une mission créée par l'opérateur. Les missions intégrées ne sont pas supprimables.",
    inputSchema: z.object({ name: z.string() }),
    run: async (i) => ((await deleteCustomMission(i.name)) ? `mission « ${i.name} » supprimée` : `aucune mission créée nommée « ${i.name} »`),
  });

  const listMissions = betaZodTool({
    name: "list_missions",
    description: "Liste toutes les missions : les intégrées et celles créées par l'opérateur.",
    inputSchema: z.object({}),
    run: async () => {
      const custom = await listCustomMissions();
      return [
        `intégrées : ${MISSIONS.map((m) => m.name).join(", ")}, report`,
        custom.length
          ? `créées par toi :\n${custom.map((m) => `- ${m.name} (${m.toolset}, ${m.model}, ${m.budget_usd} $) : ${m.objective.slice(0, 120)}`).join("\n")}`
          : "créées par toi : aucune pour l'instant",
      ].join("\n");
    },
  });

  const playbooks = betaZodTool({
    name: "show_playbooks",
    description: "Affiche les playbooks (règles que l'agent s'est données lors des réflexions ordonnées). Rien n'est caché.",
    inputSchema: z.object({}),
    run: async () => memoryDigest(6_000, "/memories/playbooks"),
  });

  // --- Agents persistants -------------------------------------------------
  // Une mission est un savoir-faire ; un agent est quelqu'un qui le porte,
  // avec une identité, un budget et un journal qui survivent au redémarrage.
  const newAgent = betaZodTool({
    name: "create_agent",
    description:
      "Crée (ou met à jour) un AGENT persistant. À utiliser quand Lionel parle d'un rôle durable — « un agent qui surveille mes sites », « un directeur SEO » — plutôt que d'une tâche isolée. L'agent continue d'exister et de travailler quand la conversation est fermée. Réutiliser un identifiant met à jour l'agent et incrémente sa version, sans perdre son historique.",
    inputSchema: z.object({
      id: z.string().describe("identifiant court en minuscules, ex: seo-director"),
      name: z.string(),
      role: z.string().optional(),
      mission: z.string().min(10).describe("sa raison d'être, en une ou deux phrases"),
      instructions: z.string().optional().describe("comment il doit travailler"),
      toolset: z.enum(TOOLSETS).default("recherche"),
      model: z.enum(MODELS).default("worker"),
      autonomy: z.number().int().min(0).max(MAX_AUTONOMY).default(1)
        .describe("0 lecture seule · 1 propositions · 2 actions réversibles · 3 actions externes · 4 large, critique toujours validé"),
      budget_usd: z.number().positive().max(20).default(2),
      daily_usd: z.number().positive().max(50).default(5),
    }),
    run: async (i) => {
      try {
        const a = await createAgent({
          id: i.id, name: i.name, role: i.role, mission: i.mission, instructions: i.instructions,
          toolset: i.toolset as Toolset, modelKind: i.model as ModelKind,
          autonomy: i.autonomy, budgetUsd: i.budget_usd, dailyUsd: i.daily_usd, createdBy: "whatsapp",
        });
        return `agent « ${a.name} » (${a.id}) enregistré, version ${a.version}, autonomie ${a.autonomy}, plafond ${a.daily_usd} $/jour. Donne-lui du travail avec assign_task.`;
      } catch (e) {
        return `Error: ${String(e instanceof Error ? e.message : e)}`;
      }
    },
  });

  const assign = betaZodTool({
    name: "assign_task",
    description:
      "Confie une tâche à un agent. Elle part dans sa file et s'exécute en arrière-plan, même conversation fermée, même après un redémarrage du serveur. `depends_on` construit un enchaînement : une tâche n'est servie que lorsque celles dont elle dépend sont terminées.",
    inputSchema: z.object({
      agent_id: z.string(),
      title: z.string().min(3),
      brief: z.string().optional().describe("le détail de ce qu'il faut faire"),
      mission: z.string().optional().describe("nom d'une mission existante à exécuter, si c'en est une"),
      priority: z.number().int().min(1).max(5).default(3),
      depends_on: z.array(z.number().int()).optional(),
    }),
    run: async (i) => {
      if (!(await getAgent(i.agent_id))) return `Error: agent « ${i.agent_id} » inconnu (list_agents pour voir)`;
      const t = await createTask({ agentId: i.agent_id, title: i.title, brief: i.brief, mission: i.mission, priority: i.priority, dependsOn: i.depends_on });
      return `tâche #${t.id} « ${t.title} » mise en file pour ${i.agent_id}${i.depends_on?.length ? ` (attend ${i.depends_on.join(", ")})` : ""}`;
    },
  });

  const agents = betaZodTool({
    name: "list_agents",
    description: "Liste les agents persistants, leur état et leur dépense des dernières 24 h.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await listAgents();
      if (!rows.length) return "aucun agent pour l'instant — create_agent pour en créer un";
      const parts = await Promise.all(rows.map(async (a) => `- ${a.id} « ${a.name} » : ${a.state}, autonomie ${a.autonomy}, ${(await agentSpend(a.id)).toFixed(2)}/${a.daily_usd} $ sur 24 h`));
      return parts.join("\n");
    },
  });

  const agentStatus = betaZodTool({
    name: "agent_status",
    description: "Ce que fait un agent en ce moment : ses tâches et sa timeline d'activité. Sers-t'en dès que Lionel demande « où il en est ».",
    inputSchema: z.object({ agent_id: z.string(), limit: z.number().int().min(3).max(30).default(10) }),
    run: async (i) => {
      const a = await getAgent(i.agent_id);
      if (!a) return `Error: agent « ${i.agent_id} » inconnu`;
      const tasks = await listTasks(i.agent_id, undefined, 10);
      const tl = await timeline(i.agent_id, i.limit);
      return [
        `${a.name} (${a.id}) — ${a.state}, ${(await agentSpend(a.id)).toFixed(2)} $ sur 24 h`,
        tasks.length ? "tâches :\n" + tasks.map((t) => `  #${t.id} ${t.status} · ${t.title}${t.error ? ` — ${t.error.slice(0, 80)}` : ""}`).join("\n") : "aucune tâche",
        tl.length ? "activité :\n" + tl.map((e) => `  ${String(e.ts).slice(11, 16)} ${e.kind} ${e.message.slice(0, 70)}`).join("\n") : "",
      ].filter(Boolean).join("\n");
    },
  });

  const dropAgent = betaZodTool({
    name: "delete_agent",
    description: "Supprime un agent et tout son historique de tâches. Irréversible ; demande confirmation à Lionel avant.",
    inputSchema: z.object({ agent_id: z.string() }),
    run: async (i) => ((await deleteAgent(i.agent_id)) ? `agent ${i.agent_id} supprimé` : `aucun agent nommé ${i.agent_id}`),
  });

  return [runMission, swarm, latestReport, schedule, schedules, spend, playbooks, createMission, deleteMission, listMissions,
          newAgent, assign, agents, agentStatus, dropAgent];
}

/* ------------------------------------------------------------------------ */

const queues = new Map<string, Promise<unknown>>();
const seen = new Set<string>();

export async function handleChat(opts: { channel: "whatsapp" | "api"; peer: string; text: string; extId?: string; notify?: Notify }): Promise<string> {
  if (opts.extId) {
    if (seen.has(opts.extId)) return "";
    seen.add(opts.extId);
    if (seen.size > 5000) seen.delete(seen.values().next().value!);
    const dup = await db().query(`SELECT 1 FROM chat_messages WHERE ext_id=$1`, [opts.extId]);
    if (dup.rowCount) return "";
  }
  const prev = queues.get(opts.peer) ?? Promise.resolve();
  // Chaque message est un travail de la boîte noire : ce qui a été reçu, tout
  // ce qu'il a fait pour répondre, et ce qu'il a répondu, d'un seul tenant.
  const next = prev.then(() =>
    dansTrace("conversation", opts.text.trim().slice(0, 120) || "(message vide)", async () => {
      enregistrer({ type: "entree", titre: `Message reçu (${opts.channel})`, detail: opts.text.slice(0, 2000) });
      const r = await respond(opts);
      enregistrer({ type: "reponse", titre: r ? "Réponse envoyée" : "Aucune réponse", detail: r.slice(0, 2000), ok: Boolean(r), niveau: r ? "info" : "warn" });
      return r;
    }),
  ).catch((e) => {
    logger.error({ err: String(e) }, "chat");
    return "Je bute sur une erreur interne, réessaie dans une minute.";
  });
  queues.set(opts.peer, next);
  return next;
}

async function respond(opts: { channel: "whatsapp" | "api"; peer: string; text: string; extId?: string; notify?: Notify }): Promise<string> {
  const text = opts.text.trim();
  if (!text) return "";
  // Réponse à une demande d'approbation (OUI-XXXX / NON-XXXX) : pas de LLM.
  const approval = await handleApprovalReply(text);
  if (approval) return approval;
  // « bien » / « nul » (+ commentaire) : retour capturé pour la réflexion, sans LLM.
  const fb = await captureFeedback(opts.peer, text);
  if (fb) {
    await db().query(`INSERT INTO chat_messages(channel, peer, role, content) VALUES ($1,$2,'assistant',$3)`, [opts.channel, opts.peer, fb]);
    return fb;
  }
  // Limite de débit par numéro : un téléphone volé ou un webhook rejoué ne vide pas le budget.
  const recent = await db().query<{ n: string }>(`SELECT count(*) AS n FROM chat_messages WHERE peer=$1 AND role='user' AND ts > now() - interval '1 hour'`, [opts.peer]);
  if (Number(recent.rows[0]?.n ?? 0) >= (await limiteMessagesHeure())) return "Trop de messages cette heure-ci ; je reprends dans un moment.";
  const plafondJour = await dailyBudget();
  if ((await spentToday()) >= plafondJour) return `Plafond journalier atteint (${plafondTexte(plafondJour)}). Je ne lance plus rien aujourd'hui ; écris « monte le plafond à 20 » ou « désactive les limites ».`;
  await db().query(`INSERT INTO chat_messages(channel, peer, role, content, ext_id) VALUES ($1,$2,'user',$3,$4)`, [opts.channel, opts.peer, text, opts.extId ?? null]);

  const hist = await db().query<{ role: string; content: string; ts: string }>(
    `SELECT role, content, ts FROM chat_messages WHERE peer=$1 ORDER BY ts DESC LIMIT 30`,
    [opts.peer],
  );
  const history = hist.rows.reverse().slice(0, -1);
  const notify: Notify = opts.notify ?? (opts.channel === "whatsapp" ? async (t) => void (await sendWhatsApp(opts.peer, t)) : async () => undefined);

  // Mémoire coupée (interrupteur du panneau, comme « personnaliser avec
  // l'historique » chez Grok) : il ne s'appuie plus sur son profil et
  // n'enregistre plus de faits. La conversation courante reste lisible.
  const memoire = await memoireActive();
  const task = [
    `Date: ${new Date().toISOString()} — heure locale de Lionel : ${new Date().toLocaleString("fr-FR", { timeZone: config().TZ, dateStyle: "full", timeStyle: "short" })} (${config().TZ})`,
    memoire ? `<profil>\n${await memoryDigest(2_000, "/memories/profil")}\n</profil>` : "",
    history.length ? `<historique>\n${history.map((h) => `${h.role === "user" ? "opérateur" : "toi"}: ${h.content}`).join("\n")}\n</historique>` : "",
    `Message de l'opérateur :\n${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Routeur : Mistral d'abord (français, courant), DeepSeek s'il échoue,
  // Claude en dernier recours. `runRouted` ne monte d'un cran que sur un
  // échec constaté, jamais sur une impression de qualité.
  const res = await runRouted("chat", {
    // La personnalité se relit à chaque message : un réglage changé au
    // panneau se voit à la réponse suivante, sans redémarrage.
    system: [await composerPrompt(CHAT_SYSTEM), await blocCompetences()].filter(Boolean).join("\n\n"),
    task,
    // Le navigateur était réservé aux missions : demander « ouvre Gmail » dans
    // la conversation obtenait « je n'ai pas accès à ton navigateur », ce qui
    // était vrai de la conversation et faux du système. Il est ici aussi.
    tools: [memoryTool, ...(memoire ? [rememberFact] : []), recallFacts, oublierTool, taskTool, episodesTool, feedbackTool, ...controlTools(notify), screenshotTool(opts.channel, opts.peer), enregistrerIdentifiantTool(opts.peer), loginRequestTool(opts.peer), panelLinkTool(opts.peer), settingsTool(), fichiersRecusTool, ...outilsRappels(opts.peer), ...outilsCompetences, ...outilsDeclencheurs, outilImage(opts.channel, opts.peer), outilRetouche(opts.channel, opts.peer), outilDiagnostic, outilRecherche(notify), dernieresRecherchesTool, outilDev(notify, launch), lireCodeSiteTool, ...(await searchToolsAsync()), scrapePageTool, browserTool, vaultListTool, ...marketTools, ...googleTools()],
    effort: "low",
    // Un appel navigateur = une action : ouvrir une page, lire, cliquer, relire.
    // Huit tours suffisaient à une conversation, pas à une navigation.
    // Une vraie session de navigation, c'est vingt à trente actions : ouvrir,
    // lire, cliquer, remplir, vérifier, recommencer autrement. Vingt tours
    // coupaient l'agent au milieu d'une tâche, et il rendait un « je n'ai pas
    // trouvé » qui voulait dire « je n'ai pas eu le temps ».
    maxIterations: 40,
    budgetUsd: 0.5,
  });
  const reply = res.finalText || (res.stopReason === "refusal" ? "Je ne peux pas faire ça." : "Fait.");
  await db().query(`INSERT INTO chat_messages(channel, peer, role, content) VALUES ($1,$2,'assistant',$3)`, [opts.channel, opts.peer, reply]);
  await db().query(`INSERT INTO spend(day, usd) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET usd = spend.usd + EXCLUDED.usd`, [res.usage.usd]);
  return reply;
}
