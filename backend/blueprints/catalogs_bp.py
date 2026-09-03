from flask import Blueprint, request, jsonify, g

from db import q, q1, execute, tx
from auth import login_required, require_permission
from services.audit_service import log_change

bp = Blueprint("catalogs", __name__)


# =============================== CLIENTES ===================================
def _gen_client_code():
    """Genera un codigo correlativo CLI-0001 cuando el usuario no escribe uno propio,
    para que 'crear cliente nuevo' nunca quede bloqueado por falta de codigo."""
    row = q1("SELECT COUNT(*) as n FROM clients")
    n = (row["n"] if row else 0) + 1
    while True:
        code = f"CLI-{n:04d}"
        if not q1("SELECT id FROM clients WHERE code=?", (code,)):
            return code
        n += 1


@bp.get("/clients")
@login_required
def list_clients():
    search = request.args.get("q", "").strip()
    active_only = request.args.get("active_only")
    sql = """SELECT c.*, cc.dispatch_extra_field, cc.fefo_or_fifo, cc.requires_lot, cc.requires_po, cc.expiry_thresholds
             FROM clients c LEFT JOIN client_configs cc ON cc.client_id=c.id WHERE 1=1"""
    params = []
    if search:
        sql += """ AND (c.name LIKE ? OR c.code LIKE ? OR c.tax_id LIKE ?
                    OR c.id IN (SELECT client_id FROM client_aliases WHERE alias_text LIKE ?))"""
        params += [f"%{search}%", f"%{search}%", f"%{search}%", f"%{search}%"]
    if active_only:
        sql += " AND c.active=1"
    sql += " ORDER BY c.name"
    return jsonify(q(sql, tuple(params)))


@bp.get("/clients/<int:cid>")
@login_required
def get_client(cid):
    c = q1("""SELECT c.*, cc.dispatch_extra_field, cc.fefo_or_fifo, cc.requires_lot, cc.requires_po, cc.expiry_thresholds
              FROM clients c LEFT JOIN client_configs cc ON cc.client_id=c.id WHERE c.id=?""", (cid,))
    if not c:
        return jsonify({"error": "no encontrado"}), 404
    return jsonify(c)


@bp.post("/clients")
@login_required
@require_permission("create", "edit", "create_reception")
def create_client():
    """Crea un cliente nuevo 'al vuelo'. Nunca bloquea: si no viene codigo, se genera uno.
    El nombre es lo unico obligatorio (para poder crearlo desde cualquier formulario)."""
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre del cliente es obligatorio"}), 400
    code = (d.get("code") or "").strip() or _gen_client_code()
    existing = q1("SELECT id FROM clients WHERE code=?", (code,))
    if existing:
        return jsonify({"error": f"Ya existe un cliente con codigo {code}"}), 409
    existing_name = q1("SELECT id, name FROM clients WHERE LOWER(name)=LOWER(?)", (name,))
    if existing_name and not d.get("confirm_duplicate"):
        return jsonify({
            "warning": f"Ya existe un cliente muy similar: '{existing_name['name']}'. Confirme si de verdad es otro cliente.",
            "existing_id": existing_name["id"],
        }), 200
    with tx():
        cid = execute("INSERT INTO clients (code, name, tax_id, contact) VALUES (?,?,?,?)",
                       (code, name, d.get("tax_id"), d.get("contact")))
        execute(
            """INSERT INTO client_configs (client_id, requires_lot, requires_po, dispatch_extra_field, fefo_or_fifo, expiry_thresholds)
               VALUES (?,?,?,?,?,?)""",
            (cid, int(d.get("requires_lot", 0)), int(d.get("requires_po", 0)),
             d.get("dispatch_extra_field", "client_acceptance"), d.get("fefo_or_fifo", "FEFO"),
             d.get("expiry_thresholds", "7,15,30,60,90")),
        )
        log_change("client", cid, g.user["id"], action="CREATE", new_value=name)
    return jsonify({"id": cid, "code": code}), 201


