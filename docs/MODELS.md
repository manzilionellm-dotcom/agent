# Choix des modèles — ce qui est vrai, ce qui ne l'est pas

## Corrections de prémisses (avant tout)

1. **« 90 % de Grok » n'est pas une cible mesurable.** Aucun benchmark public ne définit « l'intelligence de Grok » comme une échelle. Ce qui se mesure sur TES missions : taux de succès, coût par mission réussie, tours en erreur. La mission `reflect` produit ces chiffres chaque nuit (`/memories/playbooks/_metrics.md`). C'est ça, ta jauge.
2. **Kimi K2 / DeepSeek V3 / Qwen 3 en local sur un VPS : impossible.** Ce sont des modèles à centaines de milliards de paramètres (MoE) ; il faut des centaines de Go de VRAM. En pratique on les consomme via leurs API hébergées (DeepSeek, Moonshot, DashScope, OpenRouter). C'est branché : `LLM_PROVIDER=openai_compat`.
3. **Tavily/SerpAPI n'indexent pas X.** Pour X, seule l'API officielle v2 lit les posts de façon fiable (`x_search`). Tavily/SerpAPI couvrent le web ; ils sont bien « le chaînon manquant » quand on quitte Claude, parce qu'on perd alors les outils serveur `web_search`/`web_fetch`.
4. **LangGraph n'ajoute pas d'intelligence.** C'est une bibliothèque de graphes d'état. L'intelligence vient du modèle, du cahier des charges et de la mémoire. Voir `ARCHITECTURE.md` §7 pour pourquoi l'orchestrateur reste sans framework.

## Recommandation (nommée, justifiée, avec ses risques)

**Défaut : Claude Opus 5 (planificateur, codeur, fusion) + Claude Sonnet 5 (workers).**

Pourquoi : c'est la combinaison qui a, au moment où j'écris, la meilleure fiabilité sur les longues séquences d'appels d'outils (INFÉRENCE à partir des usages agentiques observés et des choix d'outils de ce type — confiance élevée pour le code et l'exécution longue, moyenne pour la rédaction où l'écart est faible). Elle apporte en plus des capacités que l'adaptateur OpenAI-compatible n'a pas : outils serveur web avec citations, compaction serveur, fallback sur refus, cache 1 h, thinking adaptatif avec réglage d'effort, sorties structurées garanties par schéma.

Risques : prix (5 $/25 $ par M tokens sur Opus 5), dépendance à un fournisseur, refus possibles sur certains sujets (routés par le fallback).

**Quand basculer sur DeepSeek / Kimi / Qwen** : missions de volume à faible enjeu (veille, résumés, extraction) où un coût 5 à 10 fois inférieur compte plus qu'une fiabilité de quelques points ; contraintes de souveraineté ; ou comme second avis. Garde Claude pour le code et la fusion : un déploiement cassé coûte plus qu'une nuit de tokens.

## Routage par type de travail (mode éco)

`resolveModel(kind)` dans `agent/src/llm.ts` : `planner`, `worker`, `chat` → `LLM_PROVIDER`/`MODEL_*` ; `critical` (missions `seo_daily`, `iptv_comparator`, `repo_maintenance`, rôles `coder`/`publisher`/`deployer`) → `LLM_PROVIDER_CRITICAL`/`MODEL_CRITICAL`. Le `.env.example` livre DeepSeek pour le premier groupe et Claude Sonnet 5 pour le second : c'est le compromis coût/fiabilité recommandé (le déploiement cassé coûte plus cher que les tokens économisés).

## Brancher un autre fournisseur

```env
LLM_PROVIDER=openai_compat
OPENAI_COMPAT_BASE_URL=https://api.deepseek.com/v1        # ou https://api.moonshot.ai/v1, https://openrouter.ai/api/v1, DashScope compat, vLLM local
OPENAI_COMPAT_API_KEY=sk-...
MODEL_PLANNER=deepseek-reasoner                            # kimi-k2-…, qwen3-…
MODEL_WORKER=deepseek-chat
MODEL_CODER=claude-opus-5                                  # le sous-agent codeur (Claude Code) reste sur Claude
MODEL_PRICES=deepseek-reasoner=0.55/2.19,deepseek-chat=0.27/1.10
TAVILY_API_KEY=tvly-...                                    # obligatoire : remplace web_search/web_fetch
```

Ce que l'adaptateur (`agent/src/llm/openaiCompat.ts`) fait : boucle d'appels d'outils avec exécution parallèle, conversion des schémas (y compris l'outil mémoire), troncature des vieux résultats d'outils (compaction locale), budget, sortie JSON pour le rapport et le plan d'essaim. Ce qu'il ne fait pas : outils serveur Anthropic, fallback sur refus, cache explicite, `pause_turn`.

Le sous-agent codeur (`delegate_coding_task`) est Claude Code : il exige `ANTHROPIC_API_KEY` quel que soit le fournisseur principal. Sans clé Anthropic, l'agent code avec `sandbox_bash`/`sandbox_write_file` (moins bon, mais fonctionnel).

## Mesurer avant de croire

Protocole en une semaine, coût < 30 $ :

1. Lance `veille` et `seo_daily` 3 jours sur Claude, 3 jours sur l'alternative (même cahier des charges).
2. Compare dans `episodes` : statut, tours, coût, et lis les articles produits.
3. Décide par mission, pas globalement. Le fichier `.env` accepte des modèles différents par rôle.

## Prix (USD / 1M tokens, à revalider trimestriellement)

| Modèle | Entrée | Sortie | Notes |
|---|---|---|---|
| claude-opus-5 | 5 | 25 | cache lecture 0,5 |
| claude-sonnet-5 | 2 | 10 | cache lecture 0,2 |
| claude-haiku-4-5 | 1 | 5 | contexte 200 k |
| deepseek-chat / reasoner | ~0,27 / ~0,55 | ~1,1 / ~2,2 | cache implicite ; vérifier la grille du jour |
| kimi-k2 (Moonshot) | ~0,6 | ~2,5 | vérifier |
| qwen3 (DashScope) | variable selon taille | | vérifier |

Les prix non-Anthropic sont donnés à titre indicatif (UNVERIFIED au jour de lecture) : renseigne `MODEL_PRICES` avec la grille courante, sinon le compteur de budget est faux.
