"""
Motor de calculo de productividad para el modulo de Produccion / Maquila.

Definiciones (ver seccion 27 del pedido del cliente):
  PRODUCCION    = cantidad fisica producida (packs / unidades)
  RECURSO       = personas x tiempo (horas-hombre)
  PRODUCTIVIDAD = produccion / recurso utilizado (packs por hora-hombre)
  EFICIENCIA    = produccion real / produccion esperada (segun estandar historico)
  CALIDAD       = unidades buenas / unidades producidas

Todas las funciones son de solo lectura salvo donde se indique; no se llama
aqui a nada que modifique inventario (el modulo de produccion es independiente
del kardex de almacen).
"""
import datetime
import statistics

from db import q, q1

ASSUMED_WORKDAY_HOURS = 8.0  # supuesto para "utilizacion de personal" (jornada tipica)


def _today_lima():
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def resolve_date_preset(preset):
    today = _today_lima()
    if preset == "today":
        return today, today
    if preset == "this_week":
        start = today - datetime.timedelta(days=today.weekday())
        return start, today
    if preset == "last_week":
        start_this = today - datetime.timedelta(days=today.weekday())
        start = start_this - datetime.timedelta(days=7)
        return start, start_this - datetime.timedelta(days=1)
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


def duration_hours(activity_date, start_time, end_time):
    """Horas entre start_time y end_time (HH:MM). None si falta la hora de fin.
    Si end < start se asume que cruzo medianoche (turno nocturno)."""
    if not start_time or not end_time:
        return None
    try:
        fmt = "%Y-%m-%d %H:%M"
        s = datetime.datetime.strptime(f"{str(activity_date)[:10]} {str(start_time)[:5]}", fmt)
        e = datetime.datetime.strptime(f"{str(activity_date)[:10]} {str(end_time)[:5]}", fmt)
        if e <= s:
            e += datetime.timedelta(days=1)
        return (e - s).total_seconds() / 3600
    except ValueError:
        return None


def compute_metrics(row):
    """row: dict-like con activity_date, start_time, end_time, operator_count,
    qty_produced, qty_good, qty_defective."""
    hours = duration_hours(row["activity_date"], row["start_time"], row["end_time"])
    operators = row.get("operator_count") or 0
    produced = row.get("qty_produced") or 0
    good = row.get("qty_good") or 0
    defective = row.get("qty_defective") or 0
    man_hours = (hours * operators) if (hours is not None and operators) else None
    return {
        "hours": round(hours, 2) if hours is not None else None,
        "man_hours": round(man_hours, 2) if man_hours else None,
        "packs_per_hour": round(produced / hours, 1) if hours else None,
        "packs_per_operator": round(produced / operators, 1) if operators else None,
        "packs_per_man_hour": round(produced / man_hours, 2) if man_hours else None,
        "minutes_man_per_pack": round((man_hours * 60) / produced, 2) if man_hours and produced else None,
        "quality_pct": round(100 * good / produced, 1) if produced else None,
        "defect_pct": round(100 * defective / produced, 1) if produced else None,
    }


def _ranges_overlap(s1, e1, s2, e2):
    return s1 < e2 and s2 < e1


def find_overlaps_for_operators(operator_ids, activity_date, start_time, end_time, exclude_activity_id=None):
    """Devuelve advertencias (no bloquea el registro) cuando un operario queda
    asignado a dos actividades con horarios que se superponen el mismo dia."""
    warnings = []
    if not operator_ids or not start_time or not end_time:
        return warnings
    for op_id in operator_ids:
        rows = q(
            """SELECT pa.id, pa.start_time, pa.end_time, pa.description, o.name as operator_name,
                      COALESCE(ot.name, pa.operation_type_free_text, 'Actividad') as op_label
               FROM production_activity_operators pao
               JOIN production_activities pa ON pa.id = pao.production_activity_id
               JOIN operators o ON o.id = pao.operator_id
               LEFT JOIN operation_types ot ON ot.id = pa.operation_type_id
               WHERE pao.operator_id=? AND pa.activity_date=? AND pa.status!='CANCELADA' AND pa.end_time IS NOT NULL""",
            (op_id, activity_date),
        )
        for r in rows:
            if exclude_activity_id and r["id"] == exclude_activity_id:
                continue
            if _ranges_overlap(start_time, end_time, r["start_time"], r["end_time"]):
                warnings.append({
                    "operator_id": op_id,
                    "operator_name": r["operator_name"],
                    "conflicting_activity_id": r["id"],
                    "message": (
                        f"⚠️ {r['operator_name']} aparece asignado simultaneamente a "
                        f"{start_time}-{end_time} y a {r['op_label']} ({r['start_time']}-{r['end_time']})."
                    ),
                })
    return warnings


