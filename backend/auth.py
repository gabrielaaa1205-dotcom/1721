"""Autenticacion JWT + control de roles/permisos."""
import os
import datetime
from functools import wraps

import jwt
from flask import request, jsonify, g
from werkzeug.security import generate_password_hash, check_password_hash

from db import q1

JWT_SECRET = os.environ.get("WMS_JWT_SECRET", "wms-dev-secret-change-in-production")
JWT_ALGO = "HS256"
TOKEN_TTL_HOURS = 12

# Matriz de permisos por rol (modulo -> acciones permitidas)
ROLE_PERMISSIONS = {
    "ADMIN": {"*"},
    "SUPERVISOR": {"view", "create", "edit", "approve", "quality", "adjust", "locate", "move", "count", "pick", "dispatch"},
    "RECEPCION": {"view", "create_reception", "edit_reception", "quality", "locate"},
    "ALMACEN": {"view", "locate", "move", "count", "quality", "edit"},
    "PICKING": {"view", "pick", "dispatch"},
    "CONSULTA": {"view"},
}


def hash_password(pw: str) -> str:
    return generate_password_hash(pw)


def verify_password(pw: str, pw_hash: str) -> bool:
    return check_password_hash(pw_hash, pw)


def make_token(user: dict) -> str:
    payload = {
        "uid": user["id"],
        "email": user["email"],
        "role": user["role_code"],
        "name": user["name"],
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_TTL_HOURS),
        "iat": datetime.datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def decode_token(token: str):
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "No autenticado"}), 401
        token = auth_header.split(" ", 1)[1]
        try:
            payload = decode_token(token)
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Sesion expirada"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Token invalido"}), 401
        user = q1("SELECT * FROM users WHERE id=? AND active=1", (payload["uid"],))
        if not user:
            return jsonify({"error": "Usuario inactivo o no encontrado"}), 401
        g.user = user
        g.role = payload["role"]
        return f(*args, **kwargs)
    return wrapper


def require_permission(*perms):
    """Decorator: requiere que el rol del usuario tenga al menos uno de los permisos dados."""
    def deco(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            role_perms = ROLE_PERMISSIONS.get(g.role, set())
            if "*" in role_perms or any(p in role_perms for p in perms):
                return f(*args, **kwargs)
            return jsonify({"error": "No tiene permiso para esta accion"}), 403
        return wrapper
    return deco
