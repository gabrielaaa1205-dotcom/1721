"""
Reemplaza el layout de almacen (demo o una version anterior/incorrecta) por el
layout REAL confirmado por el cliente (plano dibujado a mano), con los
nombres reales de cada rack y las cantidades exactas de cada tramo.

FORMA REAL (todos los racks son barras verticales de la MISMA altura, en una
sola fila -- no hay racks divididos en mitad de arriba / mitad de abajo).
Orden fisico de izquierda a derecha tal como lo dibujo el cliente:

  Rack H -> Patio de Despacho (zona ancha, sin racks) -> Rack G y Rack F
  (pegados entre si, sin espacio) -> Rack E y Rack D (pegados entre si) ->
  Rack C y Rack B (pegados entre si) -> Rack A (el mas grande, aparte, al
  final).

  La numeracion/lectura empieza en Rack A (el del otro extremo) segun la
  convencion original del cliente ("empieza desde la derecha"); en el plano
  de izquierda a derecha en pantalla queda H...A tal como esta arriba.

  - Rack H: 30 racks x 2 paletas = 60 posiciones.
  - Rack G / Rack F: pegados, 57 racks x 2 paletas = 114 posiciones c/u.
  - Rack E / Rack D: pegados, 114 posiciones c/u.
  - Rack C / Rack B: pegados, 114 posiciones c/u.
  - Rack A: el mas grande, 60 racks x 2 paletas = 120 posiciones.

  => 8 racks en total: A, B, C, D, E, F, G, H
  => TOTAL: 120 (A) + 3 x 228 (B/C, D/E, F/G) + 60 (H) = 864 posiciones.

Cada rack tiene 6 niveles (1 = piso .. 6 = mas alto), posiciones repartidas
parejo entre los 6 niveles: A: 20/nivel . B/C/D/E/F/G: 19/nivel . H: 10/nivel

SISTEMA DE CODIGO: "{rack en minuscula}{nivel},{posicion}", ej. "a1,1" =
Rack A, Nivel 1, Posicion 1; "a2,1" = Rack A, Nivel 2 (el de arriba),
Posicion 1. Igual para cualquier rack (ej. "g3,8" = Rack G, Nivel 3,
Posicion 8). Cada posicion admite 2 paletas (dato de contexto).

Se puede correr las veces que haga falta: si el layout cargado no coincide
con RACKS de abajo, lo borra y lo vuelve a crear con los datos correctos.
"""
from db import get_conn, execute, q, q1

LEVELS_PER_RACK = 6

# code, posiciones_totales (incluye los 6 niveles), orden en el plano
# (izquierda a derecha, dejando la posicion 2 libre para "Patio de
# Despacho"), tight_after (1 = va pegado, sin espacio de pasillo, al rack
# inmediatamente anterior en el orden -- forma la pareja)
RACKS = [
    ("H", 60, 1, 0),
    ("G", 114, 3, 0),
    ("F", 114, 4, 1),   # pegado a G
    ("E", 114, 5, 0),
    ("D", 114, 6, 1),   # pegado a E
    ("C", 114, 7, 0),
    ("B", 114, 8, 1),   # pegado a C
    ("A", 120, 9, 0),
]

# pareja de cada rack (para la etiqueta "Junto a Rack X" en vez de una
# generica "doble acceso"); los laterales H y A no tienen pareja.
PAIR_OF = {"G": "F", "F": "G", "E": "D", "D": "E", "C": "B", "B": "C"}

PATIO_GRID_COL = 2  # posicion del plano reservada para "Patio de Despacho" (sin racks)

TOTAL_POSITIONS = sum(r[1] for r in RACKS)  # 864


def _layout_is_current(zone_id):
    rows = q("SELECT code, grid_col, tight_after FROM racks WHERE zone_id=?", (zone_id,))
    current = {r["code"]: (r["grid_col"], r["tight_after"]) for r in rows}
    expected = {r[0]: (r[2], r[3]) for r in RACKS}
    if current != expected:
        return False
    total = q1(
        """SELECT COUNT(*) AS c FROM locations loc
           JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           JOIN racks r ON r.id = lvl.rack_id
           WHERE r.zone_id=?""",
        (zone_id,),
    )
    return total and total["c"] == TOTAL_POSITIONS


def _wipe_zone(conn, zone_id):
    locs = q(
        """SELECT loc.id FROM locations loc
           JOIN rack_levels lvl ON lvl.id = loc.rack_level_id
           JOIN racks r ON r.id = lvl.rack_id
           WHERE r.zone_id=?""",
        (zone_id,),
    )
    if locs:
        loc_ids = tuple(l["id"] for l in locs)
        placeholders = ",".join("?" * len(loc_ids))
        conn.execute(f"UPDATE inventory_movements SET from_location_id=NULL WHERE from_location_id IN ({placeholders})", loc_ids)
        conn.execute(f"UPDATE inventory_movements SET to_location_id=NULL WHERE to_location_id IN ({placeholders})", loc_ids)
        conn.execute(f"UPDATE reception_items SET location_id=NULL WHERE location_id IN ({placeholders})", loc_ids)
        conn.execute(f"UPDATE dispatch_items SET location_id=NULL WHERE location_id IN ({placeholders})", loc_ids)
        conn.execute(f"DELETE FROM picking_items WHERE location_id IN ({placeholders})", loc_ids)
        conn.execute(f"DELETE FROM reservations WHERE location_id IN ({placeholders})", loc_ids)
        conn.execute(f"DELETE FROM physical_inventory_items WHERE location_id IN ({placeholders})", loc_ids)
    conn.execute("UPDATE physical_inventory_counts SET zone_id=NULL WHERE zone_id=?", (zone_id,))
    conn.execute("DELETE FROM zones WHERE id=?", (zone_id,))  # cascada borra racks/niveles/ubicaciones
    conn.commit()


