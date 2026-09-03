"""
Modulo de Produccion / Maquila.

Cubre: catalogos flexibles (tipos de operacion, operarios, mesas/grupos),
registro de actividades de produccion con multiples operarios simultaneos,
alertas de solapamiento de personal, calculo de productividad normalizada
(packs/hora, packs/operario, packs/hora-hombre, minutos-hombre/pack),
estandares aprendidos del historial, comparaciones, rankings, KPIs de
dashboard, alertas inteligentes y tendencias.

Este modulo NO toca inventory_movements ni el stock de almacen: es un
sistema de control de personal y productividad, independiente del kardex.
"""
import datetime

from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services.audit_service import log_change
from services import production_service as ps

bp = Blueprint("production", __name__)


# =============================== CATALOGOS ===================================
@bp.get("/operation-types")
@login_required
def list_operation_types():
    active_only = request.args.get("active_only")
    sql = "SELECT * FROM operation_types WHERE 1=1"
    if active_only:
        sql += " AND active=1"
    return jsonify(q(sql + " ORDER BY name"))


@bp.post("/operation-types")
@login_required
@require_permission("create", "edit")
def create_operation_type():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre es obligatorio"}), 400
    code = (d.get("code") or "").strip().upper() or name[:10].upper().replace(" ", "_")
    if q1("SELECT id FROM operation_types WHERE code=?", (code,)):
        return jsonify({"error": f"Ya existe el tipo de operacion {code}"}), 409
    oid = execute("INSERT INTO operation_types (code, name) VALUES (?,?)", (code, name))
    return jsonify({"id": oid, "code": code}), 201


@bp.put("/operation-types/<int:oid>")
@login_required
@require_permission("create", "edit")
def update_operation_type(oid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM operation_types WHERE id=?", (oid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    execute("UPDATE operation_types SET name=?, active=? WHERE id=?",
            (d.get("name", old["name"]), int(d.get("active", old["active"])), oid))
    return jsonify({"ok": True})


@bp.get("/operators")
@login_required
def list_operators():
    search = request.args.get("q", "").strip()
    active_only = request.args.get("active_only")
    sql = "SELECT * FROM operators WHERE 1=1"
    params = []
    if search:
        sql += " AND (name LIKE ? OR code LIKE ?)"; params += [f"%{search}%", f"%{search}%"]
    if active_only:
        sql += " AND active=1"
    sql += " ORDER BY name"
    return jsonify(q(sql, tuple(params)))


def _gen_operator_code():
    row = q1("SELECT COUNT(*) as n FROM operators")
    n = (row["n"] if row else 0) + 1
    while True:
        code = f"OP-{n:04d}"
        if not q1("SELECT id FROM operators WHERE code=?", (code,)):
            return code
        n += 1


@bp.post("/operators")
@login_required
@require_permission("create", "edit", "create_reception")
def create_operator():
    """Registrar un operario nuevo nunca debe bloquear el registro de una
    actividad: si no viene codigo se genera uno automaticamente."""
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre del operario es obligatorio"}), 400
    code = (d.get("code") or "").strip() or _gen_operator_code()
    if q1("SELECT id FROM operators WHERE code=?", (code,)):
        return jsonify({"error": f"Ya existe un operario con codigo {code}"}), 409
    oid = execute("INSERT INTO operators (code, name, document_id) VALUES (?,?,?)",
                  (code, name, d.get("document_id")))
    return jsonify({"id": oid, "code": code}), 201


@bp.put("/operators/<int:oid>")
@login_required
@require_permission("create", "edit")
def update_operator(oid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM operators WHERE id=?", (oid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    execute("UPDATE operators SET name=?, document_id=?, active=? WHERE id=?",
            (d.get("name", old["name"]), d.get("document_id", old["document_id"]),
             int(d.get("active", old["active"])), oid))
    return jsonify({"ok": True})


@bp.get("/work-groups")
@login_required
def list_work_groups():
    active_only = request.args.get("active_only")
    sql = "SELECT * FROM work_groups WHERE 1=1"
    if active_only:
        sql += " AND active=1"
    return jsonify(q(sql + " ORDER BY group_type, name"))


