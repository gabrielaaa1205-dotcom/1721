/*
 * Selector visual de ubicacion (rack -> nivel -> posicion), reutilizable.
 * Se usa desde Recepciones (Ubicar / Reubicar) y desde Stock (Ubicar /
 * Reubicar cualquier producto ya en el almacen, sin depender de la
 * recepcion original) -- asi el flujo es el mismo en todas partes.
 */
import { api } from "../api.js";
import { esc, showModal, closeModal, toast, debounce } from "../utils.js";

/**
 * Abre el modal completo de seleccion de ubicacion.
 * @param {object} opts
 * @param {string} opts.title - Titulo del modal.
 * @param {string} [opts.subtitle] - Linea de contexto debajo del titulo (ej. que producto/lote se esta ubicando).
 * @param {boolean} [opts.showPatioButton] - Si mostrar el boton "Ubicar en Patio (temporal)".
 * @param {{location_id:number, location_code:string, reason:string}|null} [opts.suggestion] - Sugerencia automatica opcional (FEFO/FIFO).
 * @param {boolean} [opts.excludePatio=true] - Si excluir el rack PATIO de los botones/busqueda (para no "reubicar" hacia el patio).
 * @param {(locationId:string|number, locationCode:string) => Promise<void>} opts.onConfirm - Que hacer cuando se elige una ubicacion (llamar al endpoint correspondiente: putaway o relocate).
 */
export function openLocationPickerModal({ title = "Asignar ubicacion", subtitle = "", showPatioButton = false, suggestion = null, excludePatio = true, showQtyInput = false, remainingQty = null, unitLabel = "unidades", onConfirm }) {
  showModal(
    `<h3>${esc(title)}</h3>
    ${subtitle ? `<p class="muted">${subtitle}</p>` : ""}
    <div id="lp-status"></div>
    ${
      showQtyInput
        ? `<div class="field" style="max-width:220px">
            <label>Cantidad a ubicar en esta posicion (${esc(unitLabel)})</label>
            <input type="number" id="lp-qty" step="any" min="0.0001" value="${remainingQty ?? ""}" />
            <div class="hint" id="lp-qty-hint">Quedan ${fmtQty(remainingQty)} por ubicar en total. Si son varias paletas del mismo lote, ponga aqui solo lo que va en ESTA posicion.</div>
          </div>`
        : ""
    }
    <div class="toolbar" style="margin-bottom:10px">
      ${showPatioButton ? `<button type="button" class="btn" id="btn-patio">⏱ Ubicar en Patio (temporal)</button>` : ""}
      ${suggestion ? `<button type="button" class="btn btn-primary" id="btn-suggested">✓ Usar sugerencia: ${esc(suggestion.location_code)}</button>` : ""}
    </div>
    ${suggestion ? `<div class="hint" style="margin-bottom:10px">${esc(suggestion.reason)}</div>` : ""}

    <p class="hint" style="margin-bottom:8px">Elija visualmente: primero el rack, luego el nivel y la posicion.</p>
    <div id="rack-picker-step">
      <div id="rack-buttons" class="rack-btn-row"><div class="hint">Cargando racks...</div></div>
    </div>
    <div id="level-picker-step" class="hidden"></div>
    <div id="position-picker-step" class="hidden"></div>

    <div style="margin-top:14px">
      <a id="toggle-search" style="font-size:12px;cursor:pointer;color:var(--blue)">🔍 Prefiero escribir el codigo directamente</a>
    </div>
    <div class="field hidden" id="search-block" style="margin-top:8px">
      <label>Buscar una ubicacion (rack/nivel/posicion)</label>
      <div class="picker-box">
        <input type="text" class="picker-input" id="loc-search" placeholder="Ej: a1,1 · b3,8 · patio..." autocomplete="off" />
        <div class="picker-results hidden" id="loc-results"></div>
      </div>
    </div>`,
    {
      wide: true,
      onMount: async (root) => {
        async function confirmLocation(locationId, locationCode) {
          const qtyInput = root.querySelector("#lp-qty");
          const qty = qtyInput ? parseFloat(qtyInput.value) || null : null;
          if (qtyInput && (!qty || qty <= 0)) {
            toast("Ingrese una cantidad valida para esta posicion", "error");
            return;
          }
          try {
            const result = await onConfirm(locationId, locationCode, qty);
            if (result?.keepOpen) {
              root.querySelector("#lp-status").innerHTML = `<div class="alert-row" style="border-color:var(--ok);background:var(--ok-bg);margin-bottom:12px">✓ ${esc(locationCode)}: ${fmtQty(qty)} ${esc(unitLabel)} ubicadas. ${esc(result.message || "")}</div>`;
              if (qtyInput && result.remaining != null) {
                qtyInput.value = result.remaining;
                root.querySelector("#lp-qty-hint").textContent = `Quedan ${fmtQty(result.remaining)} por ubicar en total. Elija la siguiente posicion.`;
              }
              // refresca el paso de posiciones actual para que la que se acaba de llenar se vea ocupada
              const currentLevelBtn = root.querySelector(".level-btn.selected");
              const currentRackBtn = root.querySelector(".rack-btn.selected");
              if (currentRackBtn) {
                const rack = await api.get(`/warehouse/racks/${currentRackBtn.dataset.rackId}`);
                if (currentLevelBtn) {
                  const lvl = rack.levels.find((l) => l.code === currentLevelBtn.dataset.levelCode);
                  renderLevelStep(root, rack, confirmLocation);
                  root.querySelector(`.level-btn[data-level-code="${lvl.code}"]`)?.classList.add("selected");
                  renderPositionStep(root, rack, lvl, confirmLocation);
                } else {
                  renderLevelStep(root, rack, confirmLocation);
                }
              }
              return;
            }
            closeModal();
          } catch (err) {
            toast(err.message, "error");
          }
        }

        root.querySelector("#btn-patio")?.addEventListener("click", async () => {
          try {
            const slot = await api.get("/warehouse/patio/next");
            await confirmLocation(slot.location_id, slot.location_code);
          } catch (err) {
            toast(err.message, "error");
          }
        });
        root.querySelector("#btn-suggested")?.addEventListener("click", () => confirmLocation(suggestion.location_id, suggestion.location_code));

        await mountVisualLocationPicker(root, { confirmLocation, excludePatio });
      },
    }
  );
}

