"""
Migraciones aditivas de esquema (2026 — modulo de Produccion/Maquila + mejoras).

Reglas:
- NUNCA se borra ni se resetea una tabla existente.
- Las columnas nuevas se agregan solo si no existen (ALTER TABLE ... ADD COLUMN).
- Las tablas nuevas usan CREATE TABLE IF NOT EXISTS.
- Se puede ejecutar en cada arranque del servidor sin riesgo (idempotente).
"""
from db import get_conn, execute, q1


def _column_names(table):
    conn = get_conn()
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column_if_missing(table, column_def):
    col_name = column_def.split()[0]
    if col_name not in _column_names(table):
        get_conn().execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
        get_conn().commit()
        print(f"[migrate] {table}: agregada columna {col_name}")


NEW_TABLES_SQL = """
-- ---------- Catalogos de Produccion / Maquila ----------
CREATE TABLE IF NOT EXISTS operation_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  document_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  group_type TEXT NOT NULL DEFAULT 'MESA' CHECK(group_type IN ('MESA','LINEA','GRUPO')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Actividades de produccion (cabecera) ----------
CREATE TABLE IF NOT EXISTS production_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_date TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  work_order TEXT,
  product_id INTEGER REFERENCES products(id),
  product_free_text TEXT,
  operation_type_id INTEGER REFERENCES operation_types(id),
  operation_type_free_text TEXT,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  qty_produced REAL NOT NULL DEFAULT 0,
  qty_good REAL NOT NULL DEFAULT 0,
  qty_defective REAL NOT NULL DEFAULT 0,
  operator_count INTEGER NOT NULL DEFAULT 0,
  work_group_id INTEGER REFERENCES work_groups(id),
  work_group_free_text TEXT,
  supervisor_user_id INTEGER REFERENCES users(id),
  supervisor_free_text TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'EN_CURSO' CHECK(status IN ('EN_CURSO','FINALIZADA','CANCELADA')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_prodact_date ON production_activities(activity_date);
CREATE INDEX IF NOT EXISTS idx_prodact_client ON production_activities(client_id);
CREATE INDEX IF NOT EXISTS idx_prodact_optype ON production_activities(operation_type_id);
CREATE INDEX IF NOT EXISTS idx_prodact_product ON production_activities(product_id);

-- ---------- Participantes de una actividad (personal asignado) ----------
CREATE TABLE IF NOT EXISTS production_activity_operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_activity_id INTEGER NOT NULL REFERENCES production_activities(id) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL REFERENCES operators(id),
  role_note TEXT,
  UNIQUE(production_activity_id, operator_id)
);
CREATE INDEX IF NOT EXISTS idx_prodops_activity ON production_activity_operators(production_activity_id);
CREATE INDEX IF NOT EXISTS idx_prodops_operator ON production_activity_operators(operator_id);

-- ---------- Combos / Kits (Bill of Materials): un producto "combo" no tiene
-- stock propio, se arma de otros productos. Al despacharlo se descuentan sus
-- componentes en vez de el mismo. ----------
CREATE TABLE IF NOT EXISTS product_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id),
  qty_per_kit REAL NOT NULL CHECK(qty_per_kit > 0),
  UNIQUE(kit_product_id, component_product_id)
);
CREATE INDEX IF NOT EXISTS idx_components_kit ON product_components(kit_product_id);

-- ---------- Ubicacion partida (varias posiciones para un mismo item de
-- recepcion, ej. 6 paletas del mismo lote en 6 posiciones distintas) ----------
CREATE TABLE IF NOT EXISTS reception_item_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reception_item_id INTEGER NOT NULL REFERENCES reception_items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty REAL NOT NULL CHECK(qty > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ril_item ON reception_item_locations(reception_item_id);
"""


def _relax_reservations_location_nullable():
    """El stock importado desde el Excel historico no tiene ubicacion de rack
    asignada (nunca paso por 'Ubicar'). Antes, esto bloqueaba CUALQUIER
    despacho porque reservations.location_id era NOT NULL. Se relaja a NULL
    para poder reservar/despachar stock aunque todavia no tenga rack asignado
    (se puede ubicar despues, sin bloquear la operacion mientras tanto)."""
    conn = get_conn()
    info = conn.execute("PRAGMA table_info(reservations)").fetchall()
    loc_col = next((r for r in info if r[1] == "location_id"), None)
    if not loc_col or loc_col[3] == 0:
        return  # no existe la tabla aun, o location_id ya es nullable: nada que hacer
    conn.execute("DROP VIEW IF EXISTS active_reservations_by_loc")
    conn.execute("DROP TABLE IF EXISTS reservations_new")  # residuo de un intento anterior interrumpido
    conn.execute(
        """CREATE TABLE reservations_new (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             dispatch_item_id INTEGER NOT NULL REFERENCES dispatch_items(id) ON DELETE CASCADE,
             product_id INTEGER NOT NULL REFERENCES products(id),
             lot_id INTEGER REFERENCES lots(id),
             location_id INTEGER REFERENCES locations(id),
             client_id INTEGER NOT NULL REFERENCES clients(id),
             qty REAL NOT NULL,
             status TEXT NOT NULL DEFAULT 'ACTIVA' CHECK(status IN ('ACTIVA','CONSUMIDA','LIBERADA')),
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             reason TEXT
           )"""
    )
    conn.execute("INSERT INTO reservations_new SELECT * FROM reservations")
    conn.execute("DROP TABLE reservations")
    conn.execute("ALTER TABLE reservations_new RENAME TO reservations")
    conn.execute(
        """CREATE VIEW active_reservations_by_loc AS
           SELECT product_id, lot_id, location_id, client_id, SUM(qty) AS reserved_qty
           FROM reservations WHERE status = 'ACTIVA'
           GROUP BY product_id, lot_id, location_id, client_id"""
    )
    conn.commit()
    print("[migrate] reservations: location_id ahora acepta NULL (stock sin ubicacion asignada)")


