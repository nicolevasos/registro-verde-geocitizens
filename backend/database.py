from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - optional for SQLite-only local use
    psycopg = None
    dict_row = None

BASE_DIR = Path(__file__).resolve().parents[1]
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
SQLITE_PATH = Path(
    os.getenv("GEOCITIZENS_CACHE_DB", BASE_DIR / "data" / "cadastre_cache.sqlite3")
)
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))


POSTGRES_SCHEMA = """
CREATE TABLE IF NOT EXISTS cadastre_cache (
    cache_key TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL,
    response_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_queue (
    id BIGSERIAL PRIMARY KEY,
    geometry_hash TEXT NOT NULL,
    plot_name TEXT NOT NULL,
    composite_score DOUBLE PRECISION NOT NULL,
    layer_scores_json TEXT NOT NULL,
    feature_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_geometry
  ON review_queue(geometry_hash) WHERE status='pending';
CREATE TABLE IF NOT EXISTS farmer_labels (
    id BIGSERIAL PRIMARY KEY,
    queue_id BIGINT NOT NULL REFERENCES review_queue(id),
    decision TEXT NOT NULL,
    correction_type TEXT NOT NULL,
    notes TEXT NOT NULL,
    corrected_feature_json TEXT,
    penalising_layer TEXT,
    weights_before_json TEXT NOT NULL,
    weights_after_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS scoring_weights (
    layer TEXT PRIMARY KEY,
    weight DOUBLE PRECISION NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_submissions (
    id BIGSERIAL PRIMARY KEY,
    geometry_hash TEXT NOT NULL,
    plot_name TEXT NOT NULL,
    original_feature_json TEXT NOT NULL,
    errors_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_labels (
    id BIGSERIAL PRIMARY KEY,
    submission_id BIGINT NOT NULL REFERENCES repair_submissions(id),
    decision TEXT NOT NULL,
    selected_candidate_id TEXT,
    selected_rank INTEGER,
    farmer_modified INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_strategy_stats (
    strategy_id TEXT PRIMARY KEY,
    selections INTEGER NOT NULL DEFAULT 0,
    recommended_wins INTEGER NOT NULL DEFAULT 0,
    edited_selections INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS study_sessions (
    id BIGSERIAL PRIMARY KEY,
    session_uuid TEXT NOT NULL UNIQUE,
    participant_code TEXT NOT NULL,
    study_condition TEXT NOT NULL,
    app_version TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT,
    completion_status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS study_events (
    id BIGSERIAL PRIMARY KEY,
    session_uuid TEXT NOT NULL REFERENCES study_sessions(session_uuid),
    event_type TEXT NOT NULL,
    plot_name TEXT,
    task_id TEXT,
    elapsed_ms BIGINT,
    payload_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS study_questionnaires (
    id BIGSERIAL PRIMARY KEY,
    session_uuid TEXT NOT NULL REFERENCES study_sessions(session_uuid),
    questionnaire_type TEXT NOT NULL,
    task_id TEXT,
    responses_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_study_events_session ON study_events(session_uuid, created_at);
CREATE INDEX IF NOT EXISTS ix_study_events_type ON study_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS ix_questionnaires_session ON study_questionnaires(session_uuid, created_at);
"""


class Result:
    def __init__(self, cursor: Any, lastrowid: int | None = None):
        self._cursor = cursor
        self.lastrowid = lastrowid

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()


