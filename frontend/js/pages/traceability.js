import { api } from "../api.js";
import { esc, fmtNum, fmtDate, table, debounce } from "../utils.js";
import { navigate } from "../router.js";

export async function renderTraceability(container, lotId) {
  container.innerHTML = `
    <div class="card">
      <div class="field"><label>Buscar lote, o SKU / descripcion de producto para encontrar sus lotes</label>
        <div class="toolbar" style="margin-bottom:0">
          <input id="lot-search" placeholder="Ej: 51551157" autocomplete="off" style="flex:1; max-width:360px" />
          <button id="lot-search-btn" class="btn btn-primary">Buscar</button>
        </div>
      </div>
      <div id="lot-suggestions"></div>
    </div>
    <div id="trace-result"></div>
  `;

  const input = container.querySelector("#lot-search");
  const suggBox = container.querySelector("#lot-suggestions");

  async function doSearch() {
    const term = input.value.trim();
    if (term.length < 2) {
      suggBox.innerHTML = `<div class="hint">Escriba al menos 2 caracteres.</div>`;
      return;
    }
    suggBox.innerHTML = `<div class="hint">Buscando...</div>`;
    const { results } = await api.get("/search", { q: term });
    const lots = results.filter((r) => r.type === "Lote");
    const products = results.filter((r) => r.type === "Producto");

    if (!lots.length && !products.length) {
      suggBox.innerHTML = `<div class="empty-state">Sin resultados para "${esc(term)}". Verifique el SKU, descripcion o codigo de lote.</div>`;
      return;
    }

    suggBox.innerHTML = `
      ${lots.length ? `<p class="hint" style="margin:10px 0 4px">Lotes</p>` : ""}
      ${lots.map((l) => `<div class="simple-bar-row row-link" style="cursor:pointer" data-lot="${l.id}"><strong>${esc(l.label)}</strong></div>`).join("")}
      ${products.length ? `<p class="hint" style="margin:10px 0 4px">Productos (clic para ver sus lotes con stock)</p>` : ""}
      ${products.map((p) => `<div class="simple-bar-row row-link" style="cursor:pointer" data-product-sku="${esc(p.sku_code)}"><strong>${esc(p.label)}</strong></div>`).join("")}
    `;

    suggBox.querySelectorAll("[data-lot]").forEach((el) =>
      el.addEventListener("click", () => navigate(`/trazabilidad/${el.dataset.lot}`))
    );
    suggBox.querySelectorAll("[data-product-sku]").forEach((el) =>
      el.addEventListener("click", async () => {
        suggBox.innerHTML = `<div class="hint">Buscando lotes de este producto...</div>`;
        const { rows } = await api.get("/stock", { sku: el.dataset.productSku });
        const uniqueLots = [];
        const seen = new Set();
        for (const r of rows) {
          if (r.lot_id && !seen.has(r.lot_id)) {
            seen.add(r.lot_id);
            uniqueLots.push(r);
          }
        }
        if (!uniqueLots.length) {
          suggBox.innerHTML = `<div class="empty-state">Este producto no tiene lotes con stock actual. Si busca un lote especifico, escriba directamente su codigo de lote.</div>`;
          return;
        }
        if (uniqueLots.length === 1) {
          navigate(`/trazabilidad/${uniqueLots[0].lot_id}`);
          return;
        }
        suggBox.innerHTML = `
          <p class="hint" style="margin:10px 0 4px">Este producto tiene ${uniqueLots.length} lotes con stock. Elija uno:</p>
          ${uniqueLots
            .map(
              (r) =>
                `<div class="simple-bar-row row-link" style="cursor:pointer" data-lot2="${r.lot_id}"><strong>Lote ${esc(r.lot_code)}</strong> <span class="muted">— ${fmtNum(r.qty)} ${esc(r.unit_of_measure || "")}</span></div>`
            )
            .join("")}
        `;
        suggBox.querySelectorAll("[data-lot2]").forEach((el2) =>
          el2.addEventListener("click", () => navigate(`/trazabilidad/${el2.dataset.lot2}`))
        );
      })
    );
  }

  input.addEventListener("input", debounce(doSearch, 300));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  container.querySelector("#lot-search-btn").addEventListener("click", doSearch);

  if (lotId) {
    const trace = await api.get(`/lots/${lotId}/trace`);
    const resultBox = container.querySelector("#trace-result");
    resultBox.innerHTML = `
      <div class="card">
        <h3>Lote ${esc(trace.lot.lot_code)}</h3>
        <div class="form-grid">
          <div><span class="muted">SKU:</span> <span class="mono">${esc(trace.lot.sku_code)}</span></div>
          <div><span class="muted">Producto:</span> ${esc(trace.lot.description)}</div>
          <div><span class="muted">Cliente:</span> ${esc(trace.lot.client_name)}</div>
          <div><span class="muted">Vencimiento:</span> ${fmtDate(trace.lot.expiration_date)}</div>
        </div>
      </div>
      <div class="card-row">
        <div class="card">
          <h3>Saldo actual</h3>
          ${table(
            [
              { label: "Ubicacion", render: (r) => (r.location_code ? esc(r.location_code) : "Sin ubicar") },
              { label: "Estado", key: "status" },
              { label: "Cantidad", render: (r) => fmtNum(r.qty) },
            ],
            trace.current_balance,
            { emptyText: "Sin stock actual de este lote" }
          )}
        </div>
        <div class="card" style="flex:2">
          <h3>Linea de tiempo</h3>
          <div class="timeline">
            ${trace.events
              .map(
                (e) => `<div class="timeline-item">
                  <div class="timeline-date">${e.date}</div>
                  <div class="timeline-label">${esc(e.label)}</div>
                  <div class="timeline-detail">${esc(e.detail)} ${e.ref ? "· " + esc(e.ref) : ""}</div>
                </div>`
              )
              .join("") || `<div class="empty-state">Sin eventos registrados</div>`}
          </div>
        </div>
      </div>
    `;
  }
}
