/*
 * Selectores reutilizables "buscar + crear nuevo" para Cliente y Producto.
 *
 * Regla de todo el sistema: el catalogo AYUDA pero NUNCA bloquea. Por eso
 * estos componentes siempre ofrecen una salida para crear el registro que
 * falta, sin salir del formulario donde se esta trabajando.
 */
import { api } from "../api.js";
import { esc, showModal, closeModal, toast, debounce } from "../utils.js";

let uidCounter = 0;
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

// =============================== CLIENTE ======================================
export function clientPickerHTML({ name = "client_id", label = "Cliente", initialId = "", initialLabel = "", required = true } = {}) {
  const id = uid("cp");
  return `
    <div class="field picker" data-picker-root="${id}">
      <label>${esc(label)}</label>
      <input type="hidden" name="${name}" value="${esc(initialId)}" data-picker-value />
      <div class="picker-box">
        <input type="text" class="picker-input" data-picker-input placeholder="Buscar por nombre, codigo o RUC..."
               autocomplete="off" value="${esc(initialLabel)}" ${required ? "required" : ""} />
        <div class="picker-results hidden" data-picker-results></div>
      </div>
    </div>`;
}

export function mountClientPicker(root, { id, onSelect } = {}) {
  const pickerRoot = id ? root.querySelector(`[data-picker-root="${id}"]`) : root.querySelector("[data-picker-root]");
  const hidden = pickerRoot.querySelector("[data-picker-value]");
  const input = pickerRoot.querySelector("[data-picker-input]");
  const results = pickerRoot.querySelector("[data-picker-results]");

  function renderResults(clients, term) {
    const rows = clients
      .map(
        (c) => `<div class="picker-item" data-id="${c.id}" data-label="${esc(c.name)}">
          <div><strong>${esc(c.name)}</strong> <span class="muted">(${esc(c.code)})</span></div>
          ${c.tax_id ? `<div class="muted" style="font-size:11px">RUC ${esc(c.tax_id)}</div>` : ""}
        </div>`
      )
      .join("");
    results.innerHTML =
      rows +
      `<div class="picker-item picker-item-create" data-create="1">
        <strong>&#65291; Nuevo cliente</strong>${term ? ` — crear "${esc(term)}"` : ""}
      </div>`;
    results.classList.remove("hidden");
    results.querySelectorAll("[data-id]").forEach((el) =>
      el.addEventListener("click", () => {
        hidden.value = el.dataset.id;
        input.value = el.dataset.label;
        results.classList.add("hidden");
        onSelect?.({ id: el.dataset.id, name: el.dataset.label });
      })
    );
    results.querySelector("[data-create]").addEventListener("click", () => openCreateClientModal(term, (client) => {
      hidden.value = client.id;
      input.value = client.name;
      results.classList.add("hidden");
      onSelect?.(client);
    }));
  }

  const doSearch = debounce(async () => {
    const term = input.value.trim();
    const clients = await api.get("/clients", { q: term });
    renderResults(clients.slice(0, 12), term);
  }, 220);

  input.addEventListener("input", () => {
    hidden.value = "";
    doSearch();
  });
  input.addEventListener("focus", doSearch);
  document.addEventListener("click", (e) => {
    if (!pickerRoot.contains(e.target)) results.classList.add("hidden");
  });

  return {
    getValue: () => hidden.value,
    setValue: (client) => {
      hidden.value = client.id;
      input.value = client.name;
    },
  };
}

export function openCreateClientModal(initialName, onCreated) {
  showModal(
    `<h3>＋ Nuevo cliente</h3>
    <p class="hint">Solo el nombre es obligatorio. El codigo se genera automaticamente si no escribe uno.</p>
    <form id="f-new-client">
      <div class="field"><label>Nombre / razon social</label><input name="name" required value="${esc(initialName || "")}" /></div>
      <div class="form-grid">
        <div class="field"><label>Codigo (opcional)</label><input name="code" placeholder="Auto" /></div>
        <div class="field"><label>RUC (opcional)</label><input name="tax_id" /></div>
      </div>
      <div class="field"><label>Contacto (opcional)</label><input name="contact" placeholder="Nombre y/o telefono" /></div>
      <div class="error-text hidden" id="new-client-err"></div>
      <button class="btn btn-primary" type="submit">Crear cliente</button>
    </form>`,
    {
      onMount: (root) => {
        root.querySelector("#f-new-client").addEventListener("submit", async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(e.target).entries());
          try {
            const res = await api.post("/clients", payload);
            if (res.warning) {
              payload.confirm_duplicate = 1;
              const res2 = await api.post("/clients", payload);
              toast("Cliente creado", "ok");
              closeModal();
              onCreated({ id: res2.id, name: payload.name });
              return;
            }
            toast("Cliente creado", "ok");
            closeModal();
            onCreated({ id: res.id, name: payload.name });
          } catch (err) {
            root.querySelector("#new-client-err").textContent = err.message;
            root.querySelector("#new-client-err").classList.remove("hidden");
          }
        });
      },
    }
  );
}

