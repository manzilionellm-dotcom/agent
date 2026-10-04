# AIO — source unique : aio.config.json

Les faits viennent du README, de `docs/` et de `package.json`. Une valeur inconnue reste `null` (voir `aio.todo.md`). Rien n’est inventé : pas de prix de vente, pas de débit, pas de résolution.

- `npm run aio:llms` régénère `public/llms.txt`
- `npm run build && npm start`, puis `node scripts/aio-check.mjs http://127.0.0.1:3000/`
- Les h3 de questions et le paragraphe qui suit sont du HTML rendu côté serveur (page d’accueil), sans accordéon
- FAQPage est dans le HTML de `/`. HowTo est dans le HTML de `/installation` seulement, parce que le tutoriel y est visible
- Product n’est pas émis : `plans` et `currency` sont null (aucun abonnement vendu)
