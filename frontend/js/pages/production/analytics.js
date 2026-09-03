import { api } from "../../api.js";
import { table, esc, fmtNum, fmtDate, badge, debounce, simpleBar } from "../../utils.js";
import { navigate } from "../../router.js";

const DATE_PRESETS = [
  { value: "", label: "Todo el historial" },
  { value: "this_week", label: "Esta semana" },
  { value: "last_week", label: "Semana pasada" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes pasado" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
];

const TABS = [
  { key: "standards", label: "Estandares" },
  { key: "ranking", label: "Ranking por operacion" },
  { key: "compare", label: "Comparar actividades" },
  { key: "by-operator", label: "Por operario" },
  { key: "by-client", label: "Por cliente" },
  { key: "trends", label: "Tendencias" },
];

export async function renderProductionAnalytics(container) {
  container.innerHTML = `
    <div class="tabs">${TABS.map((t, i) => `<div class="tab-btn ${i === 0 ? "active" : ""}" data-tab="${t.key}">${t.label}</div>`).join("")}</div>
    <div id="tab-content"></div>
  `;
  const content = container.querySelector("#tab-content");
  const renderers = {
    standards: renderStandards, ranking: renderRanking, compare: renderCompare,
    "by-operator": renderByOperator, "by-client": renderByClient, trends: renderTrends,
  };

  function activate(key) {
    container.querySelectorAll(".tab-btn").forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
    renderers[key](content);
  }
  container.querySelectorAll(".tab-btn").forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));
  activate("standards");
}

// =============================== ESTANDARES ====================================
async function renderStandards(content) {
  const operationTypes = await api.get("/operation-types");
  content.innerHTML = `
    <div class="card">
      <h3>Estandar de productividad (packs / hora-hombre)</h3>
      <p class="hint">Calculado del historial de actividades finalizadas. No se toma como definitivo hasta tener al menos 3 registros comparables.</p>
      <div class="toolbar">
        <select id="std-optype" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
          <option value="">Toda operacion</option>${operationTypes.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}
        </select>
      </div>
      <div id="std-result"></div>
    </div>`;
  async function load() {
    const s = await api.get("/production/standards", { operation_type_id: content.querySelector("#std-optype").value });
    content.querySelector("#std-result").innerHTML =
      s.n === 0
        ? `<div class="empty-state">Sin historial suficiente todavia para calcular un estandar.</div>`
        : `<div class="kpi-grid">
            <div class="kpi-card accent-info"><div class="kpi-label">Promedio</div><div class="kpi-value">${s.avg}</div></div>
            <div class="kpi-card accent-info"><div class="kpi-label">Mediana</div><div class="kpi-value">${s.median}</div></div>
            <div class="kpi-card accent-ok"><div class="kpi-label">Mejor resultado</div><div class="kpi-value">${s.best}</div></div>
            <div class="kpi-card accent-warn"><div class="kpi-label">Peor resultado</div><div class="kpi-value">${s.worst}</div></div>
            <div class="kpi-card accent-info"><div class="kpi-label">Percentil 75</div><div class="kpi-value">${s.p75}</div></div>
            <div class="kpi-card accent-info"><div class="kpi-label">Muestras</div><div class="kpi-value">${s.n}</div><div class="kpi-sub">${s.reliable ? "Estandar confiable" : "Aun no confiable (min. 3)"}</div></div>
          </div>
          ${s.trend_pct != null ? `<div class="hint">Tendencia: ${s.trend_pct > 0 ? "mejorando" : "empeorando"} (${s.trend_pct}% entre la primera y la segunda mitad del historial)</div>` : ""}`;
  }
  content.querySelector("#std-optype").addEventListener("change", load);
  await load();
}

// =============================== RANKING =======================================
async function renderRanking(content) {
  content.innerHTML = `
    <div class="card">
      <h3>Ranking de operaciones por productividad</h3>
      <div class="toolbar"><select id="rk-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">${DATE_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}</select></div>
      <div id="rk-table"></div>
    </div>`;
  async function load() {
    const rows = await api.get("/production/ranking", { preset: content.querySelector("#rk-preset").value });
    content.querySelector("#rk-table").innerHTML = table(
      [
        { label: "#", render: (r, i) => rows.indexOf(r) + 1 },
        { label: "Operacion", key: "operation_label" },
        { label: "Actividades", key: "activities_count" },
        { label: "Produccion total", render: (r) => fmtNum(r.total_production) },
        { label: "Packs/hora-hombre", render: (r) => r.packs_per_man_hour ?? "—" },
        { label: "Min-hombre/pack", render: (r) => r.avg_minutes_man_per_pack ?? "—" },
        { label: "Calidad", render: (r) => (r.quality_pct != null ? r.quality_pct + "%" : "—") },
        { label: "Defectos", render: (r) => (r.defect_pct != null ? r.defect_pct + "%" : "—") },
      ],
      rows,
      { emptyText: "Sin actividades en el periodo seleccionado" }
    );
  }
  content.querySelector("#rk-preset").addEventListener("change", load);
  await load();
}

