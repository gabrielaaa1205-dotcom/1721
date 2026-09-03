import datetime

from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services.audit_service import log_change
from services import stock_service
from services.stock_service import StockError

bp = Blueprint("receptions", __name__)


def _today_lima():
    """La empresa opera en hora Peru (UTC-5); los presets de fecha ('hoy',
    'esta semana', etc.) deben calcularse en esa zona, no en UTC del servidor."""
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def resolve_date_preset(preset):
    """Traduce un preset de fecha en lenguaje natural a (fecha_desde, fecha_hasta)."""
    today = _today_lima()
    if preset == "today":
        return today, today
    if preset == "this_week":
        start = today - datetime.timedelta(days=today.weekday())
        return start, today
    if preset == "last_week":
        start_this = today - datetime.timedelta(days=today.weekday())
        start = start_this - datetime.timedelta(days=7)
        end = start_this - datetime.timedelta(days=1)
        return start, end
    if preset == "this_month":
        return today.replace(day=1), today
    if preset == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - datetime.timedelta(days=1)
        return last_prev.replace(day=1), last_prev
    if preset == "last_7_days":
        return today - datetime.timedelta(days=6), today
    if preset == "last_30_days":
        return today - datetime.timedelta(days=29), today
    return None, None


def gen_reception_number():
    today = datetime.date.today().strftime("%Y%m%d")
    row = q1("SELECT COUNT(*) as n FROM receptions WHERE reception_number LIKE ?", (f"REC-{today}-%",))
    seq = (row["n"] if row else 0) + 1
    return f"REC-{today}-{seq:03d}"


def get_or_create_lot(product_id, lot_code, expiration_date, origin_reception_id=None):
    if not lot_code:
        return None
    row = q1("SELECT * FROM lots WHERE product_id=? AND lot_code=?", (product_id, lot_code))
    if row:
        return row["id"]
    return execute(
        "INSERT INTO lots (product_id, lot_code, expiration_date, origin_reception_id) VALUES (?,?,?,?)",
        (product_id, lot_code, expiration_date, origin_reception_id),
    )


# =============================== CABECERA ===================================
@bp.get("/receptions")
@login_required
def list_receptions():
    client_id = request.args.get("client_id")
    status = request.args.get("status")
    search = request.args.get("q", "").strip()
    sku = request.args.get("sku", "").strip()
    product_id = request.args.get("product_id")
    user_id = request.args.get("user_id")
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    preset = request.args.get("preset")
    limit = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))

    if preset:
        date_from, date_to = resolve_date_preset(preset)

    where = " WHERE 1=1"
    params = []
    if client_id:
        where += " AND r.client_id=?"; params.append(client_id)
    if status:
        where += " AND r.status=?"; params.append(status)
    if user_id:
        where += " AND r.created_by=?"; params.append(user_id)
    if date_from:
        where += " AND r.reception_date >= ?"; params.append(date_from)
    if date_to:
        where += " AND r.reception_date <= ?"; params.append(date_to)
    if search:
        where += " AND (r.reception_number LIKE ? OR r.guide_number LIKE ? OR r.container_number LIKE ? OR r.order_number LIKE ?)"
        params += [f"%{search}%"] * 4
    if sku or product_id:
        where += " AND r.id IN (SELECT ri.reception_id FROM reception_items ri JOIN products p ON p.id=ri.product_id WHERE 1=1"
        if sku:
            where += " AND (p.sku_code LIKE ? OR p.description LIKE ?)"; params += [f"%{sku}%", f"%{sku}%"]
        if product_id:
            where += " AND p.id=?"; params.append(product_id)
        where += ")"

    from_clause = " FROM receptions r JOIN clients c ON c.id=r.client_id LEFT JOIN users u ON u.id=r.created_by"
    total = q1("SELECT COUNT(*) as n" + from_clause + where, tuple(params))["n"]

    # Orden cronologico: mas reciente primero (fecha de ingreso, luego hora de registro)
    select_sql = ("SELECT r.*, c.name as client_name, u.name as created_by_name,"
                  " (SELECT COUNT(*) FROM reception_items ri WHERE ri.reception_id=r.id) as item_count"
                  + from_clause + where + " ORDER BY r.reception_date DESC, r.created_at DESC LIMIT ? OFFSET ?")
    rows = q(select_sql, tuple(params) + (limit, offset))
    return jsonify({"rows": rows, "total": total, "limit": limit, "offset": offset})


