import { api } from "../api.js";
import { fmtNum, simpleBar, esc, fmtDate, badge } from "../utils.js";
import { navigate } from "../router.js";

export async function renderDashboard(container) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const d = await api.get("/dashboard");
  const op = d.operation_today;
  const sb = d.stock_by_status;
  const wh = d.warehouse;
  const pr = d.production_today;

  const stockTotal = Object.values(sb).reduce((a, b) => a + b, 0);
  const stockColors = { DISPONIBLE: "#1e7b34", RESERVADO: "#2f5597", CUARENTENA: "#a15c00", BLOQUEADO: "#b3261e", DANADO: "#6b7280" };
  const stockLabels = { DISPONIBLE: "Disponible", RESERVADO: "Reservado", CUARENTENA: "Cuarentena", BLOQUEADO: "Bloqueado", DANADO: "Danado" };

  container.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card accent-info">
        <div class="kpi-label">Recepciones hoy</div>
        <div class="kpi-value">${fmtNum(op.receptions)}</div>
        <div class="kpi-sub">${fmtNum(op.units_received)} unidades ingresadas</div>
      </div>
      <div class="kpi-card accent-info">
        <div class="kpi-label">Despachos hoy</div>
        <div class="kpi-value">${fmtNum(op.dispatches)}</div>
        <div class="kpi-sub">${fmtNum(op.units_dispatched)} unidades despachadas</div>
      </div>
      <div class="kpi-card accent-warn">
        <div class="kpi-label">Pendientes</div>
        <div class="kpi-value">${fmtNum(op.receptions_pending + op.dispatches_pending)}</div>
        <div class="kpi-sub">${fmtNum(op.receptions_pending)} recepciones · ${fmtNum(op.dispatches_pending)} despachos</div>
      </div>
      <div class="kpi-card accent-bad">
        <div class="kpi-label">Observados</div>
        <div class="kpi-value">${fmtNum(op.receptions_observed + op.dispatches_observed)}</div>
        <div class="kpi-sub">Requieren revision</div>
      </div>
      <div class="kpi-card accent-ok">
        <div class="kpi-label">Ocupacion de almacen</div>
        <div class="kpi-value">${wh.occupancy_pct}%</div>
        <div class="kpi-sub">${fmtNum(wh.occupied_locations)} de ${fmtNum(wh.total_locations)} posiciones</div>
      </div>
    </div>

    <div class="card-row">
      <div class="card">
        <h3>Produccion / Maquila — hoy</h3>
        <div class="kpi-grid" style="margin-bottom:0">
          <div class="kpi-card accent-info"><div class="kpi-label">Actividades</div><div class="kpi-value">${fmtNum(pr.activities)}</div></div>
          <div class="kpi-card accent-ok"><div class="kpi-label">Produccion</div><div class="kpi-value">${fmtNum(pr.total_production)}</div></div>
          <div class="kpi-card accent-info"><div class="kpi-label">Productividad</div><div class="kpi-value">${pr.productivity_packs_per_man_hour ?? "—"}</div><div class="kpi-sub">packs/hora-hombre</div></div>
          <div class="kpi-card accent-info"><div class="kpi-label">Operarios activos</div><div class="kpi-value">${fmtNum(pr.operators_active)}</div></div>
        </div>
        <div class="hint" style="margin-top:10px"><a data-nav="/produccion/hoy">Ver linea de tiempo del dia &rarr;</a></div>
      </div>
      <div class="card">
        <h3>Alertas</h3>
        <div id="dash-alerts"></div>
      </div>
    </div>

    <div class="card-row">
      <div class="card">
        <h3>Stock por estado</h3>
        ${Object.keys(stockLabels).map((k) => simpleBar(stockLabels[k], sb[k] || 0, stockTotal || 1, stockColors[k])).join("")}
      </div>
      <div class="card">
        <h3>Vencimientos proximos</h3>
        ${["7", "15", "30", "60", "90"]
          .map((t) => {
            const e = d.expiring[t];
            return simpleBar(`${t} dias`, e.qty, Math.max(1, d.expiring["90"].qty), "#a15c00");
          })
          .join("")}
        <div class="hint">Vencidos: <strong style="color:var(--bad)">${fmtNum(d.expired.qty)}</strong> unidades en ${fmtNum(d.expired.skus)} SKU(s)</div>
      </div>
    </div>

    <div class="card-row">
      <div class="card">
        <h3>Recepciones recientes</h3>
        <div id="recent-receptions"></div>
      </div>
      <div class="card">
        <h3>Despachos recientes</h3>
        <div id="recent-dispatches"></div>
      </div>
    </div>
  `;

  const recRec = container.querySelector("#recent-receptions");
  recRec.innerHTML = d.recent_receptions.length
    ? d.recent_receptions
        .map(
          (r) => `<div class="simple-bar-row row-link" data-nav="/recepciones/${r.id}" style="cursor:pointer">
        <div style="flex:1">
          <div><strong>${esc(r.reception_number)}</strong> — ${esc(r.client_name)}</div>
          <div class="muted" style="font-size:11.5px">${fmtDate(r.reception_date)}</div>
        </div>${badge(r.status)}</div>`
        )
        .join("")
    : `<div class="empty-state">Sin recepciones aun</div>`;

  const recDsp = container.querySelector("#recent-dispatches");
  recDsp.innerHTML = d.recent_dispatches.length
    ? d.recent_dispatches
        .map(
          (r) => `<div class="simple-bar-row row-link" data-nav="/despachos/${r.id}" style="cursor:pointer">
        <div style="flex:1">
          <div><strong>${esc(r.dispatch_number)}</strong> — ${esc(r.client_name)}</div>
          <div class="muted" style="font-size:11.5px">${fmtDate(r.dispatch_date)}</div>
        </div>${badge(r.status)}</div>`
        )
        .join("")
    : `<div class="empty-state">Sin despachos aun</div>`;

  container.querySelector("#dash-alerts").innerHTML = d.alerts.length
    ? `<div class="alert-list">${d.alerts
        .map((a) => `<div class="alert-row ${a.severity === "bad" ? "bad" : ""} ${a.activity_id ? "row-link" : ""}" ${a.activity_id ? `data-nav="/produccion/actividades/${a.activity_id}"` : ""}>${esc(a.message)}</div>`)
        .join("")}</div>`
    : `<div class="empty-state">Sin alertas activas.</div>`;

  container.querySelectorAll("[data-nav]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.nav)));
}
