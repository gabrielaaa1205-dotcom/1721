import { api } from "../api.js";
import { table, esc, fmtNum, fmtDate, badge, showModal, closeModal, toast, debounce } from "../utils.js";
import { navigate } from "../router.js";
import { hasPermission } from "../state.js";
import { clientPickerHTML, mountClientPicker, productPickerHTML, mountProductPicker } from "../components/pickers.js";

export async function renderDispatchesList(container) {
  const clients = await api.get("/clients");
  container.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="Buscar numero, guia o N pedido..." style="max-width:260px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <select id="f-client" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los clientes</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
      </select>
      <select id="f-status" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los estados</option>
        <option value="PENDIENTE">Pendiente</option><option value="RESERVADO">Reservado</option>
        <option value="EN_PICKING">En picking</option><option value="VERIFICADO">Verificado</option>
        <option value="CERRADO">Cerrado</option><option value="CANCELADO">Cancelado</option>
      </select>
      <div class="spacer"></div>
      ${hasPermission("create", "dispatch") ? `<button class="btn btn-primary" id="btn-new">+ Nuevo despacho</button>` : ""}
    </div>
    <div class="card"><div id="tbl"></div></div>`;

  async function load() {
    const rows = await api.get("/dispatches", {
      q: container.querySelector("#q").value,
      client_id: container.querySelector("#f-client").value,
      status: container.querySelector("#f-status").value,
    });
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "N Despacho", render: (r) => `<span class="mono">${esc(r.dispatch_number)}</span>` },
        { label: "Cliente", key: "client_name" },
        { label: "Fecha", render: (r) => fmtDate(r.dispatch_date) },
        { label: "Guia", render: (r) => esc(r.guide_number || "—") },
        { label: "N Pedido", render: (r) => esc(r.order_number || "—") },
        { label: "Destino", render: (r) => esc(r.destination || "—") },
        { label: "Items", key: "item_count" },
        { label: "Estado", render: (r) => badge(r.status) },
      ],
      rows,
      { rowAttrs: (r) => `class="row-link" data-id="${r.id}"`, emptyText: "No hay despachos registrados" }
    );
    container.querySelectorAll("[data-id]").forEach((tr) => tr.addEventListener("click", () => navigate(`/despachos/${tr.dataset.id}`)));
  }

  container.querySelector("#btn-new")?.addEventListener("click", () => openNewDispatchModal(clients, load));
  container.querySelector("#q").addEventListener("input", debounce(load, 250));
  container.querySelector("#f-client").addEventListener("change", load);
  container.querySelector("#f-status").addEventListener("change", load);
  await load();
}

function openNewDispatchModal(clients, onDone) {
  showModal(
    `<h3>Nuevo despacho</h3>
    <form id="f">
      <div class="form-grid">
        ${clientPickerHTML({ label: "Cliente" })}
        <div class="field"><label>Fecha de despacho</label><input type="date" name="dispatch_date" required value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div class="field"><label>Hora</label><input type="time" name="dispatch_time" /></div>
        <div class="field"><label>Nº guia</label><input name="guide_number" /></div>
        <div class="field"><label>Nº pedido</label><input name="order_number" /></div>
        <div class="field"><label>Destino</label><input name="destination" /></div>
      </div>
      <button class="btn btn-primary" type="submit">Crear despacho</button>
    </form>`,
    {
      onMount: (root) => {
        mountClientPicker(root);
        root.querySelector("#f").addEventListener("submit", async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(e.target).entries());
          if (!payload.client_id) { toast("Seleccione o cree un cliente", "error"); return; }
          try {
            const res = await api.post("/dispatches", payload);
            closeModal();
            navigate(`/despachos/${res.id}`);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    }
  );
}

export async function renderDispatchDetail(container, id) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const dsp = await api.get(`/dispatches/${id}`);
  let pickingOrder = await api.get(`/dispatches/${id}/picking-order`);

  const extraFieldLabel = dsp.client_config?.dispatch_extra_field === "copacker_lot" ? "Lote copacker" : dsp.client_config?.dispatch_extra_field === "client_acceptance" ? "Aceptacion cliente" : null;

  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div><h3 style="margin-bottom:2px">${esc(dsp.dispatch_number)} ${badge(dsp.status)}</h3>
          <div class="muted">${esc(dsp.client_name)} · ${fmtDate(dsp.dispatch_date)} ${dsp.destination ? "· " + esc(dsp.destination) : ""} ${dsp.order_number ? `· Pedido: ${esc(dsp.order_number)}` : ""}</div></div>
        <div class="spacer"></div>
        <div id="action-buttons"></div>
      </div>
    </div>

    <div id="quick-dispatch-banner"></div>

    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Lineas de despacho</h3><div class="spacer"></div>
        ${dsp.status === "PENDIENTE" && hasPermission("create", "dispatch") ? `<button class="btn btn-sm btn-primary" id="btn-add-item">+ Agregar linea</button>` : ""}
      </div>
      <div id="items-table"></div>
    </div>

    ${pickingOrder ? `<div class="card"><h3>Orden de picking</h3><div id="picking-table"></div></div>` : ""}
  `;

  renderActionButtons();
  renderItems();
  renderQuickDispatchBanner();
  if (pickingOrder) renderPicking();

  container.querySelector("#btn-add-item")?.addEventListener("click", () => openAddItemModal());

  /** Banner grande y directo: para el caso normal (se despacha exactamente lo
   * solicitado), un solo boton hace reserva + picking + verificacion + cierre,
   * y recien ahi se descuenta el stock real. */
  function renderQuickDispatchBanner() {
    const box = container.querySelector("#quick-dispatch-banner");
    const canDispatch = ["PENDIENTE", "RESERVADO", "EN_PICKING"].includes(dsp.status) && dsp.items.length && hasPermission("dispatch", "approve");
    if (!canDispatch) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `
      <div class="card pending-banner">
        <div class="pending-row">
          <div><strong>⚡ Despachar ahora</strong><div class="muted" style="font-size:12px">Descuenta el stock de las ${dsp.items.length} linea(s) de una sola vez (reserva + picking + cierre). Use esto salvo que necesite hacer picking parcial o revisar diferencias.</div></div>
          <button class="btn btn-primary" id="btn-quick-dispatch" style="white-space:nowrap">⚡ Despachar y descontar stock</button>
        </div>
      </div>`;
    box.querySelector("#btn-quick-dispatch").addEventListener("click", async () => {
      if (!confirm(`¿Despachar las ${dsp.items.length} linea(s) de ${esc(dsp.client_name)}? Esto descuenta el stock real y no se puede deshacer.`)) return;
      try {
        await api.post(`/dispatches/${id}/quick-dispatch`);
        toast("Despacho cerrado. Stock descontado.", "ok");
        renderDispatchDetail(container, id);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  function renderActionButtons() {
    const box = container.querySelector("#action-buttons");
    let html = "";
    if (dsp.status === "PENDIENTE" && dsp.items.length && hasPermission("create", "dispatch"))
      html += `<span class="hint">Reserve cada linea para pasar a estado Reservado</span>`;
    if (dsp.status === "RESERVADO" && hasPermission("dispatch", "pick"))
      html += `<button class="btn btn-sm btn-primary" id="btn-gen-picking">Generar picking</button>`;
    if (dsp.status === "EN_PICKING") html += `<span class="hint">Complete el picking abajo</span>`;
    if (dsp.status === "EN_PICKING" && pickingOrder?.status === "COMPLETADO" && hasPermission("dispatch", "approve"))
      html += ` <button class="btn btn-sm btn-primary" id="btn-verify">Verificar</button>`;
    if (dsp.status === "VERIFICADO" && hasPermission("dispatch", "approve"))
      html += `<button class="btn btn-sm btn-primary" id="btn-close">Cerrar despacho</button>`;
    if (!["CERRADO", "CANCELADO"].includes(dsp.status) && hasPermission("dispatch", "approve"))
      html += ` <button class="btn btn-sm btn-danger" id="btn-cancel">Cancelar</button>`;
    box.innerHTML = html;
    box.querySelector("#btn-gen-picking")?.addEventListener("click", async () => {
      try {
        await api.post(`/dispatches/${id}/generate-picking`);
        toast("Orden de picking generada", "ok");
        renderDispatchDetail(container, id);
      } catch (err) {
        toast(err.message, "error");
      }
    });
    box.querySelector("#btn-verify")?.addEventListener("click", async () => {
      try {
        await api.post(`/dispatches/${id}/verify`);
        toast("Despacho verificado", "ok");
        renderDispatchDetail(container, id);
      } catch (err) {
        toast(err.message, "error");
      }
    });
    box.querySelector("#btn-close")?.addEventListener("click", async () => {
      try {
        await api.post(`/dispatches/${id}/close`);
        toast("Despacho cerrado. Stock descontado.", "ok");
        renderDispatchDetail(container, id);
      } catch (err) {
        toast(err.message, "error");
      }
    });
    box.querySelector("#btn-cancel")?.addEventListener("click", async () => {
      if (!confirm("¿Cancelar este despacho? Se liberaran las reservas activas.")) return;
      await api.put(`/dispatches/${id}/status`, { status: "CANCELADO" });
      toast("Despacho cancelado", "info");
      renderDispatchDetail(container, id);
    });
  }

  function renderItems() {
    container.querySelector("#items-table").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Producto", key: "product_description" },
        { label: "Lote", render: (r) => esc(r.lot_code || "cualquiera") },
        { label: "Solicitado", render: (r) => fmtNum(r.qty_requested) },
        { label: "Reservado", render: (r) => fmtNum(r.reserved_qty) },
        extraFieldLabel ? { label: extraFieldLabel, render: (r) => esc(r.client_acceptance || r.copacker_lot || "—") } : null,
        {
          label: "",
          render: (r) =>
            dsp.status === "PENDIENTE" && r.reserved_qty < r.qty_requested && hasPermission("create", "dispatch")
              ? `<button class="btn btn-sm" data-reserve="${r.id}">Reservar (FEFO/FIFO)</button>`
              : "",
        },
      ].filter(Boolean),
      dsp.items,
      { emptyText: "Sin lineas. Agregue el primer producto a despachar." }
    );
    container.querySelectorAll("[data-reserve]").forEach((b) => b.addEventListener("click", () => doReserve(b.dataset.reserve)));
  }

  async function doReserve(itemId) {
    try {
      const res = await api.post(`/dispatches/items/${itemId}/reserve`);
      showModal(
        `<h3>Reserva confirmada (FEFO/FIFO)</h3>
        <p class="muted">El sistema asigno automaticamente el stock segun vencimiento/antiguedad:</p>
        <div class="timeline">${res.allocations.map((a) => `<div class="timeline-item"><div class="timeline-label">${fmtNum(a.qty)} unidades — ${a.location_code ? esc(a.location_code) : '<span style="color:var(--warn)">sin ubicar</span>'}</div><div class="timeline-detail">${esc(a.reason)}</div></div>`).join("")}</div>
        <button class="btn btn-primary" id="btn-ok">Entendido</button>`,
        { onMount: (root) => root.querySelector("#btn-ok").addEventListener("click", () => { closeModal(); renderDispatchDetail(container, id); }) }
      );
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function renderPicking() {
    container.querySelector("#picking-table").innerHTML =
      `<p class="hint">Orden sugerida para minimizar desplazamiento dentro del almacen (agrupado por zona/rack/nivel).</p>` +
      table(
        [
          { label: "#", key: "sequence" },
          { label: "Ubicacion", render: (r) => (r.location_code ? `<span class="mono">${esc(r.location_code)}</span>` : `<span class="muted">sin ubicar</span>`) },
          { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
          { label: "Producto", key: "product_description" },
          { label: "Lote", render: (r) => esc(r.lot_code || "—") },
          { label: "Solicitado", render: (r) => fmtNum(r.qty_requested) },
          { label: "Pickeado", render: (r) => fmtNum(r.qty_picked) },
          { label: "Estado", render: (r) => badge(r.status) },
          {
            label: "",
            render: (r) =>
              r.status === "PENDIENTE" && hasPermission("pick")
                ? `<button class="btn btn-sm" data-pick="${r.id}" data-qty="${r.qty_requested}">Marcar pickeado</button>`
                : "",
          },
        ],
        pickingOrder.items,
        { emptyText: "Sin lineas de picking" }
      );
    container.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", async () => {
        const qty = prompt("Cantidad realmente pickeada:", b.dataset.qty);
        if (qty === null) return;
        await api.post(`/picking-items/${b.dataset.pick}/pick`, { qty_picked: parseFloat(qty) });
        toast("Linea de picking actualizada", "ok");
        renderDispatchDetail(container, id);
      })
    );
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

  function openAddItemModal() {
    showModal(
      `<h3>Agregar linea de despacho</h3>
      ${productPickerHTML({ clientId: dsp.cid, clientLabel: dsp.client_name, label: "Producto", allowNew: false })}
      <div id="stock-preview"></div>
      <form id="f">
        <div class="form-grid">
          <div class="field"><label>Lote (opcional — si se deja vacio, el sistema elige por FEFO/FIFO)</label><input name="lot_code" /></div>
        </div>
        <div class="field">
          <label>Unidad de medida de este despacho</label>
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
          <div class="hint">Al elegir el producto se sugiere la unidad del catalogo, pero usted decide con cual trabajar este despacho.</div>
        </div>
        <div class="card" style="background:#f7f8fb;box-shadow:none;padding:14px 16px;margin:6px 0 14px">
          <div class="form-grid">
            <div class="field"><label data-qty-cases-label>Cantidad (cajas)</label><input id="in-cases" type="number" step="any" min="0" value="0" /></div>
            <div class="field"><label data-upc-label>Unidades por caja</label><input id="in-upc" type="number" step="any" min="0" placeholder="Ej: 12" /></div>
            <div class="field"><label>Unidades sueltas adicionales</label><input id="in-extra" type="number" step="any" min="0" value="0" /></div>
          </div>
          <div class="hint">Si se despachan cajas completas + unidades sueltas (ej. 10 cajas + 5 sueltas), llene ambos campos — el total se calcula solo.</div>
          <div id="total-preview" style="font-size:14px;font-weight:700;color:var(--navy-dark);margin-top:6px">Total: 0 unidades</div>
        </div>
        ${extraFieldLabel ? `<div class="form-grid"><div class="field"><label>${extraFieldLabel}</label><input name="${dsp.client_config.dispatch_extra_field === "copacker_lot" ? "copacker_lot" : "client_acceptance"}" /></div></div>` : ""}
        <button class="btn btn-primary" type="submit">Agregar</button>
      </form>`,
      {
        onMount: (root) => {
          const stockPreview = root.querySelector("#stock-preview");
          const inUom = root.querySelector("#in-uom");
          const inCases = root.querySelector("#in-cases");
          const inUpc = root.querySelector("#in-upc");
          const inExtra = root.querySelector("#in-extra");
          const preview = root.querySelector("#total-preview");
          const casesLabel = root.querySelector("[data-qty-cases-label]");
          const upcLabel = root.querySelector("[data-upc-label]");

          function currentTotal() {
            const cases = parseFloat(inCases.value) || 0;
            const upc = parseFloat(inUpc.value) || 0;
            const extra = parseFloat(inExtra.value) || 0;
            return cases * upc + extra;
          }
          function refreshPreview() {
            const total = currentTotal();
            preview.textContent = `Total: ${total.toLocaleString("es-PE")} unidades`;
            preview.style.color = total > 0 ? "var(--navy-dark)" : "var(--bad)";
          }
          function refreshUomLabels() {
            casesLabel.textContent = `Cantidad (${pluralFor(inUom.value)})`;
            upcLabel.textContent = `Unidades por ${singularFor(inUom.value)}`;
          }
          [inCases, inUpc, inExtra].forEach((el) => el.addEventListener("input", refreshPreview));
          let uomTouchedByUser = false;
          inUom.addEventListener("change", () => {
            uomTouchedByUser = true;
            refreshUomLabels();
          });
          refreshPreview();
          refreshUomLabels();

          const picker = mountProductPicker(root, {
            fixedClientId: dsp.cid,
            onChange: async (ctx) => {
              const uomValue = (ctx.unitOfMeasure || "").trim().toUpperCase();
              const isValidPreset = [...inUom.options].some((o) => o.value === uomValue);
              if (!uomTouchedByUser && isValidPreset) inUom.value = uomValue;
              refreshUomLabels();

              if (!ctx.productId) {
                stockPreview.innerHTML = "";
                return;
              }
              stockPreview.innerHTML = `<div class="hint">Consultando stock disponible...</div>`;
              const components = await api.get(`/products/${ctx.productId}/components`);
              if (components.length) {
                // Es un combo: no tiene stock propio -- se calcula cuantos
                // combos completos se pueden armar segun el componente mas
                // limitante, y se muestra que se va a descontar de cada uno.
                const stocks = await Promise.all(
                  components.map((c) => api.get("/stock", { product_id: c.component_product_id, client_id: dsp.cid, status: "DISPONIBLE" }))
                );
                let maxCombos = Infinity;
                const lines = components.map((c, i) => {
                  const avail = stocks[i].total_qty || 0;
                  const possible = Math.floor(avail / c.qty_per_kit);
                  maxCombos = Math.min(maxCombos, possible);
                  return `<li>${esc(c.sku_code)} — ${esc(c.description)}: se descuentan <strong>${c.qty_per_kit}</strong> por combo (disponible: ${fmtNum(avail)})</li>`;
                });
                stockPreview.innerHTML = `
                  <div class="alert-row" style="border-color:var(--info);background:var(--info-bg)">
                    <div>
                      <strong>🎁 Este producto es un combo — se descontaran sus componentes, no el combo en si:</strong>
                      <ul style="margin:6px 0 4px 18px; padding:0">${lines.join("")}</ul>
                      <div style="margin-top:4px">${maxCombos > 0 ? `✓ Se pueden armar hasta <strong>${maxCombos}</strong> combo(s) con el stock actual.` : `<span style="color:var(--bad)">⚠ No alcanza el stock de algun componente para armar ni 1 combo.</span>`}</div>
                    </div>
                  </div>`;
                return;
              }
              const { rows, total_qty } = await api.get("/stock", { product_id: ctx.productId, client_id: dsp.cid, status: "DISPONIBLE" });
              if (!rows.length) {
                stockPreview.innerHTML = `<div class="alert-row bad">⚠ Este producto no tiene stock disponible para despachar ahora mismo.</div>`;
                return;
              }
              stockPreview.innerHTML = `
                <div class="alert-row" style="border-color:var(--ok);background:var(--ok-bg)">
                  <span>✓ Disponible: <strong>${fmtNum(total_qty)} unidades</strong> en ${rows.length} lote(s)/ubicacion(es).
                  El sistema asigna automaticamente por FEFO/FIFO (lo mas antiguo o proximo a vencer primero).</span>
                </div>`;
            },
          });
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const total = currentTotal();
            if (total <= 0) {
              toast("Ingrese al menos una cantidad (cajas o unidades sueltas)", "error");
              return;
            }
            const payload = Object.fromEntries(new FormData(e.target).entries());
            payload.qty_requested = total;
            payload.qty_cases = parseFloat(inCases.value) || null;
            try {
              payload.product_id = await picker.resolveProductId();
              await api.post(`/dispatches/${id}/items`, payload);
              closeModal();
              renderDispatchDetail(container, id);
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }
}
