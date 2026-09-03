from flask import Blueprint, request, jsonify, g

from db import q1
from auth import verify_password, make_token, login_required

bp = Blueprint("auth", __name__)


@bp.post("/auth/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    user = q1(
        """SELECT u.*, r.code as role_code, r.name as role_name FROM users u
           JOIN roles r ON r.id = u.role_id WHERE lower(u.email)=? AND u.active=1""",
        (email,),
    )
    if not user or not verify_password(password, user["password_hash"]):
        return jsonify({"error": "Credenciales invalidas"}), 401
    token = make_token(user)
    return jsonify({
        "token": token,
        "user": {"id": user["id"], "name": user["name"], "email": user["email"],
                  "role": user["role_code"], "role_name": user["role_name"]},
    })


@bp.get("/auth/me")
@login_required
def me():
    u = g.user
    role = q1("SELECT * FROM roles WHERE id=?", (u["role_id"],))
    return jsonify({"id": u["id"], "name": u["name"], "email": u["email"],
                     "role": role["code"], "role_name": role["name"]})
