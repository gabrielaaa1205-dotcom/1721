import { api } from "../../api.js";
import { esc, fmtNum } from "../../utils.js";
import { navigate } from "../../router.js";

const DATE_PRESETS = [
  { value: "today", label: "Hoy" },
  { value: "this_week", label: "Esta semana" },
  { value: "last_week", label: "Semana pasada" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes pasado" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
];

export async function renderProductionDashboard(container) {
  container.innerHTML = `
    <div class="toolbar">
      <select id="f-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        ${DATE_PRESETS.map((p) => `<option value="${p.value}" ${p.value === "this_month" ? "selected" : ""}>${p.label}</option>`).join("")}
      </select>
    </div>
    <div id="kpis"></div>
    <div class="card-row">
      <div class="card" style="flex:2">
        <h3>Alertas de produccion</h3>
        <div id="alerts"></div>
      </div>
      <div class="card">
        <h3>Accesos rapidos</h3>
        <div class="tag-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <a data-nav="/produccion/hoy">&rarr; Produccion de hoy</a>
          <a data-nav="/produccion/analitica">&rarr; Estandares, ranking y comparaciones</a>
          <a data-nav="/produccion/actividades">&rarr; Todas las actividades</a>
          <a data-nav="/produccion/catalogos">&rarr; Operarios, mesas y tipos de operacion</a>
        </div>
      </div>
    </div>
  `;
  container.querySelectorAll("[data-nav]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.nav)));

  async function load() {
    const preset = container.querySelector("#f-preset").value;
    const [kpis, alerts] = await Promise.all([
      api.get("/production/kpis", { preset }),
      api.get("/production/alerts"),
    ]);

    container.querySelector("#kpis").innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card accent-ok"><div class="kpi-label">Produccion total</div><div class="kpi-value">${fmtNum(kpis.total_production)}</div><div class="kpi-sub">${kpis.activities_count} actividad(es)</div></div>
        <div class="kpi-card accent-info"><div class="kpi-label">Horas-hombre</div><div class="kpi-value">${fmtNum(kpis.total_man_hours)}</div><div class="kpi-sub">${fmtNum(kpis.total_hours)} horas de operacion</div></div>
        <div class="kpi-card accent-info"><div class="kpi-label">Productividad</div><div class="kpi-value">${kpis.productivity_packs_per_man_hour ?? "—"}</div><div class="kpi-sub">packs / hora-hombre</div></div>
        <div class="kpi-card ${kpis.avg_efficiency_pct != null && kpis.avg_efficiency_pct < 85 ? "accent-warn" : "accent-ok"}"><div class="kpi-label">Eficiencia promedio</div><div class="kpi-value">${kpis.avg_efficiency_pct != null ? kpis.avg_efficiency_pct + "%" : "—"}</div><div class="kpi-sub">vs. estandar historico</div></div>
        <div class="kpi-card accent-ok"><div class="kpi-label">Calidad</div><div class="kpi-value">${kpis.quality_pct ?? "—"}%</div><div class="kpi-sub">Merma: ${kpis.defect_pct ?? "—"}%</div></div>
        <div class="kpi-card accent-info"><div class="kpi-label">Utilizacion de personal</div><div class="kpi-value">${kpis.utilization_pct != null ? kpis.utilization_pct + "%" : "—"}</div><div class="kpi-sub">${esc(kpis.utilization_note)}</div></div>
        <div class="kpi-card accent-info"><div class="kpi-label">Operarios activos</div><div class="kpi-value">${kpis.operators_active}</div></div>
      </div>`;

    container.querySelector("#alerts").innerHTML = alerts.length
      ? `<div class="alert-list">${alerts.map((a) => `<div class="alert-row ${a.severity === "bad" ? "bad" : ""} ${a.activity_id ? "row-link" : ""}" ${a.activity_id ? `data-activity="${a.activity_id}"` : ""}>${esc(a.message)}</div>`).join("")}</div>`
      : `<div class="empty-state">Sin alertas activas. Todo dentro de parametros normales.</div>`;
    container.querySelectorAll("[data-activity]").forEach((el) => el.addEventListener("click", () => navigate(`/produccion/actividades/${el.dataset.activity}`)));
  }

  container.querySelector("#f-preset").addEventListener("change", load);
  await load();
}
