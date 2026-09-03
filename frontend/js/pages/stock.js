import { api } from "../api.js";
import { table, esc, fmtNum, badge, fmtDate, toast, debounce } from "../utils.js";
import { hasPermission } from "../state.js";
import { openLocationPickerModal } from "../components/locationPicker.js";

export async function renderStock(container, initialQuery = {}) {
  const clients = await api.get("/clients");
  container.innerHTML = `
    <div class="card">
      <div class="form-grid" style="margin-bottom:6px">
        <div class="field"><label>SKU</label><input id="f-sku" value="${esc(initialQuery.sku || "")}" /></div>
        <div class="field"><label>Lote</label><input id="f-lot" /></div>
        <div class="field"><label>N° Pedido</label><input id="f-order" placeholder="Buscar por pedido..." /></div>
        <div class="field"><label>Cliente</label>
          <select id="f-client"><option value="">Todos</option>${clients.map((c) => `<option value="${c.id}" ${initialQuery.client_id == c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Estado</label>
          <select id="f-status"><option value="">Todos</option>
            <option value="DISPONIBLE">Disponible</option><option value="RESERVADO">Reservado</option>
            <option value="CUARENTENA">Cuarentena</option><option value="BLOQUEADO">Bloqueado</option><option value="DANADO">Danado</option>
          </select>
        </div>
        <div class="field"><label>Tipo</label>
          <select id="f-item-type"><option value="">Todos</option>
            <option value="PRODUCTO">📦 Solo productos</option><option value="MATERIAL">🧰 Solo materiales/empaques</option>
          </select>
        </div>
        <div class="field"><label>Ubicacion</label>
          <select id="f-loc-status"><option value="">Todas</option>
            <option value="SIN_UBICAR">📍 Sin ubicar</option>
            <option value="PATIO">⏱ En Patio (temporal)</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-filter">Filtrar</button>
    </div>
    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Resultado <span id="total-badge" class="badge badge-info"></span></h3></div>
      <div id="stock-table"></div>
    </div>
  `;

  async function load() {
    const params = {
      sku: container.querySelector("#f-sku").value,
      lot_code: container.querySelector("#f-lot").value,
      order_number: container.querySelector("#f-order").value,
      client_id: container.querySelector("#f-client").value,
      status: container.querySelector("#f-status").value,
      item_type: container.querySelector("#f-item-type").value,
      product_id: initialQuery.product_id,
    };
    let { rows, total_qty, count } = await api.get("/stock", params);
    const locFilter = container.querySelector("#f-loc-status").value;
    if (locFilter === "SIN_UBICAR") rows = rows.filter((r) => !r.location_code);
    else if (locFilter === "PATIO") rows = rows.filter((r) => r.location_code?.startsWith("patio,"));
    if (locFilter) {
      total_qty = rows.reduce((s, r) => s + r.qty, 0);
      count = rows.length;
    }
    const canLocate = hasPermission("locate", "edit");
    container.querySelector("#total-badge").textContent = `${fmtNum(total_qty)} unidades en ${count} posiciones`;
    container.querySelector("#stock-table").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Producto", render: (r) => `${r.item_type === "MATERIAL" ? '<span class="badge badge-warn" style="margin-right:5px">🧰 Material</span>' : ""}${esc(r.product_description)}` },
        { label: "Cliente", key: "client_name" },
        { label: "Lote", render: (r) => esc(r.lot_code || "—") },
        { label: "Vencimiento", render: (r) => fmtDate(r.expiration_date) },
        { label: "Ubicacion", render: (r) => (r.location_code ? `<span class="mono">${esc(r.location_code)}</span>` : `<span class="muted">Sin ubicar</span>`) },
        { label: "N Pedido", render: (r) => esc(r.order_number || "—") },
        { label: "Estado", render: (r) => badge(r.status) },
        { label: "Cantidad", render: (r) => `<strong>${fmtNum(r.qty)}</strong>` },
        {
          label: "",
          render: (r) => {
            if (!canLocate || r.status !== "DISPONIBLE") return "";
            const idx = rows.indexOf(r);
            return r.location_code
              ? `<button class="btn btn-sm" data-reloc-idx="${idx}">↔ Reubicar</button>`
              : `<button class="btn btn-sm btn-primary" data-loc-idx="${idx}">📍 Ubicar</button>`;
          },
        },
      ],
      rows,
      { emptyText: "Sin stock que coincida con el filtro" }
    );

    container.querySelectorAll("[data-loc-idx], [data-reloc-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows[btn.dataset.locIdx ?? btn.dataset.relocIdx];
        openLocationPickerModal({
          title: row.location_code ? "Reubicar a otra posicion" : "Asignar ubicacion",
          subtitle: `${esc(row.sku_code)} — ${esc(row.product_description)} · Lote ${esc(row.lot_code || "s/lote")}${row.location_code ? ` · Actualmente en <span class="mono">${esc(row.location_code)}</span>` : ""}`,
          showPatioButton: !row.location_code,
          excludePatio: true,
          onConfirm: async (locationId, locationCode) => {
            await api.post("/inventory/relocate", {
              product_id: row.product_id,
              client_id: row.client_id,
              lot_id: row.lot_id,
              from_location_id: row.location_id,
              to_location_id: locationId,
              qty: row.qty,
            });
            toast(row.location_code ? `Reubicado a ${locationCode}` : `Ubicado en ${locationCode}`, "ok");
            load();
          },
        });
      });
    });
  }

  container.querySelector("#btn-filter").addEventListener("click", load);
  container.querySelector("#f-order").addEventListener("input", debounce(load, 300));
  container.querySelector("#f-loc-status").addEventListener("change", load);
  await load();
}