class DatabaseConnection:
    """Small DB-API compatibility layer for SQLite locally and PostgreSQL on Render."""

    def __init__(self) -> None:
        self.is_postgres = IS_POSTGRES
        if self.is_postgres:
            if psycopg is None:
                raise RuntimeError("psycopg is required when DATABASE_URL uses PostgreSQL")
            # Render's internal URL is already suitable for TLS/private networking.
            self.raw = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        else:
            SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
            self.raw = sqlite3.connect(SQLITE_PATH)
            self.raw.row_factory = sqlite3.Row

    def __enter__(self) -> "DatabaseConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if exc_type is None:
            self.raw.commit()
        else:
            self.raw.rollback()
        self.raw.close()

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()

    def executescript(self, script: str) -> None:
        if not self.is_postgres:
            self.raw.executescript(script)
            return
        with self.raw.cursor() as cursor:
            for statement in [part.strip() for part in script.split(";") if part.strip()]:
                cursor.execute(statement)

    def execute(self, sql: str, params: Iterable[Any] = ()) -> Result:
        if not self.is_postgres:
            cursor = self.raw.execute(sql, tuple(params))
            return Result(cursor, cursor.lastrowid)

        pg_sql = self._postgres_sql(sql)
        return_id = self._needs_returning_id(pg_sql)
        if return_id:
            pg_sql = pg_sql.rstrip().rstrip(";") + " RETURNING id"

        cursor = self.raw.cursor()
        cursor.execute(pg_sql, tuple(params))
        lastrowid = None
        if return_id:
            row = cursor.fetchone()
            lastrowid = int(row["id"] if isinstance(row, dict) else row[0])
            # Return a lightweight exhausted cursor for callers that only need lastrowid.
        return Result(cursor, lastrowid)

    @staticmethod
    def _needs_returning_id(sql: str) -> bool:
        lowered = " ".join(sql.lower().split())
        return any(
            lowered.startswith(f"insert into {table}(")
            for table in ("review_queue", "repair_submissions", "study_questionnaires")
        )

    @staticmethod
    def _postgres_sql(sql: str) -> str:
        converted = sql
        converted = converted.replace("?", "%s")

        # SQLite convenience syntax translated to PostgreSQL UPSERTs.
        converted = re.sub(
            r"INSERT\s+OR\s+IGNORE\s+INTO\s+scoring_weights\s*\(layer,weight,updated_at\)\s*VALUES\(%s,%s,%s\)",
            "INSERT INTO scoring_weights(layer,weight,updated_at) VALUES(%s,%s,%s) ON CONFLICT(layer) DO NOTHING",
            converted,
            flags=re.IGNORECASE,
        )
        converted = re.sub(
            r"INSERT\s+OR\s+REPLACE\s+INTO\s+scoring_weights\s*\(layer,weight,updated_at\)\s*VALUES\(%s,%s,%s\)",
            "INSERT INTO scoring_weights(layer,weight,updated_at) VALUES(%s,%s,%s) "
            "ON CONFLICT(layer) DO UPDATE SET weight=EXCLUDED.weight, updated_at=EXCLUDED.updated_at",
            converted,
            flags=re.IGNORECASE,
        )
        converted = re.sub(
            r"INSERT\s+OR\s+REPLACE\s+INTO\s+cadastre_cache\s*\(cache_key,created_at,response_json\)\s*VALUES\(%s,%s,%s\)",
            "INSERT INTO cadastre_cache(cache_key,created_at,response_json) VALUES(%s,%s,%s) "
            "ON CONFLICT(cache_key) DO UPDATE SET created_at=EXCLUDED.created_at, response_json=EXCLUDED.response_json",
            converted,
            flags=re.IGNORECASE,
        )
        converted = re.sub(
            r"INSERT\s+OR\s+IGNORE\s+INTO\s+repair_strategy_stats\s*\(strategy_id,updated_at\)\s*VALUES\(%s,%s\)",
            "INSERT INTO repair_strategy_stats(strategy_id,updated_at) VALUES(%s,%s) ON CONFLICT(strategy_id) DO NOTHING",
            converted,
            flags=re.IGNORECASE,
        )
        # Study session start uses SQLite conflict syntax in the application.
        converted = re.sub(
            r"INSERT\s+OR\s+IGNORE\s+INTO\s+study_sessions",
            "INSERT INTO study_sessions",
            converted,
            flags=re.IGNORECASE,
        )
        if "INSERT INTO study_sessions" in converted and "ON CONFLICT" not in converted.upper():
            converted = converted.rstrip().rstrip(";") + " ON CONFLICT(session_uuid) DO NOTHING"
        return converted


def connect() -> DatabaseConnection:
    return DatabaseConnection()


def initialize_database() -> None:
    """Create all database tables. Safe to run at every startup."""
    with connect() as conn:
        if conn.is_postgres:
            conn.executescript(POSTGRES_SCHEMA)
        else:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cadastre_cache (
                cache_key TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                response_json TEXT NOT NULL
                )"""
            )


def database_label() -> str:
    if IS_POSTGRES:
        return "PostgreSQL (DATABASE_URL)"
    return str(SQLITE_PATH)