// =============================== PRODUCTO ======================================
/**
 * Selector de producto con dos modos explicitos: EXISTENTE (buscar) y NUEVO
 * (SKU manual). El caller obtiene el product_id final llamando a
 * resolveProductId() en el submit del formulario (puede crear el producto en
 * ese momento si el modo NUEVO esta activo).
 */
export function productPickerHTML({ clientId = "", clientLabel = "", label = "Producto", required = true, allowNew = true } = {}) {
  const id = uid("pp");
  return `
    <div class="field picker" data-product-picker="${id}">
      <label>${esc(label)}</label>
      ${
        allowNew
          ? `<div class="tabs" style="margin-bottom:8px">
        <div class="tab-btn active" data-tab="existing">Producto existente</div>
        <div class="tab-btn" data-tab="new">＋ Producto nuevo</div>
      </div>`
          : ""
      }

      <div data-tab-panel="existing">
        <input type="hidden" data-existing-value />
        <div class="picker-box">
          <input type="text" class="picker-input" data-existing-input placeholder="Buscar por SKU, nombre o descripcion..." autocomplete="off" ${required ? "required" : ""} />
          <div class="picker-results hidden" data-existing-results></div>
        </div>
        <div class="hint" data-existing-summary></div>
      </div>

      ${
        allowNew
          ? `<div data-tab-panel="new" class="hidden">
        <div class="hint" style="margin-bottom:8px">El SKU lo escribe usted: no se genera automaticamente para productos nuevos.</div>
        <div class="field">
          <label>Que estamos ingresando?</label>
          <div class="item-type-toggle">
            <label class="item-type-opt"><input type="radio" name="_new_item_type_${id}" data-new-item-type value="PRODUCTO" checked /><span class="item-type-text"><span>📦 Producto</span><small>Va a stock del cliente, para despachar</small></span></label>
            <label class="item-type-opt"><input type="radio" name="_new_item_type_${id}" data-new-item-type value="MATERIAL" /><span class="item-type-text"><span>🧰 Material / Empaque</span><small>Cajas, displays, insumos para produccion</small></span></label>
          </div>
        </div>
        <div class="form-grid">
          <div class="field"><label>SKU</label><input data-new-sku placeholder="Ej: PEPSI-NEW-001" /></div>
          <div class="field"><label>Categoria</label><input data-new-category /></div>
        </div>
        <div class="field"><label>Nombre / descripcion</label><input data-new-description /></div>
        <div class="form-grid">
          <div class="field"><label>Presentacion</label><input data-new-presentation placeholder="Ej: Pack x6" /></div>
          <div class="field"><label>Unidad de medida</label>
            <input data-new-uom list="uom-presets-${id}" value="CAJA" placeholder="Elija o escriba la suya" />
            <datalist id="uom-presets-${id}">
              <option value="CAJA"></option><option value="PAQUETE"></option><option value="UND"></option>
              <option value="SACO"></option><option value="BOLSA"></option><option value="KG"></option>
              <option value="LT"></option><option value="BALDE"></option><option value="ROLLO"></option>
            </datalist>
          </div>
        </div>
        <div class="field"><label data-uom-word-label>Unidades por caja/paquete</label>
          <input data-new-units-per-case type="number" step="any" min="0" placeholder="Ej: 12" />
          <div class="hint" style="margin-top:2px">Cuantas unidades trae cada caja/paquete — se usa para calcular el total automaticamente al recibir mercaderia.</div>
        </div>
        <div class="field"><label>Observaciones</label><input data-new-observations /></div>
        <div class="field ${clientId ? "hidden" : ""}" data-new-client-field>
          <label>Cliente del producto nuevo</label>
          ${clientPickerHTML({ name: "_new_product_client_id", initialId: clientId, initialLabel: clientLabel, required: false })}
        </div>
      </div>`
          : ""
      }
    </div>`;
}

