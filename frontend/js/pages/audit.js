import { api } from "../api.js";
import { table, esc, fmtDateTime } from "../utils.js";

export async function renderAudit(container) {
  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="f-entity" placeholder="Tipo de entidad (ej: reception, dispatch, product)" style="max-width:280px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
        <button class="btn btn-sm" id="btn-filter">Filtrar</button>
      </div>
      <div id="tbl"></div>
    </div>`;

  async function load() {
    const rows = await api.get("/audit", { entity_type: container.querySelector("#f-entity").value });
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "Fecha", render: (r) => fmtDateTime(r.timestamp) },
        { label: "Entidad", key: "entity_type" },
        { label: "ID", key: "entity_id" },
        { label: "Accion", key: "action" },
        { label: "Campo", render: (r) => esc(r.field || "—") },
        { label: "Valor anterior", render: (r) => esc((r.old_value || "").slice(0, 60)) },
        { label: "Valor nuevo", render: (r) => esc((r.new_value || "").slice(0, 60)) },
        { label: "Usuario", render: (r) => esc(r.user_name || "—") },
        { label: "Motivo", render: (r) => esc(r.reason || "—") },
      ],
      rows,
      { emptyText: "Sin eventos de auditoria registrados aun" }
    );
  }
  container.querySelector("#btn-filter").addEventListener("click", load);
  await load();
}
