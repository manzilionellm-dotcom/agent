"""Le cerveau : Claude (tool runner async) + outils MCP + mémoire SQLite + orchestrateur.

Contrat de conversation :
  - réponses courtes et orales (pas de markdown, pas de listes à puces lues à voix haute) ;
  - exécute sans demander (demande explicite de l'opérateur), sauf les outils listés
    dans JARVIS_CONFIRM_TOOLS qui déclenchent une confirmation vocale ;
  - les tâches longues partent vers Manzi Junior (VPS) et Jarvis répond tout de suite.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic, beta_async_tool
from anthropic.lib.tools.mcp import async_mcp_tool
from mcp.client.client import Client as McpClient
from mcp.client.stdio import StdioServerParameters

from .config import Config
from .memory import Memory
from .orchestrator import Orchestrator

SYSTEM = """Tu es {name}, l'assistante vocale de l'opérateur. Tu es la voix de Manzi Junior, l'agent autonome qui travaille pour lui 24h/24 sur un VPS.

Style : oral, naturel, chaleureux et direct. Phrases courtes. Pas de markdown, pas de listes, pas d'URL lues à voix haute (dis « je t'ai mis le lien dans le rapport »). Une réponse tient en 1 à 4 phrases sauf si on te demande un détail. Tutoie l'opérateur sauf s'il préfère le vouvoiement (voir profil).

Comportement :
- Tu EXÉCUTES. Quand l'opérateur demande quelque chose, tu le fais avec les outils puis tu confirmes en une phrase. Tu ne demandes pas de permission, tu ne récapitules pas ce que tu vas faire avant de le faire.
- Les tâches longues (article, audit, essaim, mission) : lance-les via l'orchestrateur et réponds tout de suite « c'est lancé, je te tiens au courant ». Ne bloque jamais la conversation.
- Mémoire : note dans remember_fact ce qui servira demain (préférences → topic 'profil:...', décisions, faits). Consulte recall_facts avant de dire « je ne sais pas ».
- Si tu n'es pas sûre d'un fait, dis-le en une demi-phrase. N'invente jamais un chiffre.
- Si l'opérateur dit « stop », « tais-toi », « pause » : réponds « ok » et rien d'autre.

Profil de l'opérateur :
{profile}