@bp.post("/work-groups")
@login_required
@require_permission("create", "edit", "create_reception")
def create_work_group():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre es obligatorio"}), 400
    code = (d.get("code") or "").strip().upper() or name.upper().replace(" ", "-")
    if q1("SELECT id FROM work_groups WHERE code=?", (code,)):
        return jsonify({"id": q1('SELECT id FROM work_groups WHERE code=?', (code,))["id"]}), 200
    gid = execute("INSERT INTO work_groups (code, name, group_type) VALUES (?,?,?)",
                  (code, name, d.get("group_type", "GRUPO")))
    return jsonify({"id": gid, "code": code}), 201


# =============================== ACTIVIDADES ==================================
def _base_activity_select():
    return """SELECT pa.*, c.name as client_name, p.sku_code, p.description as product_description,
                     ot.name as operation_type_name, wg.name as work_group_name, wg.group_type,
                     su.name as supervisor_name, cu.name as created_by_name
              FROM production_activities pa
              JOIN clients c ON c.id = pa.client_id
              LEFT JOIN products p ON p.id = pa.product_id
              LEFT JOIN operation_types ot ON ot.id = pa.operation_type_id
              LEFT JOIN work_groups wg ON wg.id = pa.work_group_id
              LEFT JOIN users su ON su.id = pa.supervisor_user_id
              LEFT JOIN users cu ON cu.id = pa.created_by"""


def _enrich(row):
    row = dict(row)
    row["product_label"] = row.get("product_description") or row.get("product_free_text") or None
    row["operation_label"] = row.get("operation_type_name") or row.get("operation_type_free_text") or "Sin clasificar"
    row["work_group_label"] = row.get("work_group_name") or row.get("work_group_free_text") or None
    row["supervisor_label"] = row.get("supervisor_name") or row.get("supervisor_free_text") or None
    row["metrics"] = ps.compute_metrics(row)
    return row


@bp.get("/production/activities")
@login_required
def list_activities():
    client_id = request.args.get("client_id")
    operation_type_id = request.args.get("operation_type_id")
    product_id = request.args.get("product_id")
    work_group_id = request.args.get("work_group_id")
    operator_id = request.args.get("operator_id")
    status = request.args.get("status")
    search = request.args.get("q", "").strip()
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset")
    limit = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))

    if preset:
        date_from, date_to = ps.resolve_date_preset(preset)

    where = " WHERE 1=1"
    params = []
    if client_id:
        where += " AND pa.client_id=?"; params.append(client_id)
    if operation_type_id:
        where += " AND pa.operation_type_id=?"; params.append(operation_type_id)
    if product_id:
        where += " AND pa.product_id=?"; params.append(product_id)
    if work_group_id:
        where += " AND pa.work_group_id=?"; params.append(work_group_id)
    if status:
        where += " AND pa.status=?"; params.append(status)
    if date_from:
        where += " AND pa.activity_date >= ?"; params.append(date_from)
    if date_to:
        where += " AND pa.activity_date <= ?"; params.append(date_to)
    if operator_id:
        where += " AND pa.id IN (SELECT production_activity_id FROM production_activity_operators WHERE operator_id=?)"
        params.append(operator_id)
    if search:
        where += """ AND (pa.work_order LIKE ? OR pa.description LIKE ? OR pa.product_free_text LIKE ?
                     OR pa.operation_type_free_text LIKE ?)"""
        params += [f"%{search}%"] * 4

    from_clause = " FROM production_activities pa" + where
    total = q1("SELECT COUNT(*) as n" + from_clause, tuple(params))["n"]

    sql = (_base_activity_select() + where +
           " ORDER BY pa.activity_date DESC, pa.start_time DESC LIMIT ? OFFSET ?")
    rows = q(sql, tuple(params) + (limit, offset))
    rows = [_enrich(r) for r in rows]
    return jsonify({"rows": rows, "total": total, "limit": limit, "offset": offset})


