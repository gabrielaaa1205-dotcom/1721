from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services import stock_service
from services.stock_service import StockError
from services.audit_service import log_change

bp = Blueprint("inventory", __name__)


@bp.get("/stock")
@login_required
def stock_query():
    sql = """
        SELECT b.product_id, b.lot_id, b.client_id, b.location_id, b.status, b.qty,
               p.sku_code, p.description as product_description, p.unit_of_measure, p.item_type,
               c.name as client_name, c.code as client_code,
               l.lot_code, l.expiration_date,
               loc.full_code as location_code,
               r.order_number, r.reception_number
        FROM inventory_balances b
        JOIN products p ON p.id = b.product_id
        JOIN clients c ON c.id = b.client_id
        LEFT JOIN lots l ON l.id = b.lot_id
        LEFT JOIN locations loc ON loc.id = b.location_id
        LEFT JOIN receptions r ON r.id = l.origin_reception_id
        WHERE 1=1
    """
    params = []
    for field, col in [("product_id", "b.product_id"), ("client_id", "b.client_id"),
                        ("lot_id", "b.lot_id"), ("location_id", "b.location_id"), ("status", "b.status")]:
        val = request.args.get(field)
        if val:
            sql += f" AND {col}=?"; params.append(val)
    item_type = request.args.get("item_type")
    if item_type:
        sql += " AND p.item_type=?"; params.append(item_type)
    sku = request.args.get("sku")
    if sku:
        sql += " AND p.sku_code LIKE ?"; params.append(f"%{sku}%")
    lot_code = request.args.get("lot_code")
    if lot_code:
        sql += " AND l.lot_code LIKE ?"; params.append(f"%{lot_code}%")
    order_number = request.args.get("order_number")
    if order_number:
        sql += " AND r.order_number LIKE ?"; params.append(f"%{order_number}%")
    sql += " ORDER BY p.description, b.status"
    rows = q(sql, tuple(params))
    total = sum(r["qty"] for r in rows)
    return jsonify({"rows": rows, "total_qty": total, "count": len(rows)})


@bp.get("/stock/summary-by-product")
@login_required
def stock_summary_by_product():
    """Vista agregada: SKU -> total DISPONIBLE, RESERVADO, CUARENTENA, etc + desglose por ubicacion."""
    rows = q(
        """SELECT p.id as product_id, p.sku_code, p.description, c.name as client_name, b.status,
                  SUM(b.qty) as qty
           FROM inventory_balances b
           JOIN products p ON p.id=b.product_id
           JOIN clients c ON c.id=b.client_id
           GROUP BY p.id, b.status
           ORDER BY p.description"""
    )
    grouped = {}
    for r in rows:
        key = r["product_id"]
        if key not in grouped:
            grouped[key] = {"product_id": key, "sku_code": r["sku_code"], "description": r["description"],
                             "client_name": r["client_name"], "by_status": {}, "total": 0}
        grouped[key]["by_status"][r["status"]] = r["qty"]
        grouped[key]["total"] += r["qty"]
    return jsonify(list(grouped.values()))


@bp.get("/products/<int:pid>/locations")
@login_required
def product_locations(pid):
    """Responde: donde esta el SKU X (desglose por ubicacion y lote)."""
    rows = q(
        """SELECT b.*, loc.full_code as location_code, l.lot_code, l.expiration_date,
                  rk.code as rack_code, z.code as zone_code
           FROM inventory_balances b
           LEFT JOIN locations loc ON loc.id=b.location_id
           LEFT JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           LEFT JOIN racks rk ON rk.id = lvl.rack_id
           LEFT JOIN zones z ON z.id = rk.zone_id
           LEFT JOIN lots l ON l.id=b.lot_id
           WHERE b.product_id=? ORDER BY b.status, loc.full_code""",
        (pid,),
    )
    return jsonify(rows)


