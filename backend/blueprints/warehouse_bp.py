from flask import Blueprint, request, jsonify, g

from db import q, q1, execute
from auth import login_required, require_permission
from services.audit_service import log_change
from seed_racks_real import PATIO_GRID_COL, PAIR_OF

bp = Blueprint("warehouse", __name__)


def cardinal_label(zone_desc, zone_code, aisle_code, rack_code, level_code, position_code):
    """Traduce el codigo tecnico de una ubicacion a algo que un operario entiende
    de un vistazo: 'Rack B / Nivel 3 / Posicion 8'."""
    lvln = level_code.lstrip("N") if level_code.startswith("N") else level_code
    return f"Rack {rack_code} / Nivel {lvln} / Posicion {int(position_code)}"


@bp.get("/warehouses")
@login_required
def list_warehouses():
    return jsonify(q("SELECT * FROM warehouses ORDER BY code"))


@bp.get("/warehouse/patio/next")
@login_required
def patio_next_slot():
    """Siguiente posicion libre del Patio de Despacho, para el boton de
    ubicacion rapida (sin tener que buscar/escribir nada)."""
    loc = q1(
        """SELECT loc.id, loc.full_code FROM locations loc
           JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           JOIN racks r ON r.id = lvl.rack_id
           WHERE r.code='PATIO' AND loc.status='DISPONIBLE'
             AND loc.id NOT IN (SELECT location_id FROM inventory_balances WHERE location_id IS NOT NULL AND qty > 0)
           ORDER BY loc.position_code LIMIT 1"""
    )
    if not loc:
        return jsonify({"error": "El Patio de Despacho esta lleno, no hay posiciones libres"}), 404
    return jsonify({"location_id": loc["id"], "location_code": loc["full_code"]})


@bp.post("/warehouses")
@login_required
@require_permission("create", "edit")
def create_warehouse():
    d = request.get_json(force=True)
    wid = execute("INSERT INTO warehouses (code, name, address) VALUES (?,?,?)",
                  (d["code"], d["name"], d.get("address")))
    return jsonify({"id": wid}), 201


@bp.post("/zones")
@login_required
@require_permission("create", "edit")
def create_zone():
    d = request.get_json(force=True)
    zid = execute("INSERT INTO zones (warehouse_id, code, description) VALUES (?,?,?)",
                  (d["warehouse_id"], d["code"], d.get("description")))
    return jsonify({"id": zid}), 201


@bp.post("/racks")
@login_required
@require_permission("create", "edit")
def create_rack():
    d = request.get_json(force=True)
    rid = execute("INSERT INTO racks (zone_id, code, aisle_code) VALUES (?,?,?)",
                  (d["zone_id"], d["code"], d.get("aisle_code")))
    return jsonify({"id": rid}), 201


@bp.put("/racks/<int:rack_id>/aisle")
@login_required
@require_permission("create", "edit")
def set_rack_aisle(rack_id):
    """Permite asignar/editar el pasillo de un rack existente sin tener que recrearlo,
    para poder adoptar el sistema cardinal sobre el almacen ya cargado."""
    d = request.get_json(force=True)
    execute("UPDATE racks SET aisle_code=? WHERE id=?", (d.get("aisle_code"), rack_id))
    return jsonify({"ok": True})


@bp.post("/rack-levels")
@login_required
@require_permission("create", "edit")
def create_level():
    d = request.get_json(force=True)
    lid = execute("INSERT INTO rack_levels (rack_id, code) VALUES (?,?)", (d["rack_id"], d["code"]))
    return jsonify({"id": lid}), 201


@bp.post("/locations")
@login_required
@require_permission("create", "edit")
def create_location():
    d = request.get_json(force=True)
    full_code = d.get("full_code")
    if not full_code:
        return jsonify({"error": "full_code requerido"}), 400
    existing = q1("SELECT id FROM locations WHERE full_code=?", (full_code,))
    if existing:
        return jsonify({"error": f"La ubicacion {full_code} ya existe"}), 409
    lid = execute(
        """INSERT INTO locations (rack_level_id, position_code, full_code, loc_type, capacity, status)
           VALUES (?,?,?,?,?,?)""",
        (d["rack_level_id"], d["position_code"], full_code, d.get("loc_type", "ESTANTERIA"),
         d.get("capacity", 0), d.get("status", "DISPONIBLE")),
    )
    return jsonify({"id": lid}), 201