export function mountProductPicker(root, { fixedClientId = null, onChange = null } = {}) {
  const pickerRoot = root.querySelector("[data-product-picker]");
  const tabs = pickerRoot.querySelectorAll(".tab-btn");
  const panels = pickerRoot.querySelectorAll("[data-tab-panel]");
  const uomInput = pickerRoot.querySelector("[data-new-uom]");
  const upcInput = pickerRoot.querySelector("[data-new-units-per-case]");
  const uomLabel = pickerRoot.querySelector("[data-uom-word-label]");
  const existingHidden = pickerRoot.querySelector("[data-existing-value]");
  const existingInput = pickerRoot.querySelector("[data-existing-input]");
  const existingResults = pickerRoot.querySelector("[data-existing-results]");
  const existingSummary = pickerRoot.querySelector("[data-existing-summary]");
  let selectedProduct = null; // declarado arriba de todo: getContext() lo lee y se usa desde el primer refreshUomLabel()

  // Palabra usada en el catalogo (ej. "CAJA") -> como se lee en un rotulo
  // (ej. "Unidades por caja"). Cubre los presets comunes; para cualquier otra
  // UOM cae a algo generico y legible igual.
  const UOM_WORDS = { CAJA: "caja", PAQUETE: "paquete", SACO: "saco", BOLSA: "bolsa", BALDE: "balde", ROLLO: "rollo", UND: "unidad", KG: "kilo", LT: "litro" };
  function wordFor(uom) {
    const key = (uom || "").trim().toUpperCase();
    return UOM_WORDS[key] || (key ? key.toLowerCase() : "caja/paquete");
  }
  function refreshUomLabel() {
    if (uomLabel) uomLabel.textContent = `Unidades por ${wordFor(uomInput.value)}`;
    onChange?.(getContext());
  }
  uomInput?.addEventListener("input", refreshUomLabel);
  upcInput?.addEventListener("input", () => onChange?.(getContext()));
  refreshUomLabel();

  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      panels.forEach((p) => p.classList.toggle("hidden", p.dataset.tabPanel !== tab.dataset.tab));
      onChange?.(getContext());
    })
  );

  const doSearch = debounce(async () => {
    const term = existingInput.value.trim();
    if (term.length < 1) {
      existingResults.classList.add("hidden");
      return;
    }
    const products = await api.get("/products", { q: term, client_id: fixedClientId || undefined });
    existingResults.innerHTML = products.length
      ? products
          .slice(0, 12)
          .map(
            (p) => `<div class="picker-item" data-id="${p.id}">
              <div>${p.item_type === "MATERIAL" ? '<span class="badge badge-warn" style="margin-right:5px">🧰 Material</span>' : ""}<span class="mono">${esc(p.sku_code)}</span> — <strong>${esc(p.description)}</strong></div>
              <div class="muted" style="font-size:11px">${esc(p.client_name)} · ${esc(p.unit_of_measure)}${p.presentation ? " · " + esc(p.presentation) : ""}${p.units_per_case ? ` · ${p.units_per_case} und/${wordFor(p.unit_of_measure)}` : ""}</div>
            </div>`
          )
          .join("")
      : `<div class="picker-item muted">Sin coincidencias. Use la pestana "＋ Producto nuevo".</div>`;
    existingResults.classList.remove("hidden");
    existingResults.querySelectorAll("[data-id]").forEach((el) =>
      el.addEventListener("click", () => {
        const p = products.find((x) => x.id == el.dataset.id);
        selectedProduct = p;
        existingHidden.value = p.id;
        existingInput.value = `${p.sku_code} — ${p.description}`;
        existingSummary.innerHTML = `${p.item_type === "MATERIAL" ? '<span class="badge badge-warn">🧰 Material</span> · ' : ""}Cliente: ${esc(p.client_name)} · Unidad: ${esc(p.unit_of_measure)}${p.presentation ? " · Presentacion: " + esc(p.presentation) : ""}${!p.units_per_case ? ` · <span style="color:var(--warn)">sin unidades/${wordFor(p.unit_of_measure)} definidas</span>` : ""}`;
        existingResults.classList.add("hidden");
        onChange?.(getContext());
      })
    );
  }, 220);
  existingInput.addEventListener("input", () => {
    existingHidden.value = "";
    selectedProduct = null;
    doSearch();
    onChange?.(getContext());
  });
  existingInput.addEventListener("focus", doSearch);
  document.addEventListener("click", (e) => {
    if (!pickerRoot.contains(e.target)) existingResults.classList.add("hidden");
  });

  let newClientPicker = null;
  if (!fixedClientId) {
    newClientPicker = mountClientPicker(pickerRoot.querySelector("[data-new-client-field]"));
  }

  /** Unidad de medida y unidades-por-caja "vigentes" en el formulario ahora
   * mismo, sea que se eligio un producto existente o se esta creando uno
   * nuevo -- para que el modal que use este picker pueda calcular totales
   * en vivo sin importar el modo. */
  function getContext() {
    const newTab = pickerRoot.querySelector('.tab-btn[data-tab="new"]');
    const isNew = newTab ? newTab.classList.contains("active") : false;
    if (isNew) {
      return {
        unitOfMeasure: uomInput?.value.trim() || "CAJA",
        unitsPerCase: parseFloat(upcInput?.value) || null,
        itemType: pickerRoot.querySelector("[data-new-item-type]:checked")?.value || "PRODUCTO",
      };
    }
    return {
      unitOfMeasure: selectedProduct?.unit_of_measure || "CAJA",
      unitsPerCase: selectedProduct?.units_per_case || null,
      itemType: selectedProduct?.item_type || "PRODUCTO",
      productId: selectedProduct?.id || null,
      product: selectedProduct || null,
    };
  }

  return {
    isNewMode: () => {
      const newTab = pickerRoot.querySelector('.tab-btn[data-tab="new"]');
      return newTab ? newTab.classList.contains("active") : false;
    },
    getExistingId: () => existingHidden.value,
    getContext,
    /** Devuelve {product_id} resolviendo (y creando si hace falta) el producto elegido. */
    async resolveProductId() {
      const isNew = this.isNewMode();
      if (!isNew) {
        if (!existingHidden.value) throw new Error("Seleccione un producto existente o cree uno nuevo");
        return parseInt(existingHidden.value);
      }
      const sku = pickerRoot.querySelector("[data-new-sku]").value.trim();
      const description = pickerRoot.querySelector("[data-new-description]").value.trim();
      const clientId = fixedClientId || newClientPicker?.getValue();
      if (!sku || !description) throw new Error("SKU y nombre son obligatorios para un producto nuevo");
      if (!clientId) throw new Error("Seleccione el cliente del producto nuevo");
      const payload = {
        sku_code: sku,
        description,
        client_id: clientId,
        category: pickerRoot.querySelector("[data-new-category]").value.trim(),
        presentation: pickerRoot.querySelector("[data-new-presentation]").value.trim(),
        unit_of_measure: uomInput.value.trim() || "CAJA",
        units_per_case: parseFloat(upcInput.value) || null,
        observations: pickerRoot.querySelector("[data-new-observations]").value.trim(),
        item_type: pickerRoot.querySelector("[data-new-item-type]:checked")?.value || "PRODUCTO",
      };
      const res = await api.post("/products", payload);
      if (res.warning) {
        toast(res.warning, "info");
        return res.existing_id;
      }
      toast(`${payload.item_type === "MATERIAL" ? "Material" : "Producto"} ${sku} creado en el catalogo`, "ok");
      return res.id;
    },
  };
}