@bp.get("/movements")
@login_required
def list_movements():
    sql = """SELECT m.*, p.sku_code, p.description as product_description, l.lot_code,
                     fl.full_code as from_location_code, tl.full_code as to_location_code,
                     u.name as user_name, c.name as client_name
              FROM inventory_movements m
              JOIN products p ON p.id=m.product_id
              LEFT JOIN lots l ON l.id=m.lot_id
              LEFT JOIN locations fl ON fl.id=m.from_location_id
              LEFT JOIN locations tl ON tl.id=m.to_location_id
              LEFT JOIN users u ON u.id=m.user_id
              JOIN clients c ON c.id = m.client_id
              WHERE 1=1"""
    params = []
    for field, col in [("product_id", "m.product_id"), ("lot_id", "m.lot_id"), ("client_id", "m.client_id"),
                        ("movement_type", "m.movement_type"), ("reference_type", "m.reference_type"),
                        ("reference_id", "m.reference_id")]:
        val = request.args.get(field)
        if val:
            sql += f" AND {col}=?"; params.append(val)
    sql += " ORDER BY m.movement_date DESC, m.id DESC LIMIT ?"
    params.append(int(request.args.get("limit", 200)))
    return jsonify(q(sql, tuple(params)))


@bp.get("/lots/<int:lot_id>/trace")
@login_required
def trace_lot(lot_id):
    """Linea de tiempo completa: recepcion -> calidad -> ubicacion -> reservas -> picking -> despacho."""
    lot = q1("""SELECT l.*, p.sku_code, p.description, c.name as client_name, c.id as client_id
                FROM lots l JOIN products p ON p.id=l.product_id JOIN clients c ON c.id=p.client_id WHERE l.id=?""", (lot_id,))
    if not lot:
        return jsonify({"error": "no encontrado"}), 404

    events = []
    rec_items = q(
        """SELECT ri.*, r.reception_number, r.reception_date, r.client_id, r.status as reception_status
           FROM reception_items ri JOIN receptions r ON r.id=ri.reception_id WHERE ri.lot_id=?""", (lot_id,))
    for ri in rec_items:
        events.append({"type": "RECEPCION", "date": ri["reception_date"], "label": f"Recepcion {ri['reception_number']}",
                        "detail": f"{ri['qty_units']:g} unidades ingresadas", "ref": ri["reception_number"]})
        insp = q1("SELECT * FROM quality_inspections WHERE reception_item_id=?", (ri["id"],))
        if insp:
            events.append({"type": "CALIDAD", "date": insp["inspection_date"],
                            "label": "Inspeccion de calidad",
                            "detail": f"Conforme: {insp['conforming_qty']:g} · Defectuoso: {insp['defective_qty']:g}",
                            "ref": ri["reception_number"]})
        if ri["location_id"]:
            loc = q1("SELECT full_code FROM locations WHERE id=?", (ri["location_id"],))
            events.append({"type": "UBICACION", "date": ri["reception_date"],
                            "label": f"Ubicado en {loc['full_code'] if loc else '?'}",
                            "detail": "Asignacion de ubicacion tras control de calidad", "ref": ri["reception_number"]})

    movements = q(
        """SELECT m.*, fl.full_code as from_code, tl.full_code as to_code, u.name as user_name
           FROM inventory_movements m
           LEFT JOIN locations fl ON fl.id=m.from_location_id
           LEFT JOIN locations tl ON tl.id=m.to_location_id
           LEFT JOIN users u ON u.id=m.user_id
           WHERE m.lot_id=? AND m.movement_type IN ('TRANSFERENCIA','RESERVA','LIBERACION_RESERVA','DESPACHO','MERMA','AJUSTE_POSITIVO','AJUSTE_NEGATIVO','CUARENTENA','LIBERACION_CALIDAD','DEVOLUCION')
           ORDER BY m.movement_date""",
        (lot_id,),
    )
    for m in movements:
        events.append({"type": m["movement_type"], "date": m["movement_date"],
                        "label": m["movement_type"].replace("_", " ").title(),
                        "detail": f"{m['qty']:g} unidades" + (f" · {m['reason']}" if m["reason"] else ""),
                        "ref": f"{m['from_code'] or ''} -> {m['to_code'] or 'SALIDA'}"})

    disp_items = q(
        """SELECT di.*, d.dispatch_number, d.dispatch_date, d.status as dispatch_status
           FROM dispatch_items di JOIN dispatches d ON d.id=di.dispatch_id WHERE di.lot_id=?""", (lot_id,))
    for di in disp_items:
        events.append({"type": "DESPACHO", "date": di["expiration_date"] or "", "label": f"Despacho {di['dispatch_number']}",
                        "detail": f"Solicitado: {di['qty_requested']:g} · Estado: {di['dispatch_status']}",
                        "ref": di["dispatch_number"]})

    events = [e for e in events if e.get("date")]
    events.sort(key=lambda e: e["date"])
    current_balance = q(
        """SELECT loc.full_code as location_code, b.status, b.qty FROM inventory_balances b
           LEFT JOIN locations loc ON loc.id=b.location_id WHERE b.lot_id=?""", (lot_id,))
    return jsonify({"lot": lot, "events": events, "current_balance": current_balance})


