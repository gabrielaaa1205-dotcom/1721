import datetime

from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services import stock_service
from services.stock_service import StockError
from services.audit_service import log_change

bp = Blueprint("dispatches", __name__)


def gen_dispatch_number():
    today = datetime.date.today().strftime("%Y%m%d")
    row = q1("SELECT COUNT(*) as n FROM dispatches WHERE dispatch_number LIKE ?", (f"DES-{today}-%",))
    seq = (row["n"] if row else 0) + 1
    return f"DES-{today}-{seq:03d}"


# =============================== CABECERA ===================================
@bp.get("/dispatches")
@login_required
def list_dispatches():
    client_id = request.args.get("client_id")
    status = request.args.get("status")
    search = request.args.get("q", "").strip()
    sql = """SELECT d.*, c.name as client_name,
                    (SELECT COUNT(*) FROM dispatch_items di WHERE di.dispatch_id=d.id) as item_count
             FROM dispatches d JOIN clients c ON c.id=d.client_id WHERE 1=1"""
    params = []
    if client_id:
        sql += " AND d.client_id=?"; params.append(client_id)
    if status:
        sql += " AND d.status=?"; params.append(status)
    if search:
        sql += " AND (d.dispatch_number LIKE ? OR d.guide_number LIKE ? OR d.order_number LIKE ?)"
        params += [f"%{search}%"] * 3
    sql += " ORDER BY d.created_at DESC LIMIT 300"
    return jsonify(q(sql, tuple(params)))


@bp.get("/dispatches/<int:did>")
@login_required
def get_dispatch(did):
    dsp = q1("SELECT d.*, c.name as client_name, c.id as cid FROM dispatches d JOIN clients c ON c.id=d.client_id WHERE d.id=?", (did,))
    if not dsp:
        return jsonify({"error": "no encontrado"}), 404
    cfg = q1("SELECT * FROM client_configs WHERE client_id=?", (dsp["cid"],))
    items = q(
        """SELECT di.*, p.sku_code, p.description as product_description, l.lot_code, l.expiration_date,
                  a.name as activity_name,
                  COALESCE((SELECT SUM(qty) FROM reservations WHERE dispatch_item_id=di.id AND status='ACTIVA'),0) as reserved_qty
           FROM dispatch_items di
           JOIN products p ON p.id = di.product_id
           LEFT JOIN lots l ON l.id = di.lot_id
           LEFT JOIN activities a ON a.id = di.activity_id
           WHERE di.dispatch_id=?""",
        (did,),
    )
    return jsonify({**dsp, "items": items, "client_config": cfg})


