"""Mémoire persistante de Jarvis en SQLite (WAL + FTS5).

Trois tables :
  turns  — historique des échanges (user/assistant), horodaté, avec session.
  facts  — faits atomiques que Jarvis retient (« l'opérateur préfère être vouvoyé »,
           « le concurrent X a baissé ses prix le 12/09 »). Indexés FTS5.
  kv     — préférences et état (dernier rapport lu, voix, etc.).

Pourquoi SQLite ici et Postgres côté VPS : Jarvis tourne sur la machine avec le
micro, souvent hors ligne ; il a besoin d'une mémoire locale à zéro dépendance.
La mémoire « métier » (missions, faits de veille) reste dans Postgres et se
consulte via l'API de Manzi Junior.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_session_ts ON turns(session, ts);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  ts REAL NOT NULL,
  expires REAL
);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(topic, fact, content='facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, topic, fact) VALUES (new.id, new.topic, new.fact);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, topic, fact) VALUES ('delete', old.id, old.topic, old.fact);
END;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts REAL NOT NULL);
"""


class Memory:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)

    # --- historique ---------------------------------------------------------
    def add_turn(self, session: str, role: str, content: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO turns(session, role, content, ts) VALUES (?,?,?,?)", (session, role, content, time.time()))
            self._db.commit()

    def recent_turns(self, session: str, limit: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT role, content FROM turns WHERE session=? ORDER BY ts DESC LIMIT ?", (session, limit)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def yesterday_digest(self, max_chars: int = 3000) -> str:
        """Ce qui s'est dit dans les dernières 36 h, pour la continuité d'une session à l'autre."""
        since = time.time() - 36 * 3600
        with self._lock:
            rows = self._db.execute(
                "SELECT role, content, ts FROM turns WHERE ts > ? ORDER BY ts DESC LIMIT 60", (since,)
            ).fetchall()
        out = []
        total = 0
        for r in rows:
            line = f"- {time.strftime('%d/%m %H:%M', time.localtime(r['ts']))} {r['role']}: {r['content'][:240]}"
            if total + len(line) > max_chars:
                break
            out.append(line)
            total += len(line)
        return "\n".join(reversed(out)) or "(aucun échange récent)"

    # --- faits --------------------------------------------------------------
    def remember(self, topic: str, fact: str, source: str | None = None, confidence: float = 0.7, ttl_days: int | None = None) -> int:
        expires = time.time() + ttl_days * 86400 if ttl_days else None
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO facts(topic, fact, source, confidence, ts, expires) VALUES (?,?,?,?,?,?)",
                (topic, fact, source, confidence, time.time(), expires),
            )
            self._db.commit()
            return int(cur.lastrowid)

    def recall(self, query: str, limit: int = 10) -> list[dict]:
        q = " OR ".join(f'"{w}"' for w in query.split() if w)
        if not q:
            return []
        with self._lock:
            rows = self._db.execute(
                """SELECT f.topic, f.fact, f.source, f.confidence, f.ts FROM facts_fts s
                   JOIN facts f ON f.id = s.rowid
                   WHERE facts_fts MATCH ? AND (f.expires IS NULL OR f.expires > ?)
                   ORDER BY f.ts DESC LIMIT ?""",
                (q, time.time(), limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def profile(self, max_chars: int = 2500) -> str:
        """Faits 'profil:' (préférences durables), injectés dans chaque prompt."""
        with self._lock:
            rows = self._db.execute(
                "SELECT fact FROM facts WHERE topic LIKE 'profil:%' AND (expires IS NULL OR expires > ?) ORDER BY ts DESC LIMIT 40",
                (time.time(),),
            ).fetchall()
        text = "\n".join(f"- {r['fact']}" for r in rows)
        return text[:max_chars] or "(profil vide — apprends au fil des échanges)"

    # --- kv -----------------------------------------------------------------
    def get(self, k: str, default: str | None = None) -> str | None:
        with self._lock:
            r = self._db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default

    def set(self, k: str, v: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO kv(k,v,ts) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts", (k, v, time.time()))
            self._db.commit()
