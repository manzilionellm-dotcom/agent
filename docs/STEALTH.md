# Navigateur — furtivité (stealth) & Chrome réel

Manzi Junior pilote un navigateur pour la recherche et le soft-sell légitime.
Objectif : **moins ressembler à un bot**, pas contourner banques / captchas / paiements.

`BROWSER_DENY_DOMAINS` reste en vigueur. Pas de fermes de captcha, pas de credential stuffing.

## Ordre de préférence (meilleur → acceptable)

| Rang | Mode | Comment | Détection |
|---|---|---|---|
| **1** | **Chrome réel via CDP** | `BROWSER_CDP_URL` + tunnel SSH (voir `docs/ECO.md` §5) | Meilleur : vrai Chrome, vrai profil, vraies sessions |
| **2** | Chromium sandbox + stealth | `BROWSER_STEALTH=true` (défaut) | Correct pour sites soft ; **jamais 100 %** |
| — | Chromium nu | `BROWSER_STEALTH=false` | Fortement détectable |

**Jamais 100 % indétectable** face à Cloudflare Turnstile, Google advanced bot protection, ou fingerprint réseau (datacenter IP). Pour les sites durs : tunnel Chrome.

## Variables d'environnement

```env
# Préféré : ton Chrome (tunnel). Vide = Chromium sandbox.
BROWSER_CDP_URL=http://host.docker.internal:9222

# Stealth sandbox (défaut true). Ignoré en mode CDP.
BROWSER_STEALTH=true

# Locale / fuseau (Lionel · Europe/Stockholm)
BROWSER_LOCALE=sv-SE          # ou fr-FR, fr-CA, en-CA…
BROWSER_TIMEZONE=Europe/Stockholm

# Optionnel
# BROWSER_VIEWPORT_SEED=desk1
# BROWSER_HW_CONCURRENCY=8
# BROWSER_DEVICE_MEMORY=8
# BROWSER_UA_PLATFORM=linux     # linux | mac | win

BROWSER_DENY_DOMAINS=paypal.com,stripe.com
```

## Ce que fait le stealth sandbox

Implémenté dans `docker/browser/stealth.js` + `daemon.js` (patches manuels, équivalent
d’un sous-ensemble de `puppeteer-extra-plugin-stealth`, sans dépendance npm extra) :

- `--disable-blink-features=AutomationControlled`
- ignore Playwright `--enable-automation`
- `navigator.webdriver` → `undefined`
- `window.chrome.runtime` présent
- UA aligné sur Chromium Playwright (Chrome 140 / `playwright@1.55`)
- `languages`, `platform`, `hardwareConcurrency`, `deviceMemory`
- spoof WebGL vendor/renderer **léger**
- patch `permissions.query` (notifications)
- viewport desktop courant (1280×800 ou autre au hasard / seed)
- `locale` + `timezoneId` Playwright
- délais `settle_ms` légèrement randomisés ; frappe clavier à délai variable

## Redémarrage du démon

```bash
docker compose exec sandbox bash -lc 'pkill -f "/opt/browser/daemon.js" || true'
```

Ou rebuild sandbox : `docker compose up -d --build sandbox`

## Limites assumées

- IP VPS / datacenter ≠ résidentiel.
- Headless Chromium laisse d’autres signaux (CDP, canvas, TLS JA3…).
- Turnstile / reCAPTCHA v3 avancés : utilise le tunnel Chrome, ou abandonne la page.
- Ne contourne **pas** les domaines de `BROWSER_DENY_DOMAINS`.

## Vérification rapide

```bash
docker compose exec sandbox node /opt/browser/bctl.js status
docker compose exec sandbox node /opt/browser/bctl.js eval \
  '{"js":"({webdriver:navigator.webdriver,langs:navigator.languages,ua:navigator.userAgent.slice(0,80),chrome:!!window.chrome})"}'
```

Voir aussi `docs/ECO.md` §5 (tunnel Chrome) et `docs/HOSTING.md`.