@bp.get("/receptions/<int:rid>")
@login_required
def get_reception(rid):
    rec = q1("""SELECT r.*, c.name as client_name FROM receptions r JOIN clients c ON c.id=r.client_id WHERE r.id=?""", (rid,))
    if not rec:
        return jsonify({"error": "no encontrado"}), 404
    items = q(
        """SELECT ri.*, p.sku_code, p.description as product_description, l.lot_code, l.expiration_date,
                  a.name as activity_name, loc.full_code as location_code
           FROM reception_items ri
           JOIN products p ON p.id = ri.product_id
           LEFT JOIN lots l ON l.id = ri.lot_id
           LEFT JOIN activities a ON a.id = ri.activity_id
           LEFT JOIN locations loc ON loc.id = ri.location_id
           WHERE ri.reception_id=?""",
        (rid,),
    )
    for it in items:
        locs = q(
            """SELECT ril.qty, loc.full_code as location_code
               FROM reception_item_locations ril JOIN locations loc ON loc.id = ril.location_id
               WHERE ril.reception_item_id=? ORDER BY ril.created_at""",
            (it["id"],),
        )
        it["locations"] = locs
        it["located_qty"] = sum(l["qty"] for l in locs)
        it["remaining_to_locate"] = max(0, it["qty_units"] - it["located_qty"])
    return jsonify({**rec, "items": items})


@bp.get("/receptions/<int:rid>/history")
@login_required
def reception_history(rid):
    """Trazabilidad completa: quien la creo, cada cambio de cabecera, cada item
    agregado/inspeccionado/ubicado, con usuario, fecha/hora y valor anterior/nuevo."""
    rec = q1("SELECT * FROM receptions WHERE id=?", (rid,))
    if not rec:
        return jsonify({"error": "no encontrado"}), 404
    item_ids = [r["id"] for r in q("SELECT id FROM reception_items WHERE reception_id=?", (rid,))]
    placeholders = ",".join("?" * len(item_ids)) if item_ids else "-1"
    rows = q(
        f"""SELECT a.*, u.name as user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
            WHERE (a.entity_type='reception' AND a.entity_id=?)
               OR (a.entity_type='reception_item' AND a.entity_id IN ({placeholders}))
            ORDER BY a.timestamp DESC""",
        tuple([rid] + item_ids),
    )
    return jsonify(rows)


@bp.post("/receptions")
@login_required
@require_permission("create_reception", "create")
def create_reception():
    d = request.get_json(force=True)
    if not d.get("client_id") or not d.get("reception_date"):
        return jsonify({"error": "client_id y reception_date son obligatorios"}), 400
    with tx():
        number = gen_reception_number()
        rid = execute(
            """INSERT INTO receptions (reception_number, client_id, reception_date, reception_time,
                 container_number, order_number, guide_number, origin, cargo_type, purchase_order,
                 status, created_by, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (number, d["client_id"], d["reception_date"], d.get("reception_time"),
             d.get("container_number"), d.get("order_number"), d.get("guide_number"), d.get("origin"),
             d.get("cargo_type"), d.get("purchase_order"), "PENDIENTE", g.user["id"], "MANUAL"),
        )
        log_change("reception", rid, g.user["id"], action="CREATE", new_value=number)
    return jsonify({"id": rid, "reception_number": number}), 201


@bp.put("/receptions/<int:rid>")
@login_required
@require_permission("create_reception", "edit_reception", "edit")
def update_reception(rid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM receptions WHERE id=?", (rid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    fields = ["reception_date", "reception_time", "container_number", "order_number", "guide_number",
              "origin", "cargo_type", "purchase_order"]
    updates = {k: d.get(k, old[k]) for k in fields}
    execute(
        f"UPDATE receptions SET {','.join(f'{k}=?' for k in fields)}, updated_by=?, updated_at=datetime('now') WHERE id=?",
        (*[updates[k] for k in fields], g.user["id"], rid),
    )
    for k in fields:
        if str(old[k]) != str(updates[k]):
            log_change("reception", rid, g.user["id"], field=k, old_value=old[k], new_value=updates[k])
    return jsonify({"ok": True})


@bp.put("/receptions/<int:rid>/status")
@login_required
@require_permission("create_reception", "edit_reception", "approve")
def set_reception_status(rid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM receptions WHERE id=?", (rid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    new_status = d.get("status")
    valid = {"PENDIENTE", "EN_PROCESO", "OBSERVADO", "COMPLETADO", "BLOQUEADO", "CANCELADO"}
    if new_status not in valid:
        return jsonify({"error": "estado invalido"}), 400
    execute("UPDATE receptions SET status=?, updated_by=?, updated_at=datetime('now') WHERE id=?",
            (new_status, g.user["id"], rid))
    log_change("reception", rid, g.user["id"], field="status", old_value=old["status"], new_value=new_status, reason=d.get("reason"))
    return jsonify({"ok": True})


# =============================== DETALLE (ITEMS) =============================
@bp.post("/receptions/<int:rid>/items")
@login_required
@require_permission("create_reception", "edit_reception", "create")
def add_item(rid):
    d = request.get_json(force=True)
    reception = q1("SELECT * FROM receptions WHERE id=?", (rid,))
    if not reception:
        return jsonify({"error": "recepcion no encontrada"}), 404
    if not d.get("product_id") or d.get("qty_units") in (None, ""):
        return jsonify({"error": "product_id y qty_units son obligatorios"}), 400

    cfg = q1("SELECT * FROM client_configs WHERE client_id=?", (reception["client_id"],))
    if cfg and cfg["requires_lot"] and not d.get("lot_code"):
        return jsonify({"error": "Este cliente exige lote obligatorio"}), 400

    if d.get("expiration_date") and d.get("reception_date_check", reception["reception_date"]):
        try:
            exp = datetime.date.fromisoformat(d["expiration_date"][:10])
            rec_date = datetime.date.fromisoformat(reception["reception_date"][:10])
            if exp < rec_date:
                return jsonify({"error": "La fecha de vencimiento no puede ser anterior a la fecha de ingreso"}), 400
        except ValueError:
            return jsonify({"error": "Fecha invalida"}), 400

    with tx():
        lot_id = get_or_create_lot(d["product_id"], d.get("lot_code"), d.get("expiration_date"), origin_reception_id=rid)
        item_id = execute(
            """INSERT INTO reception_items (reception_id, product_id, lot_id, qty_cases, qty_units,
                 activity_id, promotion_id, notes, quality_status, storage_status)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rid, d["product_id"], lot_id, d.get("qty_cases") or None, d["qty_units"], d.get("activity_id") or None,
             d.get("promotion_id") or None, d.get("notes"), "PENDIENTE", "PENDIENTE"),
        )
        if reception["status"] == "PENDIENTE":
            execute("UPDATE receptions SET status='EN_PROCESO' WHERE id=?", (rid,))
    return jsonify({"id": item_id, "lot_id": lot_id}), 201