@bp.put("/locations/<int:lid>/status")
@login_required
@require_permission("locate", "edit")
def update_location_status(lid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM locations WHERE id=?", (lid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    execute("UPDATE locations SET status=? WHERE id=?", (d["status"], lid))
    log_change("location", lid, g.user["id"], action="UPDATE", field="status",
               old_value=old["status"], new_value=d["status"], reason=d.get("reason"))
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
@bp.get("/warehouse/map")
@login_required
def warehouse_map():
    """Estructura jerarquica con % de ocupacion por rack, para el mapa visual."""
    warehouses = q("SELECT * FROM warehouses ORDER BY code")
    result = []
    for wh in warehouses:
        zones = q("SELECT * FROM zones WHERE warehouse_id=? ORDER BY code", (wh["id"],))
        wh_out = {**wh, "zones": []}
        for z in zones:
            racks = q("SELECT * FROM racks WHERE zone_id=? ORDER BY grid_col, grid_row, code", (z["id"],))
            z_out = {**z, "racks": [], "patio_grid_col": PATIO_GRID_COL if racks else None}
            for r in racks:
                positions = q(
                    """SELECT loc.id, loc.full_code, loc.capacity, loc.status,
                              COALESCE((SELECT SUM(b.qty) FROM inventory_balances b WHERE b.location_id=loc.id
                                        AND b.status IN ('DISPONIBLE','RESERVADO','CUARENTENA','BLOQUEADO','DANADO')),0) as occupied
                       FROM locations loc
                       JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
                       WHERE lvl.rack_id=?""",
                    (r["id"],),
                )
                total_pos = len(positions)
                occupied_pos = len([p for p in positions if p["occupied"] > 0])
                pct = round(100 * occupied_pos / total_pos, 1) if total_pos else 0
                z_out["racks"].append({
                    **r, "total_positions": total_pos, "occupied_positions": occupied_pos,
                    "free_positions": total_pos - occupied_pos, "occupancy_pct": pct,
                    "access_label": f"Junto a Rack {PAIR_OF[r['code']]}" if r["code"] in PAIR_OF else "Pegado a pared",
                })
            wh_out["zones"].append(z_out)
        result.append(wh_out)
    return jsonify(result)


@bp.get("/warehouse/racks/<int:rack_id>")
@login_required
def rack_detail(rack_id):
    rack = q1(
        """SELECT r.*, z.code as zone_code, z.description as zone_description
           FROM racks r JOIN zones z ON z.id=r.zone_id WHERE r.id=?""", (rack_id,))
    if not rack:
        return jsonify({"error": "no encontrado"}), 404
    rack["access_label"] = f"Junto a Rack {PAIR_OF[rack['code']]}" if rack["code"] in PAIR_OF else "Pegado a pared"
    levels = q("SELECT * FROM rack_levels WHERE rack_id=? ORDER BY code", (rack_id,))
    out_levels = []
    for lvl in levels:
        locs = q(
            """SELECT loc.*,
                      (SELECT SUM(b.qty) FROM inventory_balances b WHERE b.location_id=loc.id AND b.status IN ('DISPONIBLE','RESERVADO','CUARENTENA','BLOQUEADO','DANADO')) as occupied
               FROM locations loc WHERE loc.rack_level_id=? ORDER BY loc.position_code""",
            (lvl["id"],),
        )
        for l in locs:
            l["cardinal_label"] = cardinal_label(rack["zone_description"], rack["zone_code"], rack["aisle_code"], rack["code"], lvl["code"], l["position_code"])
        out_levels.append({**lvl, "locations": locs})
    return jsonify({**rack, "levels": out_levels})


def _location_row_with_cardinal(loc_id):
    return q1(
        """SELECT loc.*, lvl.code as level_code, r.code as rack_code, r.aisle_code as aisle_code,
                  z.code as zone_code, z.description as zone_description, wh.code as warehouse_code
           FROM locations loc
           JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           JOIN racks r ON r.id = lvl.rack_id
           JOIN zones z ON z.id = r.zone_id
           JOIN warehouses wh ON wh.id = z.warehouse_id
           WHERE loc.id=?""",
        (loc_id,),
    )


@bp.get("/warehouse/locations/<int:loc_id>")
@login_required
def location_detail(loc_id):
    loc = _location_row_with_cardinal(loc_id)
    if not loc:
        return jsonify({"error": "no encontrado"}), 404
    loc = dict(loc)
    loc["cardinal_label"] = cardinal_label(loc["zone_description"], loc["zone_code"], loc["aisle_code"], loc["rack_code"], loc["level_code"], loc["position_code"])
    contents = q(
        """SELECT b.*, p.sku_code, p.description as product_description, c.name as client_name,
                  l.lot_code, l.expiration_date
           FROM inventory_balances b
           JOIN products p ON p.id = b.product_id
           JOIN clients c ON c.id = b.client_id
           LEFT JOIN lots l ON l.id = b.lot_id
           WHERE b.location_id=? ORDER BY b.status""",
        (loc_id,),
    )
    return jsonify({**loc, "contents": contents})


# =============================== BUSCADOR DE UBICACIONES ======================
@bp.get("/warehouse/find")
@login_required
def find_locations():
    """Responde 'donde esta almacenado esto' buscando por SKU, producto, cliente o
    codigo de ubicacion, y devuelve TODAS las ubicaciones donde hay stock (un
    producto puede estar repartido en varias)."""
    sku = request.args.get("sku", "").strip()
    product_id = request.args.get("product_id")
    client_id = request.args.get("client_id")
    loc_code = request.args.get("location", "").strip()

    sql = """SELECT b.location_id, b.status, b.qty, p.id as product_id, p.sku_code, p.description as product_description,
                     c.name as client_name, l.lot_code, l.expiration_date,
                     loc.full_code, loc.position_code, lvl.code as level_code, r.code as rack_code, r.aisle_code,
                     z.code as zone_code, z.description as zone_description
              FROM inventory_balances b
              JOIN products p ON p.id = b.product_id
              JOIN clients c ON c.id = b.client_id
              LEFT JOIN lots l ON l.id = b.lot_id
              LEFT JOIN locations loc ON loc.id = b.location_id
              LEFT JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
              LEFT JOIN racks r ON r.id = lvl.rack_id
              LEFT JOIN zones z ON z.id = r.zone_id
              WHERE b.qty > 0"""
    params = []
    if sku:
        sql += " AND p.sku_code LIKE ?"; params.append(f"%{sku}%")
    if product_id:
        sql += " AND p.id=?"; params.append(product_id)
    if client_id:
        sql += " AND c.id=?"; params.append(client_id)
    if loc_code:
        sql += " AND loc.full_code LIKE ?"; params.append(f"%{loc_code}%")
    sql += " ORDER BY p.description, loc.full_code"
    rows = q(sql, tuple(params))
    for r in rows:
        r["cardinal_label"] = (
            cardinal_label(r["zone_description"], r["zone_code"], r["aisle_code"], r["rack_code"], r["level_code"], r["position_code"])
            if r["zone_code"] else "Sin ubicar"
        )
    return jsonify(rows)
