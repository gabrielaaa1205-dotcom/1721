import datetime

from flask import Blueprint, jsonify, request

from db import q, q1
from services import production_service as ps

bp = Blueprint("dashboard", __name__)
from auth import login_required


@bp.get("/dashboard")
@login_required
def dashboard():
    today = datetime.date.today().isoformat()

    receptions_today = q1("SELECT COUNT(*) as n FROM receptions WHERE reception_date=?", (today,))
    dispatches_today = q1("SELECT COUNT(*) as n FROM dispatches WHERE dispatch_date=?", (today,))
    receptions_pending = q1("SELECT COUNT(*) as n FROM receptions WHERE status IN ('PENDIENTE','EN_PROCESO')")
    dispatches_pending = q1("SELECT COUNT(*) as n FROM dispatches WHERE status IN ('PENDIENTE','RESERVADO','EN_PICKING')")
    receptions_observed = q1("SELECT COUNT(*) as n FROM receptions WHERE status='OBSERVADO'")
    dispatches_observed = q1("SELECT COUNT(*) as n FROM dispatches WHERE status='OBSERVADO'")

    units_received_today = q1(
        """SELECT COALESCE(SUM(m.qty),0) as n FROM inventory_movements m
           WHERE m.movement_type='RECEPCION' AND date(m.movement_date)=?""", (today,))
    units_dispatched_today = q1(
        """SELECT COALESCE(SUM(m.qty),0) as n FROM inventory_movements m
           WHERE m.movement_type='DESPACHO' AND date(m.movement_date)=?""", (today,))

    stock_by_status = q("SELECT status, SUM(qty) as qty FROM inventory_balances GROUP BY status")
    stock_map = {r["status"]: r["qty"] for r in stock_by_status}

    total_locations = q1("SELECT COUNT(*) as n FROM locations")
    occupied_locations = q1(
        """SELECT COUNT(DISTINCT location_id) as n FROM inventory_balances
           WHERE status IN ('DISPONIBLE','RESERVADO','CUARENTENA','BLOQUEADO','DANADO') AND location_id IS NOT NULL"""
    )
    blocked_locations = q1("SELECT COUNT(*) as n FROM locations WHERE status IN ('BLOQUEADA','MANTENIMIENTO')")

    thresholds = [7, 15, 30, 60, 90]
    expiring = {}
    for t in thresholds:
        limit = (datetime.date.today() + datetime.timedelta(days=t)).isoformat()
        row = q1(
            """SELECT COALESCE(SUM(b.qty),0) as qty, COUNT(DISTINCT b.product_id) as skus
               FROM inventory_balances b JOIN lots l ON l.id=b.lot_id
               WHERE b.status='DISPONIBLE' AND l.expiration_date IS NOT NULL
                 AND l.expiration_date <= ? AND l.expiration_date >= ?""",
            (limit, today),
        )
        expiring[str(t)] = row
    expired = q1(
        """SELECT COALESCE(SUM(b.qty),0) as qty, COUNT(DISTINCT b.product_id) as skus
           FROM inventory_balances b JOIN lots l ON l.id=b.lot_id
           WHERE b.status='DISPONIBLE' AND l.expiration_date IS NOT NULL AND l.expiration_date < ?""",
        (today,),
    )

    recent_receptions = q(
        """SELECT r.id, r.reception_number, r.status, r.reception_date, c.name as client_name
           FROM receptions r JOIN clients c ON c.id=r.client_id ORDER BY r.created_at DESC LIMIT 6"""
    )
    recent_dispatches = q(
        """SELECT d.id, d.dispatch_number, d.status, d.dispatch_date, c.name as client_name
           FROM dispatches d JOIN clients c ON c.id=d.client_id ORDER BY d.created_at DESC LIMIT 6"""
    )

    top_clients = q(
        """SELECT c.name, COUNT(*) as movs FROM inventory_movements m JOIN clients c ON c.id=m.client_id
           WHERE date(m.movement_date) >= date('now', '-30 days')
           GROUP BY c.id ORDER BY movs DESC LIMIT 8"""
    )

    # ------------------- Bloque de Produccion / Maquila (hoy) -------------------
    prod_today = q("SELECT * FROM production_activities WHERE activity_date=? AND status!='CANCELADA'", (today,))
    prod_production = sum(r["qty_produced"] or 0 for r in prod_today)
    prod_good = sum(r["qty_good"] or 0 for r in prod_today)
    prod_man_hours = sum((ps.compute_metrics(r)["man_hours"] or 0) for r in prod_today)
    prod_operators_today = q1(
        """SELECT COUNT(DISTINCT pao.operator_id) as n FROM production_activity_operators pao
           JOIN production_activities pa ON pa.id=pao.production_activity_id WHERE pa.activity_date=?""",
        (today,),
    )["n"]

    # ------------------- Alertas combinadas (almacen + produccion) -------------
    alerts = []
    if receptions_observed["n"]:
        alerts.append({"type": "recepciones_observadas", "severity": "warn",
                        "message": f"⚠️ {receptions_observed['n']} recepcion(es) observada(s) pendientes de revision"})
    if dispatches_observed["n"]:
        alerts.append({"type": "despachos_observados", "severity": "warn",
                        "message": f"⚠️ {dispatches_observed['n']} despacho(s) observado(s) pendientes de revision"})
    if expired["qty"]:
        alerts.append({"type": "vencidos", "severity": "bad",
                        "message": f"⚠️ {expired['qty']:g} unidades ya vencidas en {expired['skus']} SKU(s)"})
    if blocked_locations["n"]:
        alerts.append({"type": "ubicaciones_bloqueadas", "severity": "warn",
                        "message": f"⚠️ {blocked_locations['n']} ubicacion(es) bloqueada(s) o en mantenimiento"})
    alerts += ps.compute_alerts()

    return jsonify({
        "alerts": alerts,
        "production_today": {
            "activities": len(prod_today),
            "total_production": prod_production,
            "man_hours": round(prod_man_hours, 1),
            "productivity_packs_per_man_hour": round(prod_production / prod_man_hours, 2) if prod_man_hours else None,
            "quality_pct": round(100 * prod_good / prod_production, 1) if prod_production else None,
            "operators_active": prod_operators_today,
        },
        "operation_today": {
            "receptions": receptions_today["n"], "dispatches": dispatches_today["n"],
            "units_received": units_received_today["n"], "units_dispatched": units_dispatched_today["n"],
            "receptions_pending": receptions_pending["n"], "dispatches_pending": dispatches_pending["n"],
            "receptions_observed": receptions_observed["n"], "dispatches_observed": dispatches_observed["n"],
        },
        "stock_by_status": stock_map,
        "warehouse": {
            "total_locations": total_locations["n"], "occupied_locations": occupied_locations["n"],
            "free_locations": total_locations["n"] - occupied_locations["n"],
            "blocked_locations": blocked_locations["n"],
            "occupancy_pct": round(100 * occupied_locations["n"] / total_locations["n"], 1) if total_locations["n"] else 0,
        },
        "expiring": expiring,
        "expired": expired,
        "recent_receptions": recent_receptions,
        "recent_dispatches": recent_dispatches,
        "top_clients_30d": top_clients,
    })
