from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any
from dotenv import load_dotenv
from collections import Counter, defaultdict
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from shapely.geometry import mapping, shape
from shapely.validation import make_valid

from backend.database import connect as database_connect, database_label, initialize_database

BASE_DIR = Path(__file__).resolve().parents[1]
IGAC_URL = os.getenv(
    "IGAC_CADASTRE_URL",
    "https://mapas.igac.gov.co/server/rest/services/Dato_Fundamental_Catastro/MapServer/1/query",
)
CACHE_TTL_SECONDS = int(os.getenv("IGAC_CACHE_TTL_SECONDS", str(30 * 24 * 3600)))
MIN_IOU = float(os.getenv("IGAC_MIN_IOU", "0.01"))

load_dotenv()

WHISP_API_KEY = os.getenv("WHISP_API_KEY")
WHISP_BASE_URL = "https://whisp.openforis.org/api"

@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    with db_conn() as conn:
        init_stage3(conn)
        # Reconcile sessions created by earlier versions: a stored post-study
        # questionnaire is authoritative evidence that the study completed.
        conn.execute(
            """UPDATE study_sessions
               SET completion_status='completed',
                   ended_at=COALESCE(
                       ended_at,
                       (SELECT MIN(q.created_at)
                        FROM study_questionnaires q
                        WHERE q.session_uuid=study_sessions.session_uuid
                          AND q.questionnaire_type='post_study')
                   )
               WHERE EXISTS (
                   SELECT 1 FROM study_questionnaires q
                   WHERE q.session_uuid=study_sessions.session_uuid
                     AND q.questionnaire_type='post_study'
               )"""
        )
    yield


app = FastAPI(title="GeoCitizens", version="3.1.0", lifespan=lifespan)


# Allow the frontend to run either from this FastAPI app or from a local
# development server such as VS Code Live Server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5050",
        "http://localhost:5050",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
        "http://127.0.0.1:5502",
        "http://localhost:5502",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)



DECISIONS = {"accepted", "rejected", "corrected", "confirmed_as_is"}
CORRECTION_TYPES = {"boundary_shift", "full_redraw", "hole_resolved", "multi_parcel_confirmed", "confirmed_as_is"}
DEFAULT_WEIGHTS = {"a2": 0.25, "a3": 0.30, "a4": 0.10}
LEARNING_RATE = float(os.getenv("ACTIVE_LEARNING_ALPHA", "0.08"))


class QueueSubmissionRequest(BaseModel):
    feature: dict[str, Any]
    plot_name: str = "Unnamed parcel"
    composite_score: float = Field(ge=0.0, le=1.0)
    layer_scores: dict[str, float | None]
    metadata: dict[str, Any] = {}


class FarmerDecisionRequest(BaseModel):
    decision: str
    correction_type: str
    notes: str = ""
    corrected_feature: dict[str, Any] | None = None


class RepairSubmissionRequest(BaseModel):
    plot_name: str = "Unnamed parcel"
    original_feature: dict[str, Any]
    errors: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]]


class RepairDecisionRequest(BaseModel):
    decision: str
    selected_candidate_id: str | None = None
    selected_rank: int | None = None
    farmer_modified: bool = False
    notes: str = ""

class StudySessionStartRequest(BaseModel):
    session_uuid: str
    participant_code: str = "anonymous"
    study_condition: str = "multi_candidate"
    app_version: str = "session-analytics-v1"
    metadata: dict[str, Any] = {}


class StudyEventRequest(BaseModel):
    session_uuid: str
    event_type: str
    plot_name: str | None = None
    task_id: str | None = None
    elapsed_ms: int | None = None
    payload: dict[str, Any] = {}


class StudySessionEndRequest(BaseModel):
    session_uuid: str
    completion_status: str = "completed"
    metadata: dict[str, Any] = {}


class StudyQuestionnaireRequest(BaseModel):
    session_uuid: str
    questionnaire_type: str
    responses: dict[str, Any]
    task_id: str | None = None

class WhispAnalysisRequest(BaseModel):
    geojson: dict[str, Any]

