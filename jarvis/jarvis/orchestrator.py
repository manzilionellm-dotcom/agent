"""Client HTTP vers Manzi Junior (l'orchestrateur sur le VPS).

Jarvis ne fait pas le gros travail lui-même : il parle, comprend, et DÉLÈGUE
les missions longues (essaim, audit, article SEO) à l'orchestrateur, puis rend
compte. C'est ce qui permet une conversation fluide : aucun appel de 10 minutes
ne bloque la voix.
"""

from __future__ import annotations

import httpx

from .config import Config


class Orchestrator:
    def __init__(self, cfg: Config):
        self.enabled = bool(cfg.orchestrator_url and cfg.orchestrator_token)
        self._c = httpx.AsyncClient(
            base_url=cfg.orchestrator_url or "http://127.0.0.1:8787",
            headers={"Authorization": f"Bearer {cfg.orchestrator_token or ''}"},
            timeout=30,
        )

    async def health(self) -> dict:
        r = await self._c.get("/healthz")
        r.raise_for_status()
        return r.json()

    async def missions(self) -> list[dict]:
        r = await self._c.get("/missions")
        r.raise_for_status()
        return r.json()

    async def run_mission(self, name: str) -> dict:
        r = await self._c.post(f"/missions/{name}")
        r.raise_for_status()
        return r.json()

    async def run_swarm(self, objective: str, budget_usd: float | None = None) -> dict:
        r = await self._c.post("/swarm", json={"objective": objective, **({"budgetUsd": budget_usd} if budget_usd else {})})
        r.raise_for_status()
        return r.json()

    async def swarm_status(self, swarm_id: str) -> dict:
        r = await self._c.get(f"/swarm/{swarm_id}")
        r.raise_for_status()
        return r.json()

    async def latest_report(self) -> dict | None:
        r = await self._c.get("/reports/latest")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def close(self) -> None:
        await self._c.aclose()