@bp.post("/dispatches")
@login_required
@require_permission("create", "dispatch")
def create_dispatch():
    d = request.get_json(force=True)
    if not d.get("client_id") or not d.get("dispatch_date"):
        return jsonify({"error": "client_id y dispatch_date son obligatorios"}), 400
    with tx():
        number = gen_dispatch_number()
        did = execute(
            """INSERT INTO dispatches (dispatch_number, client_id, dispatch_date, dispatch_time, guide_number,
                 destination, order_number, status, responsible_user_id, created_by, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (number, d["client_id"], d["dispatch_date"], d.get("dispatch_time"), d.get("guide_number"),
             d.get("destination"), d.get("order_number"), "PENDIENTE", g.user["id"], g.user["id"], "MANUAL"),
        )
        log_change("dispatch", did, g.user["id"], action="CREATE", new_value=number)
    return jsonify({"id": did, "dispatch_number": number}), 201


@bp.put("/dispatches/<int:did>/status")
@login_required
@require_permission("dispatch", "approve")
def set_dispatch_status(did):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM dispatches WHERE id=?", (did,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    new_status = d.get("status")
    valid = {"PENDIENTE", "RESERVADO", "EN_PICKING", "VERIFICADO", "DESPACHADO", "CERRADO", "OBSERVADO", "BLOQUEADO", "CANCELADO"}
    if new_status not in valid:
        return jsonify({"error": "estado invalido"}), 400
    if new_status == "CANCELADO":
        active_resv = q("SELECT * FROM reservations r JOIN dispatch_items di ON di.id=r.dispatch_item_id WHERE di.dispatch_id=? AND r.status='ACTIVA'", (did,))
        with tx():
            for r in active_resv:
                stock_service.release_reservation(r["id"], g.user["id"], reason="Cancelacion de despacho")
            execute("UPDATE dispatches SET status='CANCELADO' WHERE id=?", (did,))
    else:
        execute("UPDATE dispatches SET status=? WHERE id=?", (new_status, did))
    log_change("dispatch", did, g.user["id"], field="status", old_value=old["status"], new_value=new_status, reason=d.get("reason"))
    return jsonify({"ok": True})


# =============================== DETALLE (ITEMS) =============================
@bp.post("/dispatches/<int:did>/items")
@login_required
@require_permission("create", "dispatch")
def add_dispatch_item(did):
    d = request.get_json(force=True)
    dsp = q1("SELECT * FROM dispatches WHERE id=?", (did,))
    if not dsp:
        return jsonify({"error": "despacho no encontrado"}), 404
    if not d.get("product_id") or not d.get("qty_requested"):
        return jsonify({"error": "product_id y qty_requested son obligatorios"}), 400

    lot_id = None
    if d.get("lot_code"):
        lot = q1("SELECT id, expiration_date FROM lots WHERE product_id=? AND lot_code=?", (d["product_id"], d["lot_code"]))
        if not lot:
            return jsonify({"error": "Ese lote no existe para este producto"}), 400
        lot_id = lot["id"]

    item_id = execute(
        """INSERT INTO dispatch_items (dispatch_id, product_id, lot_id, origin_container, qty_cases, qty_requested,
             expiration_date, client_acceptance, copacker_lot, activity_id, promotion_id, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (did, d["product_id"], lot_id, d.get("origin_container"), d.get("qty_cases") or None, d["qty_requested"],
         d.get("expiration_date") or None, d.get("client_acceptance"), d.get("copacker_lot"), d.get("activity_id") or None,
         d.get("promotion_id") or None, d.get("notes")),
    )
    return jsonify({"id": item_id}), 201


@bp.delete("/dispatches/items/<int:item_id>")
@login_required
@require_permission("create", "dispatch")
def delete_dispatch_item(item_id):
    active = q1("SELECT COUNT(*) as n FROM reservations WHERE dispatch_item_id=? AND status='ACTIVA'", (item_id,))
    if active["n"]:
        return jsonify({"error": "No se puede eliminar: tiene stock reservado. Libere la reserva primero."}), 400
    execute("DELETE FROM dispatch_items WHERE id=?", (item_id,))
    return jsonify({"ok": True})


# =============================== RESERVA (FEFO/FIFO) ==========================
@bp.post("/dispatches/items/<int:item_id>/reserve")
@login_required
@require_permission("create", "dispatch")
def reserve_item(item_id):
    try:
        with tx():
            allocations = stock_service.reserve_for_dispatch_item(item_id, g.user["id"])
            item = q1("SELECT * FROM dispatch_items WHERE id=?", (item_id,))
            dispatch = q1("SELECT * FROM dispatches WHERE id=?", (item["dispatch_id"],))
            if dispatch["status"] == "PENDIENTE":
                execute("UPDATE dispatches SET status='RESERVADO' WHERE id=?", (dispatch["id"],))
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"allocations": allocations})


@bp.post("/reservations/<int:rid>/release")
@login_required
@require_permission("create", "dispatch", "edit")
def release_reservation_endpoint(rid):
    d = request.get_json(force=True, silent=True) or {}
    try:
        with tx():
            stock_service.release_reservation(rid, g.user["id"], reason=d.get("reason", "Liberacion manual"))
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


# =============================== PICKING ======================================
@bp.post("/dispatches/<int:did>/generate-picking")
@login_required
@require_permission("dispatch", "pick")
def generate_picking(did):
    dsp = q1("SELECT * FROM dispatches WHERE id=?", (did,))
    if not dsp:
        return jsonify({"error": "no encontrado"}), 404
    existing = q1("SELECT id FROM picking_orders WHERE dispatch_id=?", (did,))
    if existing:
        return jsonify({"error": "Ya existe una orden de picking para este despacho", "picking_order_id": existing["id"]}), 409

    reservations = q(
        """SELECT r.*, loc.full_code, z.code as zone_code, rk.code as rack_code, lvl.code as level_code
           FROM reservations r
           JOIN dispatch_items di ON di.id = r.dispatch_item_id
           LEFT JOIN locations loc ON loc.id = r.location_id
           LEFT JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           LEFT JOIN racks rk ON rk.id = lvl.rack_id
           LEFT JOIN zones z ON z.id = rk.zone_id
           WHERE di.dispatch_id=? AND r.status='ACTIVA'
           ORDER BY (r.location_id IS NULL), z.code, rk.code, lvl.code, loc.position_code""",
        (did,),
    )
    if not reservations:
        return jsonify({"error": "No hay stock reservado. Reserve las lineas antes de generar picking."}), 400

    with tx():
        po_id = execute("INSERT INTO picking_orders (dispatch_id, status) VALUES (?, 'PENDIENTE')", (did,))
        for idx, r in enumerate(reservations, start=1):
            execute(
                """INSERT INTO picking_items (picking_order_id, reservation_id, product_id, lot_id, location_id,
                     qty_requested, sequence, status)
                   VALUES (?,?,?,?,?,?,?,'PENDIENTE')""",
                (po_id, r["id"], r["product_id"], r["lot_id"], r["location_id"], r["qty"], idx),
            )
        execute("UPDATE dispatches SET status='EN_PICKING', picking_at=datetime('now') WHERE id=?", (did,))
    return jsonify({"picking_order_id": po_id, "lines": len(reservations)}), 201


