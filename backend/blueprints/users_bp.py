from flask import Blueprint, request, jsonify, g

from db import q, q1, execute
from auth import login_required, require_permission, hash_password
from services.audit_service import log_change

bp = Blueprint("users", __name__)


@bp.get("/roles")
@login_required
def list_roles():
    return jsonify(q("SELECT * FROM roles ORDER BY id"))


@bp.get("/users/basic")
@login_required
def list_users_basic():
    """Lista liviana (id + nombre) para poblar filtros 'usuario que registro' en
    cualquier modulo, sin requerir el permiso de administracion de usuarios."""
    return jsonify(q("SELECT id, name FROM users WHERE active=1 ORDER BY name"))


@bp.get("/users")
@login_required
@require_permission("*")
def list_users():
    return jsonify(q(
        """SELECT u.id, u.name, u.email, u.active, u.created_at, r.code as role, r.name as role_name
           FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.name"""
    ))


@bp.post("/users")
@login_required
@require_permission("*")
def create_user():
    d = request.get_json(force=True)
    if not d.get("name") or not d.get("email") or not d.get("password") or not d.get("role_id"):
        return jsonify({"error": "name, email, password y role_id son obligatorios"}), 400
    existing = q1("SELECT id FROM users WHERE lower(email)=?", (d["email"].lower(),))
    if existing:
        return jsonify({"error": "Ya existe un usuario con ese correo"}), 409
    uid = execute(
        "INSERT INTO users (name, email, password_hash, role_id, active) VALUES (?,?,?,?,1)",
        (d["name"], d["email"].lower(), hash_password(d["password"]), d["role_id"]),
    )
    log_change("user", uid, g.user["id"], action="CREATE", new_value=d["email"])
    return jsonify({"id": uid}), 201


@bp.put("/users/<int:uid>")
@login_required
@require_permission("*")
def update_user(uid):
    d = request.get_json(force=True)
    old = q1("SELECT * FROM users WHERE id=?", (uid,))
    if not old:
        return jsonify({"error": "no encontrado"}), 404
    active = int(d.get("active", old["active"]))
    role_id = d.get("role_id", old["role_id"])
    execute("UPDATE users SET active=?, role_id=? WHERE id=?", (active, role_id, uid))
    if d.get("password"):
        execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(d["password"]), uid))
    log_change("user", uid, g.user["id"], action="UPDATE", old_value=dict(old), new_value=d)
    return jsonify({"ok": True})