def compute_standard(operation_type_id=None, product_id=None, client_id=None, exclude_id=None, min_samples=3):
    """Estandar de productividad (packs/hora-hombre) calculado del historial real,
    nunca de una sola actividad. n < min_samples => 'reliable': False."""
    sql = "SELECT * FROM production_activities WHERE status='FINALIZADA' AND end_time IS NOT NULL"
    params = []
    if operation_type_id:
        sql += " AND operation_type_id=?"; params.append(operation_type_id)
    if product_id:
        sql += " AND product_id=?"; params.append(product_id)
    if client_id:
        sql += " AND client_id=?"; params.append(client_id)
    if exclude_id:
        sql += " AND id!=?"; params.append(exclude_id)
    sql += " ORDER BY activity_date, start_time"
    rows = q(sql, tuple(params))

    values = []
    for r in rows:
        m = compute_metrics(r)
        if m["packs_per_man_hour"]:
            values.append(m["packs_per_man_hour"])

    n = len(values)
    if n == 0:
        return {"n": 0, "reliable": False}

    trend_pct = None
    if n >= 4:
        half = n // 2
        first_avg = sum(values[:half]) / half
        second_avg = sum(values[half:]) / (n - half)
        if first_avg > 0:
            trend_pct = round(100 * (second_avg - first_avg) / first_avg, 1)

    p75 = statistics.quantiles(values, n=4)[2] if n >= 2 else values[0]
    return {
        "n": n,
        "reliable": n >= min_samples,
        "avg": round(sum(values) / n, 2),
        "median": round(statistics.median(values), 2),
        "best": round(max(values), 2),
        "worst": round(min(values), 2),
        "p75": round(p75, 2),
        "trend_pct": trend_pct,
    }


def efficiency_pct(actual_packs_per_man_hour, standard):
    if not actual_packs_per_man_hour or not standard or not standard.get("reliable") or not standard.get("avg"):
        return None
    return round(100 * actual_packs_per_man_hour / standard["avg"], 1)


def compute_alerts():
    """Alertas inteligentes del modulo de produccion. Compartida entre el
    dashboard gerencial y la pantalla de alertas del modulo."""
    alerts = []
    today = _today_lima().isoformat()

    stuck = q("""SELECT pa.id, pa.activity_date, COALESCE(ot.name, pa.operation_type_free_text,'Actividad') as label, c.name as client_name
                 FROM production_activities pa JOIN clients c ON c.id=pa.client_id LEFT JOIN operation_types ot ON ot.id=pa.operation_type_id
                 WHERE pa.status='EN_CURSO' AND pa.activity_date < ? AND pa.end_time IS NULL""", (today,))
    for r in stuck:
        alerts.append({"type": "sin_hora_fin", "severity": "warn", "activity_id": r["id"],
                        "message": f"⚠️ Actividad sin hora de finalizacion: {r['label']} ({r['client_name']}, {r['activity_date']})"})

    zero_ops = q("""SELECT pa.id, pa.activity_date, COALESCE(ot.name, pa.operation_type_free_text,'Actividad') as label, c.name as client_name
                    FROM production_activities pa JOIN clients c ON c.id=pa.client_id LEFT JOIN operation_types ot ON ot.id=pa.operation_type_id
                    WHERE pa.qty_produced > 0 AND (pa.operator_count IS NULL OR pa.operator_count = 0)""")
    for r in zero_ops:
        alerts.append({"type": "sin_operarios", "severity": "bad", "activity_id": r["id"],
                        "message": f"⚠️ Produccion sin operarios registrados: {r['label']} ({r['client_name']}, {r['activity_date']})"})

    recent = q("""SELECT pa.* FROM production_activities pa WHERE pa.status!='CANCELADA' AND pa.activity_date >= date(?, '-14 days')""", (today,))
    seen = set()
    for r in recent:
        m = compute_metrics(r)
        if m["defect_pct"] and m["defect_pct"] > 5:
            alerts.append({"type": "alto_defecto", "severity": "warn", "activity_id": r["id"],
                            "message": f"⚠️ Alto % de defectos ({m['defect_pct']}%) en actividad #{r['id']} del {r['activity_date']}"})
        if m["packs_per_man_hour"]:
            std = compute_standard(operation_type_id=r["operation_type_id"], product_id=r["product_id"], exclude_id=r["id"])
            eff = efficiency_pct(m["packs_per_man_hour"], std)
            if eff is not None and eff < 70:
                alerts.append({"type": "baja_productividad", "severity": "warn", "activity_id": r["id"],
                                "message": f"⚠️ Productividad {eff}% por debajo del estandar en actividad #{r['id']} del {r['activity_date']}"})
        ops = [x["operator_id"] for x in q("SELECT operator_id FROM production_activity_operators WHERE production_activity_id=?", (r["id"],))]
        for w in find_overlaps_for_operators(ops, r["activity_date"], r["start_time"], r["end_time"], exclude_activity_id=r["id"]):
            key = tuple(sorted([r["id"], w["conflicting_activity_id"]])) + (w["operator_id"],)
            if key in seen:
                continue
            seen.add(key)
            alerts.append({"type": "solapamiento", "severity": "bad", "activity_id": r["id"], "message": w["message"]})

    return alerts