@bp.get("/production/activities/<int:aid>")
@login_required
def get_activity(aid):
    row = q1(_base_activity_select() + " WHERE pa.id=?", (aid,))
    if not row:
        return jsonify({"error": "no encontrado"}), 404
    row = _enrich(row)
    participants = q(
        """SELECT pao.id as participant_id, o.id as operator_id, o.code, o.name, pao.role_note
           FROM production_activity_operators pao JOIN operators o ON o.id=pao.operator_id
           WHERE pao.production_activity_id=? ORDER BY o.name""",
        (aid,),
    )
    row["participants"] = participants
    standard = ps.compute_standard(operation_type_id=row["operation_type_id"], product_id=row["product_id"], exclude_id=aid)
    row["standard"] = standard
    row["efficiency_pct"] = ps.efficiency_pct(row["metrics"]["packs_per_man_hour"], standard)
    row["overlap_warnings"] = ps.find_overlaps_for_operators(
        [p["operator_id"] for p in participants], row["activity_date"], row["start_time"], row["end_time"], exclude_activity_id=aid
    )
    return jsonify(row)


@bp.get("/production/activities/<int:aid>/history")
@login_required
def activity_history(aid):
    rows = q(
        """SELECT a.*, u.name as user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
           WHERE a.entity_type='production_activity' AND a.entity_id=? ORDER BY a.timestamp DESC""",
        (aid,),
    )
    return jsonify(rows)


def _consistency_errors(d):
    produced = float(d.get("qty_produced") or 0)
    good = float(d.get("qty_good") or 0)
    defective = float(d.get("qty_defective") or 0)
    if good + defective - produced > 0.01:
        return f"Buenas ({good:g}) + defectuosas ({defective:g}) no puede superar la produccion total ({produced:g})"
    return None