# =============================== AJUSTES / MERMAS / DEVOLUCIONES =============
@bp.post("/inventory/adjust")
@login_required
@require_permission("adjust", "edit")
def create_adjustment():
    d = request.get_json(force=True)
    try:
        with tx():
            stock_service.adjust(
                d["product_id"], d["client_id"], d.get("lot_id"), d.get("location_id"), d.get("status", "DISPONIBLE"),
                float(d["qty"]), g.user["id"], bool(d["positive"]), "MANUAL", None, d.get("reason", "Ajuste manual"),
            )
            log_change("inventory_adjust", d["product_id"], g.user["id"], action="ADJUST",
                       new_value=f"{'+' if d['positive'] else '-'}{d['qty']}", reason=d.get("reason"))
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@bp.post("/inventory/merma")
@login_required
@require_permission("adjust", "edit")
def create_merma():
    d = request.get_json(force=True)
    try:
        with tx():
            stock_service.merma(d["product_id"], d["client_id"], d.get("lot_id"), d["location_id"], d.get("status", "DISPONIBLE"),
                                 float(d["qty"]), g.user["id"], d.get("reason", "Merma"))
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@bp.post("/inventory/quarantine")
@login_required
@require_permission("quality", "edit")
def set_quarantine():
    d = request.get_json(force=True)
    try:
        with tx():
            stock_service.record_movement(
                "CUARENTENA", d["product_id"], d["client_id"], float(d["qty"]), g.user["id"],
                lot_id=d.get("lot_id"), from_location_id=d.get("location_id"), from_status=d.get("from_status", "DISPONIBLE"),
                to_location_id=d.get("location_id"), to_status="CUARENTENA",
                reference_type="MANUAL", reason=d.get("reason"),
            )
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@bp.post("/inventory/release-quality")
@login_required
@require_permission("quality", "approve")
def release_quality():
    d = request.get_json(force=True)
    try:
        with tx():
            stock_service.record_movement(
                "LIBERACION_CALIDAD", d["product_id"], d["client_id"], float(d["qty"]), g.user["id"],
                lot_id=d.get("lot_id"), from_location_id=d.get("location_id"), from_status=d.get("from_status", "CUARENTENA"),
                to_location_id=d.get("location_id"), to_status=d.get("to_status", "DISPONIBLE"),
                reference_type="MANUAL", reason=d.get("reason"),
            )
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@bp.post("/inventory/relocate")
@login_required
@require_permission("locate", "edit")
def relocate_stock():
    """Mueve stock DISPONIBLE de una ubicacion a otra (ej. de Patio de Despacho
    a una posicion real de rack, o entre dos posiciones de rack)."""
    d = request.get_json(force=True)
    # from_location_id puede ser NULL de verdad (ubicando por primera vez
    # stock que nunca paso por un rack, ej. stock importado); solo
    # to_location_id es obligatorio de verdad.
    for f in ("product_id", "client_id", "to_location_id", "qty"):
        if d.get(f) in (None, ""):
            return jsonify({"error": f"{f} es obligatorio"}), 400
    try:
        with tx():
            stock_service.relocate(
                d["product_id"], d["client_id"], d.get("lot_id"),
                d["from_location_id"], d["to_location_id"], float(d["qty"]), g.user["id"],
                reason=d.get("reason"),
            )
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})
