from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services import stock_service
from services.stock_service import StockError
from services.audit_service import log_change

bp = Blueprint("physical_inventory", __name__)


@bp.get("/physical-counts")
@login_required
def list_counts():
    return jsonify(q(
        """SELECT pc.*, w.name as warehouse_name, z.code as zone_code, u.name as created_by_name
           FROM physical_inventory_counts pc
           JOIN warehouses w ON w.id=pc.warehouse_id
           LEFT JOIN zones z ON z.id=pc.zone_id
           LEFT JOIN users u ON u.id=pc.created_by
           ORDER BY pc.created_at DESC"""
    ))


@bp.post("/physical-counts")
@login_required
@require_permission("count", "edit")
def create_count():
    d = request.get_json(force=True)
    with tx():
        cid = execute("INSERT INTO physical_inventory_counts (warehouse_id, zone_id, status, created_by) VALUES (?,?,?,?)",
                      (d["warehouse_id"], d.get("zone_id"), "ABIERTO", g.user["id"]))
        sql = """SELECT b.product_id, b.lot_id, b.location_id, SUM(b.qty) as qty
                 FROM inventory_balances b
                 JOIN locations loc ON loc.id=b.location_id
                 JOIN rack_levels lvl ON lvl.id=loc.rack_level_id
                 JOIN racks rk ON rk.id=lvl.rack_id
                 WHERE rk.zone_id=?""" if d.get("zone_id") else \
              """SELECT product_id, lot_id, location_id, SUM(qty) as qty FROM inventory_balances
                 WHERE location_id IS NOT NULL GROUP BY product_id, lot_id, location_id"""
        params = (d.get("zone_id"),) if d.get("zone_id") else ()
        if d.get("zone_id"):
            sql += " GROUP BY b.product_id, b.lot_id, b.location_id"
        lines = q(sql, params)
        for ln in lines:
            execute(
                "INSERT INTO physical_inventory_items (count_id, product_id, lot_id, location_id, system_qty) VALUES (?,?,?,?,?)",
                (cid, ln["product_id"], ln["lot_id"], ln["location_id"], ln["qty"]),
            )
    return jsonify({"id": cid, "lines": len(lines)}), 201


@bp.get("/physical-counts/<int:cid>")
@login_required
def get_count(cid):
    c = q1("SELECT * FROM physical_inventory_counts WHERE id=?", (cid,))
    if not c:
        return jsonify({"error": "no encontrado"}), 404
    items = q(
        """SELECT pci.*, p.sku_code, p.description as product_description, l.lot_code, loc.full_code as location_code
           FROM physical_inventory_items pci
           JOIN products p ON p.id=pci.product_id
           LEFT JOIN lots l ON l.id=pci.lot_id
           JOIN locations loc ON loc.id=pci.location_id
           WHERE pci.count_id=? ORDER BY loc.full_code""",
        (cid,),
    )
    return jsonify({**c, "items": items})


@bp.put("/physical-count-items/<int:item_id>")
@login_required
@require_permission("count", "edit")
def set_counted_qty(item_id):
    d = request.get_json(force=True)
    item = q1("SELECT * FROM physical_inventory_items WHERE id=?", (item_id,))
    if not item:
        return jsonify({"error": "no encontrado"}), 404
    counted = float(d["counted_qty"])
    diff = counted - item["system_qty"]
    execute("UPDATE physical_inventory_items SET counted_qty=?, difference=? WHERE id=?", (counted, diff, item_id))
    return jsonify({"ok": True, "difference": diff})


@bp.post("/physical-counts/<int:cid>/approve")
@login_required
@require_permission("approve")
def approve_count(cid):
    """Aplica los ajustes (solo diferencias != 0) y cierra el conteo. Requiere rol con permiso 'approve'."""
    c = q1("SELECT * FROM physical_inventory_counts WHERE id=?", (cid,))
    if not c:
        return jsonify({"error": "no encontrado"}), 404
    items = q("SELECT * FROM physical_inventory_items WHERE count_id=? AND counted_qty IS NOT NULL", (cid,))
    try:
        with tx():
            for it in items:
                if abs(it["difference"] or 0) < 0.0001:
                    continue
                product = q1("SELECT client_id FROM products WHERE id=?", (it["product_id"],))
                if it["difference"] > 0:
                    stock_service.adjust(it["product_id"], product["client_id"], it["lot_id"], it["location_id"], "DISPONIBLE",
                                          abs(it["difference"]), g.user["id"], True, "PHYSICAL_COUNT", cid,
                                          f"Ajuste por inventario fisico #{cid}")
                else:
                    stock_service.adjust(it["product_id"], product["client_id"], it["lot_id"], it["location_id"], "DISPONIBLE",
                                          abs(it["difference"]), g.user["id"], False, "PHYSICAL_COUNT", cid,
                                          f"Ajuste por inventario fisico #{cid}")
                execute("UPDATE physical_inventory_items SET approved_by=?, approved_at=datetime('now') WHERE id=?",
                        (g.user["id"], it["id"]))
            execute("UPDATE physical_inventory_counts SET status='CERRADO', closed_at=datetime('now') WHERE id=?", (cid,))
            log_change("physical_count", cid, g.user["id"], action="APPROVE", reason="Aprobacion de ajustes de inventario fisico")
    except StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "adjustments_applied": len([i for i in items if abs(i["difference"] or 0) > 0.0001])})
