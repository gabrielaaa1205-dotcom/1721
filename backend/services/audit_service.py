"""Registro de auditoria: nunca se sobreescribe un dato critico sin dejar rastro."""
from db import execute


def log_change(entity_type, entity_id, user_id, action="UPDATE", field=None, old_value=None, new_value=None, reason=None):
    execute(
        """INSERT INTO audit_logs (entity_type, entity_id, field, old_value, new_value, user_id, action, reason)
           VALUES (?,?,?,?,?,?,?,?)""",
        (entity_type, entity_id, field, str(old_value) if old_value is not None else None,
         str(new_value) if new_value is not None else None, user_id, action, reason),
    )
