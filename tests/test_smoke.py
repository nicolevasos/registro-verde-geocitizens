from __future__ import annotations

import os
from pathlib import Path

os.environ.pop("DATABASE_URL", None)
os.environ["GEOCITIZENS_CACHE_DB"] = str(Path(__file__).parent / "test.sqlite3")

from fastapi.testclient import TestClient
from backend.app import app


def test_health_and_study_flow() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["database_status"] == "connected"

        session = client.post(
            "/api/study/sessions/start",
            json={"session_uuid": "smoke-session", "participant_code": "P001"},
        )
        assert session.status_code == 200

        event = client.post(
            "/api/study/events",
            json={"session_uuid": "smoke-session", "event_type": "plot_opened"},
        )
        assert event.status_code == 200