def init_stage3(conn: Any) -> None:
    if not conn.is_postgres:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS review_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                geometry_hash TEXT NOT NULL,
                plot_name TEXT NOT NULL,
                composite_score REAL NOT NULL,
                layer_scores_json TEXT NOT NULL,
                feature_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_geometry
              ON review_queue(geometry_hash) WHERE status='pending';
            CREATE TABLE IF NOT EXISTS farmer_labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                queue_id INTEGER NOT NULL,
                decision TEXT NOT NULL,
                correction_type TEXT NOT NULL,
                notes TEXT NOT NULL,
                corrected_feature_json TEXT,
                penalising_layer TEXT,
                weights_before_json TEXT NOT NULL,
                weights_after_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(queue_id) REFERENCES review_queue(id)
            );
            CREATE TABLE IF NOT EXISTS scoring_weights (
                layer TEXT PRIMARY KEY,
                weight REAL NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS repair_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                geometry_hash TEXT NOT NULL,
                plot_name TEXT NOT NULL,
                original_feature_json TEXT NOT NULL,
                errors_json TEXT NOT NULL,
                candidates_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS repair_labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_id INTEGER NOT NULL,
                decision TEXT NOT NULL,
                selected_candidate_id TEXT,
                selected_rank INTEGER,
                farmer_modified INTEGER NOT NULL DEFAULT 0,
                notes TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(submission_id) REFERENCES repair_submissions(id)
            );
            CREATE TABLE IF NOT EXISTS repair_strategy_stats (
                strategy_id TEXT PRIMARY KEY,
                selections INTEGER NOT NULL DEFAULT 0,
                recommended_wins INTEGER NOT NULL DEFAULT 0,
                edited_selections INTEGER NOT NULL DEFAULT 0,
                rejected INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS study_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_uuid TEXT NOT NULL UNIQUE,
                participant_code TEXT NOT NULL,
                study_condition TEXT NOT NULL,
                app_version TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                completion_status TEXT NOT NULL DEFAULT 'active'
            );
            CREATE TABLE IF NOT EXISTS study_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_uuid TEXT NOT NULL,
                event_type TEXT NOT NULL,
                plot_name TEXT,
                task_id TEXT,
                elapsed_ms INTEGER,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_uuid) REFERENCES study_sessions(session_uuid)
            );
            CREATE TABLE IF NOT EXISTS study_questionnaires (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_uuid TEXT NOT NULL,
                questionnaire_type TEXT NOT NULL,
                task_id TEXT,
                responses_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(session_uuid) REFERENCES study_sessions(session_uuid)
            );
            CREATE INDEX IF NOT EXISTS ix_study_events_session ON study_events(session_uuid, created_at);
            CREATE INDEX IF NOT EXISTS ix_study_events_type ON study_events(event_type, created_at);
            CREATE INDEX IF NOT EXISTS ix_questionnaires_session ON study_questionnaires(session_uuid, created_at);
            """
        )
    now = int(time.time())
    for layer, weight in DEFAULT_WEIGHTS.items():
        conn.execute(
            "INSERT OR IGNORE INTO scoring_weights(layer,weight,updated_at) VALUES(?,?,?)",
            (layer, weight, now),
        )

def get_weights(conn: Any) -> dict[str, float]:
    init_stage3(conn)
    rows = conn.execute("SELECT layer,weight FROM scoring_weights").fetchall()
    return {row["layer"]: float(row["weight"]) for row in rows}


def normalise_weights(weights: dict[str, float], target_total: float | None = None) -> dict[str, float]:
    target_total = target_total if target_total is not None else sum(DEFAULT_WEIGHTS.values())
    clean = {k: max(0.02, float(v)) for k, v in weights.items()}
    total = sum(clean.values()) or 1.0
    return {k: v / total * target_total for k, v in clean.items()}


def update_weights_for_label(conn: Any, layer_scores: dict[str, Any], decision: str) -> tuple[str | None, dict[str, float], dict[str, float]]:
    before = get_weights(conn)
    available = {k: float(v) for k, v in layer_scores.items() if k in before and v is not None}
    if not available:
        return None, before, before
    penalising = min(available, key=available.get)
    after = dict(before)
    # If the farmer rejects or corrects an uncertain parcel, the weakest layer was
    # informative and gains influence. If the farmer accepts/confirms it, that
    # weak layer was overly pessimistic and loses influence.
    direction = 1.0 if decision in {"rejected", "corrected"} else -1.0
    target = min(0.65, before[penalising] + 0.20) if direction > 0 else max(0.02, before[penalising] - 0.15)
    after[penalising] = (1.0 - LEARNING_RATE) * before[penalising] + LEARNING_RATE * target
    after = normalise_weights(after, sum(DEFAULT_WEIGHTS.values()))
    now = int(time.time())
    for layer, weight in after.items():
        conn.execute(
            "INSERT OR REPLACE INTO scoring_weights(layer,weight,updated_at) VALUES(?,?,?)",
            (layer, weight, now),
        )
    return penalising, before, after


class CadastreRequest(BaseModel):
    feature: dict[str, Any]
    force_refresh: bool = False


def db_conn():
    conn = database_connect()
    init_stage3(conn)
    return conn


def normalized_feature(feature: dict[str, Any]) -> dict[str, Any]:
    if feature.get("type") == "FeatureCollection":
        features = feature.get("features") or []
        if not features:
            raise HTTPException(400, "FeatureCollection is empty")
        feature = features[0]
    if feature.get("type") == "Feature":
        geometry = feature.get("geometry")
    else:
        geometry = feature
    if not geometry or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise HTTPException(400, "A Polygon or MultiPolygon is required")
    return {"type": "Feature", "properties": feature.get("properties", {}), "geometry": geometry}


def cache_key(feature: dict[str, Any]) -> str:
    payload = json.dumps(feature["geometry"], sort_keys=True, separators=(",", ":"))
    return "arcgis-r-terreno-v1:" + hashlib.sha256(payload.encode()).hexdigest()


def cache_get(key: str) -> dict[str, Any] | None:
    with db_conn() as conn:
        row = conn.execute("SELECT created_at,response_json FROM cadastre_cache WHERE cache_key=?", (key,)).fetchone()
    if not row or int(time.time()) - row["created_at"] > CACHE_TTL_SECONDS:
        return None
    value = json.loads(row["response_json"])
    value["backend_cached"] = True
    return value


def cache_set(key: str, value: dict[str, Any]) -> None:
    with db_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO cadastre_cache(cache_key,created_at,response_json) VALUES(?,?,?)",
            (key, int(time.time()), json.dumps(value, ensure_ascii=False)),
        )


def safe_geom(obj: dict[str, Any]):
    geom = shape(obj)
    if not geom.is_valid:
        geom = make_valid(geom)
    return geom


@app.get("/health")
def health() -> dict[str, str]:
    try:
        with db_conn() as conn:
            conn.execute("SELECT 1 AS ok").fetchone()
        database_status = "connected"
        status = "ok"
    except Exception as exc:
        database_status = f"error: {type(exc).__name__}"
        status = "degraded"
    return {
        "status": status,
        "service": "geocitizens",
        "version": "3.0.0",
        "database": database_label(),
        "database_status": database_status,
        "cadastre_source": "IGAC ArcGIS R_TERRENO",
    }


@app.post("/api/cadastre/search")
async def cadastral_search(request: CadastreRequest) -> dict[str, Any]:
    feature = normalized_feature(request.feature)
    key = cache_key(feature)
    if not request.force_refresh:
        cached = cache_get(key)
        if cached:
            return cached

    source = safe_geom(feature["geometry"])
    if source.is_empty:
        raise HTTPException(400, "Geometry is empty")
    minx, miny, maxx, maxy = source.bounds
    params = {
        "where": "1=1",
        "geometry": f"{minx},{miny},{maxx},{maxy}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    try:
        timeout = httpx.Timeout(25.0, connect=8.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(IGAC_URL, params=params, headers={"Accept": "application/geo+json,application/json"})
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        return {"status": "unavailable", "iou": None, "message": f"IGAC cadastral service unavailable: {exc}", "backend_cached": False}

    if isinstance(data, dict) and data.get("error"):
        return {"status": "unavailable", "iou": None, "message": data["error"], "backend_cached": False}

    candidates = data.get("features", []) if isinstance(data, dict) else []
    best = None
    best_iou = 0.0
    source_area = source.area
    for candidate in candidates:
        try:
            target = safe_geom(candidate.get("geometry"))
            if target.is_empty or not source.intersects(target):
                continue
            intersection_area = source.intersection(target).area
            union_area = source_area + target.area - intersection_area
            iou = intersection_area / union_area if union_area > 0 else 0.0
            if iou > best_iou:
                best_iou = iou
                best = candidate
        except Exception:
            continue

    if best is None or best_iou < MIN_IOU:
        result = {"status": "not_found", "iou": None, "candidate_count": len(candidates), "message": "No overlapping IGAC rural parcel was found.", "backend_cached": False}
    else:
        source_m2 = source_area * (111_320 ** 2)
        target = safe_geom(best["geometry"])
        target_m2 = target.area * (111_320 ** 2)
        result = {
            "status": "success",
            "iou": round(best_iou, 6),
            "candidate_count": len(candidates),
            "best_match": {
                "properties": best.get("properties", {}),
                "geometry": mapping(target),
                "source_area_ha_approx": round(source_m2 / 10000, 4),
                "cadastre_area_ha_approx": round(target_m2 / 10000, 4),
            },
            "backend_cached": False,
        }
    cache_set(key, result)
    return result



@app.get("/api/active-learning/weights")
def active_learning_weights() -> dict[str, Any]:
    with db_conn() as conn:
        return {"weights": get_weights(conn), "alpha": LEARNING_RATE}


@app.post("/api/active-learning/queue")
def enqueue_submission(request: QueueSubmissionRequest) -> dict[str, Any]:
    feature = normalized_feature(request.feature)
    geom_hash = cache_key(feature).split(":", 1)[1]
    now = int(time.time())
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM review_queue WHERE geometry_hash=? AND status='pending'",
            (geom_hash,),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE review_queue SET plot_name=?,composite_score=?,layer_scores_json=?,feature_json=?,metadata_json=?,updated_at=? WHERE id=?",
                (request.plot_name, request.composite_score, json.dumps(request.layer_scores), json.dumps(feature), json.dumps(request.metadata), now, existing["id"]),
            )
            queue_id = existing["id"]
            created = False
        else:
            cur = conn.execute(
                "INSERT INTO review_queue(geometry_hash,plot_name,composite_score,layer_scores_json,feature_json,metadata_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
                (geom_hash, request.plot_name, request.composite_score, json.dumps(request.layer_scores), json.dumps(feature), json.dumps(request.metadata), now, now),
            )
            queue_id = cur.lastrowid
            created = True
    return {"status": "queued", "queue_id": queue_id, "created": created}


@app.get("/api/active-learning/queue")
def list_queue(status: str = "pending", limit: int = 100) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM review_queue WHERE status=? ORDER BY composite_score ASC, created_at ASC LIMIT ?",
            (status, limit),
        ).fetchall()
        items = []
        for row in rows:
            items.append({
                "id": row["id"], "plot_name": row["plot_name"],
                "composite_score": row["composite_score"],
                "layer_scores": json.loads(row["layer_scores_json"]),
                "feature": json.loads(row["feature_json"]),
                "metadata": json.loads(row["metadata_json"]),
                "status": row["status"], "created_at": row["created_at"]
            })
        return {"items": items, "count": len(items), "weights": get_weights(conn), "alpha": LEARNING_RATE}


@app.post("/api/active-learning/queue/{queue_id}/decision")
def label_queue_item(queue_id: int, request: FarmerDecisionRequest) -> dict[str, Any]:
    if request.decision not in DECISIONS:
        raise HTTPException(400, f"decision must be one of {sorted(DECISIONS)}")
    if request.correction_type not in CORRECTION_TYPES:
        raise HTTPException(400, f"correction_type must be one of {sorted(CORRECTION_TYPES)}")
    now = int(time.time())
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM review_queue WHERE id=?", (queue_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Queue item not found")
        if row["status"] != "pending":
            raise HTTPException(409, "Queue item has already been reviewed")
        scores = json.loads(row["layer_scores_json"] )
        penalising, before, after = update_weights_for_label(conn, scores, request.decision)
        conn.execute(
            "INSERT INTO farmer_labels(queue_id,decision,correction_type,notes,corrected_feature_json,penalising_layer,weights_before_json,weights_after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (queue_id, request.decision, request.correction_type, request.notes, json.dumps(request.corrected_feature) if request.corrected_feature else None, penalising, json.dumps(before), json.dumps(after), now),
        )
        conn.execute("UPDATE review_queue SET status='reviewed',updated_at=? WHERE id=?", (now, queue_id))
    return {"status": "reviewed", "queue_id": queue_id, "penalising_layer": penalising, "weights_before": before, "weights_after": after, "alpha": LEARNING_RATE}


@app.post("/api/active-learning/repair-submissions")
def create_repair_submission(request: RepairSubmissionRequest) -> dict[str, Any]:
    feature = normalized_feature(request.original_feature)
    geom_hash = cache_key(feature).split(":", 1)[1]
    now = int(time.time())
    with db_conn() as conn:
        cur = conn.execute(
            "INSERT INTO repair_submissions(geometry_hash,plot_name,original_feature_json,errors_json,candidates_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)",
            (geom_hash, request.plot_name, json.dumps(feature), json.dumps(request.errors), json.dumps(request.candidates), now, now),
        )
        submission_id = cur.lastrowid
    return {"status": "queued", "submission_id": submission_id, "candidate_count": len(request.candidates)}


@app.post("/api/active-learning/repair-submissions/{submission_id}/decision")
def label_repair_submission(submission_id: int, request: RepairDecisionRequest) -> dict[str, Any]:
    allowed={"accepted_recommended","accepted_alternative","edited_candidate","rejected_all"}
    if request.decision not in allowed:
        raise HTTPException(400, f"decision must be one of {sorted(allowed)}")
    now=int(time.time())
    with db_conn() as conn:
        row=conn.execute("SELECT * FROM repair_submissions WHERE id=?",(submission_id,)).fetchone()
        if not row: raise HTTPException(404,"Repair submission not found")
        if row["status"]!="pending": raise HTTPException(409,"Repair submission already reviewed")
        conn.execute("INSERT INTO repair_labels(submission_id,decision,selected_candidate_id,selected_rank,farmer_modified,notes,created_at) VALUES(?,?,?,?,?,?,?)",
                     (submission_id,request.decision,request.selected_candidate_id,request.selected_rank,1 if request.farmer_modified else 0,request.notes,now))
        if request.selected_candidate_id:
            conn.execute("INSERT OR IGNORE INTO repair_strategy_stats(strategy_id,updated_at) VALUES(?,?)",(request.selected_candidate_id,now))
            conn.execute("UPDATE repair_strategy_stats SET selections=selections+1,recommended_wins=recommended_wins+?,edited_selections=edited_selections+?,updated_at=? WHERE strategy_id=?",
                         (1 if request.selected_rank==1 else 0,1 if request.farmer_modified else 0,now,request.selected_candidate_id))
        elif request.decision=="rejected_all":
            for cand in json.loads(row["candidates_json"]):
                sid=cand.get("candidate_id")
                if sid:
                    conn.execute("INSERT OR IGNORE INTO repair_strategy_stats(strategy_id,updated_at) VALUES(?,?)",(sid,now))
                    conn.execute("UPDATE repair_strategy_stats SET rejected=rejected+1,updated_at=? WHERE strategy_id=?",(now,sid))
        conn.execute("UPDATE repair_submissions SET status='reviewed',updated_at=? WHERE id=?",(now,submission_id))
    return {"status":"reviewed","submission_id":submission_id}


@app.get("/api/active-learning/repair-stats")
def repair_strategy_stats() -> dict[str, Any]:
    with db_conn() as conn:
        rows=conn.execute("SELECT * FROM repair_strategy_stats ORDER BY selections DESC,recommended_wins DESC").fetchall()
        return {"items":[dict(r) for r in rows]}


@app.post("/api/study/sessions/start")
def start_study_session(request: StudySessionStartRequest) -> dict[str, Any]:
    now = int(time.time())
    with db_conn() as conn:
        conn.execute(
            """INSERT INTO study_sessions(session_uuid,participant_code,study_condition,app_version,metadata_json,started_at,completion_status)
               VALUES(?,?,?,?,?,?,'active')
               ON CONFLICT(session_uuid) DO UPDATE SET
                 participant_code=excluded.participant_code,
                 study_condition=excluded.study_condition,
                 app_version=excluded.app_version,
                 metadata_json=excluded.metadata_json""",
            (request.session_uuid, request.participant_code, request.study_condition, request.app_version, json.dumps(request.metadata), now),
        )
    return {"status": "active", "session_uuid": request.session_uuid, "started_at": now}


@app.post("/api/study/events")
def record_study_event(request: StudyEventRequest) -> dict[str, Any]:
    now = int(time.time())
    with db_conn() as conn:
        exists = conn.execute("SELECT 1 FROM study_sessions WHERE session_uuid=?", (request.session_uuid,)).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO study_sessions(session_uuid,participant_code,study_condition,app_version,metadata_json,started_at,completion_status) VALUES(?,?,?,?,?,?,'active')",
                (request.session_uuid, "anonymous", "multi_candidate", "session-analytics-v1", "{}", now),
            )
        conn.execute(
            "INSERT INTO study_events(session_uuid,event_type,plot_name,task_id,elapsed_ms,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
            (request.session_uuid, request.event_type, request.plot_name, request.task_id, request.elapsed_ms, json.dumps(request.payload), now),
        )
    return {"status": "recorded", "created_at": now}


@app.post("/api/study/sessions/end")
def end_study_session(request: StudySessionEndRequest) -> dict[str, Any]:
    now = int(time.time())
    with db_conn() as conn:
        conn.execute(
            "UPDATE study_sessions SET ended_at=?,completion_status=?,metadata_json=? WHERE session_uuid=?",
            (now, request.completion_status, json.dumps(request.metadata), request.session_uuid),
        )
    return {"status": request.completion_status, "ended_at": now}


def _event_payload(row: Any) -> dict[str, Any]:
    try:
        return json.loads(row["payload_json"] or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}


@app.get("/api/study/config")
def study_config(condition: str = "multi_candidate") -> dict[str, Any]:
    config_path = BASE_DIR / "study_config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        config = {"study_title": "GeoCitizens user study", "tasks": []}
    condition_overrides = config.get("conditions", {}).get(condition, {})
    merged = {**config, **condition_overrides}
    merged.pop("conditions", None)
    merged["condition"] = condition
    return merged


@app.post("/api/study/questionnaires")
def submit_study_questionnaire(request: StudyQuestionnaireRequest) -> dict[str, Any]:
    now = int(time.time())
    with db_conn() as conn:
        init_stage3(conn)
        exists = conn.execute("SELECT 1 FROM study_sessions WHERE session_uuid=?", (request.session_uuid,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Study session not found")
        cursor = conn.execute(
            "INSERT INTO study_questionnaires(session_uuid,questionnaire_type,task_id,responses_json,created_at) VALUES(?,?,?,?,?)",
            (request.session_uuid, request.questionnaire_type, request.task_id, json.dumps(request.responses), now),
        )
        conn.execute(
            "INSERT INTO study_events(session_uuid,event_type,plot_name,task_id,elapsed_ms,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
            (request.session_uuid, "questionnaire_submitted", None, request.task_id, None, json.dumps({"questionnaire_type": request.questionnaire_type}), now),
        )
        # A successfully stored post-study questionnaire completes the same session.
        # Keeping this update in the same transaction prevents the questionnaire
        # and session status from diverging if the browser closes immediately.
        if request.questionnaire_type == "post_study":
            conn.execute(
                "UPDATE study_sessions SET ended_at=?, completion_status='completed' WHERE session_uuid=?",
                (now, request.session_uuid),
            )
    return {
        "status": "stored",
        "questionnaire_id": cursor.lastrowid,
        "session_uuid": request.session_uuid,
        "completion_status": "completed" if request.questionnaire_type == "post_study" else "active",
        "ended_at": now if request.questionnaire_type == "post_study" else None,
    }


@app.get("/api/analytics/questionnaires")
def analytics_questionnaires(session_uuid: str | None = None, limit: int = 2000) -> dict[str, Any]:
    limit = max(1, min(limit, 5000))
    with db_conn() as conn:
        init_stage3(conn)
        if session_uuid:
            rows = conn.execute(
                "SELECT * FROM study_questionnaires WHERE session_uuid=? ORDER BY created_at LIMIT ?",
                (session_uuid, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM study_questionnaires ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    items=[]
    for row in rows:
        item=dict(row)
        item["responses"]=json.loads(item.pop("responses_json"))
        items.append(item)
    return {"items": items, "count": len(items)}


@app.get("/api/analytics/summary")
def analytics_summary() -> dict[str, Any]:
    with db_conn() as conn:
        sessions = conn.execute("SELECT * FROM study_sessions ORDER BY started_at").fetchall()
        events = conn.execute("SELECT * FROM study_events ORDER BY created_at").fetchall()
        labels = conn.execute("SELECT decision,correction_type,penalising_layer,created_at,weights_after_json FROM farmer_labels ORDER BY created_at").fetchall()
        repair_labels = conn.execute("SELECT decision,selected_candidate_id,selected_rank,farmer_modified,created_at FROM repair_labels ORDER BY created_at").fetchall()
        weights = get_weights(conn)

    event_counts = Counter(row["event_type"] for row in events)
    last_event_by_session = {}
    for event in events:
        session_id = event["session_uuid"]
        last_event_by_session[session_id] = max(
            last_event_by_session.get(session_id, event["created_at"]),
            event["created_at"],
        )

    session_durations=[]
    for row in sessions:
        end = (
            row["ended_at"]
            or last_event_by_session.get(row["session_uuid"])
            or row["started_at"]
        )
        session_durations.append(max(0,end-row["started_at"]))
    task_times=[row["elapsed_ms"] for row in events if row["event_type"] in {"validation_decision","stage2_completed"} and row["elapsed_ms"] is not None]
    candidate_events=[row for row in events if row["event_type"]=="repair_candidate_selected"]
    recommended=sum(1 for r in candidate_events if _event_payload(r).get("rank")==1)
    edited=sum(1 for r in events if r["event_type"]=="vertex_edit_committed")
    redraws=sum(1 for r in events if r["event_type"] in {"repair_rejected_all","validation_rejected"})
    decisions=Counter(row["decision"] for row in labels)
    repair_decisions=Counter(row["decision"] for row in repair_labels)
    correction_types=Counter(row["correction_type"] for row in labels)
    weakest=Counter((row["penalising_layer"] or "none") for row in labels)

    weight_history=[]
    for row in labels:
        try:
            after=json.loads(row["weights_after_json"])
        except Exception:
            after={}
        weight_history.append({"timestamp":row["created_at"], **after})

    return {
        "sessions": {
            "total": len(sessions),
            "active": sum(1 for s in sessions if s["completion_status"]=="active"),
            "completed": sum(1 for s in sessions if s["completion_status"]=="completed"),
            "median_duration_seconds": sorted(session_durations)[len(session_durations)//2] if session_durations else 0,
        },
        "tasks": {
            "uploads": event_counts["file_import_completed"],
            "parcels_opened": event_counts["plot_opened"],
            "stage2_completed": event_counts["stage2_completed"],
            "decisions": event_counts["validation_decision"],
            "median_task_time_ms": sorted(task_times)[len(task_times)//2] if task_times else 0,
            "manual_edits": edited,
            "redraws_or_rejections": redraws,
        },
        "repair": {
            "candidate_selections": len(candidate_events),
            "recommended_selected": recommended,
            "recommended_rate": recommended/len(candidate_events) if candidate_events else 0,
            "decisions": dict(repair_decisions),
        },
        "farmer_decisions": dict(decisions),
        "correction_types": dict(correction_types),
        "penalising_layers": dict(weakest),
        "current_weights": weights,
        "weight_history": weight_history,
        "event_counts": dict(event_counts),
    }


@app.get("/api/analytics/sessions")
def analytics_sessions(limit: int = 500) -> dict[str, Any]:
    limit=max(1,min(limit,2000))
    with db_conn() as conn:
        rows=conn.execute(
            """SELECT s.*, COUNT(DISTINCT e.id) event_count,
               COUNT(DISTINCT CASE WHEN e.event_type='validation_decision' THEN e.id END) decision_count,
               COUNT(DISTINCT CASE WHEN e.event_type='vertex_edit_committed' THEN e.id END) edit_count,
               MAX(e.created_at) last_event_at,
               COUNT(DISTINCT q.id) questionnaire_count
               FROM study_sessions s
               LEFT JOIN study_events e ON e.session_uuid=s.session_uuid
               LEFT JOIN study_questionnaires q ON q.session_uuid=s.session_uuid
               GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?""", (limit,)
        ).fetchall()
    items=[]
    for r in rows:
        questionnaire_count = int(r["questionnaire_count"] or 0)
        derived_status = "completed" if questionnaire_count > 0 else r["completion_status"]
        effective_end = r["ended_at"] or r["last_event_at"] or r["started_at"]
        items.append({
            "session_uuid":r["session_uuid"],"participant_code":r["participant_code"],
            "study_condition":r["study_condition"],"app_version":r["app_version"],
            "started_at":r["started_at"],"ended_at":r["ended_at"],
            "last_event_at":r["last_event_at"],
            "duration_seconds":max(0,effective_end-r["started_at"]),
            "completion_status":derived_status,"event_count":r["event_count"],
            "decision_count":r["decision_count"],"edit_count":r["edit_count"],
            "questionnaire_count":questionnaire_count,
        })
    return {"items":items,"count":len(items)}


@app.get("/api/analytics/events")
def analytics_events(session_uuid: str | None = None, limit: int = 1000) -> dict[str, Any]:
    limit=max(1,min(limit,5000))
    with db_conn() as conn:
        if session_uuid:
            rows=conn.execute("SELECT * FROM study_events WHERE session_uuid=? ORDER BY created_at LIMIT ?",(session_uuid,limit)).fetchall()
        else:
            rows=conn.execute("SELECT * FROM study_events ORDER BY created_at DESC LIMIT ?",(limit,)).fetchall()
    return {"items":[{**dict(r),"payload":_event_payload(r)} for r in rows],"count":len(rows)}


@app.get("/api/debug/summary")
def debug_summary() -> dict[str, Any]:
    """Return database counts and current learning state for the developer dashboard."""
    with db_conn() as conn:
        table_names = [
            "cadastre_cache", "review_queue", "farmer_labels", "scoring_weights",
            "repair_submissions", "repair_labels", "repair_strategy_stats", "study_sessions", "study_events", "study_questionnaires",
        ]
        counts: dict[str, int] = {}
        for table in table_names:
            counts[table] = int(conn.execute(f'SELECT COUNT(*) AS n FROM "{table}"').fetchone()["n"])
        weights = get_weights(conn)
        repair_stats = [dict(row) for row in conn.execute(
            "SELECT * FROM repair_strategy_stats ORDER BY selections DESC, recommended_wins DESC"
        ).fetchall()]
    return {
        "database": database_label(),
        "counts": counts,
        "weights": weights,
        "alpha": LEARNING_RATE,
        "repair_strategy_stats": repair_stats,
    }


@app.get("/api/debug/cadastre-cache")
def debug_cadastre_cache(limit: int = 200) -> dict[str, Any]:
    """Expose cached cadastral matches as GeoJSON-ready records for local debugging.

    The source parcel is recovered from review_queue when a row with the same
    geometry hash exists. Older cache entries may therefore contain only the
    IGAC geometry.
    """
    limit = max(1, min(limit, 1000))
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT cache_key, created_at, response_json FROM cadastre_cache ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        queue_rows = conn.execute(
            "SELECT geometry_hash, plot_name, feature_json, composite_score, layer_scores_json, status "
            "FROM review_queue ORDER BY updated_at DESC"
        ).fetchall()

    queue_by_hash: dict[str, dict[str, Any]] = {}
    for row in queue_rows:
        queue_by_hash.setdefault(row["geometry_hash"], {
            "plot_name": row["plot_name"],
            "feature": json.loads(row["feature_json"]),
            "composite_score": row["composite_score"],
            "layer_scores": json.loads(row["layer_scores_json"]),
            "queue_status": row["status"],
        })

    items: list[dict[str, Any]] = []
    for row in rows:
        try:
            response = json.loads(row["response_json"])
        except (TypeError, json.JSONDecodeError):
            response = {"status": "invalid_cache_record", "message": "response_json could not be parsed"}

        geometry_hash = row["cache_key"].split(":", 1)[-1]
        queue_match = queue_by_hash.get(geometry_hash)
        best_match = response.get("best_match") if isinstance(response, dict) else None
        cadastre_feature = None
        if isinstance(best_match, dict) and best_match.get("geometry"):
            cadastre_feature = {
                "type": "Feature",
                "properties": best_match.get("properties", {}),
                "geometry": best_match["geometry"],
            }

        items.append({
            "cache_key": row["cache_key"],
            "geometry_hash": geometry_hash,
            "created_at": row["created_at"],
            "status": response.get("status") if isinstance(response, dict) else None,
            "iou": response.get("iou") if isinstance(response, dict) else None,
            "candidate_count": response.get("candidate_count") if isinstance(response, dict) else None,
            "message": response.get("message") if isinstance(response, dict) else None,
            "backend_cached": response.get("backend_cached") if isinstance(response, dict) else None,
            "source_feature": queue_match.get("feature") if queue_match else None,
            "plot_name": queue_match.get("plot_name") if queue_match else None,
            "composite_score": queue_match.get("composite_score") if queue_match else None,
            "layer_scores": queue_match.get("layer_scores") if queue_match else None,
            "queue_status": queue_match.get("queue_status") if queue_match else None,
            "cadastre_feature": cadastre_feature,
            "best_match_properties": best_match.get("properties", {}) if isinstance(best_match, dict) else {},
            "source_area_ha_approx": best_match.get("source_area_ha_approx") if isinstance(best_match, dict) else None,
            "cadastre_area_ha_approx": best_match.get("cadastre_area_ha_approx") if isinstance(best_match, dict) else None,
        })
    return {"items": items, "count": len(items)}


@app.get("/debug")
def debug_dashboard():
    return FileResponse(BASE_DIR / "debug.html")

@app.get("/analytics")
def analytics_dashboard():
    return FileResponse(BASE_DIR / "analytics.html")

@app.get("/study")
def study_landing():
    return FileResponse(BASE_DIR / "study.html")

app.mount("/css", StaticFiles(directory=BASE_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=BASE_DIR / "js"), name="js")

@app.get("/")
def index():
    return FileResponse(BASE_DIR / "index.html")

@app.post("/api/whisp/analyze")
async def analyze_whisp(
    request: WhispAnalysisRequest,
) -> dict[str, Any]:
    """Run a WHISP analysis and normalize the response for the frontend.

    WHISP v3 can return a completed FeatureCollection immediately under
    ``data``. Some deployments may instead return a token, so this endpoint
    also keeps a defensive polling fallback. The API key never leaves the
    backend.
    """
    if not WHISP_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="WHISP_API_KEY is not configured in the backend environment.",
        )

    headers = {
        "Content-Type": "application/json",
        "X-API-KEY": WHISP_API_KEY,
    }

    def feature_collection_from(payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None

        candidates = [
            payload.get("result"),
            payload.get("geojson"),
            payload.get("data"),
            payload,
        ]

        for candidate in candidates:
            if (
                isinstance(candidate, dict)
                and candidate.get("type") == "FeatureCollection"
                and isinstance(candidate.get("features"), list)
            ):
                return candidate

        return None

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            submit_response = await client.post(
                f"{WHISP_BASE_URL}/submit/geojson",
                json=request.geojson,
                headers=headers,
            )

            try:
                submit_data = submit_response.json()
            except ValueError as error:
                raise HTTPException(
                    status_code=502,
                    detail="WHISP returned a non-JSON response.",
                ) from error

            if submit_response.status_code >= 400:
                raise HTTPException(
                    status_code=submit_response.status_code,
                    detail=submit_data,
                )

            # WHISP v3 commonly returns the completed analysis immediately.
            immediate_result = feature_collection_from(submit_data)
            if immediate_result is not None:
                return {
                    "status": "completed",
                    "message": submit_data.get(
                        "message",
                        "Analysis completed successfully",
                    ),
                    "result": immediate_result,
                    "context": submit_data.get("context", {}),
                }

            context = submit_data.get("context")
            context = context if isinstance(context, dict) else {}

            token = (
                submit_data.get("token")
                or submit_data.get("job_token")
                or submit_data.get("id")
                or context.get("token")
            )
            status_url = (
                submit_data.get("statusUrl")
                or submit_data.get("status_url")
            )

            if not token and not status_url:
                raise HTTPException(
                    status_code=502,
                    detail={
                        "message": (
                            "WHISP returned neither a completed GeoJSON result "
                            "nor a token/status URL."
                        ),
                        "response": submit_data,
                    },
                )

            if not status_url:
                status_url = f"{WHISP_BASE_URL}/status/{token}"
            elif status_url.startswith("/"):
                status_url = f"https://whisp.openforis.org{status_url}"

            for _ in range(60):
                await asyncio.sleep(2)

                status_response = await client.get(
                    status_url,
                    headers={"X-API-KEY": WHISP_API_KEY},
                )

                try:
                    status_data = status_response.json()
                except ValueError as error:
                    raise HTTPException(
                        status_code=502,
                        detail="WHISP status endpoint returned non-JSON data.",
                    ) from error

                if status_response.status_code >= 400:
                    raise HTTPException(
                        status_code=status_response.status_code,
                        detail=status_data,
                    )

                completed_result = feature_collection_from(status_data)
                if completed_result is not None:
                    return {
                        "status": "completed",
                        "message": status_data.get(
                            "message",
                            "Analysis completed successfully",
                        ),
                        "result": completed_result,
                        "context": status_data.get("context", context),
                    }

                status = str(status_data.get("status", "")).lower()
                if status in {"failed", "error", "cancelled"}:
                    raise HTTPException(
                        status_code=502,
                        detail={
                            "message": "WHISP analysis failed.",
                            "response": status_data,
                        },
                    )

            raise HTTPException(
                status_code=504,
                detail="WHISP analysis did not finish within 120 seconds.",
            )

    except HTTPException:
        raise
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail=f"WHISP could not be reached: {error}",
        ) from error
