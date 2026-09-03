from flask import Blueprint, request, jsonify

from db import q
from auth import login_required, require_permission

bp = Blueprint("audit", __name__)


@bp.get("/audit")
@login_required
@require_permission("approve", "view")
def list_audit():
    entity_type = request.args.get("entity_type")
    entity_id = request.args.get("entity_id")
    sql = """SELECT a.*, u.name as user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE 1=1"""
    params = []
    if entity_type:
        sql += " AND a.entity_type=?"; params.append(entity_type)
    if entity_id:
        sql += " AND a.entity_id=?"; params.append(entity_id)
    sql += " ORDER BY a.timestamp DESC LIMIT 300"
    return jsonify(q(sql, tuple(params)))
