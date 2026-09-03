import { api } from "../api.js";
import { table, esc, fmtNum, fmtDateTime, badge, showModal, closeModal, toast } from "../utils.js";
import { navigate } from "../router.js";
import { hasPermission } from "../state.js";

export async function renderPhysicalInventoryList(container) {
  const warehouses = await api.get("/warehouses");
  container.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      ${hasPermission("count", "edit") ? `<button class="btn btn-primary" id="btn-new">+ Nuevo conteo</button>` : ""}
    </div>
    <div class="card"><div id="tbl"></div></div>`;

  async function load() {
    const rows = await api.get("/physical-counts");
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "ID", key: "id" },
        { label: "Almacen", key: "warehouse_name" },
        { label: "Zona", render: (r) => esc(r.zone_code || "Todo el almacen") },
        { label: "Creado por", render: (r) => esc(r.created_by_name || "—") },
        { label: "Fecha", render: (r) => fmtDateTime(r.created_at) },
        { label: "Estado", render: (r) => badge(r.status) },
      ],
      rows,
      { rowAttrs: (r) => `class="row-link" data-id="${r.id}"`, emptyText: "Sin conteos de inventario fisico registrados" }
    );
    container.querySelectorAll("[data-id]").forEach((tr) => tr.addEventListener("click", () => navigate(`/inventario-fisico/${tr.dataset.id}`)));
  }

  container.querySelector("#btn-new")?.addEventListener("click", () => {
    showModal(
      `<h3>Nuevo conteo de inventario fisico</h3>
      <form id="f">
        <div class="field"><label>Almacen</label>
          <select name="warehouse_id" required>${warehouses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select>
        </div>
        <p class="hint">Se generara una linea por cada combinacion producto/lote/ubicacion con stock actual en el almacen.</p>
        <button class="btn btn-primary" type="submit">Crear conteo</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(new FormData(e.target).entries());
            const res = await api.post("/physical-counts", payload);
            closeModal();
            navigate(`/inventario-fisico/${res.id}`);
          }),
      }
    );
  });

  await load();
}

export async function renderPhysicalInventoryDetail(container, id) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const count = await api.get(`/physical-counts/${id}`);
  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <h3 style="margin:0">Conteo #${count.id} ${badge(count.status)}</h3>
        <div class="spacer"></div>
        ${count.status !== "CERRADO" && hasPermission("approve") ? `<button class="btn btn-primary btn-sm" id="btn-approve">Aprobar ajustes y cerrar</button>` : ""}
      </div>
      <div id="items-table"></div>
    </div>`;

  function renderItems() {
    container.querySelector("#items-table").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Producto", key: "product_description" },
        { label: "Lote", render: (r) => esc(r.lot_code || "—") },
        { label: "Ubicacion", render: (r) => `<span class="mono">${esc(r.location_code)}</span>` },
        { label: "Sistema", render: (r) => fmtNum(r.system_qty) },
        {
          label: "Fisico (contado)",
          render: (r) =>
            count.status === "CERRADO"
              ? fmtNum(r.counted_qty)
              : `<input type="number" step="any" class="counted-input" data-item="${r.id}" value="${r.counted_qty ?? ""}" style="width:110px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />`,
        },
        {
          label: "Diferencia",
          render: (r) =>
            r.difference === null || r.difference === undefined
              ? "—"
              : `<strong style="color:${r.difference === 0 ? "var(--ok)" : "var(--bad)"}">${r.difference > 0 ? "+" : ""}${fmtNum(r.difference)}</strong>`,
        },
      ],
      count.items,
      { emptyText: "Sin lineas en este conteo" }
    );
    container.querySelectorAll(".counted-input").forEach((inp) =>
      inp.addEventListener("change", async () => {
        await api.put(`/physical-count-items/${inp.dataset.item}`, { counted_qty: parseFloat(inp.value) || 0 });
        toast("Cantidad registrada", "ok");
        renderPhysicalInventoryDetail(container, id);
      })
    );
  }
  renderItems();

  container.querySelector("#btn-approve")?.addEventListener("click", async () => {
    if (!confirm("Esto aplicara ajustes de inventario para todas las diferencias registradas. ¿Continuar?")) return;
    try {
      const res = await api.post(`/physical-counts/${id}/approve`);
      toast(`Conteo cerrado. ${res.adjustments_applied} ajustes aplicados.`, "ok");
      renderPhysicalInventoryDetail(container, id);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
