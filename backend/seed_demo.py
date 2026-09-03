"""
Seed inicial: roles, usuario administrador, catalogos base (actividades y
tipos de defecto, tal como se encontraron documentados en las leyendas del
Excel original) y una estructura de almacen de ejemplo.
"""
from db import execute, q1
from auth import hash_password

ROLES = [
    ("ADMIN", "Administrador", "Acceso completo al sistema"),
    ("SUPERVISOR", "Supervisor", "Revisa, aprueba, modifica y consulta"),
    ("RECEPCION", "Recepcion", "Registra recepciones y controla calidad de ingreso"),
    ("ALMACEN", "Almacen", "Asigna ubicaciones y realiza movimientos"),
    ("PICKING", "Picking/Despacho", "Realiza picking y despachos"),
    ("CONSULTA", "Consulta", "Solo lectura"),
]

ACTIVITIES = [
    ("I", "Promociones"), ("II", "Empacado"), ("III", "Encajado"), ("IV", "Encintado"),
    ("V", "Revision 100%"), ("VI", "Canasta"), ("VII", "Etiquetado"), ("VIII", "Reetiquetado"),
]

DEFECT_TYPES = [
    ("1", "Tapa rota"), ("2", "Etiquetas danadas"), ("3", "Mala impresion (inject)"),
    ("4", "Caja master defectuosa"), ("5", "Sobre roto"), ("6", "Frasco roto"),
    ("7", "Presentacion no conforme"), ("8", "Producto abollado"), ("9", "Producto semivacio"),
    ("10", "Informacion de etiqueta no conforme"),
]

# Tipos de operacion de maquila (catalogo inicial; el usuario puede agregar mas
# desde el modulo de Produccion en cualquier momento, sin tocar codigo).
OPERATION_TYPES = [
    ("PROMO", "Promocion"), ("EMPAQ", "Empaquetado"), ("ENCAJ", "Encajado"),
    ("ENCINT", "Encintado"), ("REV100", "Revision 100%"), ("CANASTA", "Armado de canasta"),
    ("ETIQ", "Etiquetado"), ("REETIQ", "Reetiquetado"), ("OTRO", "Otra operacion"),
]

# Grupos de trabajo base (mesas/lineas tipicas). Son solo sugerencias: en el
# formulario de produccion siempre se puede escribir un nombre nuevo de mesa,
# linea o grupo sin necesidad de crearlo aqui primero.
WORK_GROUPS = [
    ("MESA-1", "Mesa 1", "MESA"), ("MESA-2", "Mesa 2", "MESA"), ("MESA-3", "Mesa 3", "MESA"),
    ("LINEA-1", "Linea 1", "LINEA"), ("LINEA-2", "Linea 2", "LINEA"),
    ("GRUPO-A", "Grupo A", "GRUPO"), ("GRUPO-B", "Grupo B", "GRUPO"),
]


def run_seed():
    for code, name, desc in ROLES:
        if not q1("SELECT id FROM roles WHERE code=?", (code,)):
            execute("INSERT INTO roles (code, name, description) VALUES (?,?,?)", (code, name, desc))

    admin_role = q1("SELECT id FROM roles WHERE code='ADMIN'")
    if not q1("SELECT id FROM users WHERE email='admin@almacen.com'"):
        execute(
            "INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)",
            ("Administrador", "admin@almacen.com", hash_password("admin123"), admin_role["id"]),
        )

    supervisor_role = q1("SELECT id FROM roles WHERE code='SUPERVISOR'")
    if not q1("SELECT id FROM users WHERE email='supervisor@almacen.com'"):
        execute(
            "INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)",
            ("Marcos Gutierrez", "supervisor@almacen.com", hash_password("super123"), supervisor_role["id"]),
        )

    for code, name in ACTIVITIES:
        if not q1("SELECT id FROM activities WHERE code=?", (code,)):
            execute("INSERT INTO activities (code, name) VALUES (?,?)", (code, name))

    for code, name in DEFECT_TYPES:
        if not q1("SELECT id FROM defect_types WHERE code=?", (code,)):
            execute("INSERT INTO defect_types (code, name) VALUES (?,?)", (code, name))

    if not q1("SELECT id FROM warehouses WHERE code='ALM-01'"):
        wid = execute("INSERT INTO warehouses (code, name, address) VALUES (?,?,?)",
                      ("ALM-01", "Almacen Principal", ""))
        zones = [("ZA", "Zona A"), ("ZB", "Zona B"), ("ZC", "Zona C")]
        for zcode, zname in zones:
            zid = execute("INSERT INTO zones (warehouse_id, code, description) VALUES (?,?,?)", (wid, zcode, zname))
            for rn in range(1, 6):
                rcode = f"R{rn:02d}"
                rid = execute("INSERT INTO racks (zone_id, code) VALUES (?,?)", (zid, rcode))
                for lvln in range(1, 4):
                    lcode = f"N{lvln:02d}"
                    lvl_id = execute("INSERT INTO rack_levels (rack_id, code) VALUES (?,?)", (rid, lcode))
                    for pn in range(1, 5):
                        pcode = f"P{pn:02d}"
                        full_code = f"ALM01-{zcode}-{rcode}-{lcode}-{pcode}"
                        execute(
                            """INSERT INTO locations (rack_level_id, position_code, full_code, loc_type, capacity, status)
                               VALUES (?,?,?,?,?,?)""",
                            (lvl_id, pcode, full_code, "ESTANTERIA", 100000, "DISPONIBLE"),
                        )

    for code, name in OPERATION_TYPES:
        if not q1("SELECT id FROM operation_types WHERE code=?", (code,)):
            execute("INSERT INTO operation_types (code, name) VALUES (?,?)", (code, name))

    for code, name, gtype in WORK_GROUPS:
        if not q1("SELECT id FROM work_groups WHERE code=?", (code,)):
            execute("INSERT INTO work_groups (code, name, group_type) VALUES (?,?,?)", (code, name, gtype))

    from db import get_conn
    get_conn().commit()
