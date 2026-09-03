"""Capa de acceso a datos: SQLite con filas tipo dict y helpers de transaccion.

Se usa una unica conexion global (permitida entre hilos) protegida por un
lock, en vez de una conexion por hilo: el servidor de desarrollo de Flask
puede atender requests en hilos distintos, y SQLite con WAL igual puede
devolver "database is locked" si dos hilos escriben casi al mismo tiempo.
Para una app de un solo almacen esto es mas simple y robusto que un pool.
"""
import os
import sqlite3
import threading
from contextlib import contextmanager

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("WMS_DB_PATH", os.path.join(BASE_DIR, "data", "wms.db"))
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

_conn = None
_lock = threading.RLock()


def get_conn():
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _conn.execute("PRAGMA journal_mode = WAL")
        _conn.execute("PRAGMA busy_timeout = 30000")
    return _conn


def init_db(reset: bool = False):
    if reset:
        for suffix in ("", "-wal", "-shm"):
            p = DB_PATH + suffix
            if os.path.exists(p):
                os.remove(p)
        global _conn
        _conn = None
    conn = get_conn()
    with _lock:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()


def q(sql, params=()):
    """SELECT -> list of dict"""
    with _lock:
        cur = get_conn().execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def q1(sql, params=()):
    rows = q(sql, params)
    return rows[0] if rows else None


def execute(sql, params=()):
    """INSERT/UPDATE/DELETE -> lastrowid. Autocommits unless inside tx()."""
    with _lock:
        cur = get_conn().execute(sql, params)
        if not getattr(_local_tx, "active", False):
            get_conn().commit()
        return cur.lastrowid


class _LocalTx(threading.local):
    active = False


_local_tx = _LocalTx()


@contextmanager
def tx():
    """Transaction context: commits on success, rolls back on exception."""
    with _lock:
        was_active = _local_tx.active
        _local_tx.active = True
        conn = get_conn()
        try:
            yield conn
            if not was_active:
                conn.commit()
        except Exception:
            if not was_active:
                conn.rollback()
            raise
        finally:
            _local_tx.active = was_active