@bp.post("/production/activities")
@login_required
@require_permission("create", "edit", "create_reception")
def create_activity():
    d = request.get_json(force=True)
    if not d.get("client_id") or not d.get("activity_date") or not d.get("start_time"):
        return jsonify({"error": "client_id, activity_date y start_time son obligatorios"}), 400
    err = _consistency_errors(d)
    if err:
        return jsonify({"error": err}), 400

    operator_ids = [int(x) for x in (d.get("operator_ids") or [])]
    operator_count = int(d.get("operator_count") or len(operator_ids) or 0)

    overlap_warnings = ps.find_overlaps_for_operators(
        operator_ids, d["activity_date"], d.get("start_time"), d.get("end_time")
    )

    with tx():
        aid = execute(
            """INSERT INTO production_activities
                 (activity_date, client_id, work_order, product_id, product_free_text,
                  operation_type_id, operation_type_free_text, description, start_time, end_time,
                  qty_produced, qty_good, qty_defective, operator_count, work_group_id, work_group_free_text,
                  supervisor_user_id, supervisor_free_text, notes, status, created_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (d["activity_date"], d["client_id"], d.get("work_order"), d.get("product_id") or None,
             d.get("product_free_text"), d.get("operation_type_id") or None, d.get("operation_type_free_text"),
             d.get("description"), d["start_time"], d.get("end_time") or None,
             float(d.get("qty_produced") or 0), float(d.get("qty_good") or 0), float(d.get("qty_defective") or 0),
             operator_count, d.get("work_group_id") or None, d.get("work_group_free_text"),
             d.get("supervisor_user_id") or None, d.get("supervisor_free_text"), d.get("notes"),
             d.get("status", "EN_CURSO"), g.user["id"]),
        )
        for op_id in operator_ids:
            execute("INSERT OR IGNORE INTO production_activity_operators (production_activity_id, operator_id) VALUES (?,?)",
                    (aid, op_id))
        log_change("production_activity", aid, g.user["id"], action="CREATE",
                    new_value=d.get("description") or d.get("operation_type_free_text"))
    return jsonify({"id": aid, "overlap_warnings": overlap_warnings}), 201


@bp.put("/production/activities/<int:aid>")
@login_required
@require_permission("create", "edit", "create_reception", "edit_reception")
def update_activity(aid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM production_activities WHERE id=?", (aid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    err = _consistency_errors({**dict(old), **d})
    if err:
        return jsonify({"error": err}), 400

    fields = ["activity_date", "client_id", "work_order", "product_id", "product_free_text",
              "operation_type_id", "operation_type_free_text", "description", "start_time", "end_time",
              "qty_produced", "qty_good", "qty_defective", "operator_count", "work_group_id",
              "work_group_free_text", "supervisor_user_id", "supervisor_free_text", "notes"]
    updates = {k: d.get(k, old[k]) for k in fields}
    with tx():
        execute(
            f"UPDATE production_activities SET {','.join(f'{k}=?' for k in fields)}, updated_by=?, updated_at=datetime('now') WHERE id=?",
            (*[updates[k] for k in fields], g.user["id"], aid),
        )
        for k in fields:
            if str(old[k]) != str(updates[k]):
                log_change("production_activity", aid, g.user["id"], field=k, old_value=old[k], new_value=updates[k], reason=d.get("reason"))

    overlap_warnings = []
    if d.get("start_time") or d.get("end_time"):
        participants = [r["operator_id"] for r in q("SELECT operator_id FROM production_activity_operators WHERE production_activity_id=?", (aid,))]
        overlap_warnings = ps.find_overlaps_for_operators(participants, updates["activity_date"], updates["start_time"], updates["end_time"], exclude_activity_id=aid)
    return jsonify({"ok": True, "overlap_warnings": overlap_warnings})


@bp.put("/production/activities/<int:aid>/status")
@login_required
@require_permission("create", "edit", "approve", "create_reception")
def set_activity_status(aid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM production_activities WHERE id=?", (aid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    new_status = d.get("status")
    if new_status not in ("EN_CURSO", "FINALIZADA", "CANCELADA"):
        return jsonify({"error": "estado invalido"}), 400
    if new_status == "FINALIZADA" and not old["end_time"]:
        return jsonify({"error": "No se puede finalizar una actividad sin hora de finalizacion"}), 400
    execute("UPDATE production_activities SET status=?, updated_by=?, updated_at=datetime('now') WHERE id=?",
            (new_status, g.user["id"], aid))
    log_change("production_activity", aid, g.user["id"], field="status", old_value=old["status"], new_value=new_status, reason=d.get("reason"))
    return jsonify({"ok": True})


@bp.post("/production/activities/<int:aid>/participants")
@login_required
@require_permission("create", "edit", "create_reception")
def add_participants(aid):
    d = request.get_json(force=True)
    activity = q1("SELECT * FROM production_activities WHERE id=?", (aid,))
    if not activity:
        return jsonify({"error": "no encontrado"}), 404
    operator_ids = [int(x) for x in (d.get("operator_ids") or [])]
    with tx():
        for op_id in operator_ids:
            execute("INSERT OR IGNORE INTO production_activity_operators (production_activity_id, operator_id) VALUES (?,?)", (aid, op_id))
        n = q1("SELECT COUNT(*) as n FROM production_activity_operators WHERE production_activity_id=?", (aid,))["n"]
        execute("UPDATE production_activities SET operator_count=? WHERE id=?", (n, aid))
    overlap_warnings = ps.find_overlaps_for_operators(operator_ids, activity["activity_date"], activity["start_time"], activity["end_time"], exclude_activity_id=aid)
    return jsonify({"ok": True, "operator_count": n, "overlap_warnings": overlap_warnings})


@bp.delete("/production/activities/<int:aid>/participants/<int:operator_id>")
@login_required
@require_permission("create", "edit", "create_reception")
def remove_participant(aid, operator_id):
    execute("DELETE FROM production_activity_operators WHERE production_activity_id=? AND operator_id=?", (aid, operator_id))
    n = q1("SELECT COUNT(*) as n FROM production_activity_operators WHERE production_activity_id=?", (aid,))["n"]
    execute("UPDATE production_activities SET operator_count=? WHERE id=?", (n, aid))
    return jsonify({"ok": True, "operator_count": n})


# =============================== TIMELINE DE HOY ==============================
@bp.get("/production/today")
@login_required
def production_today():
    date = request.args.get("date") or ps._today_lima().isoformat()
    rows = q(_base_activity_select() + " WHERE pa.activity_date=? ORDER BY pa.start_time", (date,))
    rows = [_enrich(r) for r in rows]
    for r in rows:
        r["participants"] = q(
            "SELECT o.id, o.name FROM production_activity_operators pao JOIN operators o ON o.id=pao.operator_id WHERE pao.production_activity_id=?",
            (r["id"],),
        )
    total_production = sum(r["qty_produced"] or 0 for r in rows)
    active_operators = len({p["id"] for r in rows for p in r["participants"]})
    return jsonify({"date": date, "activities": rows, "total_production": total_production, "active_operators": active_operators})


# =============================== KPIs / DASHBOARD =============================
@bp.get("/production/kpis")
@login_required
def production_kpis():
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset", "this_month")
    if not date_from and not date_to:
        date_from, date_to = ps.resolve_date_preset(preset)

    where = " WHERE pa.status!='CANCELADA'"
    params = []
    if date_from:
        where += " AND pa.activity_date>=?"; params.append(date_from)
    if date_to:
        where += " AND pa.activity_date<=?"; params.append(date_to)
    rows = q("SELECT * FROM production_activities pa" + where, tuple(params))

    total_production = sum(r["qty_produced"] or 0 for r in rows)
    total_good = sum(r["qty_good"] or 0 for r in rows)
    total_defective = sum(r["qty_defective"] or 0 for r in rows)
    total_hours = 0.0
    total_man_hours = 0.0
    efficiencies = []
    for r in rows:
        m = ps.compute_metrics(r)
        if m["hours"]:
            total_hours += m["hours"]
        if m["man_hours"]:
            total_man_hours += m["man_hours"]
        if m["packs_per_man_hour"]:
            std = ps.compute_standard(operation_type_id=r["operation_type_id"], product_id=r["product_id"], exclude_id=r["id"])
            eff = ps.efficiency_pct(m["packs_per_man_hour"], std)
            if eff is not None:
                efficiencies.append(eff)

    distinct_operators = q1(
        """SELECT COUNT(DISTINCT pao.operator_id) as n FROM production_activity_operators pao
           JOIN production_activities pa ON pa.id=pao.production_activity_id""" + where, tuple(params)
    )["n"]
    distinct_dates = q1("SELECT COUNT(DISTINCT pa.activity_date) as n FROM production_activities pa" + where, tuple(params))["n"]
    utilization_pct = None
    if distinct_operators and distinct_dates:
        capacity = distinct_operators * distinct_dates * ps.ASSUMED_WORKDAY_HOURS
        utilization_pct = round(min(100, 100 * total_man_hours / capacity), 1) if capacity else None

    return jsonify({
        "date_from": str(date_from) if date_from else None, "date_to": str(date_to) if date_to else None,
        "total_production": total_production,
        "total_hours": round(total_hours, 1),
        "total_man_hours": round(total_man_hours, 1),
        "productivity_packs_per_man_hour": round(total_production / total_man_hours, 2) if total_man_hours else None,
        "avg_efficiency_pct": round(sum(efficiencies) / len(efficiencies), 1) if efficiencies else None,
        "quality_pct": round(100 * total_good / total_production, 1) if total_production else None,
        "defect_pct": round(100 * total_defective / total_production, 1) if total_production else None,
        "operators_active": distinct_operators,
        "utilization_pct": utilization_pct,
        "utilization_note": f"Estimado sobre jornada de {ps.ASSUMED_WORKDAY_HOURS:g}h por operario/dia con actividad registrada.",
        "activities_count": len(rows),
    })


@bp.get("/production/standards")
@login_required
def production_standards():
    return jsonify(ps.compute_standard(
        operation_type_id=request.args.get("operation_type_id"),
        product_id=request.args.get("product_id"),
        client_id=request.args.get("client_id"),
    ))


@bp.get("/production/ranking")
@login_required
def production_ranking():
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset")
    if preset:
        date_from, date_to = ps.resolve_date_preset(preset)
    where = " WHERE pa.status!='CANCELADA'"
    params = []
    if date_from:
        where += " AND pa.activity_date>=?"; params.append(date_from)
    if date_to:
        where += " AND pa.activity_date<=?"; params.append(date_to)
    rows = q("SELECT pa.*, COALESCE(ot.name, pa.operation_type_free_text, 'Sin clasificar') as op_label, pa.operation_type_id as op_id "
             "FROM production_activities pa LEFT JOIN operation_types ot ON ot.id=pa.operation_type_id" + where, tuple(params))

    groups = {}
    for r in rows:
        key = r["op_label"]
        groups.setdefault(key, []).append(r)

    ranking = []
    for label, acts in groups.items():
        produced = sum(a["qty_produced"] or 0 for a in acts)
        good = sum(a["qty_good"] or 0 for a in acts)
        defective = sum(a["qty_defective"] or 0 for a in acts)
        man_hours = sum((ps.compute_metrics(a)["man_hours"] or 0) for a in acts)
        avg_minutes = [ps.compute_metrics(a)["minutes_man_per_pack"] for a in acts if ps.compute_metrics(a)["minutes_man_per_pack"]]
        ranking.append({
            "operation_label": label,
            "activities_count": len(acts),
            "total_production": produced,
            "packs_per_man_hour": round(produced / man_hours, 2) if man_hours else None,
            "avg_minutes_man_per_pack": round(sum(avg_minutes) / len(avg_minutes), 2) if avg_minutes else None,
            "quality_pct": round(100 * good / produced, 1) if produced else None,
            "defect_pct": round(100 * defective / produced, 1) if produced else None,
        })
    ranking.sort(key=lambda r: r["packs_per_man_hour"] or 0, reverse=True)
    return jsonify(ranking)


@bp.get("/production/by-operator")
@login_required
def production_by_operator():
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset")
    operation_type_id = request.args.get("operation_type_id")
    if preset:
        date_from, date_to = ps.resolve_date_preset(preset)

    where = " WHERE pa.status!='CANCELADA'"
    params = []
    if date_from:
        where += " AND pa.activity_date>=?"; params.append(date_from)
    if date_to:
        where += " AND pa.activity_date<=?"; params.append(date_to)
    if operation_type_id:
        where += " AND pa.operation_type_id=?"; params.append(operation_type_id)

    activities = q("SELECT pa.* FROM production_activities pa" + where, tuple(params))
    act_by_id = {a["id"]: a for a in activities}
    if not act_by_id:
        return jsonify([])
    placeholders = ",".join("?" * len(act_by_id))
    links = q(f"SELECT pao.operator_id, o.name, o.code, pao.production_activity_id FROM production_activity_operators pao "
              f"JOIN operators o ON o.id=pao.operator_id WHERE pao.production_activity_id IN ({placeholders})", tuple(act_by_id.keys()))

    per_op = {}
    for link in links:
        act = act_by_id[link["production_activity_id"]]
        m = ps.compute_metrics(act)
        bucket = per_op.setdefault(link["operator_id"], {
            "operator_id": link["operator_id"], "name": link["name"], "code": link["code"],
            "activities_count": 0, "hours": 0.0, "man_hours": 0.0, "estimated_production": 0.0,
            "quality_samples": [],
        })
        bucket["activities_count"] += 1
        bucket["hours"] += m["hours"] or 0
        bucket["man_hours"] += m["hours"] or 0  # 1 operario x sus propias horas
        if act["operator_count"]:
            bucket["estimated_production"] += (act["qty_produced"] or 0) / act["operator_count"]
        if m["quality_pct"] is not None:
            bucket["quality_samples"].append(m["quality_pct"])

    out = []
    for b in per_op.values():
        out.append({
            "operator_id": b["operator_id"], "name": b["name"], "code": b["code"],
            "activities_count": b["activities_count"],
            "hours": round(b["hours"], 1),
            "man_hours": round(b["man_hours"], 1),
            "estimated_production": round(b["estimated_production"], 1),
            "estimated_packs_per_hour": round(b["estimated_production"] / b["hours"], 2) if b["hours"] else None,
            "avg_quality_pct": round(sum(b["quality_samples"]) / len(b["quality_samples"]), 1) if b["quality_samples"] else None,
        })
    out.sort(key=lambda r: r["hours"], reverse=True)
    return jsonify({
        "rows": out,
        "note": "La produccion por operario es un estimado (produccion de cada actividad repartida entre sus participantes), "
                "porque el registro es por actividad/grupo, no por persona. Compare solo dentro de la misma operacion/producto.",
    })


@bp.get("/production/by-client")
@login_required
def production_by_client():
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset")
    if preset:
        date_from, date_to = ps.resolve_date_preset(preset)
    where = " WHERE pa.status!='CANCELADA'"
    params = []
    if date_from:
        where += " AND pa.activity_date>=?"; params.append(date_from)
    if date_to:
        where += " AND pa.activity_date<=?"; params.append(date_to)
    rows = q("SELECT pa.*, c.name as client_name FROM production_activities pa JOIN clients c ON c.id=pa.client_id" + where, tuple(params))
    groups = {}
    for r in rows:
        groups.setdefault(r["client_id"], {"client_name": r["client_name"], "acts": []})["acts"].append(r)
    out = []
    for cid, g_ in groups.items():
        acts = g_["acts"]
        produced = sum(a["qty_produced"] or 0 for a in acts)
        good = sum(a["qty_good"] or 0 for a in acts)
        man_hours = sum((ps.compute_metrics(a)["man_hours"] or 0) for a in acts)
        out.append({
            "client_id": cid, "client_name": g_["client_name"], "activities_count": len(acts),
            "total_production": produced, "total_man_hours": round(man_hours, 1),
            "packs_per_man_hour": round(produced / man_hours, 2) if man_hours else None,
            "quality_pct": round(100 * good / produced, 1) if produced else None,
        })
    out.sort(key=lambda r: r["total_man_hours"], reverse=True)
    return jsonify(out)


@bp.get("/production/compare")
@login_required
def production_compare():
    ids = [int(x) for x in request.args.get("ids", "").split(",") if x.strip().isdigit()]
    if not ids:
        return jsonify({"error": "Pase ids=1,2,3"}), 400
    out = []
    for aid in ids:
        row = q1(_base_activity_select() + " WHERE pa.id=?", (aid,))
        if not row:
            continue
        row = _enrich(row)
        std = ps.compute_standard(operation_type_id=row["operation_type_id"], product_id=row["product_id"], exclude_id=aid)
        row["efficiency_pct"] = ps.efficiency_pct(row["metrics"]["packs_per_man_hour"], std)
        out.append(row)
    winner = max((r for r in out if r["metrics"]["packs_per_man_hour"]), key=lambda r: r["metrics"]["packs_per_man_hour"], default=None)
    return jsonify({"activities": out, "most_productive_id": winner["id"] if winner else None})


# =============================== TENDENCIAS ====================================
@bp.get("/production/trends")
@login_required
def production_trends():
    granularity = request.args.get("granularity", "week")  # week | month
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset", "last_30_days" if granularity == "week" else "this_month")
    if not date_from and not date_to:
        date_from, date_to = ps.resolve_date_preset(preset)
    where = " WHERE pa.status!='CANCELADA'"
    params = []
    if date_from:
        where += " AND pa.activity_date>=?"; params.append(str(date_from))
    if date_to:
        where += " AND pa.activity_date<=?"; params.append(str(date_to))
    rows = q("SELECT * FROM production_activities pa" + where, tuple(params))

    buckets = {}
    for r in rows:
        d = datetime.date.fromisoformat(r["activity_date"][:10])
        key = d.strftime("%G-W%V") if granularity == "week" else d.strftime("%Y-%m")
        buckets.setdefault(key, []).append(r)

    out = []
    for key in sorted(buckets.keys()):
        acts = buckets[key]
        produced = sum(a["qty_produced"] or 0 for a in acts)
        good = sum(a["qty_good"] or 0 for a in acts)
        man_hours = sum((ps.compute_metrics(a)["man_hours"] or 0) for a in acts)
        out.append({
            "period": key, "total_production": produced,
            "productivity_packs_per_man_hour": round(produced / man_hours, 2) if man_hours else None,
            "quality_pct": round(100 * good / produced, 1) if produced else None,
            "activities_count": len(acts),
        })
    best = max(out, key=lambda r: r["productivity_packs_per_man_hour"] or 0, default=None)
    worst = min((o for o in out if o["productivity_packs_per_man_hour"]), key=lambda r: r["productivity_packs_per_man_hour"], default=None)
    return jsonify({"periods": out, "best_period": best, "worst_period": worst})


# =============================== ALERTAS =======================================
@bp.get("/production/alerts")
@login_required
def production_alerts():
    return jsonify(ps.compute_alerts())