// =============================== COMPARAR ======================================
async function renderCompare(content) {
  content.innerHTML = `
    <div class="card">
      <h3>Comparar actividades</h3>
      <p class="hint">Busque y agregue 2 o mas actividades para comparar cual fue realmente mas productiva (no solo por produccion total).</p>
      <input id="cmp-search" placeholder="Buscar por OT o descripcion..." style="max-width:280px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <div id="cmp-suggestions" class="hint"></div>
      <div class="tag-row" id="cmp-chips" style="margin:10px 0"></div>
      <button class="btn btn-primary btn-sm" id="cmp-go">Comparar</button>
    </div>
    <div id="cmp-result"></div>`;
  const selected = new Map();

  function renderChips() {
    content.querySelector("#cmp-chips").innerHTML = [...selected.entries()]
      .map(([id, label]) => `<span class="badge badge-info" data-remove="${id}" style="cursor:pointer">${esc(label)} &times;</span>`)
      .join("");
    content.querySelectorAll("[data-remove]").forEach((el) => el.addEventListener("click", () => { selected.delete(el.dataset.remove); renderChips(); }));
  }

  const doSearch = debounce(async () => {
    const term = content.querySelector("#cmp-search").value.trim();
    if (term.length < 1) { content.querySelector("#cmp-suggestions").innerHTML = ""; return; }
    const res = await api.get("/production/activities", { q: term, limit: 8 });
    content.querySelector("#cmp-suggestions").innerHTML = res.rows
      .map((r) => `<div class="picker-item" data-id="${r.id}" data-label="${esc(r.operation_label)} (${fmtDate(r.activity_date)})">${esc(r.operation_label)} — ${esc(r.client_name)} — ${fmtDate(r.activity_date)}</div>`)
      .join("") || `<div class="picker-item muted">Sin resultados</div>`;
    content.querySelectorAll("#cmp-suggestions [data-id]").forEach((el) =>
      el.addEventListener("click", () => { selected.set(el.dataset.id, el.dataset.label); renderChips(); content.querySelector("#cmp-search").value = ""; content.querySelector("#cmp-suggestions").innerHTML = ""; })
    );
  }, 220);
  content.querySelector("#cmp-search").addEventListener("input", doSearch);

  content.querySelector("#cmp-go").addEventListener("click", async () => {
    if (selected.size < 2) { content.querySelector("#cmp-result").innerHTML = `<div class="hint">Agregue al menos 2 actividades.</div>`; return; }
    const res = await api.get("/production/compare", { ids: [...selected.keys()].join(",") });
    content.querySelector("#cmp-result").innerHTML = `
      <div class="card">
        <h3>Resultado</h3>
        ${table(
          [
            { label: "Actividad", render: (a) => `<a data-nav="${a.id}">${esc(a.operation_label)}</a>` },
            { label: "Cliente", key: "client_name" },
            { label: "Fecha", render: (a) => fmtDate(a.activity_date) },
            { label: "Produccion", render: (a) => fmtNum(a.qty_produced) },
            { label: "Packs/hora", render: (a) => a.metrics.packs_per_hour ?? "—" },
            { label: "Packs/operario", render: (a) => a.metrics.packs_per_operator ?? "—" },
            { label: "Packs/hora-hombre", render: (a) => a.metrics.packs_per_man_hour ?? "—" },
            { label: "Min-hombre/pack", render: (a) => a.metrics.minutes_man_per_pack ?? "—" },
            { label: "% Defectos", render: (a) => a.metrics.defect_pct ?? "—" },
            { label: "", render: (a) => (a.id === res.most_productive_id ? `<span class="badge badge-ok">Mas productiva</span>` : "") },
          ],
          res.activities,
          { emptyText: "—" }
        )}
      </div>`;
    content.querySelectorAll("[data-nav]").forEach((el) => el.addEventListener("click", () => navigate(`/produccion/actividades/${el.dataset.nav}`)));
  });
}

