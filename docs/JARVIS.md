# Jarvis — la voix de Manzi Junior

Whisper en entrée, Kokoro (voix féminine française) en sortie, Claude + MCP au milieu, mémoire SQLite locale, et Manzi Junior (VPS) pour tout ce qui prend plus de dix secondes.

## Installation en une commande

Sur la machine qui a le micro (macOS ou Linux ; Python 3.10–3.12, Kokoro n'accepte pas 3.13) :

```bash
bash jarvis/install.sh          # ou : ./install.sh --jarvis depuis la racine
```

Installe espeak-ng et PortAudio (Homebrew/apt), `uv`, l'environnement Python, télécharge les modèles (Whisper small 500 Mo, Kokoro 330 Mo, Silero 2 Mo), crée `jarvis/.env` et `jarvis/mcp.json`. Puis :

```bash
cd jarvis && .venv/bin/jarvis            # vocal
cd jarvis && .venv/bin/jarvis --text     # clavier (test sans micro)
cd jarvis && .venv/bin/jarvis --devices  # choisir micro/haut-parleur
```

Connexion au VPS : `ssh -N -L 8787:127.0.0.1:8787 manzi@vps` dans un terminal, `ORCHESTRATOR_URL=http://127.0.0.1:8787` et le `ORCHESTRATOR_TOKEN` du `.env` du VPS dans `jarvis/.env`.

Docker (**Linux seulement**, le micro n'est pas accessible depuis Docker sur macOS/Windows) :

```bash
docker build -t jarvis -f jarvis/Dockerfile jarvis
docker run --rm -it --device /dev/snd --group-add audio -v ~/.jarvis:/root/.jarvis --env-file jarvis/.env --network host jarvis
```

## Comment ça marche

```
micro 16 kHz ─► Silero VAD (fin de phrase = 0,8 s de silence)
             ─► faster-whisper small int8 (fr) ─► texte
             ─► mode d'éveil : « Jarvis » ouvre une fenêtre de 45 s (suite sans le nom)
             ─► Brain : Claude Opus 5 tool runner
                    outils : remember_fact / recall_facts (SQLite FTS5)
                             manzi_* (statut, missions, essaim, rapport)      ─► API VPS
                             MCP github / vercel / gmail / gcal (mcp-remote)
             ─► réponse orale courte ─► Kokoro ff_siwis, phrase par phrase ─► haut-parleur
             ◄─ barge-in : si tu parles pendant qu'elle parle, elle se tait
```

Latence CPU (phrase de 5 s) ≈ 3 s entre ta fin de phrase et sa première syllabe ; GPU ≈ 1,5 s. Les tâches longues sont déléguées : « lance l'audit du site » → « c'est lancé » en 2 s, le travail se fait sur le VPS.

## Voix

Kokoro-82M, `lang_code="f"`, voix `ff_siwis` : voix féminine française naturelle, la meilleure disponible en local et gratuite à ce jour (licence Apache 2.0). Vitesse par défaut 1,05. Autres voix féminines (anglais) : `af_heart`, `af_bella`, `af_nicole` avec `JARVIS_KOKORO_LANG=a`.

Le texte est nettoyé avant lecture (pas de markdown, pas d'URL, pas de code) et le prompt impose un style oral : 1 à 4 phrases, tutoiement sauf préférence contraire mémorisée.

## Exécuter sans demander

Par défaut, aucun outil n'exige de confirmation (`JARVIS_CONFIRM_TOOLS=` vide) : elle fait, puis confirme en une phrase. Si tu veux un « oui » vocal pour certains outils irréversibles : `JARVIS_CONFIRM_TOOLS=gmail__send_email,gcal__delete-event`.

Risque à connaître (une ligne) : sans confirmation, une phrase mal transcrite peut envoyer un e-mail. La mémoire du profil et la fenêtre de conversation limitent les faux départs ; garde `send_email` en confirmation les deux premières semaines, puis décide.

## Modes d'éveil

- `conversation` (défaut) : dire « Jarvis » ouvre 45 s d'écoute active, renouvelés à chaque échange. Naturel, économique.
- `wake` : le nom à chaque requête.
- `always` : tout ce qui est dit est traité. Réserve-le à une pièce calme ; chaque phrase coûte un appel.

« Stop », « tais-toi », « pause » : elle se tait et ferme la fenêtre.

## Mémoire (SQLite, `~/.jarvis/memory.sqlite`)

- `turns` : tout l'historique, avec session. Les 36 dernières heures sont résumées dans le prompt (continuité d'un jour à l'autre).
- `facts` (FTS5) : ce qu'elle retient via `remember_fact`. Les faits `profil:*` (préférences) sont injectés dans chaque prompt : c'est ainsi qu'elle s'adapte à toi.
- `kv` : état divers.

Pourquoi SQLite ici et Postgres sur le VPS : Jarvis doit marcher hors ligne et sans service ; la mémoire métier (missions, veille, playbooks) reste dans Postgres et se consulte via l'API.

## MCP (`jarvis/mcp.json`)

Tous les serveurs sont lancés en stdio ; les serveurs distants (GitHub, Vercel) passent par `mcp-remote` avec l'en-tête Bearer. Gmail/Agenda utilisent les mêmes identifiants OAuth Google que le VPS (`~/.jarvis/gcp-oauth.keys.json`). `allow` limite les outils exposés ; garde la liste courte, c'est meilleur pour la latence et la précision.

## Dépannage

- Pas de son / micro muet : `jarvis --devices`, puis `JARVIS_INPUT_DEVICE=<index>`.
- Elle se déclenche sur la télé : monte `JARVIS_VAD_THRESHOLD=0.7`, mode `wake`.
- Transcription médiocre : `JARVIS_WHISPER_MODEL=medium` (CPU) ou `large-v3` + `JARVIS_WHISPER_DEVICE=cuda`.
- Kokoro muet en français : `espeak-ng` manquant (`brew install espeak-ng` / `apt install espeak-ng`).
- `ORCHESTRATOR_URL` injoignable : le tunnel SSH n'est pas ouvert ; les outils `manzi_*` sont alors absents et elle le dit.