@bp.get("/picking-orders/<int:po_id>")
@login_required
def get_picking_order(po_id):
    po = q1("SELECT * FROM picking_orders WHERE id=?", (po_id,))
    if not po:
        return jsonify({"error": "no encontrado"}), 404
    items = q(
        """SELECT pi.*, p.sku_code, p.description as product_description, l.lot_code, l.expiration_date,
                  loc.full_code as location_code
           FROM picking_items pi
           JOIN products p ON p.id=pi.product_id
           LEFT JOIN lots l ON l.id=pi.lot_id
           LEFT JOIN locations loc ON loc.id=pi.location_id
           WHERE pi.picking_order_id=? ORDER BY pi.sequence""",
        (po_id,),
    )
    return jsonify({**po, "items": items})


@bp.get("/dispatches/<int:did>/picking-order")
@login_required
def get_picking_order_by_dispatch(did):
    po = q1("SELECT * FROM picking_orders WHERE dispatch_id=?", (did,))
    if not po:
        return jsonify(None)
    return get_picking_order(po["id"])


@bp.post("/picking-items/<int:pid>/pick")
@login_required
@require_permission("pick")
def pick_item(pid):
    d = request.get_json(force=True)
    item = q1("SELECT * FROM picking_items WHERE id=?", (pid,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    qty_picked = float(d.get("qty_picked", item["qty_requested"]))
    status = "PICKEADO" if abs(qty_picked - item["qty_requested"]) < 0.01 else (
        "DIFERENCIA" if qty_picked > 0 else "NO_ENCONTRADO")
    execute("UPDATE picking_items SET qty_picked=?, status=? WHERE id=?", (qty_picked, status, pid))

    po = q1("SELECT * FROM picking_orders WHERE id=?", (item["picking_order_id"],))
    remaining = q1("SELECT COUNT(*) as n FROM picking_items WHERE picking_order_id=? AND status='PENDIENTE'", (po["id"],))
    if remaining["n"] == 0:
        execute("UPDATE picking_orders SET status='COMPLETADO' WHERE id=?", (po["id"],))
    else:
        execute("UPDATE picking_orders SET status='EN_PROCESO' WHERE id=?", (po["id"],))
    return jsonify({"ok": True, "status": status})


@bp.post("/dispatches/<int:did>/quick-dispatch")
@login_required
@require_permission("dispatch", "approve")
def quick_dispatch_endpoint(did):
    """Un solo clic: reserva + picking + verificacion + cierre, para el caso
    normal donde se despacha exactamente lo solicitado, sin diferencias."""
    try:
        with tx():
            result = stock_service.quick_dispatch(did, g.user["id"])
            log_change("dispatch", did, g.user["id"], field="status", new_value="CERRADO", reason="Despacho rapido")
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **result})


# =============================== VERIFICACION Y CIERRE ========================
@bp.post("/dispatches/<int:did>/verify")
@login_required
@require_permission("dispatch", "approve")
def verify_dispatch(did):
    po = q1("SELECT * FROM picking_orders WHERE dispatch_id=?", (did,))
    if not po:
        return jsonify({"error": "No hay orden de picking generada"}), 400
    pending = q1("SELECT COUNT(*) as n FROM picking_items WHERE picking_order_id=? AND status='PENDIENTE'", (po["id"],))
    if pending["n"] > 0:
        return jsonify({"error": f"Quedan {pending['n']} lineas sin pickear"}), 400
    execute("UPDATE dispatches SET status='VERIFICADO', verified_at=datetime('now') WHERE id=?", (did,))
    return jsonify({"ok": True})


@bp.post("/dispatches/<int:did>/close")
@login_required
@require_permission("dispatch", "approve")
def close_dispatch(did):
    dsp = q1("SELECT * FROM dispatches WHERE id=?", (did,))
    if not dsp:
        return jsonify({"error": "no encontrado"}), 404
    if dsp["status"] not in ("VERIFICADO",):
        return jsonify({"error": "El despacho debe estar VERIFICADO antes de cerrarse"}), 400
    active_resv = q(
        "SELECT r.* FROM reservations r JOIN dispatch_items di ON di.id=r.dispatch_item_id WHERE di.dispatch_id=? AND r.status='ACTIVA'",
        (did,),
    )
    try:
        with tx():
            for r in active_resv:
                stock_service.confirm_dispatch_movement(r["id"], g.user["id"], did)
            execute(
                "UPDATE dispatches SET status='CERRADO', closed_at=datetime('now'), prepared_at=COALESCE(prepared_at, datetime('now')) WHERE id=?",
                (did,),
            )
            log_change("dispatch", did, g.user["id"], field="status", old_value=dsp["status"], new_value="CERRADO")
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})
