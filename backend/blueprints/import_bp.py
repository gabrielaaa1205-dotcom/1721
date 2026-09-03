import os
import tempfile

from flask import Blueprint, request, jsonify, g

from db import q, tx
from auth import login_required, require_permission
from importer import excel_importer

bp = Blueprint("import", __name__)


@bp.post("/import/validate")
@login_required
@require_permission("create", "edit")
def validate_import():
    if "file" not in request.files:
        return jsonify({"error": "Debe adjuntar un archivo (campo 'file')"}), 400
    f = request.files["file"]
    batch_type = request.form.get("batch_type", "CRP").upper()
    if batch_type not in ("CRP", "CDP"):
        return jsonify({"error": "batch_type debe ser CRP o CDP"}), 400

    suffix = os.path.splitext(f.filename)[1] or ".xlsx"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    f.save(tmp.name)
    tmp.close()

    try:
        token, validated, summary = excel_importer.stage_import(tmp.name, batch_type)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    finally:
        os.unlink(tmp.name)

    preview = validated[:60]
    return jsonify({"token": token, "summary": summary, "total_rows": len(validated), "preview": preview})


@bp.post("/import/confirm")
@login_required
@require_permission("create", "edit")
def confirm_import():
    d = request.get_json(force=True)
    token = d.get("token")
    if not token:
        return jsonify({"error": "token requerido"}), 400
    try:
        with tx():
            result = excel_importer.confirm_import(token, g.user["id"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except excel_importer.stock_service.StockError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(result)


@bp.get("/import/batches")
@login_required
def list_batches():
    return jsonify(q(
        """SELECT ib.*, u.name as imported_by_name FROM import_batches ib
           LEFT JOIN users u ON u.id=ib.imported_by ORDER BY ib.imported_at DESC"""
    ))