// =============================== SELECTOR FLEXIBLE GENERICO ===================
/**
 * Para catalogos "de apoyo" (tipo de operacion, mesa/grupo, producto en el
 * modulo de produccion): el usuario escribe libremente. Si lo que escribe
 * coincide con algo del catalogo se vincula por id; si no, se guarda como
 * texto libre y el catalogo NUNCA bloquea el registro.
 */
export function flexiblePickerHTML({ label, placeholder = "" } = {}) {
  const id = uid("fx");
  return `
    <div class="field picker" data-flex-picker="${id}">
      <label>${esc(label)}</label>
      <div class="picker-box">
        <input type="text" class="picker-input" data-flex-input placeholder="${esc(placeholder)}" autocomplete="off" />
        <div class="picker-results hidden" data-flex-results></div>
      </div>
    </div>`;
}

/**
 * `pickerRootEl` is the specific `[data-flex-picker]` element to mount on
 * (use `root.querySelectorAll("[data-flex-picker]")[n]` when a form has more
 * than one, in DOM order).
 */
export function mountFlexiblePicker(pickerRootEl, { fetchOptions, minChars = 0 } = {}) {
  const pickerRoot = pickerRootEl;
  const input = pickerRoot.querySelector("[data-flex-input]");
  const results = pickerRoot.querySelector("[data-flex-results]");
  let selected = null; // {id, label}

  const doSearch = debounce(async () => {
    const term = input.value.trim();
    if (term.length < minChars) {
      results.classList.add("hidden");
      return;
    }
    const options = await fetchOptions(term);
    results.innerHTML = options.length
      ? options.map((o) => `<div class="picker-item" data-id="${o.id}" data-label="${esc(o.label)}">${esc(o.label)}</div>`).join("")
      : `<div class="picker-item muted">Sin coincidencias — se usara el texto tal como lo escribio.</div>`;
    results.classList.remove("hidden");
    results.querySelectorAll("[data-id]").forEach((el) =>
      el.addEventListener("click", () => {
        selected = { id: el.dataset.id, label: el.dataset.label };
        input.value = el.dataset.label;
        results.classList.add("hidden");
      })
    );
  }, 200);

  input.addEventListener("input", () => {
    selected = null;
    doSearch();
  });
  input.addEventListener("focus", doSearch);
  document.addEventListener("click", (e) => {
    if (!pickerRoot.contains(e.target)) results.classList.add("hidden");
  });

  return {
    getId: () => (selected && selected.label === input.value.trim() ? selected.id : null),
    getFreeText: () => input.value.trim(),
    setValue: (opt) => {
      selected = opt;
      input.value = opt.label;
    },
  };
}

