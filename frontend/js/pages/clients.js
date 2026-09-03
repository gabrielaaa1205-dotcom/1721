import { api } from "../api.js";
import { table, esc, showModal, closeModal, toast, debounce } from "../utils.js";
import { hasPermission } from "../state.js";
import { openCreateClientModal } from "../components/pickers.js";

export async function renderClients(container) {
  container.innerHTML = `
    <div class="toolbar">
      <input id="client-search" placeholder="Buscar por nombre, codigo o RUC..." style="max-width:280px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <div class="spacer"></div>
      ${hasPermission("create", "edit") ? `<button class="btn btn-primary" id="btn-new-client">＋ Nuevo cliente</button>` : ""}
    </div>
    <div class="hint" style="margin-bottom:10px">El catalogo de clientes nunca es una lista cerrada: si el cliente no existe, se crea aqui mismo o desde cualquier formulario que lo necesite (recepcion, despacho, produccion).</div>
    <div class="card"><div id="clients-table"></div></div>
  `;

  async function load(q = "") {
    const rows = await api.get("/clients", { q });
    container.querySelector("#clients-table").innerHTML = table(
      [
        { label: "Codigo", render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { label: "Nombre", key: "name" },
        { label: "RUC", render: (r) => esc(r.tax_id || "—") },
        { label: "Contacto", render: (r) => esc(r.contact || "—") },
        { label: "Estado", render: (r) => (r.active ? `<span class="badge badge-ok">Activo</span>` : `<span class="badge badge-grey">Inactivo</span>`) },
        {
          label: "",
          render: (r) =>
            hasPermission("create", "edit")
              ? `<button class="btn btn-sm" data-edit="${r.id}">Editar</button> <button class="btn btn-sm" data-config="${r.id}">Reglas</button>`
              : "",
        },
      ],
      rows,
      { emptyText: "No hay clientes registrados. Cree uno o importe el Excel historico." }
    );
    container.querySelectorAll("[data-config]").forEach((btn) =>
      btn.addEventListener("click", () => openConfigModal(rows.find((r) => r.id == btn.dataset.config)))
    );
    container.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => openEditModal(rows.find((r) => r.id == btn.dataset.edit)))
    );
  }

  function openEditModal(client) {
    showModal(
      `<h3>Editar cliente</h3>
      <form id="edit-client-form">
        <div class="form-grid">
          <div class="field"><label>Codigo</label><input value="${esc(client.code)}" disabled /></div>
          <div class="field"><label>RUC</label><input name="tax_id" value="${esc(client.tax_id || "")}" /></div>
        </div>
        <div class="field"><label>Nombre / razon social</label><input name="name" required value="${esc(client.name)}" /></div>
        <div class="field"><label>Contacto</label><input name="contact" value="${esc(client.contact || "")}" placeholder="Nombre y/o telefono" /></div>
        <div class="field"><label><input type="checkbox" name="active" ${client.active ? "checked" : ""} style="width:auto;margin-right:6px" />Cliente activo</label></div>
        <button class="btn btn-primary" type="submit">Guardar cambios</button>
      </form>`,
      {
        onMount: (root) => {
          root.querySelector("#edit-client-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            try {
              await api.put(`/clients/${client.id}`, {
                name: fd.get("name"), tax_id: fd.get("tax_id"), contact: fd.get("contact"),
                active: fd.get("active") ? 1 : 0,
              });
              toast("Cliente actualizado", "ok");
              closeModal();
              load(container.querySelector("#client-search").value);
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }

  function openConfigModal(client) {
    showModal(
      `<h3>Reglas de operacion — ${esc(client.name)}</h3>
      <form id="config-form">
        <div class="field"><label>Campo adicional en despacho</label>
          <select name="dispatch_extra_field">
            <option value="client_acceptance" ${client.dispatch_extra_field === "client_acceptance" ? "selected" : ""}>Aceptacion del cliente (Si/No)</option>
            <option value="copacker_lot" ${client.dispatch_extra_field === "copacker_lot" ? "selected" : ""}>Lote copacker</option>
            <option value="none" ${client.dispatch_extra_field === "none" ? "selected" : ""}>Ninguno</option>
          </select>
        </div>
        <div class="field"><label>Regla de picking</label>
          <select name="fefo_or_fifo">
            <option value="FEFO" ${client.fefo_or_fifo === "FEFO" ? "selected" : ""}>FEFO (vence primero, sale primero)</option>
            <option value="FIFO" ${client.fefo_or_fifo === "FIFO" ? "selected" : ""}>FIFO (ingreso primero, sale primero)</option>
          </select>
        </div>
        <div class="field"><label><input type="checkbox" name="requires_lot" ${client.requires_lot ? "checked" : ""} style="width:auto;margin-right:6px" />Lote obligatorio en recepcion</label></div>
        <div class="field"><label><input type="checkbox" name="requires_po" ${client.requires_po ? "checked" : ""} style="width:auto;margin-right:6px" />Orden de compra obligatoria</label></div>
        <div class="field"><label>Umbrales de alerta de vencimiento (dias, separados por coma)</label>
          <input name="expiry_thresholds" value="${esc(client.expiry_thresholds)}" /></div>
        <button class="btn btn-primary" type="submit">Guardar</button>
      </form>`,
      {
        onMount: (root) => {
          root.querySelector("#config-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            await api.put(`/clients/${client.id}/config`, {
              dispatch_extra_field: fd.get("dispatch_extra_field"),
              fefo_or_fifo: fd.get("fefo_or_fifo"),
              requires_lot: fd.get("requires_lot") ? 1 : 0,
              requires_po: fd.get("requires_po") ? 1 : 0,
              expiry_thresholds: fd.get("expiry_thresholds"),
            });
            toast("Configuracion actualizada", "ok");
            closeModal();
            load();
          });
        },
      }
    );
  }

  container.querySelector("#btn-new-client")?.addEventListener("click", () =>
    openCreateClientModal("", () => load(container.querySelector("#client-search").value))
  );
  container.querySelector("#client-search").addEventListener(
    "input",
    debounce((e) => load(e.target.value), 250)
  );
  await load();
}