Derniers échanges (continuité) :
{digest}
"""


class Brain:
    def __init__(self, cfg: Config, memory: Memory, speak_confirm: Callable[[str], Awaitable[bool]] | None = None):
        self.cfg = cfg
        self.memory = memory
        self.session = time.strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:6]
        self.orch = Orchestrator(cfg)
        self._client = AsyncAnthropic(api_key=cfg.anthropic_api_key, max_retries=3, timeout=120)
        self._stack = AsyncExitStack()
        self._tools: list[Any] = []
        self._confirm = speak_confirm
        self.history: list[dict] = []

    # --- démarrage ------------------------------------------------------------------
    async def start(self) -> None:
        self._tools = [*self._memory_tools(), *self._orchestrator_tools()]
        self._tools += await self._mcp_tools()
        # Historique de la veille pour la continuité.
        for t in self.memory.recent_turns(self.session, 0):
            self.history.append({"role": t["role"], "content": t["content"]})

    async def close(self) -> None:
        await self._stack.aclose()
        await self.orch.close()

    # --- outils locaux -----------------------------------------------------------------
    def _memory_tools(self) -> list[Any]:
        mem = self.memory

        @beta_async_tool
        async def remember_fact(topic: str, fact: str, source: str | None = None, confidence: float = 0.8, ttl_days: int | None = None) -> str:
            """Mémorise un fait durable. Utilise topic 'profil:<sujet>' pour les préférences de l'opérateur.

            Args:
                topic: Sujet court, ex: 'profil:voix', 'client:acme', 'decision:seo'.
                fact: Une phrase factuelle.
                source: Origine (URL, 'oral', 'rapport du 12/09').
                confidence: 0 à 1.
                ttl_days: Expiration en jours si le fait est volatil.
            """
            mem.remember(topic, fact, source, confidence, ttl_days)
            return "mémorisé"

        @beta_async_tool
        async def recall_facts(query: str, limit: int = 8) -> str:
            """Cherche dans la mémoire long terme (mots-clés).

            Args:
                query: Mots-clés.
                limit: Nombre max de résultats.
            """
            rows = mem.recall(query, limit)
            if not rows:
                return "rien en mémoire"
            return "\n".join(f"- [{r['topic']}] {r['fact']}" + (f" ({r['source']})" if r["source"] else "") for r in rows)

        return [remember_fact, recall_facts]

    def _orchestrator_tools(self) -> list[Any]:
        orch = self.orch
        if not orch.enabled:
            return []

        @beta_async_tool
        async def manzi_status() -> str:
            """État de Manzi Junior : dépense du jour, serveurs MCP connectés, prochaines missions planifiées."""
            h = await orch.health()
            jobs = ", ".join(f"{j['pattern']}→{str(j.get('next'))[:16]}" for j in h.get("jobs", []))
            return f"dépense aujourd'hui {h.get('spentTodayUsd', 0):.2f} USD ; MCP: {', '.join(h.get('mcp', {}).keys()) or 'aucun'} ; crons: {jobs}"

        @beta_async_tool
        async def manzi_run_mission(name: str) -> str:
            """Lance immédiatement une mission planifiée de Manzi Junior (veille, seo_daily, iptv_comparator, competitor_watch, site_audit, inbox_calendar, repo_maintenance).

            Args:
                name: Nom exact de la mission.
            """
            r = await orch.run_mission(name)
            return f"mission {r.get('started', name)} lancée"

        @beta_async_tool
        async def manzi_swarm(objective: str, budget_usd: float | None = None) -> str:
            """Lance un essaim de sous-agents parallèles sur un objectif complet (recherche, code, publication, déploiement, audit).

            Args:
                objective: Objectif complet, précis, avec critères de succès.
                budget_usd: Plafond de dépense optionnel.
            """
            r = await orch.run_swarm(objective, budget_usd)
            return f"essaim {r.get('id')} lancé"

        @beta_async_tool
        async def manzi_swarm_status(swarm_id: str) -> str:
            """Où en est un essaim lancé (running/done/failed) et son livrable s'il est terminé.

            Args:
                swarm_id: Identifiant retourné par manzi_swarm.
            """
            s = await orch.swarm_status(swarm_id)
            if s.get("status") == "done":
                res = s.get("result", {})
                return f"terminé en {int(res.get('wallSeconds', 0))} s pour {res.get('totalUsd', 0):.2f} USD.\n{res.get('merged', '')[:4000]}"
            return f"{s.get('status')} — {s.get('error') or 'en cours'}"

        @beta_async_tool
        async def manzi_latest_report() -> str:
            """Le dernier rapport du matin de Manzi Junior (markdown), à résumer à voix haute."""
            r = await orch.latest_report()
            return r["markdown"][:6000] if r else "aucun rapport disponible"

        return [manzi_status, manzi_run_mission, manzi_swarm, manzi_swarm_status, manzi_latest_report]

    async def _mcp_tools(self) -> list[Any]:
        """Connecte les serveurs MCP de mcp.json (stdio ; les serveurs HTTP passent par mcp-remote)."""
        path: Path = self.cfg.mcp_config
        if not path.exists():
            return []
        spec = json.loads(path.read_text())
        tools: list[Any] = []
        for name, s in spec.get("servers", {}).items():
            if not s.get("enabled", True):
                continue
            try:
                env = {k: _expand(v) for k, v in (s.get("env") or {}).items()}
                params = StdioServerParameters(command=s["command"], args=[_expand(a) for a in s.get("args", [])], env={**_safe_env(), **env})
                client = await self._stack.enter_async_context(McpClient(params))
                listed = await client.list_tools()
                allow = set(s.get("allow") or [])
                for t in listed.tools:
                    if allow and t.name not in allow:
                        continue
                    tool = async_mcp_tool(t, client)  # type: ignore[arg-type]
                    tool.name = f"{name}__{t.name}"  # type: ignore[attr-defined]
                    tools.append(self._gate(tool, f"{name}__{t.name}"))
            except Exception as e:  # noqa: BLE001
                print(f"[mcp] {name}: connexion échouée ({e}) — serveur ignoré")
        return tools

    def _gate(self, tool: Any, name: str) -> Any:
        """Confirmation vocale pour les outils listés dans JARVIS_CONFIRM_TOOLS."""
        if name not in self.cfg.confirm_tools or self._confirm is None:
            return tool
        original = tool.call

        async def guarded(args: dict) -> Any:  # noqa: ANN401
            ok = await self._confirm(f"Je confirme {name.replace('__', ' ')} ?")
            if not ok:
                return "annulé par l'opérateur"
            return await original(args)

        tool.call = guarded
        return tool

    # --- conversation -------------------------------------------------------------------
    async def respond(self, user_text: str) -> str:
        self.memory.add_turn(self.session, "user", user_text)
        self.history.append({"role": "user", "content": user_text})
        self._trim()

        system = SYSTEM.format(name=self.cfg.name, profile=self.memory.profile(), digest=self.memory.yesterday_digest())
        runner = self._client.beta.messages.tool_runner(
            model=self.cfg.model,
            max_tokens=2048,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=list(self.history),
            tools=self._tools,
            max_iterations=12,
            output_config={"effort": self.cfg.effort},
            fallbacks="default",
            betas=["server-side-fallback-2026-07-01"],
        )
        final_text = ""
        async for message in runner:
            if message.stop_reason == "refusal":
                final_text = "Je ne peux pas faire ça."
                break
            text = " ".join(b.text for b in message.content if getattr(b, "type", "") == "text").strip()
            if text:
                final_text = text
        if not final_text:
            final_text = "C'est fait."
        self.history.append({"role": "assistant", "content": final_text})
        self.memory.add_turn(self.session, "assistant", final_text)
        return final_text

    def _trim(self) -> None:
        # On ne garde que les N derniers tours texte : les outils ne sont pas rejoués (moins de tokens, cache stable).
        if len(self.history) > self.cfg.max_history_turns:
            self.history = self.history[-self.cfg.max_history_turns :]
            while self.history and self.history[0]["role"] != "user":
                self.history.pop(0)


def _expand(v: str) -> str:
    import os
    import re

    return re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), ""), v)


def _safe_env() -> dict[str, str]:
    import os

    keep = ("PATH", "HOME", "USER", "LANG", "TMPDIR", "NODE_OPTIONS")
    return {k: v for k, v in os.environ.items() if k in keep}


async def _noop(_: str) -> bool:
    return True


__all__ = ["Brain", "asyncio", "_noop"]