def _relax_picking_items_location_nullable():
    """Igual que con reservations: el stock sin ubicar tambien debe poder
    pasar por picking (queda con location_id NULL, se ubica despues)."""
    conn = get_conn()
    info = conn.execute("PRAGMA table_info(picking_items)").fetchall()
    loc_col = next((r for r in info if r[1] == "location_id"), None)
    if not loc_col or loc_col[3] == 0:
        return
    conn.execute("DROP TABLE IF EXISTS picking_items_new")
    conn.execute(
        """CREATE TABLE picking_items_new (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             picking_order_id INTEGER NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
             reservation_id INTEGER REFERENCES reservations(id),
             product_id INTEGER NOT NULL REFERENCES products(id),
             lot_id INTEGER REFERENCES lots(id),
             location_id INTEGER REFERENCES locations(id),
             qty_requested REAL NOT NULL,
             qty_picked REAL NOT NULL DEFAULT 0,
             sequence INTEGER NOT NULL DEFAULT 0,
             status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','EN_PICKING','PICKEADO','DIFERENCIA','NO_ENCONTRADO'))
           )"""
    )
    conn.execute("INSERT INTO picking_items_new SELECT * FROM picking_items")
    conn.execute("DROP TABLE picking_items")
    conn.execute("ALTER TABLE picking_items_new RENAME TO picking_items")
    conn.commit()
    print("[migrate] picking_items: location_id ahora acepta NULL (stock sin ubicacion asignada)")


def _add_parcial_storage_status():
    """Permite storage_status='PARCIAL' (algunas paletas del lote ya ubicadas,
    otras todavia no) -- antes solo aceptaba PENDIENTE/UBICADO."""
    conn = get_conn()
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='reception_items'").fetchone()
    if not row or "PARCIAL" in row[0]:
        return  # no existe la tabla aun, o ya esta migrada
    conn.execute("DROP TABLE IF EXISTS reception_items_new")
    conn.execute(
        """CREATE TABLE reception_items_new (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             reception_id INTEGER NOT NULL REFERENCES receptions(id) ON DELETE CASCADE,
             product_id INTEGER NOT NULL REFERENCES products(id),
             lot_id INTEGER REFERENCES lots(id),
             qty_cases REAL,
             qty_units REAL NOT NULL,
             activity_id INTEGER REFERENCES activities(id),
             promotion_id INTEGER REFERENCES promotions(id),
             notes TEXT,
             quality_status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(quality_status IN ('PENDIENTE','DISPONIBLE','CUARENTENA','OBSERVADO','RECHAZADO','DANADO')),
             storage_status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(storage_status IN ('PENDIENTE','PARCIAL','UBICADO')),
             location_id INTEGER REFERENCES locations(id)
           )"""
    )
    conn.execute("INSERT INTO reception_items_new SELECT * FROM reception_items")
    conn.execute("DROP TABLE reception_items")
    conn.execute("ALTER TABLE reception_items_new RENAME TO reception_items")
    conn.commit()
    print("[migrate] reception_items: storage_status ahora acepta 'PARCIAL' (ubicacion partida en varias posiciones)")


def run_migrations():
    conn = get_conn()

    # --- clients: contacto ---
    _add_column_if_missing("clients", "contact TEXT")

    # --- products: catalogo mas rico, sin romper columnas existentes ---
    _add_column_if_missing("products", "category TEXT")
    _add_column_if_missing("products", "presentation TEXT")
    _add_column_if_missing("products", "observations TEXT")

    # --- racks: nivel "pasillo" para el sistema de ubicacion cardinal ---
    _add_column_if_missing("racks", "aisle_code TEXT")

    # --- racks: layout real del almacen (plano fisico + accesos) ---
    _add_column_if_missing("racks", "access_sides TEXT NOT NULL DEFAULT 'UN_LADO'")
    _add_column_if_missing("racks", "grid_col INTEGER")
    _add_column_if_missing("racks", "grid_row INTEGER NOT NULL DEFAULT 1")
    _add_column_if_missing("racks", "grid_row_span INTEGER NOT NULL DEFAULT 1")
    _add_column_if_missing("racks", "tight_after INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing("products", "item_type TEXT NOT NULL DEFAULT 'PRODUCTO'")
    _add_column_if_missing("dispatches", "order_number TEXT")

    # --- nuevas tablas del modulo de Produccion / Maquila ---
    conn.executescript(NEW_TABLES_SQL)
    conn.commit()

    _relax_reservations_location_nullable()
    _relax_picking_items_location_nullable()
    _add_parcial_storage_status()

    print("[migrate] esquema al dia (clientes/productos flexibles, ubicacion cardinal, produccion)")
