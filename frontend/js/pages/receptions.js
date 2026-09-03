import { api } from "../api.js";
import { table, esc, fmtNum, fmtDate, fmtDateTime, fmtTimeLima, badge, showModal, closeModal, toast, debounce } from "../utils.js";
import { navigate } from "../router.js";
import { hasPermission } from "../state.js";
import { clientPickerHTML, mountClientPicker, productPickerHTML, mountProductPicker, flexiblePickerHTML, mountFlexiblePicker } from "../components/pickers.js";
import { openLocationPickerModal } from "../components/locationPicker.js";

const DATE_PRESETS = [
  { value: "", label: "Cualquier fecha" },
  { value: "today", label: "Hoy" },
  { value: "this_week", label: "Esta semana" },
  { value: "last_week", label: "Semana pasada" },
  { value: "this_month", label: "Este mes" },
  { value: "last_month", label: "Mes pasado" },
  { value: "last_7_days", label: "Ultimos 7 dias" },
  { value: "last_30_days", label: "Ultimos 30 dias" },
];

export async function renderReceptionsList(container) {
  const [clients, users] = await Promise.all([api.get("/clients"), api.get("/users/basic")]);
  let offset = 0;
  const limit = 25;

  container.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="Buscar numero, guia o contenedor..." style="max-width:230px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <select id="f-client" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los clientes</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
      </select>
      <select id="f-status" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los estados</option>
        <option value="PENDIENTE">Pendiente</option><option value="EN_PROCESO">En proceso</option>
        <option value="OBSERVADO">Observado</option><option value="COMPLETADO">Completado</option>
        <option value="BLOQUEADO">Bloqueado</option><option value="CANCELADO">Cancelado</option>
      </select>
      <div class="spacer"></div>
      ${hasPermission("create_reception", "create") ? `<button class="btn btn-primary" id="btn-new">＋ Nueva recepcion</button>` : ""}
    </div>
    <div class="toolbar">
      <select id="f-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        ${DATE_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}
      </select>
      <input type="date" id="f-from" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px" title="Desde" />
      <input type="date" id="f-to" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px" title="Hasta" />
      <input id="f-sku" placeholder="SKU o producto..." style="max-width:180px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <select id="f-user" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Cualquier usuario</option>${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}
      </select>
    </div>
    <div class="card">
      <div id="tbl"></div>
      <div class="toolbar" style="margin-top:10px;margin-bottom:0">
        <span class="muted" id="pg-info"></span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="pg-prev">&larr; Anterior</button>
        <button class="btn btn-sm" id="pg-next">Siguiente &rarr;</button>
      </div>
    </div>`;

  function filters() {
    return {
      q: container.querySelector("#q").value,
      client_id: container.querySelector("#f-client").value,
      status: container.querySelector("#f-status").value,
      preset: container.querySelector("#f-preset").value,
      date_from: container.querySelector("#f-preset").value ? undefined : container.querySelector("#f-from").value,
      date_to: container.querySelector("#f-preset").value ? undefined : container.querySelector("#f-to").value,
      sku: container.querySelector("#f-sku").value,
      user_id: container.querySelector("#f-user").value,
      limit, offset,
    };
  }

  async function load() {
    const res = await api.get("/receptions", filters());
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "N Recepcion", render: (r) => `<span class="mono">${esc(r.reception_number)}</span>` },
        { label: "Cliente", key: "client_name" },
        { label: "Fecha", render: (r) => `${fmtDate(r.reception_date)}<div class="muted" style="font-size:11px">${esc(fmtTimeLima(r.created_at))} hs</div>` },
        { label: "Guia", render: (r) => esc(r.guide_number || "—") },
        { label: "Contenedor", render: (r) => esc(r.container_number || "—") },
        { label: "Items", key: "item_count" },
        { label: "Usuario", render: (r) => esc(r.created_by_name || "—") },
        { label: "Estado", render: (r) => badge(r.status) },
      ],
      res.rows,
      { rowAttrs: (r) => `class="row-link" data-id="${r.id}"`, emptyText: "No hay recepciones que coincidan con los filtros" }
    );
    container.querySelectorAll("[data-id]").forEach((tr) => tr.addEventListener("click", () => navigate(`/recepciones/${tr.dataset.id}`)));
    const from = res.total ? offset + 1 : 0;
    const to = Math.min(offset + limit, res.total);
    container.querySelector("#pg-info").textContent = `${from}-${to} de ${res.total}`;
    container.querySelector("#pg-prev").disabled = offset === 0;
    container.querySelector("#pg-next").disabled = to >= res.total;
  }

  function reload() { offset = 0; load(); }

  container.querySelector("#btn-new")?.addEventListener("click", () => openNewReceptionModal(reload));
  container.querySelector("#q").addEventListener("input", debounce(reload, 250));
  container.querySelector("#f-client").addEventListener("change", reload);
  container.querySelector("#f-status").addEventListener("change", reload);
  container.querySelector("#f-sku").addEventListener("input", debounce(reload, 250));
  container.querySelector("#f-user").addEventListener("change", reload);
  container.querySelector("#f-preset").addEventListener("change", () => {
    const custom = !container.querySelector("#f-preset").value;
    container.querySelector("#f-from").disabled = !custom;
    container.querySelector("#f-to").disabled = !custom;
    reload();
  });
  container.querySelector("#f-from").addEventListener("change", reload);
  container.querySelector("#f-to").addEventListener("change", reload);
  container.querySelector("#pg-prev").addEventListener("click", () => { offset = Math.max(0, offset - limit); load(); });
  container.querySelector("#pg-next").addEventListener("click", () => { offset += limit; load(); });

  await load();
}

function openNewReceptionModal(onDone) {
  showModal(
    `<h3>Nueva recepcion</h3>
    <form id="f">
      <div class="form-grid">
        ${clientPickerHTML({ label: "Cliente" })}
        <div class="field"><label>Fecha de ingreso</label><input type="date" name="reception_date" required value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div class="field"><label>Nº contenedor</label><input name="container_number" /></div>
        <div class="field"><label>Nº pedido</label><input name="order_number" /></div>
        <div class="field"><label>Nº guia</label><input name="guide_number" /></div>
        <div class="field"><label>Procedencia</label><input name="origin" /></div>
        <div class="field"><label>Tipo de carga</label>
          <select name="cargo_type"><option value="GRANEL">Granel</option><option value="PALETIZADO">Paletizado</option></select>
        </div>
        <div class="field"><label>OC</label><input name="purchase_order" /></div>
      </div>
      <button class="btn btn-primary" type="submit">Crear recepcion</button>
    </form>`,
    {
      onMount: (root) => {
        mountClientPicker(root);
        root.querySelector("#f").addEventListener("submit", async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(e.target).entries());
          if (!payload.client_id) { toast("Seleccione o cree un cliente", "error"); return; }
          try {
            const res = await api.post("/receptions", payload);
            closeModal();
            navigate(`/recepciones/${res.id}`);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    }
  );
}

export async function renderReceptionDetail(container, id) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const rec = await api.get(`/receptions/${id}`);

  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h3 style="margin-bottom:2px">${esc(rec.reception_number)} ${badge(rec.status)}</h3>
          <div class="muted">${esc(rec.client_name)} · ${fmtDate(rec.reception_date)} ${esc(fmtTimeLima(rec.created_at))} hs · registrado por ${esc(rec.created_by_name || "—")}</div>
        </div>
        <div class="spacer"></div>
        ${statusButtons(rec)}
      </div>
      <div class="form-grid" style="margin-top:10px;font-size:13px">
        <div><span class="muted">Contenedor:</span> ${esc(rec.container_number || "—")}</div>
        <div><span class="muted">Pedido:</span> ${esc(rec.order_number || "—")}</div>
        <div><span class="muted">Guia:</span> ${esc(rec.guide_number || "—")}</div>
        <div><span class="muted">Procedencia:</span> ${esc(rec.origin || "—")}</div>
        <div><span class="muted">Tipo de carga:</span> ${esc(rec.cargo_type || "—")}</div>
        <div><span class="muted">OC:</span> ${esc(rec.purchase_order || "—")}</div>
      </div>
    </div>

    <div class="tabs">
      <div class="tab-btn active" data-tab="items">Detalle de productos</div>
      <div class="tab-btn" data-tab="history">Historial y trazabilidad</div>
    </div>

    <div data-panel="items">
      <div id="pending-banner"></div>
      <div class="card">
        <div class="toolbar"><h3 style="margin:0">Detalle de productos</h3><div class="spacer"></div>
          ${hasPermission("create_reception", "edit_reception", "create") ? `<button class="btn btn-sm btn-primary" id="btn-add-item">＋ Agregar item</button>` : ""}
        </div>
        <div id="items-table"></div>
      </div>
    </div>
    <div data-panel="history" class="hidden">
      <div class="card">
        <h3>Historial de cambios</h3>
        <p class="hint">Cada cambio queda registrado con usuario, fecha/hora, valor anterior y valor nuevo.</p>
        <div id="history-timeline"></div>
      </div>
    </div>
  `;

  container.querySelectorAll(".tab-btn").forEach((tab) =>
    tab.addEventListener("click", () => {
      container.querySelectorAll(".tab-btn").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      container.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab.dataset.tab));
      if (tab.dataset.tab === "history") loadHistory();
    })
  );

  async function loadHistory() {
    const box = container.querySelector("#history-timeline");
    box.innerHTML = `<div class="empty-state">Cargando...</div>`;
    const events = await api.get(`/receptions/${id}/history`);
    box.innerHTML = events.length
      ? `<div class="timeline">${events
          .map(
            (e) => `<div class="timeline-item">
              <div class="timeline-date">${fmtDateTime(e.timestamp)} · ${esc(e.user_name || "Sistema")}</div>
              <div class="timeline-label">${esc(e.action)}${e.field ? " — " + esc(e.field) : ""}</div>
              <div class="timeline-detail">${e.old_value ? `Antes: ${esc(e.old_value)} &rarr; ` : ""}${e.new_value ? `Ahora: ${esc(e.new_value)}` : ""}${e.reason ? ` (${esc(e.reason)})` : ""}</div>
            </div>`
          )
          .join("")}</div>`
      : `<div class="empty-state">Sin cambios registrados todavia.</div>`;
  }

  function statusButtons(r) {
    if (!hasPermission("create_reception", "edit_reception", "approve")) return "";
    const opts = { PENDIENTE: [], EN_PROCESO: ["OBSERVADO", "BLOQUEADO"], OBSERVADO: ["EN_PROCESO", "BLOQUEADO"], BLOQUEADO: ["EN_PROCESO"], COMPLETADO: [], CANCELADO: [] };
    const next = opts[r.status] || [];
    return next.map((s) => `<button class="btn btn-sm" data-set-status="${s}">Marcar ${s.replace("_", " ").toLowerCase()}</button>`).join(" ") +
      (r.status !== "CANCELADO" && r.status !== "COMPLETADO" ? ` <button class="btn btn-sm btn-danger" data-set-status="CANCELADO">Cancelar</button>` : "");
  }

  container.querySelectorAll("[data-set-status]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api.put(`/receptions/${id}/status`, { status: btn.dataset.setStatus });
      toast("Estado actualizado", "ok");
      renderReceptionDetail(container, id);
    })
  );

  function renderPendingBanner() {
    const pendingQuality = rec.items.filter((r) => r.quality_status === "PENDIENTE");
    const pendingLocate = rec.items.filter((r) => (r.quality_status === "DISPONIBLE" || r.quality_status === "OBSERVADO") && (r.storage_status === "PENDIENTE" || r.storage_status === "PARCIAL"));
    const pendingRelocate = rec.items.filter((r) => r.storage_status === "UBICADO" && r.location_code?.startsWith("patio,"));
    const canQuality = hasPermission("quality", "edit");
    const canLocate = hasPermission("locate", "edit");
    const rows = [];
    if (pendingLocate.length && canLocate) {
      rows.push(`
        <div class="pending-row">
          <div><strong>📍 ${pendingLocate.length} producto(s) listo(s) para ubicar en rack</strong><div class="muted" style="font-size:12px">Ya pasaron control de calidad — solo falta asignarles una posicion.</div></div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            ${pendingLocate.map((r) => `<button class="btn btn-sm btn-primary" data-putaway="${r.id}">${r.storage_status === "PARCIAL" ? `Ubicar resto (${fmtNum(r.remaining_to_locate)}) — ` : "Ubicar "}${esc(r.product_description)}</button>`).join("")}
          </div>
        </div>`);
    }
    if (pendingQuality.length && canQuality) {
      rows.push(`
        <div class="pending-row">
          <div><strong>🔍 ${pendingQuality.length} producto(s) pendiente(s) de calidad</strong><div class="muted" style="font-size:12px">Apruebelos para poder ubicarlos despues.</div></div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            ${pendingQuality.map((r) => `<button class="btn btn-sm btn-primary" data-quick-approve="${r.id}">✓ Aprobar y ubicar: ${esc(r.product_description)}</button>`).join("")}
          </div>
        </div>`);
    }
    if (pendingRelocate.length && canLocate) {
      rows.push(`
        <div class="pending-row">
          <div><strong>⏱ ${pendingRelocate.length} producto(s) en el Patio de Despacho</strong><div class="muted" style="font-size:12px">Ubicacion temporal — reubiquelos a su posicion definitiva en rack cuando pueda.</div></div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            ${pendingRelocate.map((r) => `<button class="btn btn-sm" data-relocate="${r.id}">Reubicar ${esc(r.product_description)}</button>`).join("")}
          </div>
        </div>`);
    }
    container.querySelector("#pending-banner").innerHTML = rows.length ? `<div class="card pending-banner">${rows.join("")}</div>` : "";
    container.querySelectorAll("#pending-banner [data-putaway]").forEach((b) => b.addEventListener("click", () => openPutawayModal(b.dataset.putaway)));
    container.querySelectorAll("#pending-banner [data-quick-approve]").forEach((b) => b.addEventListener("click", () => quickApproveAndLocate(b.dataset.quickApprove)));
    container.querySelectorAll("#pending-banner [data-relocate]").forEach((b) => b.addEventListener("click", () => openRelocateModal(b.dataset.relocate)));
  }

  function renderItems() {
    renderPendingBanner();
    container.querySelector("#items-table").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Producto", key: "product_description" },
        { label: "Lote", render: (r) => esc(r.lot_code || "—") },
        { label: "Vencim.", render: (r) => fmtDate(r.expiration_date) },
        { label: "Cajas", render: (r) => fmtNum(r.qty_cases) },
        { label: "Unidades", render: (r) => fmtNum(r.qty_units) },
        { label: "Calidad", render: (r) => badge(r.quality_status) },
        {
          label: "Ubicacion",
          render: (r) => {
            if (r.storage_status === "PARCIAL") {
              const list = (r.locations || []).map((l) => `${esc(l.location_code)} (${fmtNum(l.qty)})`).join(", ");
              return `${badge("PARCIAL")}<div class="muted" style="font-size:11px">${list || "—"} · faltan ${fmtNum(r.remaining_to_locate)}</div>`;
            }
            if (r.locations && r.locations.length > 1) {
              const list = r.locations.map((l) => `${esc(l.location_code)} (${fmtNum(l.qty)})`).join(", ");
              return `<span class="badge badge-info" title="${list}">${r.locations.length} ubicaciones</span>`;
            }
            return r.location_code ? `<span class="mono">${esc(r.location_code)}</span>` : badge(r.storage_status);
          },
        },
        {
          label: "",
          render: (r) => {
            if (r.quality_status === "PENDIENTE" && hasPermission("quality", "edit")) {
              const canLocate = hasPermission("locate", "edit");
              const canEdit = hasPermission("create_reception", "edit_reception", "edit");
              return `
                <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                  ${canLocate ? `<button class="btn btn-sm btn-primary" data-quick-approve="${r.id}" title="Aprueba el 100% sin defectos y abre la ubicacion en rack">✓ Aprobar y ubicar</button>` : ""}
                  <button class="btn btn-sm" data-inspect="${r.id}" title="Para registrar defectos o una aprobacion parcial">Inspeccionar</button>
                  ${canEdit ? `<button class="btn btn-sm" data-edit-item="${r.id}" title="Corregir cantidad, lote o vencimiento">✎ Editar</button>` : ""}
                </div>`;
            }
            if ((r.quality_status === "DISPONIBLE" || r.quality_status === "OBSERVADO") && (r.storage_status === "PENDIENTE" || r.storage_status === "PARCIAL") && hasPermission("locate", "edit"))
              return `<button class="btn btn-sm btn-primary" data-putaway="${r.id}">📍 ${r.storage_status === "PARCIAL" ? `Ubicar resto (${fmtNum(r.remaining_to_locate)})` : "Ubicar"}</button>`;
            if (r.storage_status === "UBICADO" && r.location_code?.startsWith("patio,") && hasPermission("locate", "edit"))
              return `<button class="btn btn-sm" data-relocate="${r.id}">Reubicar a rack</button>`;
            return "";
          },
        },
      ],
      rec.items,
      { emptyText: "Sin items. Agregue el primer producto de esta recepcion." }
    );
    container.querySelectorAll("[data-inspect]").forEach((b) => b.addEventListener("click", () => openInspectModal(b.dataset.inspect)));
    container.querySelectorAll("[data-putaway]").forEach((b) => b.addEventListener("click", () => openPutawayModal(b.dataset.putaway)));
    container.querySelectorAll("[data-relocate]").forEach((b) => b.addEventListener("click", () => openRelocateModal(b.dataset.relocate)));
    container.querySelectorAll("[data-quick-approve]").forEach((b) => b.addEventListener("click", () => quickApproveAndLocate(b.dataset.quickApprove)));
    container.querySelectorAll("[data-edit-item]").forEach((b) => b.addEventListener("click", () => openEditItemModal(b.dataset.editItem)));
  }
  renderItems();

  container.querySelector("#btn-add-item")?.addEventListener("click", () => openAddItemModal());

  /** Atajo para el caso mas comun: todo conforme, sin defectos. Aprueba de un
   * clic y encadena directo a elegir ubicacion, sin pasar por el formulario
   * detallado de inspeccion (ese sigue disponible aparte para cuando si hay
   * defectos que registrar). */
  async function quickApproveAndLocate(itemId) {
    const item = rec.items.find((i) => i.id == itemId);
    try {
      await api.post(`/receptions/items/${itemId}/inspect`, {
        inspected_qty: item.qty_units,
        conforming_qty: item.qty_units,
        defective_qty: 0,
        disposition: "CUARENTENA",
      });
      toast("Aprobado 100% conforme", "ok");
      await renderReceptionDetail(container, id);
      openPutawayModal(itemId);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const UOM_PLURAL = { CAJA: "cajas", PAQUETE: "paquetes", SACO: "sacos", BOLSA: "bolsas", BALDE: "baldes", ROLLO: "rollos", UND: "unidades", KG: "kilos", LT: "litros" };
  const UOM_SINGULAR = { CAJA: "caja", PAQUETE: "paquete", SACO: "saco", BOLSA: "bolsa", BALDE: "balde", ROLLO: "rollo", UND: "unidad", KG: "kilo", LT: "litro" };
  function pluralFor(uom) {
    const key = (uom || "").trim().toUpperCase();
    return UOM_PLURAL[key] || (key ? key.toLowerCase() + "s" : "cajas");
  }
  function singularFor(uom) {
    const key = (uom || "").trim().toUpperCase();
    return UOM_SINGULAR[key] || (key ? key.toLowerCase() : "caja");
  }

  function lotRowHTML(idx) {
    return `
      <div class="lot-row" data-lot-row="${idx}">
        <div class="form-grid" style="grid-template-columns:1.3fr 1fr 1fr 1fr auto; align-items:end">
          <div class="field" style="margin-bottom:0"><label>Lote</label><input class="lot-code" placeholder="Ej: 255565" /></div>
          <div class="field" style="margin-bottom:0"><label>Vencimiento</label><input class="lot-exp" type="date" /></div>
          <div class="field" style="margin-bottom:0"><label class="lot-cases-label">Cantidad (cajas)</label><input class="lot-cases" type="number" step="any" min="0" value="0" /></div>
          <div class="field" style="margin-bottom:0"><label>Unid. sueltas</label><input class="lot-extra" type="number" step="any" min="0" value="0" /></div>
          <button type="button" class="btn btn-sm btn-danger lot-remove" title="Quitar este lote" style="margin-bottom:2px">✕</button>
        </div>
        <div class="lot-subtotal muted" style="font-size:11.5px;margin:2px 0 10px">Subtotal: 0 unidades</div>
      </div>`;
  }

  function openAddItemModal() {
    const activitiesPromise = api.get("/activities");
    let lotRowCount = 1;
    showModal(
      `<h3>Agregar producto</h3>
      ${productPickerHTML({ clientId: rec.client_id, clientLabel: rec.client_name, label: "Producto" })}
      <form id="f">
        <div class="form-grid">
          <div class="field"><label>Unidad de medida</label>
            <select id="in-uom">
              <option value="CAJA">Cajas</option>
              <option value="PAQUETE">Paquetes</option>
              <option value="BOLSA">Bolsas</option>
              <option value="SACO">Sacos</option>
              <option value="UND">Unidades sueltas</option>
              <option value="KG">Kilos</option>
              <option value="LT">Litros</option>
              <option value="BALDE">Baldes</option>
              <option value="ROLLO">Rollos</option>
            </select>
          </div>
          <div class="field"><label data-upc-label>Unidades por caja</label><input id="in-upc" type="number" step="any" min="0" placeholder="Ej: 12" /></div>
        </div>
        <div class="hint" style="margin-bottom:10px">Se sugiere del catalogo al elegir el producto, pero puede cambiarla para esta recepcion. Es la misma para todos los lotes de abajo.</div>

        <div class="card" style="background:#f7f8fb;box-shadow:none;padding:14px 16px 4px;margin:6px 0 14px">
          <div style="font-weight:700;font-size:13px;color:var(--navy-dark);margin-bottom:8px">Lotes recibidos</div>
          <div class="hint" style="margin-bottom:10px">¿Llegaron varios lotes del mismo producto con distinta cantidad cada uno? Agregue una fila por lote — se registran todos juntos, sin tener que volver a buscar el producto.</div>
          <div id="lot-rows">${lotRowHTML(0)}</div>
          <button type="button" class="btn btn-sm" id="btn-add-lot" style="margin-bottom:14px">＋ Agregar otro lote de este mismo producto</button>
          <div id="grand-total-preview" style="font-size:14px;font-weight:700;color:var(--navy-dark);margin:-8px 0 14px">Total general: 0 unidades</div>
        </div>

        <div class="form-grid">
          ${flexiblePickerHTML({ label: "Actividad", placeholder: "Buscar o escribir una actividad/servicio nuevo..." })}
        </div>
        <div class="field"><label>Observaciones</label><input name="notes" /></div>
        <button class="btn btn-primary" type="submit">Agregar ${1} lote(s)</button>
      </form>`,
      {
        wide: true,
        onMount: async (root) => {
          const inUom = root.querySelector("#in-uom");
          const inUpc = root.querySelector("#in-upc");
          const upcLabel = root.querySelector("[data-upc-label]");
          const lotRowsBox = root.querySelector("#lot-rows");
          const grandTotalPreview = root.querySelector("#grand-total-preview");
          const submitBtn = root.querySelector("button[type=submit]");

          function rowTotal(rowEl) {
            const cases = parseFloat(rowEl.querySelector(".lot-cases").value) || 0;
            const upc = parseFloat(inUpc.value) || 0;
            const extra = parseFloat(rowEl.querySelector(".lot-extra").value) || 0;
            return cases * upc + extra;
          }
          function refreshAll() {
            const rowEls = [...lotRowsBox.querySelectorAll("[data-lot-row]")];
            let grand = 0;
            rowEls.forEach((rowEl) => {
              const t = rowTotal(rowEl);
              grand += t;
              rowEl.querySelector(".lot-subtotal").textContent = `Subtotal: ${t.toLocaleString("es-PE")} unidades`;
              rowEl.querySelector(".lot-remove").style.visibility = rowEls.length > 1 ? "visible" : "hidden";
            });
            grandTotalPreview.textContent = `Total general: ${grand.toLocaleString("es-PE")} unidades`;
            grandTotalPreview.style.color = grand > 0 ? "var(--navy-dark)" : "var(--bad)";
            submitBtn.textContent = `Agregar ${rowEls.length} lote${rowEls.length > 1 ? "s" : ""}`;
          }
          function refreshUomLabels() {
            const cases = pluralFor(inUom.value);
            upcLabel.textContent = `Unidades por ${singularFor(inUom.value)}`;
            lotRowsBox.querySelectorAll(".lot-cases-label").forEach((l) => (l.textContent = `Cantidad (${cases})`));
          }
          function wireRow(rowEl) {
            rowEl.querySelectorAll(".lot-cases, .lot-extra").forEach((el) => el.addEventListener("input", refreshAll));
            rowEl.querySelector(".lot-remove").addEventListener("click", () => {
              if (lotRowsBox.querySelectorAll("[data-lot-row]").length <= 1) return;
              rowEl.remove();
              refreshAll();
            });
          }
          wireRow(lotRowsBox.querySelector("[data-lot-row]"));
          inUpc.addEventListener("input", refreshAll);
          let uomTouchedByUser = false;
          inUom.addEventListener("change", () => {
            uomTouchedByUser = true;
            refreshUomLabels();
          });
          refreshUomLabels();
          refreshAll();

          root.querySelector("#btn-add-lot").addEventListener("click", () => {
            lotRowCount++;
            lotRowsBox.insertAdjacentHTML("beforeend", lotRowHTML(lotRowCount));
            const newRow = lotRowsBox.querySelector(`[data-lot-row="${lotRowCount}"]`);
            wireRow(newRow);
            refreshUomLabels();
            refreshAll();
            newRow.querySelector(".lot-code").focus();
          });

          const picker = mountProductPicker(root, {
            fixedClientId: rec.client_id,
            onChange: (ctx) => {
              const uomValue = (ctx.unitOfMeasure || "").trim().toUpperCase();
              const isValidPreset = [...inUom.options].some((o) => o.value === uomValue);
              if (!uomTouchedByUser && isValidPreset) inUom.value = uomValue;
              refreshUomLabels();
              if (ctx.unitsPerCase && !inUpc.value) inUpc.value = ctx.unitsPerCase;
              refreshAll();
            },
          });
          const activityPicker = mountFlexiblePicker(root.querySelector("[data-flex-picker]"), {
            fetchOptions: async (term) => {
              const activities = await activitiesPromise;
              const t = term.toLowerCase();
              return activities
                .filter((a) => a.name.toLowerCase().includes(t) || a.code.toLowerCase().includes(t))
                .map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }));
            },
            minChars: 0,
          });

          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const rowEls = [...lotRowsBox.querySelectorAll("[data-lot-row]")];
            const validRows = rowEls
              .map((rowEl) => ({
                lot_code: rowEl.querySelector(".lot-code").value.trim(),
                expiration_date: rowEl.querySelector(".lot-exp").value || null,
                qty_cases: parseFloat(rowEl.querySelector(".lot-cases").value) || null,
                qty_units: rowTotal(rowEl),
              }))
              .filter((r) => r.qty_units > 0);
            if (!validRows.length) {
              toast("Ingrese al menos una cantidad valida en algun lote", "error");
              return;
            }
            let productId, activityId;
            try {
              productId = await picker.resolveProductId();
              activityId = activityPicker.getId();
              const activityText = activityPicker.getFreeText();
              if (!activityId && activityText) {
                const res = await api.post("/activities", { name: activityText });
                activityId = res.id;
                toast(`Actividad "${activityText}" creada (${res.code})`, "info");
              }
            } catch (err) {
              toast(err.message, "error");
              return;
            }
            const notes = new FormData(e.target).get("notes");
            try {
              for (const row of validRows) {
                await api.post(`/receptions/${id}/items`, {
                  product_id: productId,
                  lot_code: row.lot_code,
                  expiration_date: row.expiration_date,
                  qty_cases: row.qty_cases,
                  qty_units: row.qty_units,
                  activity_id: activityId || null,
                  notes,
                });
              }
              toast(`${validRows.length} lote(s) agregado(s)`, "ok");
              closeModal();
              renderReceptionDetail(container, id);
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }

  async function openInspectModal(itemId) {
    const item = rec.items.find((i) => i.id == itemId);
    const defects = await api.get("/defect-types");
    showModal(
      `<h3>Control de calidad — ${esc(item.product_description)}</h3>
      <p class="muted">Lote ${esc(item.lot_code || "s/lote")} · Cantidad recibida: ${fmtNum(item.qty_units)} unidades</p>
      <form id="f">
        <div class="form-grid">
          <div class="field"><label>Cantidad inspeccionada</label><input name="inspected_qty" type="number" step="any" value="${item.qty_units}" required /></div>
          <div class="field"><label>Cantidad conforme</label><input name="conforming_qty" type="number" step="any" value="${item.qty_units}" required /></div>
          <div class="field"><label>Cantidad defectuosa</label><input name="defective_qty" type="number" step="any" value="0" required /></div>
          <div class="field"><label>Disposicion del defecto</label>
            <select name="disposition"><option value="CUARENTENA">Cuarentena</option><option value="OBSERVADO">Observado</option><option value="RECHAZADO">Rechazado</option><option value="DANADO">Danado</option></select>
          </div>
        </div>
        <div class="field" id="defects-box"><label>Tipo(s) de defecto</label>
          ${defects.map((d) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <input type="checkbox" class="defect-chk" value="${d.id}" style="width:auto" />
              <span style="flex:1;font-size:12.5px">${esc(d.code)}. ${esc(d.name)}</span>
              <input type="number" class="defect-qty" placeholder="cant." style="width:80px" disabled />
            </div>`).join("")}
        </div>
        <div class="field"><label>Observaciones</label><input name="notes" /></div>
        <div id="pct-preview" class="hint"></div>
        <button class="btn btn-primary" type="submit">Registrar inspeccion</button>
      </form>`,
      {
        onMount: (root) => {
          root.querySelectorAll(".defect-chk").forEach((chk) =>
            chk.addEventListener("change", (e) => {
              e.target.closest("div").querySelector(".defect-qty").disabled = !e.target.checked;
            })
          );
          const form = root.querySelector("#f");
          const updatePreview = () => {
            const insp = parseFloat(form.inspected_qty.value) || 0;
            const conf = parseFloat(form.conforming_qty.value) || 0;
            const def = parseFloat(form.defective_qty.value) || 0;
            root.querySelector("#pct-preview").textContent =
              insp > 0 ? `% conformidad: ${((conf / insp) * 100).toFixed(1)}% · % defecto: ${((def / insp) * 100).toFixed(1)}%` : "";
          };
          ["inspected_qty", "conforming_qty", "defective_qty"].forEach((n) => form[n].addEventListener("input", updatePreview));
          updatePreview();

          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const defectLines = [];
            root.querySelectorAll(".defect-chk:checked").forEach((chk) => {
              const qty = parseFloat(chk.closest("div").querySelector(".defect-qty").value) || 0;
              if (qty > 0) defectLines.push({ defect_type_id: parseInt(chk.value), qty });
            });
            const payload = {
              inspected_qty: parseFloat(fd.get("inspected_qty")),
              conforming_qty: parseFloat(fd.get("conforming_qty")),
              defective_qty: parseFloat(fd.get("defective_qty")),
              disposition: fd.get("disposition"),
              notes: fd.get("notes"),
              defects: defectLines,
            };
            try {
              const res = await api.post(`/receptions/items/${itemId}/inspect`, payload);
              toast(`Inspeccion registrada: ${res.pct_conformidad}% conforme`, "ok");
              closeModal();
              renderReceptionDetail(container, id);
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }

  async function openPutawayModal(itemId) {
    let suggestion = null;
    try {
      suggestion = await api.get(`/receptions/items/${itemId}/suggest-location`);
    } catch (err) {
      /* no suggestion available */
    }
    const item = rec.items.find((i) => i.id == itemId);
    openLocationPickerModal({
      title: "Asignar ubicacion",
      subtitle: `${esc(item.product_description)} · Lote ${esc(item.lot_code || "s/lote")}`,
      showPatioButton: true,
      suggestion,
      showQtyInput: true,
      remainingQty: item.remaining_to_locate ?? item.qty_units,
      unitLabel: "unidades",
      onConfirm: async (locationId, locationCode, qty) => {
        const res = await api.post(`/receptions/items/${itemId}/putaway`, { location_id: locationId, qty });
        if (res.remaining > 0.0001) {
          toast(`${fmtNum(res.qty_located)} unidades ubicadas en ${locationCode}`, "ok");
          return { keepOpen: true, remaining: res.remaining, message: `Faltan ${fmtNum(res.remaining)} unidades — elija la siguiente posicion (ej. otra paleta del mismo lote).` };
        }
        toast(`Ubicado en ${locationCode} — stock actualizado`, "ok");
        renderReceptionDetail(container, id);
      },
    });
  }

  async function openRelocateModal(itemId) {
    const item = rec.items.find((i) => i.id == itemId);
    openLocationPickerModal({
      title: "Reubicar a rack",
      subtitle: `${esc(item.product_description)} · Lote ${esc(item.lot_code || "s/lote")} · Actualmente en <span class="mono">${esc(item.location_code)}</span>`,
      excludePatio: true,
      onConfirm: async (locationId, locationCode) => {
        await api.post("/inventory/relocate", {
          product_id: item.product_id,
          client_id: rec.client_id,
          lot_id: item.lot_id,
          from_location_id: item.location_id,
          to_location_id: locationId,
          qty: item.qty_units,
        });
        toast(`Reubicado a ${locationCode}`, "ok");
        renderReceptionDetail(container, id);
      },
    });
  }
}
