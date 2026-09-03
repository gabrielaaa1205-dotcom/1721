-- ============================================================================
-- Sistema WMS - Esquema de base de datos (SQLite)
-- Modelo normalizado: cabecera+detalle, cliente como dato, catalogos reales,
-- stock calculado por partida doble sobre inventory_movements.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------- Identidad y permisos ----------
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,               -- ADMIN, SUPERVISOR, RECEPCION, ALMACEN, PICKING, CONSULTA
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Catalogos maestros ----------
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tax_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL,
  UNIQUE(alias_text)
);

CREATE TABLE IF NOT EXISTS client_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER UNIQUE NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  requires_lot INTEGER NOT NULL DEFAULT 0,
  requires_po INTEGER NOT NULL DEFAULT 0,
  dispatch_extra_field TEXT NOT NULL DEFAULT 'client_acceptance' CHECK(dispatch_extra_field IN ('client_acceptance','copacker_lot','none')),
  fefo_or_fifo TEXT NOT NULL DEFAULT 'FEFO' CHECK(fefo_or_fifo IN ('FEFO','FIFO')),
  expiry_thresholds TEXT NOT NULL DEFAULT '7,15,30,60,90'
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_code TEXT NOT NULL,
  description TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  unit_of_measure TEXT NOT NULL DEFAULT 'UND',
  units_per_case REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_id, sku_code)
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS defect_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  description TEXT,
  client_id INTEGER REFERENCES clients(id),
  UNIQUE(client_id, code)
);

-- ---------- Almacen fisico ----------
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  description TEXT,
  UNIQUE(warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS racks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  UNIQUE(zone_id, code)
);

CREATE TABLE IF NOT EXISTS rack_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  UNIQUE(rack_id, code)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rack_level_id INTEGER NOT NULL REFERENCES rack_levels(id) ON DELETE CASCADE,
  position_code TEXT NOT NULL,
  full_code TEXT UNIQUE NOT NULL,          -- e.g. ALM01-ZA-R05-N03-P04
  loc_type TEXT NOT NULL DEFAULT 'ESTANTERIA',
  capacity REAL NOT NULL DEFAULT 0,        -- unidades max (0 = sin limite)
  status TEXT NOT NULL DEFAULT 'DISPONIBLE' CHECK(status IN ('DISPONIBLE','OCUPADA','BLOQUEADA','RESERVADA','MANTENIMIENTO')),
  restrictions TEXT,                        -- json libre
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Lotes ----------
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_code TEXT NOT NULL,
  expiration_date TEXT,
  manufacture_date TEXT,
  origin_reception_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, lot_code)
);

-- ---------- Recepcion (cabecera + detalle) ----------
CREATE TABLE IF NOT EXISTS receptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reception_number TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  reception_date TEXT NOT NULL,
  reception_time TEXT,
  container_number TEXT,
  order_number TEXT,
  guide_number TEXT,
  origin TEXT,
  cargo_type TEXT,
  purchase_order TEXT,
  status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','EN_PROCESO','OBSERVADO','COMPLETADO','BLOQUEADO','CANCELADO')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL'    -- MANUAL | IMPORT_EXCEL
);

CREATE TABLE IF NOT EXISTS reception_items (
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
  storage_status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(storage_status IN ('PENDIENTE','UBICADO')),
  location_id INTEGER REFERENCES locations(id)
);

-- ---------- Calidad ----------
CREATE TABLE IF NOT EXISTS quality_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reception_item_id INTEGER REFERENCES reception_items(id) ON DELETE CASCADE,
  dispatch_item_id INTEGER REFERENCES dispatch_items(id) ON DELETE CASCADE,
  inspected_qty REAL NOT NULL,
  conforming_qty REAL NOT NULL,
  defective_qty REAL NOT NULL DEFAULT 0,
  inspector_user_id INTEGER REFERENCES users(id),
  inspection_date TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS quality_inspection_defects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quality_inspection_id INTEGER NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
  defect_type_id INTEGER NOT NULL REFERENCES defect_types(id),
  qty REAL NOT NULL
);