@bp.delete("/receptions/items/<int:item_id>")
@login_required
@require_permission("create_reception", "edit_reception", "edit")
def delete_item(item_id):
    item = q1("SELECT * FROM reception_items WHERE id=?", (item_id,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    if item["quality_status"] not in ("PENDIENTE",):
        return jsonify({"error": "No se puede eliminar un item ya inspeccionado (crear ajuste en su lugar)"}), 400
    execute("DELETE FROM reception_items WHERE id=?", (item_id,))
    return jsonify({"ok": True})


@bp.put("/receptions/items/<int:item_id>")
@login_required
@require_permission("create_reception", "edit_reception", "edit")
def update_item(item_id):
    """Editar cantidad/lote/vencimiento/actividad de un item mientras siga
    PENDIENTE de calidad (una vez inspeccionado, se corrige con un ajuste,
    no editando el registro original, para no perder trazabilidad)."""
    item = q1("SELECT * FROM reception_items WHERE id=?", (item_id,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    if item["quality_status"] != "PENDIENTE":
        return jsonify({"error": "Este item ya paso por control de calidad; no se puede editar (haga un ajuste de inventario en su lugar)"}), 400
    d = request.get_json(force=True)
    if d.get("qty_units") in (None, "") or float(d["qty_units"]) <= 0:
        return jsonify({"error": "La cantidad debe ser mayor a cero"}), 400

    lot_id = item["lot_id"]
    if d.get("lot_code") is not None or d.get("expiration_date") is not None:
        lot_id = get_or_create_lot(item["product_id"], d.get("lot_code"), d.get("expiration_date"), origin_reception_id=item["reception_id"])

    execute(
        """UPDATE reception_items SET lot_id=?, qty_cases=?, qty_units=?, activity_id=?, notes=?
           WHERE id=?""",
        (lot_id, d.get("qty_cases") or None, d["qty_units"], d.get("activity_id") or None,
         d.get("notes", item["notes"]), item_id),
    )
    return jsonify({"ok": True})


# =============================== CONTROL DE CALIDAD ==========================
@bp.post("/receptions/items/<int:item_id>/inspect")
@login_required
@require_permission("quality", "edit")
def inspect_item(item_id):
    d = request.get_json(force=True)
    item = q1("SELECT * FROM reception_items WHERE id=?", (item_id,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    reception = q1("SELECT * FROM receptions WHERE id=?", (item["reception_id"],))

    inspected = float(d.get("inspected_qty", item["qty_units"]))
    conforming = float(d.get("conforming_qty", 0))
    defective = float(d.get("defective_qty", 0))
    disposition = d.get("disposition", "CUARENTENA")
    if disposition not in ("CUARENTENA", "OBSERVADO", "RECHAZADO", "DANADO"):
        return jsonify({"error": "disposition invalida"}), 400
    if abs((conforming + defective) - inspected) > 0.01:
        return jsonify({"error": "conforming_qty + defective_qty debe ser igual a inspected_qty"}), 400

    with tx():
        insp_id = execute(
            """INSERT INTO quality_inspections (reception_item_id, inspected_qty, conforming_qty, defective_qty, inspector_user_id, notes)
               VALUES (?,?,?,?,?,?)""",
            (item_id, inspected, conforming, defective, g.user["id"], d.get("notes")),
        )
        for defect in d.get("defects", []):
            execute("INSERT INTO quality_inspection_defects (quality_inspection_id, defect_type_id, qty) VALUES (?,?,?)",
                    (insp_id, defect["defect_type_id"], defect["qty"]))

        if conforming > 0:
            stock_service.record_movement(
                "RECEPCION", item["product_id"], reception["client_id"], conforming, g.user["id"],
                lot_id=item["lot_id"], to_location_id=None, to_status="DISPONIBLE",
                reference_type="RECEPTION", reference_id=reception["id"],
                reason=f"Ingreso conforme - recepcion {reception['reception_number']}",
            )
        if defective > 0:
            stock_service.record_movement(
                "RECEPCION", item["product_id"], reception["client_id"], defective, g.user["id"],
                lot_id=item["lot_id"], to_location_id=None, to_status=disposition,
                reference_type="RECEPTION", reference_id=reception["id"],
                reason=f"Ingreso con defecto ({disposition}) - recepcion {reception['reception_number']}",
            )
        new_quality_status = "DISPONIBLE" if defective == 0 else (disposition if conforming == 0 else "OBSERVADO")
        execute("UPDATE reception_items SET quality_status=? WHERE id=?", (new_quality_status, item_id))

        pending = q1(
            "SELECT COUNT(*) as n FROM reception_items WHERE reception_id=? AND quality_status='PENDIENTE'",
            (reception["id"],),
        )
        if pending["n"] == 0:
            has_issues = q1(
                "SELECT COUNT(*) as n FROM reception_items WHERE reception_id=? AND quality_status NOT IN ('DISPONIBLE')",
                (reception["id"],),
            )
            execute("UPDATE receptions SET status=? WHERE id=?",
                    ("OBSERVADO" if has_issues["n"] else "EN_PROCESO", reception["id"]))

    pct_conforme = round(100 * conforming / inspected, 1) if inspected else 0
    pct_defecto = round(100 * defective / inspected, 1) if inspected else 0
    return jsonify({"ok": True, "pct_conformidad": pct_conforme, "pct_defecto": pct_defecto})


# =============================== UBICACION (PUTAWAY) =========================
@bp.get("/receptions/items/<int:item_id>/suggest-location")
@login_required
@require_permission("locate", "view")
def suggest_location(item_id):
    item = q1("SELECT * FROM reception_items WHERE id=?", (item_id,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    reception = q1("SELECT * FROM receptions WHERE id=?", (item["reception_id"],))
    suggestion = stock_service.suggest_location(item["product_id"], reception["client_id"], item["qty_units"])
    if not suggestion:
        return jsonify({"error": "No hay ubicaciones con capacidad disponible"}), 404
    return jsonify(suggestion)


@bp.post("/receptions/items/<int:item_id>/putaway")
@login_required
@require_permission("locate", "edit")
def putaway_item(item_id):
    d = request.get_json(force=True)
    try:
        with tx():
            result = stock_service.putaway(item_id, d["location_id"], g.user["id"], qty=d.get("qty"))
            item = q1("SELECT * FROM reception_items WHERE id=?", (item_id,))
            all_located = q1(
                """SELECT COUNT(*) as n FROM reception_items
                   WHERE reception_id=? AND quality_status='DISPONIBLE' AND storage_status IN ('PENDIENTE','PARCIAL')""",
                (item["reception_id"],),
            )
            if all_located["n"] == 0:
                execute("UPDATE receptions SET status='COMPLETADO' WHERE id=? AND status NOT IN ('BLOQUEADO','CANCELADO')",
                        (item["reception_id"],))
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **result})
