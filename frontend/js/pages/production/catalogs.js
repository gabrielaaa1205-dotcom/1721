import { api } from "../../api.js";
import { table, esc, showModal, closeModal, toast, debounce } from "../../utils.js";
import { hasPermission } from "../../state.js";

const TABS = [
  { key: "operators", label: "Operarios" },
  { key: "groups", label: "Mesas / Lineas / Grupos" },
  { key: "optypes", label: "Tipos de operacion" },
];

export async function renderProductionCatalogs(container) {
  container.innerHTML = `
    <div class="hint" style="margin-bottom:14px">Estos catalogos ayudan a completar formularios mas rapido, pero nunca son obligatorios: en cualquier actividad de produccion se puede escribir un valor nuevo directamente.</div>
    <div class="tabs">${TABS.map((t, i) => `<div class="tab-btn ${i === 0 ? "active" : ""}" data-tab="${t.key}">${t.label}</div>`).join("")}</div>
    <div id="tab-content"></div>`;
  const content = container.querySelector("#tab-content");
  const renderers = { operators: renderOperators, groups: renderGroups, optypes: renderOpTypes };
  function activate(key) {
    container.querySelectorAll(".tab-btn").forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
    renderers[key](content);
  }
  container.querySelectorAll(".tab-btn").forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab)));
  activate("operators");
}

async function renderOperators(content) {
  content.innerHTML = `
    <div class="toolbar">
      <input id="op-search" placeholder="Buscar operario..." style="max-width:240px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <div class="spacer"></div>
      ${hasPermission("create", "create_reception") ? `<button class="btn btn-primary btn-sm" id="btn-new-op">＋ Nuevo operario</button>` : ""}
    </div>
    <div class="card"><div id="op-table"></div></div>`;
  async function load(q = "") {
    const rows = await api.get("/operators", { q });
    content.querySelector("#op-table").innerHTML = table(
      [
        { label: "Codigo", render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { label: "Nombre", key: "name" },
        { label: "Estado", render: (r) => (r.active ? `<span class="badge badge-ok">Activo</span>` : `<span class="badge badge-grey">Inactivo</span>`) },
        { label: "", render: (r) => (hasPermission("create", "edit") ? `<button class="btn btn-sm" data-toggle="${r.id}" data-active="${r.active}">${r.active ? "Desactivar" : "Activar"}</button>` : "") },
      ],
      rows,
      { emptyText: "Sin operarios registrados. Se pueden crear aqui o al vuelo desde una actividad de produccion." }
    );
    content.querySelectorAll("[data-toggle]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api.put(`/operators/${btn.dataset.toggle}`, { active: btn.dataset.active === "1" ? 0 : 1 });
        load(content.querySelector("#op-search").value);
      })
    );
  }
  content.querySelector("#op-search").addEventListener("input", debounce((e) => load(e.target.value), 250));
  content.querySelector("#btn-new-op")?.addEventListener("click", () =>
    showModal(
      `<h3>＋ Nuevo operario</h3><form id="f">
        <div class="field"><label>Nombre completo</label><input name="name" required /></div>
        <div class="field"><label>Codigo (opcional)</label><input name="code" placeholder="Auto" /></div>
        <div class="field"><label>Documento de identidad (opcional)</label><input name="document_id" /></div>
        <button class="btn btn-primary" type="submit">Crear</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(new FormData(e.target).entries());
            try {
              await api.post("/operators", payload);
              toast("Operario registrado", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          }),
      }
    )
  );
  await load();
}

async function renderGroups(content) {
  content.innerHTML = `
    <div class="toolbar">
      <div class="spacer"></div>
      ${hasPermission("create", "create_reception") ? `<button class="btn btn-primary btn-sm" id="btn-new-group">＋ Nueva mesa/linea/grupo</button>` : ""}
    </div>
    <div class="card"><div id="group-table"></div></div>`;
  async function load() {
    const rows = await api.get("/work-groups");
    content.querySelector("#group-table").innerHTML = table(
      [
        { label: "Codigo", render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { label: "Nombre", key: "name" },
        { label: "Tipo", key: "group_type" },
        { label: "Estado", render: (r) => (r.active ? `<span class="badge badge-ok">Activo</span>` : `<span class="badge badge-grey">Inactivo</span>`) },
      ],
      rows,
      { emptyText: "Sin mesas/grupos registrados. Tambien se pueden crear al vuelo desde una actividad." }
    );
  }
  content.querySelector("#btn-new-group")?.addEventListener("click", () =>
    showModal(
      `<h3>＋ Nueva mesa / linea / grupo</h3><form id="f">
        <div class="field"><label>Nombre</label><input name="name" required placeholder="Ej: Mesa 4" /></div>
        <div class="field"><label>Tipo</label><select name="group_type"><option value="MESA">Mesa</option><option value="LINEA">Linea</option><option value="GRUPO">Grupo</option></select></div>
        <button class="btn btn-primary" type="submit">Crear</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(new FormData(e.target).entries());
            try {
              await api.post("/work-groups", payload);
              toast("Grupo registrado", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          }),
      }
    )
  );
  await load();
}

async function renderOpTypes(content) {
  content.innerHTML = `
    <div class="toolbar">
      <div class="spacer"></div>
      ${hasPermission("create", "create_reception") ? `<button class="btn btn-primary btn-sm" id="btn-new-optype">＋ Nuevo tipo de operacion</button>` : ""}
    </div>
    <div class="card"><div id="optype-table"></div></div>`;
  async function load() {
    const rows = await api.get("/operation-types");
    content.querySelector("#optype-table").innerHTML = table(
      [
        { label: "Codigo", render: (r) => `<span class="mono">${esc(r.code)}</span>` },
        { label: "Nombre", key: "name" },
        { label: "Estado", render: (r) => (r.active ? `<span class="badge badge-ok">Activo</span>` : `<span class="badge badge-grey">Inactivo</span>`) },
      ],
      rows,
      { emptyText: "Sin tipos de operacion registrados." }
    );
  }
  content.querySelector("#btn-new-optype")?.addEventListener("click", () =>
    showModal(
      `<h3>＋ Nuevo tipo de operacion</h3><form id="f">
        <div class="field"><label>Nombre</label><input name="name" required placeholder="Ej: Sellado" /></div>
        <button class="btn btn-primary" type="submit">Crear</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(new FormData(e.target).entries());
            try {
              await api.post("/operation-types", payload);
              toast("Tipo de operacion registrado", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          }),
      }
    )
  );
  await load();
}