-- ---------- Movimientos de inventario (partida doble: from -> to) ----------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_type TEXT NOT NULL CHECK(movement_type IN (
    'RECEPCION','ALMACENAMIENTO','TRANSFERENCIA','AJUSTE_POSITIVO','AJUSTE_NEGATIVO',
    'RESERVA','LIBERACION_RESERVA','PICKING','DESPACHO','DEVOLUCION','CUARENTENA',
    'LIBERACION_CALIDAD','MERMA'
  )),
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  qty REAL NOT NULL CHECK(qty > 0),
  from_location_id INTEGER REFERENCES locations(id),
  from_status TEXT,
  to_location_id INTEGER REFERENCES locations(id),
  to_status TEXT,
  reference_type TEXT,                     -- RECEPTION | DISPATCH | PHYSICAL_COUNT | MANUAL
  reference_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  movement_date TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_mov_product_lot ON inventory_movements(product_id, lot_id);
CREATE INDEX IF NOT EXISTS idx_mov_client ON inventory_movements(client_id);
CREATE INDEX IF NOT EXISTS idx_mov_date ON inventory_movements(movement_date);

-- ---------- Despacho (cabecera + detalle) ----------
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_number TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  dispatch_date TEXT NOT NULL,
  dispatch_time TEXT,
  guide_number TEXT,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','RESERVADO','EN_PICKING','VERIFICADO','DESPACHADO','CERRADO','OBSERVADO','BLOQUEADO','CANCELADO')),
  responsible_user_id INTEGER REFERENCES users(id),
  prepared_at TEXT,
  picking_at TEXT,
  verified_at TEXT,
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'MANUAL'
);

CREATE TABLE IF NOT EXISTS dispatch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  origin_container TEXT,
  qty_cases REAL,
  qty_requested REAL NOT NULL,
  qty_conforming REAL,
  qty_defective REAL DEFAULT 0,
  expiration_date TEXT,
  client_acceptance TEXT,                  -- Si/No (segun client_configs)
  copacker_lot TEXT,                       -- (segun client_configs)
  activity_id INTEGER REFERENCES activities(id),
  promotion_id INTEGER REFERENCES promotions(id),
  notes TEXT,
  location_id INTEGER REFERENCES locations(id)
);

-- ---------- Reservas ----------
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_item_id INTEGER NOT NULL REFERENCES dispatch_items(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  qty REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVA' CHECK(status IN ('ACTIVA','CONSUMIDA','LIBERADA')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);

-- ---------- Picking ----------
CREATE TABLE IF NOT EXISTS picking_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','EN_PROCESO','COMPLETADO')),
  assigned_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS picking_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  picking_order_id INTEGER NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  reservation_id INTEGER REFERENCES reservations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_requested REAL NOT NULL,
  qty_picked REAL NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(status IN ('PENDIENTE','EN_PICKING','PICKEADO','DIFERENCIA','NO_ENCONTRADO'))
);

-- ---------- Documentos ----------
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  doc_type TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Inventario fisico ----------
CREATE TABLE IF NOT EXISTS physical_inventory_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  zone_id INTEGER REFERENCES zones(id),
  status TEXT NOT NULL DEFAULT 'ABIERTO' CHECK(status IN ('ABIERTO','CONTADO','APROBADO','CERRADO')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS physical_inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES physical_inventory_counts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES lots(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  system_qty REAL NOT NULL,
  counted_qty REAL,
  difference REAL,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT
);

-- ---------- Auditoria ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL DEFAULT 'UPDATE',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);

-- ---------- Importacion desde Excel ----------
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  batch_type TEXT NOT NULL,                 -- CRP | CDP
  imported_by INTEGER REFERENCES users(id),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  summary_json TEXT
);

-- ---------- Vista de saldos de stock (fuente: inventory_movements) ----------
DROP VIEW IF EXISTS inventory_balances;
CREATE VIEW inventory_balances AS
WITH legs AS (
  SELECT product_id, lot_id, client_id, to_location_id   AS location_id, to_status   AS status, qty AS delta FROM inventory_movements WHERE to_status IS NOT NULL
  UNION ALL
  SELECT product_id, lot_id, client_id, from_location_id AS location_id, from_status AS status, -qty AS delta FROM inventory_movements WHERE from_status IS NOT NULL
)
SELECT product_id, lot_id, client_id, location_id, status, SUM(delta) AS qty
FROM legs
GROUP BY product_id, lot_id, client_id, location_id, status
HAVING SUM(delta) > 0.0001;

-- ---------- Vista de reservas activas por producto/lote/ubicacion ----------
DROP VIEW IF EXISTS active_reservations_by_loc;
CREATE VIEW active_reservations_by_loc AS
SELECT product_id, lot_id, location_id, client_id, SUM(qty) AS reserved_qty
FROM reservations
WHERE status = 'ACTIVA'
GROUP BY product_id, lot_id, location_id, client_id;