function fmtQty(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString("es-PE", { maximumFractionDigits: 3 });
}

async function mountVisualLocationPicker(root, { confirmLocation, excludePatio = true } = {}) {
  const warehouses = await api.get("/warehouse/map");
  let allRacks = warehouses.flatMap((w) => w.zones.flatMap((z) => z.racks));
  if (excludePatio) allRacks = allRacks.filter((r) => r.code !== "PATIO");
  root.querySelector("#rack-buttons").innerHTML = allRacks
    .map((r) => {
      const color = r.occupancy_pct >= 85 ? "var(--bad)" : r.occupancy_pct >= 50 ? "var(--warn)" : "var(--ok)";
      return `<button type="button" class="rack-btn" data-rack-id="${r.id}" style="border-color:${color}">
        <span class="rack-btn-code">${esc(r.code)}</span>
        <span class="rack-btn-pct" style="color:${color}">${r.occupancy_pct}%</span>
      </button>`;
    })
    .join("");

  root.querySelectorAll("[data-rack-id]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      root.querySelectorAll(".rack-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const rack = await api.get(`/warehouse/racks/${btn.dataset.rackId}`);
      renderLevelStep(root, rack, confirmLocation);
    })
  );

  // --- buscador de texto (colapsado, alternativa) ---
  root.querySelector("#toggle-search")?.addEventListener("click", () => {
    root.querySelector("#search-block").classList.toggle("hidden");
  });
  const input = root.querySelector("#loc-search");
  const results = root.querySelector("#loc-results");
  if (!input) return;
  const doSearch = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 1) {
      results.classList.add("hidden");
      return;
    }
    const { results: hits } = await api.get("/search", { q: term });
    const locs = hits.filter((h) => h.type === "Ubicacion" && (!excludePatio || !h.label.startsWith("patio,")));
    results.innerHTML = locs.length
      ? locs.map((l) => `<div class="picker-item" data-loc-id="${l.id}" data-loc-code="${esc(l.label)}"><span class="mono">${esc(l.label)}</span></div>`).join("")
      : `<div class="picker-item muted">Sin coincidencias.</div>`;
    results.classList.remove("hidden");
    results.querySelectorAll("[data-loc-id]").forEach((el) =>
      el.addEventListener("click", () => {
        results.classList.add("hidden");
        confirmLocation(el.dataset.locId, el.dataset.locCode);
      })
    );
  }, 220);
  input.addEventListener("input", doSearch);
  input.addEventListener("focus", doSearch);
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) return;
    if (!e.target.closest("#loc-search") && !e.target.closest("#loc-results")) results.classList.add("hidden");
  });
}

