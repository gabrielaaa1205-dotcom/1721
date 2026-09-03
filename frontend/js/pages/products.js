import { api } from "../api.js";
import { table, esc, showModal, closeModal, toast, debounce, fmtNum } from "../utils.js";
import { hasPermission } from "../state.js";
import { navigate } from "../router.js";
import { productPickerHTML, mountProductPicker } from "../components/pickers.js";

export async function renderProducts(container) {
  const [clients, categories] = await Promise.all([api.get("/clients"), api.get("/products/categories")]);
  container.innerHTML = `
    <div class="toolbar">
      <input id="product-search" placeholder="Buscar por SKU, descripcion u observaciones..." style="max-width:280px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <select id="client-filter" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los clientes</option>
        ${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
      </select>
      <select id="category-filter" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todas las categorias</option>
        ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <select id="item-type-filter" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Productos y materiales</option>
        <option value="PRODUCTO">📦 Solo productos</option>
        <option value="MATERIAL">🧰 Solo materiales/empaques</option>
      </select>
      <div class="spacer"></div>
      ${hasPermission("create", "edit") ? `<button class="btn btn-primary" id="btn-new-product">＋ Nuevo producto</button>` : ""}
    </div>
    <div class="hint" style="margin-bottom:10px">Esta pantalla es para <strong>ver y editar</strong> todo el catalogo (todos los clientes juntos), corregir datos o marcar un producto inactivo. Para <strong>registrar</strong> un producto o material nuevo, hagalo directo desde la recepcion donde va a entrar — ahi tambien puede crearlo sin salir del formulario.</div>
    <div class="card"><div id="products-table"></div></div>
  `;

  async function load() {
    const q = container.querySelector("#product-search").value;
    const client_id = container.querySelector("#client-filter").value;
    const category = container.querySelector("#category-filter").value;
    const item_type = container.querySelector("#item-type-filter").value;
    const rows = await api.get("/products", { q, client_id, category, item_type });
    container.querySelector("#products-table").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Descripcion", render: (r) => `${r.item_type === "MATERIAL" ? '<span class="badge badge-warn" style="margin-right:5px">🧰 Material</span>' : ""}${r.component_count ? '<span class="badge badge-info" style="margin-right:5px">🎁 Combo</span>' : ""}${esc(r.description)}` },
        { label: "Cliente", key: "client_name" },
        { label: "Categoria", render: (r) => esc(r.category || "—") },
        { label: "Presentacion", render: (r) => esc(r.presentation || "—") },
        { label: "UM", key: "unit_of_measure" },
        { label: "Und/caja", render: (r) => fmtNum(r.units_per_case) },
        {
          label: "",
          render: (r) => `<button class="btn btn-sm" data-stock="${r.id}">Stock</button> ${hasPermission("create", "edit") ? `<button class="btn btn-sm" data-combo="${r.id}">${r.component_count ? "🎁 Combo" : "＋ Combo"}</button> <button class="btn btn-sm" data-edit="${r.id}">Editar</button>` : ""}`,
        },
      ],
      rows,
      { emptyText: "No hay productos. Cree uno o importe el Excel historico." }
    );
    container.querySelectorAll("[data-stock]").forEach((btn) =>
      btn.addEventListener("click", () => navigate(`/stock?product_id=${btn.dataset.stock}`))
    );
    container.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => openEditModal(rows.find((r) => r.id == btn.dataset.edit)))
    );
    container.querySelectorAll("[data-combo]").forEach((btn) =>
      btn.addEventListener("click", () => openComponentsModal(rows.find((r) => r.id == btn.dataset.combo)))
    );
  }

  function itemTypeToggleHTML(current = "PRODUCTO") {
    return `
      <div class="field">
        <label>Que es?</label>
        <div class="item-type-toggle">
          <label class="item-type-opt"><input type="radio" name="item_type" value="PRODUCTO" ${current !== "MATERIAL" ? "checked" : ""} /><span class="item-type-text"><span>📦 Producto</span><small>Va a stock del cliente, para despachar</small></span></label>
          <label class="item-type-opt"><input type="radio" name="item_type" value="MATERIAL" ${current === "MATERIAL" ? "checked" : ""} /><span class="item-type-text"><span>🧰 Material / Empaque</span><small>Cajas, displays, insumos para produccion</small></span></label>
        </div>
      </div>`;
  }

  const UOM_SINGULAR = { CAJA: "caja", PAQUETE: "paquete", SACO: "saco", BOLSA: "bolsa", BALDE: "balde", ROLLO: "rollo", UND: "unidad", KG: "kilo", LT: "litro" };
  function singularFor(uom) {
    const key = (uom || "").trim().toUpperCase();
    return UOM_SINGULAR[key] || (key ? key.toLowerCase() : "caja");
  }

  function productFieldsHTML(p = {}) {
    return `
      <div class="form-grid">
        <div class="field"><label>Categoria</label><input name="category" value="${esc(p.category || "")}" /></div>
        <div class="field"><label>Presentacion</label><input name="presentation" value="${esc(p.presentation || "")}" placeholder="Ej: Pack x6" /></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Unidad de medida</label>
          <select name="unit_of_measure" data-uom-select>
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
        <div class="field"><label data-upc-label>Unidades por caja</label><input name="units_per_case" type="number" step="any" min="0" value="${p.units_per_case ?? ""}" placeholder="Ej: 12" /></div>
      </div>
      <div class="hint">"Unidades por caja/bolsa/paquete" es cuantas unidades trae cada una — se usa despues para calcular el total automaticamente al recibir mercaderia de este producto.</div>
      <div class="field"><label>Observaciones</label><input name="observations" value="${esc(p.observations || "")}" /></div>`;
  }

  /** Engancha el cambio de UOM para que la etiqueta "Unidades por X" se
   * actualice sola (caja/bolsa/paquete/etc), y deja el select en el valor
   * ya guardado del producto si se esta editando. */
  function mountUomLabel(root, initialUom) {
    const select = root.querySelector("[data-uom-select]");
    const label = root.querySelector("[data-upc-label]");
    if (initialUom) select.value = initialUom.toUpperCase();
    function refresh() {
      label.textContent = `Unidades por ${singularFor(select.value)}`;
    }
    select.addEventListener("change", refresh);
    refresh();
  }

  function openNewModal() {
    showModal(
      `<h3>＋ Nuevo producto</h3>
      <form id="new-product-form">
        ${itemTypeToggleHTML()}
        <div class="field"><label>Cliente</label>
          <select name="client_id" required>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        </div>
        <div class="form-grid">
          <div class="field"><label>Codigo SKU (usted lo define)</label><input name="sku_code" required placeholder="Ej: PEPSI-NEW-001" /></div>
          <div class="field"><label>Descripcion</label><input name="description" required /></div>
        </div>
        ${productFieldsHTML()}
        <button class="btn btn-primary" type="submit">Crear producto</button>
      </form>`,
      {
        onMount: (root) => {
          mountUomLabel(root, "CAJA");
          root.querySelector("#new-product-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const payload = Object.fromEntries(fd.entries());
            try {
              const res = await api.post("/products", payload);
              closeModal();
              if (res.warning) {
                toast(res.warning, "info");
                load();
                return;
              }
              toast("Producto creado en el catalogo", "ok");
              await load();
              askIfCombo(res.id, payload.sku_code, payload.description);
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }

  /** Justo despues de crear un producto, preguntar si es un combo/pack armado
   * de otros productos -- para no depender de que el usuario recuerde volver
   * despues a definirlo con el boton "🎁 Combo". */
  function askIfCombo(productId, sku, description) {
    showModal(
      `<h3>¿Este producto es un combo o pack?</h3>
      <p class="muted">${esc(sku)} — ${esc(description)}</p>
      <p class="hint">Un combo/pack (ej. "Pack Milo + Leche") se arma de OTROS productos que ya tiene en stock — no tiene stock propio, se descuentan sus componentes al despacharlo.</p>
      <div class="toolbar" style="margin-top:14px">
        <button class="btn btn-primary" id="btn-yes-combo">🎁 Si, definir sus componentes ahora</button>
        <button class="btn" id="btn-no-combo">No, es un producto normal</button>
      </div>`,
      {
        onMount: (root) => {
          root.querySelector("#btn-no-combo").addEventListener("click", () => closeModal());
          root.querySelector("#btn-yes-combo").addEventListener("click", async () => {
            closeModal();
            const product = await api.get(`/products/${productId}`);
            openComponentsModal(product);
          });
        },
      }
    );
  }

  function openEditModal(product) {
    showModal(
      `<h3>Editar producto</h3>
      <p class="muted"><span class="mono">${esc(product.sku_code)}</span> · ${esc(product.client_name)}</p>
      <form id="edit-product-form">
        ${itemTypeToggleHTML(product.item_type)}
        <div class="field"><label>Descripcion</label><input name="description" required value="${esc(product.description)}" /></div>
        ${productFieldsHTML(product)}
        <div class="field"><label><input type="checkbox" name="active" ${product.active ? "checked" : ""} style="width:auto;margin-right:6px" />Producto activo</label></div>
        <button class="btn btn-primary" type="submit">Guardar cambios</button>
      </form>`,
      {
        onMount: (root) => {
          mountUomLabel(root, product.unit_of_measure);
          root.querySelector("#edit-product-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const payload = Object.fromEntries(fd.entries());
            payload.active = fd.get("active") ? 1 : 0;
            try {
              await api.put(`/products/${product.id}`, payload);
              toast("Producto actualizado", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }

  container.querySelector("#btn-new-product")?.addEventListener("click", openNewModal);
  container.querySelector("#product-search").addEventListener("input", debounce(load, 250));
  container.querySelector("#client-filter").addEventListener("change", load);
  container.querySelector("#category-filter").addEventListener("change", load);
  container.querySelector("#item-type-filter").addEventListener("change", load);
  await load();

  /** Combo/Kit (Bill of Materials): este producto no tiene stock propio, se
   * arma de otros productos. Al despacharlo, el sistema descuenta cada
   * componente en la cantidad indicada, no el combo en si. */
  async function openComponentsModal(product) {
    const components = await api.get(`/products/${product.id}/components`);
    let rows = components.map((c) => ({ ...c }));

    function renderRows(root) {
      root.querySelector("#combo-rows").innerHTML = rows.length
        ? rows
            .map(
              (c, i) => `
          <div class="simple-bar-row" style="align-items:center">
            <span class="mono" style="flex:1">${esc(c.sku_code)} — ${esc(c.description)}</span>
            <input type="number" step="any" min="0" value="${c.qty_per_kit}" data-qty="${i}" style="width:80px;padding:5px 7px;border:1px solid var(--line);border-radius:6px" />
            <span class="muted" style="font-size:11.5px;width:60px">${esc(c.unit_of_measure)}</span>
            <button type="button" class="btn btn-sm btn-danger" data-remove="${i}">✕</button>
          </div>`
            )
            .join("")
        : `<div class="hint">Sin componentes todavia. Busque y agregue los productos que forman este combo.</div>`;
      root.querySelectorAll("[data-qty]").forEach((el) =>
        el.addEventListener("input", () => { rows[parseInt(el.dataset.qty)].qty_per_kit = parseFloat(el.value) || 0; })
      );
      root.querySelectorAll("[data-remove]").forEach((el) =>
        el.addEventListener("click", () => { rows.splice(parseInt(el.dataset.remove), 1); renderRows(root); })
      );
    }

    showModal(
      `<h3>🎁 Componentes del combo</h3>
      <p class="muted"><span class="mono">${esc(product.sku_code)}</span> — ${esc(product.description)}</p>
      <p class="hint">Al despachar este producto, el sistema descontara estos componentes (no el combo en si). Ej: 1 combo "Pack Milo+Leche" = 2 Milo + 1 Leche.</p>
      <div id="combo-rows" style="margin-bottom:14px"></div>
      ${productPickerHTML({ clientId: product.client_id, label: "Agregar componente", required: false, allowNew: false })}
      <div class="form-grid" style="margin-top:6px">
        <div class="field"><label>Cantidad por combo</label><input id="add-qty" type="number" step="any" min="0" value="1" /></div>
        <div class="field" style="display:flex;align-items:flex-end"><button type="button" class="btn" id="btn-add-component" style="width:100%">＋ Agregar al combo</button></div>
      </div>
      <button class="btn btn-primary" id="btn-save-combo" style="margin-top:14px">Guardar componentes</button>`,
      {
        onMount: (root) => {
          renderRows(root);
          const picker = mountProductPicker(root, { fixedClientId: product.client_id });
          root.querySelector("#btn-add-component").addEventListener("click", async () => {
            let pid;
            try {
              pid = await picker.resolveProductId();
            } catch (err) {
              toast(err.message, "error");
              return;
            }
            if (pid == product.id) {
              toast("Un combo no puede contener a si mismo", "error");
              return;
            }
            if (rows.some((r) => r.component_product_id == pid)) {
              toast("Ese producto ya esta en la lista", "info");
              return;
            }
            const p = await api.get(`/products/${pid}`);
            const qty = parseFloat(root.querySelector("#add-qty").value) || 1;
            rows.push({ component_product_id: pid, qty_per_kit: qty, sku_code: p.sku_code, description: p.description, unit_of_measure: p.unit_of_measure });
            renderRows(root);
          });
          root.querySelector("#btn-save-combo").addEventListener("click", async () => {
            try {
              await api.put(`/products/${product.id}/components`, {
                components: rows.map((r) => ({ component_product_id: r.component_product_id, qty_per_kit: r.qty_per_kit })),
              });
              toast(rows.length ? "Combo guardado" : "Ya no es un combo (vuelve a ser producto normal)", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          });
        },
      }
    );
  }
}