def run_seed_racks_real():
    conn = get_conn()

    wh = q1("SELECT id FROM warehouses WHERE code='ALM-01'")
    if not wh:
        wh_id = execute("INSERT INTO warehouses (code, name, address) VALUES (?,?,?)",
                         ("ALM-01", "Almacen Principal", ""))
    else:
        wh_id = wh["id"]

    for old_code in ("ZA", "ZB", "ZC"):
        old_zone = q1("SELECT id FROM zones WHERE warehouse_id=? AND code=?", (wh_id, old_code))
        if old_zone:
            _wipe_zone(conn, old_zone["id"])

    zone = q1("SELECT id FROM zones WHERE warehouse_id=? AND code='ZR'", (wh_id,))
    if zone and _layout_is_current(zone["id"]):
        return  # ya esta cargado el layout real correcto, no hacer nada

    if zone:
        _wipe_zone(conn, zone["id"])  # layout viejo/incorrecto -> recrear

    zone_id = execute(
        "INSERT INTO zones (warehouse_id, code, description) VALUES (?,?,?)",
        (wh_id, "ZR", "Zona de Racks"),
    )

    for rcode, total_pos, gcol, tight in RACKS:
        positions_per_level = total_pos // LEVELS_PER_RACK
        rid = execute(
            "INSERT INTO racks (zone_id, code, access_sides, grid_col, grid_row, grid_row_span, tight_after) VALUES (?,?,?,?,?,?,?)",
            (zone_id, rcode, "UN_LADO", gcol, 1, 1, tight),
        )
        for lvln in range(1, LEVELS_PER_RACK + 1):
            lcode = f"N{lvln}"
            lvl_id = execute("INSERT INTO rack_levels (rack_id, code) VALUES (?,?)", (rid, lcode))
            for pn in range(1, positions_per_level + 1):
                pcode = f"{pn:02d}"
                full_code = f"{rcode.lower()}{lvln},{pn}"
                execute(
                    """INSERT INTO locations (rack_level_id, position_code, full_code, loc_type, capacity, status)
                       VALUES (?,?,?,?,?,?)""",
                    (lvl_id, pcode, full_code, "ESTANTERIA", 0, "DISPONIBLE"),
                )

    conn.commit()
    print(f"[seed_racks_real] Layout real cargado: {len(RACKS)} racks, {TOTAL_POSITIONS} posiciones totales")


# ============================================================================
# PATIO DE DESPACHO: zona de ubicaciones TEMPORALES reales (no solo un
# dibujo). A veces la mercaderia recien llegada se deja un rato en el patio
# (no hay chance de guardarla al toque en su rack) y despues se reubica a una
# posicion real. Estas posiciones "patio,1".."patio,20" son de transito, sin
# limite de capacidad (para no trabar el ingreso), y quedan fuera del plano
# visual de racks (se listan aparte, mas simple, ya que no son un rack real).
PATIO_SLOTS = 20


def run_seed_patio():
    conn = get_conn()
    wh = q1("SELECT id FROM warehouses WHERE code='ALM-01'")
    if not wh:
        return  # se crea siempre despues de run_seed_racks_real(), deberia existir
    wh_id = wh["id"]

    zone = q1("SELECT id FROM zones WHERE warehouse_id=? AND code='ZP'", (wh_id,))
    if zone:
        total = q1(
            """SELECT COUNT(*) as c FROM locations loc
               JOIN rack_levels lvl ON lvl.id=loc.rack_level_id
               JOIN racks r ON r.id=lvl.rack_id WHERE r.zone_id=?""",
            (zone["id"],),
        )["c"]
        if total == PATIO_SLOTS:
            return  # ya esta cargado

    if not zone:
        zone_id = execute(
            "INSERT INTO zones (warehouse_id, code, description) VALUES (?,?,?)",
            (wh_id, "ZP", "Patio de Despacho (temporal)"),
        )
    else:
        zone_id = zone["id"]

    rack = q1("SELECT id FROM racks WHERE zone_id=? AND code='PATIO'", (zone_id,))
    if not rack:
        rack_id = execute(
            "INSERT INTO racks (zone_id, code, access_sides, grid_col, grid_row, grid_row_span, tight_after) VALUES (?,?,?,?,?,?,?)",
            (zone_id, "PATIO", "UN_LADO", None, 1, 1, 0),
        )
    else:
        rack_id = rack["id"]

    lvl = q1("SELECT id FROM rack_levels WHERE rack_id=?", (rack_id,))
    lvl_id = lvl["id"] if lvl else execute("INSERT INTO rack_levels (rack_id, code) VALUES (?,?)", (rack_id, "N1"))

    existing = {r["position_code"] for r in q("SELECT position_code FROM locations WHERE rack_level_id=?", (lvl_id,))}
    for pn in range(1, PATIO_SLOTS + 1):
        pcode = f"{pn:02d}"
        if pcode in existing:
            continue
        full_code = f"patio,{pn}"
        execute(
            """INSERT INTO locations (rack_level_id, position_code, full_code, loc_type, capacity, status)
               VALUES (?,?,?,?,?,?)""",
            (lvl_id, pcode, full_code, "PATIO", 0, "DISPONIBLE"),
        )
    conn.commit()
    print(f"[seed_racks_real] Patio de Despacho: {PATIO_SLOTS} posiciones temporales listas")