@bp.put("/clients/<int:cid>")
@login_required
@require_permission("create", "edit")
def update_client(cid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM clients WHERE id=?", (cid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    name = (d.get("name") or old["name"]).strip()
    execute(
        "UPDATE clients SET name=?, tax_id=?, contact=?, active=? WHERE id=?",
        (name, d.get("tax_id", old["tax_id"]), d.get("contact", old["contact"]),
         int(d.get("active", old["active"])), cid),
    )
    log_change("client", cid, g.user["id"], action="UPDATE", old_value=old["name"], new_value=name)
    return jsonify({"ok": True})


@bp.put("/clients/<int:cid>/config")
@login_required
@require_permission("create", "edit")
def update_client_config(cid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM client_configs WHERE client_id=?", (cid,))
    with tx():
        execute(
            """UPDATE client_configs SET requires_lot=?, requires_po=?, dispatch_extra_field=?, fefo_or_fifo=?, expiry_thresholds=?
               WHERE client_id=?""",
            (int(d.get("requires_lot", 0)), int(d.get("requires_po", 0)),
             d.get("dispatch_extra_field", "client_acceptance"), d.get("fefo_or_fifo", "FEFO"),
             d.get("expiry_thresholds", "7,15,30,60,90"), cid),
        )
        log_change("client_config", cid, g.user["id"], action="UPDATE", old_value=dict(old) if old else None, new_value=d)
    return jsonify({"ok": True})


@bp.get("/clients/<int:cid>/aliases")
@login_required
def list_aliases(cid):
    return jsonify(q("SELECT * FROM client_aliases WHERE client_id=?", (cid,)))


@bp.post("/clients/<int:cid>/aliases")
@login_required
@require_permission("create", "edit")
def add_alias(cid):
    d = request.get_json(force=True)
    alias = (d.get("alias_text") or "").strip()
    if not alias:
        return jsonify({"error": "alias_text requerido"}), 400
    try:
        aid = execute("INSERT INTO client_aliases (client_id, alias_text) VALUES (?,?)", (cid, alias))
    except Exception:
        return jsonify({"error": "Ese alias ya esta en uso"}), 409
    return jsonify({"id": aid}), 201


# =============================== PRODUCTOS ===================================
@bp.get("/products")
@login_required
def list_products():
    search = request.args.get("q", "").strip()
    client_id = request.args.get("client_id")
    category = request.args.get("category")
    item_type = request.args.get("item_type")
    sql = """SELECT p.*, c.name as client_name, c.code as client_code,
             (SELECT COUNT(*) FROM product_components WHERE kit_product_id=p.id) as component_count
             FROM products p
             JOIN clients c ON c.id = p.client_id WHERE 1=1"""
    params = []
    if search:
        sql += " AND (p.sku_code LIKE ? OR p.description LIKE ? OR p.observations LIKE ?)"
        params += [f"%{search}%", f"%{search}%", f"%{search}%"]
    if client_id:
        sql += " AND p.client_id=?"
        params.append(client_id)
    if category:
        sql += " AND p.category=?"
        params.append(category)
    if item_type:
        sql += " AND p.item_type=?"
        params.append(item_type)
    sql += " ORDER BY p.description LIMIT 500"
    return jsonify(q(sql, tuple(params)))


@bp.get("/products/<int:pid>")
@login_required
def get_product(pid):
    p = q1("""SELECT p.*, c.name as client_name FROM products p JOIN clients c ON c.id=p.client_id WHERE p.id=?""", (pid,))
    if not p:
        return jsonify({"error": "no encontrado"}), 404
    return jsonify(p)


@bp.get("/products/categories")
@login_required
def list_categories():
    rows = q("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category<>'' ORDER BY category")
    return jsonify([r["category"] for r in rows])


@bp.post("/products")
@login_required
@require_permission("create", "edit", "create_reception")
def create_product():
    """Registra un producto. Si es producto NUEVO (is_new=1) el SKU lo escribe el
    usuario libremente y NUNCA se genera automaticamente; solo se valida que no
    choque con uno ya existente para ese cliente."""
    d = request.get_json(force=True)
    sku = (d.get("sku_code") or "").strip()
    description = (d.get("description") or "").strip()
    if not sku or not description or not d.get("client_id"):
        return jsonify({"error": "sku_code, description y client_id son obligatorios"}), 400
    existing = q1("SELECT id, description FROM products WHERE client_id=? AND sku_code=?", (d["client_id"], sku))
    if existing:
        return jsonify({
            "warning": f"Ya existe el SKU {sku} para este cliente ('{existing['description']}'). Use el producto existente en vez de duplicarlo.",
            "existing_id": existing["id"],
        }), 200
    item_type = (d.get("item_type") or "PRODUCTO").strip().upper()
    if item_type not in ("PRODUCTO", "MATERIAL"):
        return jsonify({"error": "item_type debe ser PRODUCTO o MATERIAL"}), 400
    pid = execute(
        """INSERT INTO products (sku_code, description, client_id, unit_of_measure, units_per_case,
             category, presentation, observations, item_type)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (sku, description, d["client_id"], d.get("unit_of_measure", "UND"), d.get("units_per_case") or None,
         d.get("category"), d.get("presentation"), d.get("observations"), item_type),
    )
    log_change("product", pid, g.user["id"], action="CREATE", new_value=description)
    return jsonify({"id": pid}), 201


@bp.put("/products/<int:pid>")
@login_required
@require_permission("create", "edit")
def update_product(pid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM products WHERE id=?", (pid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    item_type = d.get("item_type", old["item_type"])
    if item_type not in ("PRODUCTO", "MATERIAL"):
        return jsonify({"error": "item_type debe ser PRODUCTO o MATERIAL"}), 400
    execute(
        """UPDATE products SET description=?, unit_of_measure=?, units_per_case=?, active=?,
           category=?, presentation=?, observations=?, item_type=? WHERE id=?""",
        (d.get("description", old["description"]), d.get("unit_of_measure", old["unit_of_measure"]),
         d.get("units_per_case", old["units_per_case"]), int(d.get("active", old["active"])),
         d.get("category", old["category"]), d.get("presentation", old["presentation"]),
         d.get("observations", old["observations"]), item_type, pid),
    )
    log_change("product", pid, g.user["id"], action="UPDATE", old_value=old["description"], new_value=d.get("description"))
    return jsonify({"ok": True})


# =============================== COMBOS / KITS (Bill of Materials) ==========
@bp.get("/products/<int:pid>/components")
@login_required
def list_components(pid):
    """Componentes de un combo: lo que se descuenta realmente al despacharlo."""
    rows = q(
        """SELECT pc.id, pc.component_product_id, pc.qty_per_kit,
                  p.sku_code, p.description, p.unit_of_measure
           FROM product_components pc JOIN products p ON p.id = pc.component_product_id
           WHERE pc.kit_product_id=? ORDER BY p.description""",
        (pid,),
    )
    return jsonify(rows)


@bp.put("/products/<int:pid>/components")
@login_required
@require_permission("create", "edit")
def set_components(pid):
    """Reemplaza la lista completa de componentes de un combo. Enviar
    components=[] para que deje de ser combo (vuelve a ser un producto normal
    con stock propio)."""
    d = request.get_json(force=True)
    components = d.get("components", [])
    for c in components:
        if not c.get("component_product_id") or not c.get("qty_per_kit"):
            return jsonify({"error": "Cada componente necesita component_product_id y qty_per_kit"}), 400
        if int(c["component_product_id"]) == pid:
            return jsonify({"error": "Un combo no puede tener como componente a si mismo"}), 400
    execute("DELETE FROM product_components WHERE kit_product_id=?", (pid,))
    for c in components:
        execute(
            "INSERT INTO product_components (kit_product_id, component_product_id, qty_per_kit) VALUES (?,?,?)",
            (pid, c["component_product_id"], c["qty_per_kit"]),
        )
    log_change("product", pid, g.user["id"], action="UPDATE", new_value=f"{len(components)} componente(s) de combo")
    return jsonify({"ok": True, "count": len(components)})


# =============================== ACTIVIDADES / DEFECTOS / PROMOS ============
@bp.get("/activities")
@login_required
def list_activities():
    return jsonify(q("SELECT * FROM activities ORDER BY code"))


@bp.post("/activities")
@login_required
@require_permission("create", "edit")
def create_activity():
    d = request.get_json(force=True)
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre de la actividad es obligatorio"}), 400
    code = (d.get("code") or "").strip()
    if not code:
        # El usuario solo escribio el nombre (ej. una actividad/servicio nuevo
        # sobre la marcha): se genera un codigo corto y unico a partir del
        # nombre, sin exigirle inventar uno.
        base = "".join(w[0] for w in name.upper().split()[:3]) or "ACT"
        code = base
        n = 1
        while q1("SELECT id FROM activities WHERE code=?", (code,)):
            n += 1
            code = f"{base}{n}"
    elif q1("SELECT id FROM activities WHERE code=?", (code,)):
        return jsonify({"error": f"Ya existe una actividad con el codigo {code}"}), 409
    aid = execute("INSERT INTO activities (code, name) VALUES (?,?)", (code, name))
    return jsonify({"id": aid, "code": code}), 201


@bp.get("/defect-types")
@login_required
def list_defects():
    return jsonify(q("SELECT * FROM defect_types ORDER BY code"))


@bp.post("/defect-types")
@login_required
@require_permission("create", "edit")
def create_defect():
    d = request.get_json(force=True)
    did = execute("INSERT INTO defect_types (code, name) VALUES (?,?)", (d["code"], d["name"]))
    return jsonify({"id": did}), 201


@bp.get("/promotions")
@login_required
def list_promotions():
    client_id = request.args.get("client_id")
    if client_id:
        return jsonify(q("SELECT * FROM promotions WHERE client_id=? ORDER BY code", (client_id,)))
    return jsonify(q("SELECT * FROM promotions ORDER BY code"))


@bp.post("/promotions")
@login_required
@require_permission("create", "edit")
def create_promotion():
    d = request.get_json(force=True)
    pid = execute("INSERT INTO promotions (code, description, client_id) VALUES (?,?,?)",
                  (d["code"], d.get("description"), d.get("client_id")))
    return jsonify({"id": pid}), 201