// =============================== POR OPERARIO ===================================
async function renderByOperator(content) {
  const operationTypes = await api.get("/operation-types");
  content.innerHTML = `
    <div class="card">
      <h3>Productividad por operario</h3>
      <p class="hint">Estimado (la produccion se reparte entre los participantes de cada actividad). Compare solo dentro de la misma operacion para que sea justo.</p>
      <div class="toolbar">
        <select id="op-optype" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
          <option value="">Toda operacion</option>${operationTypes.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}
        </select>
        <select id="op-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">${DATE_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}</select>
      </div>
      <div id="op-table"></div>
    </div>`;
  async function load() {
    const res = await api.get("/production/by-operator", { operation_type_id: content.querySelector("#op-optype").value, preset: content.querySelector("#op-preset").value });
    content.querySelector("#op-table").innerHTML = table(
      [
        { label: "Operario", key: "name" },
        { label: "Actividades", key: "activities_count" },
        { label: "Horas trabajadas", render: (r) => fmtNum(r.hours) },
        { label: "Produccion estimada", render: (r) => fmtNum(r.estimated_production) },
        { label: "Packs/hora (estim.)", render: (r) => r.estimated_packs_per_hour ?? "—" },
        { label: "Calidad promedio", render: (r) => (r.avg_quality_pct != null ? r.avg_quality_pct + "%" : "—") },
      ],
      res.rows || [],
      { emptyText: "Sin actividades registradas en el periodo" }
    );
  }
  content.querySelector("#op-optype").addEventListener("change", load);
  content.querySelector("#op-preset").addEventListener("change", load);
  await load();
}

// =============================== POR CLIENTE ====================================
async function renderByClient(content) {
  content.innerHTML = `
    <div class="card">
      <h3>Productividad por cliente</h3>
      <div class="toolbar"><select id="cl-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">${DATE_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}</select></div>
      <div id="cl-table"></div>
    </div>`;
  async function load() {
    const rows = await api.get("/production/by-client", { preset: content.querySelector("#cl-preset").value });
    content.querySelector("#cl-table").innerHTML = table(
      [
        { label: "Cliente", key: "client_name" },
        { label: "Actividades", key: "activities_count" },
        { label: "Horas-hombre", render: (r) => fmtNum(r.total_man_hours) },
        { label: "Produccion", render: (r) => fmtNum(r.total_production) },
        { label: "Packs/hora-hombre", render: (r) => r.packs_per_man_hour ?? "—" },
        { label: "Calidad", render: (r) => (r.quality_pct != null ? r.quality_pct + "%" : "—") },
      ],
      rows,
      { emptyText: "Sin actividades en el periodo" }
    );
  }
  content.querySelector("#cl-preset").addEventListener("change", load);
  await load();
}

// =============================== TENDENCIAS =====================================
async function renderTrends(content) {
  content.innerHTML = `
    <div class="card">
      <h3>Tendencia de productividad</h3>
      <div class="toolbar">
        <select id="tr-gran" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
          <option value="week">Por semana</option><option value="month">Por mes</option>
        </select>
      </div>
      <div id="tr-summary" class="hint" style="margin-bottom:10px"></div>
      <div id="tr-chart"></div>
      <div id="tr-table" style="margin-top:12px"></div>
    </div>`;
  async function load() {
    const granularity = content.querySelector("#tr-gran").value;
    const res = await api.get("/production/trends", { granularity, preset: granularity === "week" ? "last_30_days" : "" });
    const max = Math.max(1, ...res.periods.map((p) => p.productivity_packs_per_man_hour || 0));
    content.querySelector("#tr-chart").innerHTML = res.periods
      .map((p) => simpleBar(p.period, p.productivity_packs_per_man_hour || 0, max, "#2f5597"))
      .join("") || `<div class="empty-state">Sin datos suficientes</div>`;
    content.querySelector("#tr-summary").innerHTML = res.best_period
      ? `Mejor periodo: <strong>${esc(res.best_period.period)}</strong> (${res.best_period.productivity_packs_per_man_hour} packs/hora-hombre)` +
        (res.worst_period ? ` · Peor periodo: <strong>${esc(res.worst_period.period)}</strong> (${res.worst_period.productivity_packs_per_man_hour} packs/hora-hombre)` : "")
      : "";
    content.querySelector("#tr-table").innerHTML = table(
      [
        { label: "Periodo", key: "period" },
        { label: "Actividades", key: "activities_count" },
        { label: "Produccion", render: (r) => fmtNum(r.total_production) },
        { label: "Packs/hora-hombre", render: (r) => r.productivity_packs_per_man_hour ?? "—" },
        { label: "Calidad", render: (r) => (r.quality_pct != null ? r.quality_pct + "%" : "—") },
      ],
      res.periods,
      { emptyText: "—" }
    );
  }
  content.querySelector("#tr-gran").addEventListener("change", load);
  await load();
}
