from flask import Blueprint, request, jsonify

from db import q
from auth import login_required

bp = Blueprint("search", __name__)


@bp.get("/search")
@login_required
def global_search():
    term = request.args.get("q", "").strip()
    if len(term) < 2:
        return jsonify({"results": []})
    like = f"%{term}%"
    results = []

    for r in q("SELECT id, sku_code, description FROM products WHERE sku_code LIKE ? OR description LIKE ? LIMIT 10", (like, like)):
        results.append({"type": "Producto", "label": f"{r['sku_code']} — {r['description']}", "id": r["id"], "sku_code": r["sku_code"], "url": f"/stock?sku={r['sku_code']}"})

    for r in q("SELECT id, lot_code FROM lots WHERE lot_code LIKE ? LIMIT 10", (like,)):
        results.append({"type": "Lote", "label": f"Lote {r['lot_code']}", "id": r["id"], "url": f"/trazabilidad/{r['id']}"})

    for r in q("SELECT id, name, code FROM clients WHERE name LIKE ? OR code LIKE ? LIMIT 10", (like, like)):
        results.append({"type": "Cliente", "label": r["name"], "id": r["id"], "url": f"/stock?client_id={r['id']}"})

    for r in q("SELECT id, reception_number, guide_number, container_number, order_number FROM receptions WHERE reception_number LIKE ? OR guide_number LIKE ? OR container_number LIKE ? OR order_number LIKE ? LIMIT 10",
               (like, like, like, like)):
        results.append({"type": "Recepcion", "label": r["reception_number"], "id": r["id"], "url": f"/recepciones/{r['id']}"})

    for r in q("SELECT id, dispatch_number, guide_number, order_number FROM dispatches WHERE dispatch_number LIKE ? OR guide_number LIKE ? OR order_number LIKE ? LIMIT 10",
               (like, like, like)):
        results.append({"type": "Despacho", "label": r["dispatch_number"], "id": r["id"], "url": f"/despachos/{r['id']}"})

    for r in q("SELECT id, full_code FROM locations WHERE full_code LIKE ? LIMIT 10", (like,)):
        results.append({"type": "Ubicacion", "label": r["full_code"], "id": r["id"], "url": f"/almacen/ubicacion/{r['id']}"})

    for r in q("SELECT id, name, code FROM operators WHERE name LIKE ? OR code LIKE ? LIMIT 10", (like, like)):
        results.append({"type": "Operario", "label": r["name"], "id": r["id"], "url": f"/produccion/por-operario?operator_id={r['id']}"})

    for r in q("""SELECT pa.id, pa.work_order, pa.activity_date, COALESCE(ot.name, pa.operation_type_free_text, 'Actividad') as label
                  FROM production_activities pa LEFT JOIN operation_types ot ON ot.id=pa.operation_type_id
                  WHERE pa.work_order LIKE ? OR pa.description LIKE ? LIMIT 10""", (like, like)):
        results.append({"type": "Actividad produccion", "label": f"{r['label']} ({r['activity_date']})", "id": r["id"], "url": f"/produccion/actividades/{r['id']}"})

    return jsonify({"results": results[:40]})
