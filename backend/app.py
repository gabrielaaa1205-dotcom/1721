"""
Sistema WMS - punto de entrada.
Sirve la API (/api/*) y el frontend estatico (todo lo demas) desde el mismo
proceso Flask, para que el usuario solo necesite correr un comando.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, send_from_directory, jsonify

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")

app = Flask(__name__, static_folder=None)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25MB uploads (excel)


@app.errorhandler(Exception)
def handle_exception(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({"error": e.description}), e.code
    app.logger.exception("Unhandled error")
    return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Blueprints
from blueprints.auth_bp import bp as auth_bp
from blueprints.catalogs_bp import bp as catalogs_bp
from blueprints.warehouse_bp import bp as warehouse_bp
from blueprints.receptions_bp import bp as receptions_bp
from blueprints.inventory_bp import bp as inventory_bp
from blueprints.dispatches_bp import bp as dispatches_bp
from blueprints.dashboard_bp import bp as dashboard_bp
from blueprints.reports_bp import bp as reports_bp
from blueprints.audit_bp import bp as audit_bp
from blueprints.users_bp import bp as users_bp
from blueprints.search_bp import bp as search_bp
from blueprints.import_bp import bp as import_bp
from blueprints.physical_inventory_bp import bp as physical_bp
from blueprints.production_bp import bp as production_bp

for bp in (auth_bp, catalogs_bp, warehouse_bp, receptions_bp, inventory_bp,
           dispatches_bp, dashboard_bp, reports_bp, audit_bp, users_bp,
           search_bp, import_bp, physical_bp, production_bp):
    app.register_blueprint(bp, url_prefix="/api")


# ---------------------------------------------------------------------------
# Frontend estatico (SPA) - cualquier ruta que no sea /api/* devuelve index.html
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    full_path = os.path.join(FRONTEND_DIR, path)
    if path and os.path.isfile(full_path):
        return send_from_directory(FRONTEND_DIR, path)
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.teardown_appcontext
def close_db(exception=None):
    pass  # conexion por hilo, se mantiene abierta durante la vida del proceso


def _bootstrap():
    """Inicializa la base de datos. Se ejecuta siempre al importar este modulo
    (tanto con 'python3 app.py' como bajo un servidor WSGI como gunicorn, que
    solo importa 'app' y nunca ejecuta el bloque __main__)."""
    # Si se configuro una ruta de datos distinta a la incluida en el paquete
    # (por ejemplo un volumen persistente en un hosting en la nube) y esa
    # ruta todavia no tiene base de datos, copiamos alli la base incluida
    # (con los datos reales de catalogos/recepciones) como punto de partida.
    seed_db = os.path.normpath(os.path.join(BASE_DIR, "..", "data", "wms.db"))
    if db.DB_PATH != seed_db and not os.path.exists(db.DB_PATH) and os.path.exists(seed_db):
        import shutil
        os.makedirs(os.path.dirname(db.DB_PATH), exist_ok=True)
        shutil.copy2(seed_db, db.DB_PATH)
        print(f"Base de datos inicial copiada a {db.DB_PATH}")

    with app.app_context():
        need_init = not os.path.exists(db.DB_PATH)
        db.init_db(reset=False)
        if need_init:
            from seed_demo import run_seed
            run_seed()
            print("Base de datos inicializada con catalogos base y usuario admin.")
        from migrate import run_migrations
        run_migrations()
        from seed_demo import run_seed
        run_seed()  # idempotente: agrega catalogos nuevos (produccion) sin duplicar ni tocar datos existentes
        from seed_racks_real import run_seed_racks_real, run_seed_patio
        run_seed_racks_real()  # idempotente: reemplaza el layout demo de racks por el layout real del almacen
        run_seed_patio()  # idempotente: crea las posiciones temporales del Patio de Despacho


_bootstrap()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    print(f"WMS corriendo en http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("WMS_DEBUG") == "1")
