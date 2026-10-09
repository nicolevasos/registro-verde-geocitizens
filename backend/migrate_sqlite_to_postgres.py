from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql

from backend.database import POSTGRES_SCHEMA

TABLES = [
    "cadastre_cache",
    "review_queue",
    "farmer_labels",
    "scoring_weights",
    "repair_submissions",
    "repair_labels",
    "repair_strategy_stats",
    "study_sessions",
    "study_events",
    "study_questionnaires",
]


def split_sql(script: str) -> list[str]:
    return [statement.strip() for statement in script.split(";") if statement.strip()]


def migrate(sqlite_path: Path, database_url: str, truncate: bool = False) -> None:
    if not sqlite_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {sqlite_path}")

    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row

    with psycopg.connect(database_url) as target:
        with target.cursor() as cursor:
            for statement in split_sql(POSTGRES_SCHEMA):
                cursor.execute(statement)

            if truncate:
                cursor.execute(
                    "TRUNCATE TABLE "
                    + ", ".join(TABLES)
                    + " RESTART IDENTITY CASCADE"
                )

            for table in TABLES:
                exists = source.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                    (table,),
                ).fetchone()
                if not exists:
                    print(f"Skipping missing table: {table}")
                    continue

                rows = source.execute(f'SELECT * FROM "{table}"').fetchall()
                if not rows:
                    print(f"{table}: 0 rows")
                    continue

                columns = list(rows[0].keys())
                statement = sql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT DO NOTHING").format(
                    sql.Identifier(table),
                    sql.SQL(", ").join(map(sql.Identifier, columns)),
                    sql.SQL(", ").join(sql.Placeholder() for _ in columns),
                )
                cursor.executemany(statement, [tuple(row[col] for col in columns) for row in rows])
                print(f"{table}: migrated {len(rows)} rows")

            # Keep PostgreSQL sequences ahead of explicitly migrated IDs.
            for table in [
                "review_queue",
                "farmer_labels",
                "repair_submissions",
                "repair_labels",
                "study_sessions",
                "study_events",
                "study_questionnaires",
            ]:
                cursor.execute(
                    sql.SQL(
                        "SELECT setval(pg_get_serial_sequence(%s, 'id'), "
                        "COALESCE((SELECT MAX(id) FROM {}), 1), true)"
                    ).format(sql.Identifier(table)),
                    (table,),
                )

        target.commit()
    source.close()
    print("Migration complete.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate GeoCitizens SQLite data to PostgreSQL")
    parser.add_argument(
        "--sqlite",
        default="data/cadastre_cache.sqlite3",
        help="Path to the existing SQLite database",
    )
    parser.add_argument(
        "--database-url",
        default=os.getenv("DATABASE_URL", ""),
        help="PostgreSQL connection URL (defaults to DATABASE_URL)",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Clear destination tables before migration",
    )
    args = parser.parse_args()
    if not args.database_url:
        parser.error("Provide --database-url or set DATABASE_URL")
    migrate(Path(args.sqlite), args.database_url, args.truncate)


if __name__ == "__main__":
    main()
