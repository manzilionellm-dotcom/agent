# Merge stealth + IPTV → claude branch

Branch: `merge/stealth-iptv-claude-v3`
Base: `claude/grok-bot-autonomous-agent-3mjee3`

## Inclus
- stealth.js + docs STEALTH.md + Dockerfile.sandbox note
- stealth-preload.js + bctl.js (-r preload) — branche le stealth SANS remplacer le daemon Claude
- config BROWSER_STEALTH / LOCALE / TIMEZONE + browserEnv
- seeds IPTV + prompts Flotte IPTV / Toronto WA +1 807
- .env.example BROWSER_STEALTH=true

## Migrate seed
Si `migrate.ts` n'appelle pas encore `seedOperatorMemory`, après deploy:
```
cd ~/manzi-junior/agent && npx tsx -e "import { seedOperatorMemory } from './src/memory/seeds.ts'; console.log(await seedOperatorMemory())"
```