/** Paso 2: dentro del rack elegido, mostrar sus 6 niveles con % de ocupacion. */
function renderLevelStep(root, rack, confirmLocation) {
  const step = root.querySelector("#level-picker-step");
  step.classList.remove("hidden");
  step.innerHTML = `
    <div class="rack-mini-card">
      <div class="rack-mini-title">Rack ${esc(rack.code)} <span class="muted" style="font-weight:400">— ${esc(rack.access_label || "")}</span></div>
      <div class="level-btn-row">
        ${rack.levels
          .map((lvl) => {
            const occ = lvl.locations.filter((l) => l.occupied > 0).length;
            const pct = lvl.locations.length ? Math.round((occ / lvl.locations.length) * 100) : 0;
            const color = pct >= 85 ? "var(--bad)" : pct >= 50 ? "var(--warn)" : "var(--ok)";
            return `<button type="button" class="level-btn" data-level-code="${esc(lvl.code)}" style="border-color:${color}">
              <span>${esc(lvl.code)}</span><span class="muted" style="font-size:10px">${occ}/${lvl.locations.length}</span>
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
  step.querySelectorAll("[data-level-code]").forEach((btn) =>
    btn.addEventListener("click", () => {
      step.querySelectorAll(".level-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const lvl = rack.levels.find((l) => l.code === btn.dataset.levelCode);
      renderPositionStep(root, rack, lvl, confirmLocation);
    })
  );
  root.querySelector("#position-picker-step").classList.add("hidden");
}

/** Paso 3: dentro del nivel elegido, mostrar sus posiciones -- tarjetas
 * compactas (codigo + punto de estado); clic en una libre ubica al toque. */
function renderPositionStep(root, rack, lvl, confirmLocation) {
  const step = root.querySelector("#position-picker-step");
  step.classList.remove("hidden");
  step.innerHTML = `
    <div class="rack-mini-card">
      <div class="rack-mini-title">Rack ${esc(rack.code)} / Nivel ${esc(lvl.code)}</div>
      <div class="pos-pick-legend"><span class="pos-pick-dot free"></span> Libre (clic para ubicar) &nbsp;&nbsp; <span class="pos-pick-dot occ"></span> Ocupado</div>
      <div class="pos-pick-grid">
        ${lvl.locations
          .map((loc) => {
            const occ = loc.occupied > 0;
            const tip = occ ? `${esc(loc.full_code)} — Ocupado` : `${esc(loc.full_code)} — Libre, clic para ubicar aqui`;
            return `<div class="pos-pick-tile ${occ ? "occ" : "free"}" ${occ ? "" : `data-pick-loc="${loc.id}" data-pick-code="${esc(loc.full_code)}"`} title="${tip}">
              <span class="pos-pick-dot ${occ ? "occ" : "free"}"></span>
              <span class="pos-pick-code">${esc(loc.full_code)}</span>
            </div>`;
          })
          .join("")}
      </div>
    </div>`;
  step.querySelectorAll("[data-pick-loc]").forEach((el) =>
    el.addEventListener("click", () => confirmLocation(el.dataset.pickLoc, el.dataset.pickCode))
  );
}