// =============================== OPERARIOS (multi) =============================
/** Selector de multiples operarios con chips + creacion rapida de operario nuevo. */
export function operatorMultiPickerHTML({ label = "Operarios participantes" } = {}) {
  const id = uid("opm");
  return `
    <div class="field picker" data-opm-picker="${id}">
      <label>${esc(label)}</label>
      <div class="picker-box">
        <input type="text" class="picker-input" data-opm-input placeholder="Buscar operario por nombre o codigo..." autocomplete="off" />
        <div class="picker-results hidden" data-opm-results></div>
      </div>
      <div class="tag-row" data-opm-chips style="margin-top:8px"></div>
    </div>`;
}

export function mountOperatorMultiPicker(root, { initial = [] } = {}) {
  const pickerRoot = root.querySelector("[data-opm-picker]");
  const input = pickerRoot.querySelector("[data-opm-input]");
  const results = pickerRoot.querySelector("[data-opm-results]");
  const chips = pickerRoot.querySelector("[data-opm-chips]");
  const selected = new Map(initial.map((o) => [String(o.id), o.name]));

  function renderChips() {
    chips.innerHTML = [...selected.entries()]
      .map(([id, name]) => `<span class="badge badge-info" data-remove="${id}" style="cursor:pointer">${esc(name)} &times;</span>`)
      .join("") || `<span class="muted" style="font-size:12px">Sin operarios agregados todavia</span>`;
    chips.querySelectorAll("[data-remove]").forEach((el) =>
      el.addEventListener("click", () => {
        selected.delete(el.dataset.remove);
        renderChips();
      })
    );
  }
  renderChips();

  const doSearch = debounce(async () => {
    const term = input.value.trim();
    const ops = await api.get("/operators", { q: term, active_only: 1 });
    const filtered = ops.filter((o) => !selected.has(String(o.id)));
    results.innerHTML =
      filtered.map((o) => `<div class="picker-item" data-id="${o.id}" data-name="${esc(o.name)}">${esc(o.name)} <span class="muted">(${esc(o.code)})</span></div>`).join("") +
      `<div class="picker-item picker-item-create" data-create="1"><strong>&#65291; Nuevo operario</strong>${term ? ` — crear "${esc(term)}"` : ""}</div>`;
    results.classList.remove("hidden");
    results.querySelectorAll("[data-id]").forEach((el) =>
      el.addEventListener("click", () => {
        selected.set(el.dataset.id, el.dataset.name);
        input.value = "";
        results.classList.add("hidden");
        renderChips();
      })
    );
    results.querySelector("[data-create]").addEventListener("click", async () => {
      const name = term || prompt("Nombre del operario nuevo:");
      if (!name) return;
      const res = await api.post("/operators", { name });
      selected.set(String(res.id), name);
      input.value = "";
      results.classList.add("hidden");
      renderChips();
      toast(`Operario "${name}" registrado (${res.code})`, "ok");
    });
  }, 200);
  input.addEventListener("input", doSearch);
  input.addEventListener("focus", doSearch);
  document.addEventListener("click", (e) => {
    if (!pickerRoot.contains(e.target)) results.classList.add("hidden");
  });

  return { getSelectedIds: () => [...selected.keys()].map(Number), getSelectedEntries: () => [...selected.entries()] };
}
