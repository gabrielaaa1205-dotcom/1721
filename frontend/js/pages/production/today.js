import { api } from "../../api.js";
import { esc, fmtNum, badge, showModal, closeModal, toast } from "../../utils.js";
import { navigate } from "../../router.js";
import { openNewActivityModal } from "./activities.js";
import { hasPermission } from "../../state.js";

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function renderProductionToday(container, query) {
  const date = query?.date || new Date().toISOString().slice(0, 10);
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const data = await api.get("/production/today", { date });

  const DAY_START = 6 * 60, DAY_END = 22 * 60; // ventana visible 06:00-22:00
  const span = DAY_END - DAY_START;

  container.innerHTML = `
    <div class="toolbar">
      <input type="date" id="f-date" value="${date}" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <div class="spacer"></div>
      ${hasPermission("create", "create_reception") ? `<button class="btn btn-primary" id="btn-new">＋ Nueva actividad</button>` : ""}
    </div>
    <div class="kpi-grid">
      <div class="kpi-card accent-info"><div class="kpi-label">Actividades del dia</div><div class="kpi-value">${data.activities.length}</div></div>
      <div class="kpi-card accent-ok"><div class="kpi-label">Produccion total</div><div class="kpi-value">${fmtNum(data.total_production)}</div><div class="kpi-sub">unidades / packs</div></div>
      <div class="kpi-card accent-info"><div class="kpi-label">Operarios activos hoy</div><div class="kpi-value">${data.active_operators}</div></div>
    </div>
    <div class="card">
      <h3>Linea de tiempo — que estaba haciendo cada grupo</h3>
      ${data.activities.length ? `<div class="hint" style="margin-bottom:10px">Ventana visible 06:00–22:00. El ancho de cada barra representa la duracion de la actividad.</div>` : ""}
      <div id="gantt"></div>
    </div>
    <div class="card">
      <h3>Detalle de actividades del dia</h3>
      <div id="activities-list"></div>
    </div>
  `;

  const gantt = container.querySelector("#gantt");
  if (!data.activities.length) {
    gantt.innerHTML = `<div class="empty-state">Sin actividades registradas para esta fecha.</div>`;
  } else {
    gantt.innerHTML = data.activities
      .map((a) => {
        const startMin = Math.max(DAY_START, timeToMinutes(a.start_time) ?? DAY_START);
        const endMin = a.end_time ? Math.min(DAY_END, timeToMinutes(a.end_time)) : startMin + 30;
        const left = (100 * (startMin - DAY_START)) / span;
        const width = Math.max(2, (100 * (endMin - startMin)) / span);
        return `<div class="gantt-row row-link" data-id="${a.id}">
          <div class="gantt-label"><strong>${esc(a.operation_label)}</strong><br/><span class="muted">${esc(a.client_name)}${a.work_group_label ? " · " + esc(a.work_group_label) : ""}</span></div>
          <div class="gantt-track"><div class="gantt-bar" style="left:${left}%;width:${width}%" title="${esc(a.start_time)}–${esc(a.end_time || "?")}">${esc(a.start_time)}–${esc(a.end_time || "?")}</div></div>
          <div class="gantt-meta">${a.operator_count} operarios · ${fmtNum(a.qty_produced)} packs</div>
        </div>`;
      })
      .join("");
    gantt.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => navigate(`/produccion/actividades/${el.dataset.id}`)));
  }

  const list = container.querySelector("#activities-list");
  list.innerHTML = data.activities.length
    ? data.activities
        .map(
          (a) => `<div class="simple-bar-row row-link" data-id="${a.id}" style="cursor:pointer;align-items:flex-start">
            <div style="flex:1">
              <div><strong>${esc(a.operation_label)}</strong> — ${esc(a.client_name)} ${badge(a.status === "FINALIZADA" ? "COMPLETADO" : a.status === "CANCELADA" ? "CANCELADO" : "EN_PROCESO", a.status)}</div>
              <div class="muted" style="font-size:11.5px">${esc(a.start_time)}–${esc(a.end_time || "en curso")} · ${esc(a.product_label || "sin producto asociado")} · ${esc(a.work_group_label || "sin mesa/grupo")}</div>
              <div class="muted" style="font-size:11.5px">${a.participants.map((p) => esc(p.name)).join(", ") || "sin operarios asignados"}</div>
            </div>
            <div class="text-right" style="font-size:12px">
              <div><strong>${fmtNum(a.qty_produced)}</strong> packs</div>
              ${a.metrics.packs_per_man_hour ? `<div class="muted">${a.metrics.packs_per_man_hour} packs/hora-hombre</div>` : ""}
            </div>
          </div>`
        )
        .join("")
    : `<div class="empty-state">Sin actividades registradas para esta fecha.</div>`;
  list.querySelectorAll("[data-id]").forEach((el) => el.addEventListener("click", () => navigate(`/produccion/actividades/${el.dataset.id}`)));

  container.querySelector("#f-date").addEventListener("change", (e) => navigate(`/produccion/hoy?date=${e.target.value}`));
  container.querySelector("#btn-new")?.addEventListener("click", () => openNewActivityModal(() => renderProductionToday(container, query)));
}
