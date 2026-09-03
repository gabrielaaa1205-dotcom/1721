import { api } from "../../api.js";
import { table, esc, fmtNum, fmtDate, fmtDateTime, badge, showModal, closeModal, toast, debounce } from "../../utils.js";
import { navigate } from "../../router.js";
import { hasPermission } from "../../state.js";
import {
  clientPickerHTML, mountClientPicker,
  flexiblePickerHTML, mountFlexiblePicker,
  operatorMultiPickerHTML, mountOperatorMultiPicker,
} from "../../components/pickers.js";

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

function statusBadge(status) {
  const map = { EN_CURSO: ["info", "En curso"], FINALIZADA: ["ok", "Finalizada"], CANCELADA: ["bad", "Cancelada"] };
  const [color, label] = map[status] || ["grey", status];
  return `<span class="badge badge-${color}">${label}</span>`;
}

export async function renderActivitiesList(container) {
  const [clients, operationTypes, workGroups] = await Promise.all([api.get("/clients"), api.get("/operation-types"), api.get("/work-groups")]);
  let offset = 0;
  const limit = 25;

  container.innerHTML = `
    <div class="toolbar">
      <input id="q" placeholder="Buscar OT o descripcion..." style="max-width:220px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      <select id="f-client" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los clientes</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
      </select>
      <select id="f-optype" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Toda operacion</option>${operationTypes.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}
      </select>
      <select id="f-status" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Todos los estados</option><option value="EN_CURSO">En curso</option><option value="FINALIZADA">Finalizada</option><option value="CANCELADA">Cancelada</option>
      </select>
      <div class="spacer"></div>
      ${hasPermission("create", "create_reception") ? `<button class="btn btn-primary" id="btn-new">＋ Nueva actividad</button>` : ""}
    </div>
    <div class="toolbar">
      <select id="f-preset" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        ${DATE_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}
      </select>
      <input type="date" id="f-from" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px" title="Desde" />
      <input type="date" id="f-to" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px" title="Hasta" />
      <select id="f-group" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px">
        <option value="">Toda mesa/grupo</option>${workGroups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}
      </select>
    </div>
    <div class="card">
      <div id="tbl"></div>
      <div class="toolbar" style="margin-top:10px;margin-bottom:0">
        <span class="muted" id="pg-info"></span><div class="spacer"></div>
        <button class="btn btn-sm" id="pg-prev">&larr; Anterior</button>
        <button class="btn btn-sm" id="pg-next">Siguiente &rarr;</button>
      </div>
    </div>`;

  function filters() {
    const preset = container.querySelector("#f-preset").value;
    return {
      q: container.querySelector("#q").value,
      client_id: container.querySelector("#f-client").value,
      operation_type_id: container.querySelector("#f-optype").value,
      status: container.querySelector("#f-status").value,
      work_group_id: container.querySelector("#f-group").value,
      preset,
      date_from: preset ? undefined : container.querySelector("#f-from").value,
      date_to: preset ? undefined : container.querySelector("#f-to").value,
      limit, offset,
    };
  }

  async function load() {
    const res = await api.get("/production/activities", filters());
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "Fecha", render: (r) => fmtDate(r.activity_date) },
        { label: "Horario", render: (r) => `${esc(r.start_time)}–${esc(r.end_time || "?")}` },
        { label: "Cliente", key: "client_name" },
        { label: "Operacion", key: "operation_label" },
        { label: "Mesa/Grupo", render: (r) => esc(r.work_group_label || "—") },
        { label: "Operarios", key: "operator_count" },
        { label: "Producido", render: (r) => fmtNum(r.qty_produced) },
        { label: "Packs/hora-hombre", render: (r) => (r.metrics.packs_per_man_hour ?? "—") },
        { label: "Estado", render: (r) => statusBadge(r.status) },
      ],
      res.rows,
      { rowAttrs: (r) => `class="row-link" data-id="${r.id}"`, emptyText: "No hay actividades que coincidan con los filtros" }
    );
    container.querySelectorAll("[data-id]").forEach((tr) => tr.addEventListener("click", () => navigate(`/produccion/actividades/${tr.dataset.id}`)));
    const from = res.total ? offset + 1 : 0;
    const to = Math.min(offset + limit, res.total);
    container.querySelector("#pg-info").textContent = `${from}-${to} de ${res.total}`;
    container.querySelector("#pg-prev").disabled = offset === 0;
    container.querySelector("#pg-next").disabled = to >= res.total;
  }
  function reload() { offset = 0; load(); }

  container.querySelector("#btn-new")?.addEventListener("click", () => openNewActivityModal(reload));
  ["q", "f-client", "f-optype", "f-status", "f-group"].forEach((id) => {
    const el = container.querySelector(`#${id}`);
    el.addEventListener(id === "q" ? "input" : "change", id === "q" ? debounce(reload, 250) : reload);
  });
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

// =============================== NUEVA ACTIVIDAD ================================
export function openNewActivityModal(onDone, defaults = {}) {
  showModal(
    `<h3>＋ Nueva actividad de produccion</h3>
    <form id="f">
      <div class="form-grid">
        <div class="field"><label>Fecha</label><input type="date" name="activity_date" required value="${defaults.date || new Date().toISOString().slice(0, 10)}" /></div>
        <div class="field"><label>Orden de trabajo (OT)</label><input name="work_order" /></div>
      </div>
      ${clientPickerHTML({ label: "Cliente" })}
      ${flexiblePickerHTML({ label: "Producto (opcional)", placeholder: "Buscar producto o escribir libremente, ej: Milo + vaso" })}
      ${flexiblePickerHTML({ label: "Tipo de operacion", placeholder: "Ej: Promocion, Empaquetado..." })}
      <div class="field"><label>Descripcion del trabajo</label><input name="description" /></div>
      <div class="form-grid">
        <div class="field"><label>Hora de inicio</label><input type="time" name="start_time" required /></div>
        <div class="field"><label>Hora de finalizacion</label><input type="time" name="end_time" /></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Cantidad producida</label><input name="qty_produced" type="number" step="any" value="0" required /></div>
        <div class="field"><label>Cantidad buena</label><input name="qty_good" type="number" step="any" value="0" /></div>
        <div class="field"><label>Cantidad defectuosa</label><input name="qty_defective" type="number" step="any" value="0" /></div>
      </div>
      ${operatorMultiPickerHTML({ label: "Operarios participantes" })}
      ${flexiblePickerHTML({ label: "Mesa / Linea / Grupo (opcional)", placeholder: "Ej: Mesa 1, Linea 2..." })}
      ${flexiblePickerHTML({ label: "Supervisor (opcional)", placeholder: "Buscar usuario o escribir nombre" })}
      <div class="field"><label>Observaciones</label><input name="notes" /></div>
      <div id="overlap-warn"></div>
      <button class="btn btn-primary" type="submit">Registrar actividad</button>
    </form>`,
    {
      wide: true,
      onMount: (root) => {
        const pickers = root.querySelectorAll("[data-flex-picker]");
        mountClientPicker(root);
        // Mount each flexible picker against the correct data source, in DOM order:
        // 1) Producto  2) Tipo de operacion  3) Mesa/Grupo  4) Supervisor
        const fp1 = mountFlexiblePicker(pickers[0], {
          fetchOptions: (term) => api.get("/products", { q: term }).then((rows) => rows.map((p) => ({ id: p.id, label: `${p.sku_code} — ${p.description}` }))),
        });
        const fp2 = mountFlexiblePicker(pickers[1], {
          fetchOptions: (term) => api.get("/operation-types", { active_only: 1 }).then((rows) => rows.filter((o) => !term || o.name.toLowerCase().includes(term.toLowerCase())).map((o) => ({ id: o.id, label: o.name }))),
        });
        const fp3 = mountFlexiblePicker(pickers[2], {
          fetchOptions: (term) => api.get("/work-groups", { active_only: 1 }).then((rows) => rows.filter((g) => !term || g.name.toLowerCase().includes(term.toLowerCase())).map((g) => ({ id: g.id, label: g.name }))),
        });
        const fp4 = mountFlexiblePicker(pickers[3], {
          fetchOptions: (term) => api.get("/users/basic").then((rows) => rows.filter((u) => !term || u.name.toLowerCase().includes(term.toLowerCase())).map((u) => ({ id: u.id, label: u.name }))),
        });
        const opPicker = mountOperatorMultiPicker(root);

        root.querySelector("#f").addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = {
            activity_date: fd.get("activity_date"), work_order: fd.get("work_order"),
            client_id: fd.get("client_id"),
            product_id: fp1.getId(), product_free_text: fp1.getId() ? null : fp1.getFreeText() || null,
            operation_type_id: fp2.getId(), operation_type_free_text: fp2.getId() ? null : fp2.getFreeText() || null,
            description: fd.get("description"), start_time: fd.get("start_time"), end_time: fd.get("end_time") || null,
            qty_produced: fd.get("qty_produced"), qty_good: fd.get("qty_good"), qty_defective: fd.get("qty_defective"),
            work_group_id: fp3.getId(), work_group_free_text: fp3.getId() ? null : fp3.getFreeText() || null,
            supervisor_user_id: fp4.getId(), supervisor_free_text: fp4.getId() ? null : fp4.getFreeText() || null,
            notes: fd.get("notes"),
            operator_ids: opPicker.getSelectedIds(),
          };
          if (!payload.client_id) { toast("Seleccione o cree un cliente", "error"); return; }
          try {
            const res = await api.post("/production/activities", payload);
            if (res.overlap_warnings?.length) {
              toast(`Actividad creada con ${res.overlap_warnings.length} alerta(s) de solapamiento`, "info");
            } else {
              toast("Actividad registrada", "ok");
            }
            closeModal();
            if (defaults.noNavigate) onDone?.();
            else navigate(`/produccion/actividades/${res.id}`);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    }
  );
}

// =============================== DETALLE DE ACTIVIDAD ===========================
export async function renderActivityDetail(container, id) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const a = await api.get(`/production/activities/${id}`);

  container.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h3 style="margin-bottom:2px">${esc(a.operation_label)} ${statusBadge(a.status)}</h3>
          <div class="muted">${esc(a.client_name)} · ${fmtDate(a.activity_date)} · ${esc(a.start_time)}–${esc(a.end_time || "en curso")}${a.work_order ? " · OT " + esc(a.work_order) : ""}</div>
        </div>
        <div class="spacer"></div>
        <div id="status-actions"></div>
      </div>
      ${a.overlap_warnings.length ? `<div class="alert-list" style="margin-top:12px">${a.overlap_warnings.map((w) => `<div class="alert-row bad">${esc(w.message)}</div>`).join("")}</div>` : ""}
      <div class="form-grid" style="margin-top:12px;font-size:13px">
        <div><span class="muted">Producto:</span> ${esc(a.product_label || "—")}</div>
        <div><span class="muted">Mesa/Grupo:</span> ${esc(a.work_group_label || "—")}</div>
        <div><span class="muted">Supervisor:</span> ${esc(a.supervisor_label || "—")}</div>
        <div><span class="muted">Registrado por:</span> ${esc(a.created_by_name || "—")}</div>
        <div><span class="muted">Descripcion:</span> ${esc(a.description || "—")}</div>
        <div><span class="muted">Observaciones:</span> ${esc(a.notes || "—")}</div>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card accent-ok"><div class="kpi-label">Produccion</div><div class="kpi-value">${fmtNum(a.qty_produced)}</div><div class="kpi-sub">Buenas: ${fmtNum(a.qty_good)} · Defectuosas: ${fmtNum(a.qty_defective)}</div></div>
      <div class="kpi-card accent-info"><div class="kpi-label">Horas-hombre</div><div class="kpi-value">${a.metrics.man_hours ?? "—"}</div><div class="kpi-sub">${a.metrics.hours ?? "—"}h × ${a.operator_count} operarios</div></div>
      <div class="kpi-card accent-info"><div class="kpi-label">Productividad</div><div class="kpi-value">${a.metrics.packs_per_man_hour ?? "—"}</div><div class="kpi-sub">packs / hora-hombre</div></div>
      <div class="kpi-card ${a.efficiency_pct != null && a.efficiency_pct < 70 ? "accent-bad" : "accent-ok"}"><div class="kpi-label">Eficiencia vs estandar</div><div class="kpi-value">${a.efficiency_pct != null ? a.efficiency_pct + "%" : "—"}</div>
        <div class="kpi-sub">${a.standard.reliable ? `Estandar: ${a.standard.avg} packs/hora-hombre (n=${a.standard.n})` : "Sin estandar confiable aun (pocos registros historicos)"}</div></div>
      <div class="kpi-card ${a.metrics.quality_pct != null && a.metrics.quality_pct < 95 ? "accent-warn" : "accent-ok"}"><div class="kpi-label">Calidad</div><div class="kpi-value">${a.metrics.quality_pct ?? "—"}%</div><div class="kpi-sub">Defectos: ${a.metrics.defect_pct ?? "—"}%</div></div>
    </div>

    <div class="card">
      <div class="toolbar"><h3 style="margin:0">Operarios participantes (${a.participants.length})</h3><div class="spacer"></div>
        ${hasPermission("create", "create_reception") && a.status !== "CANCELADA" ? `<button class="btn btn-sm btn-primary" id="btn-add-op">＋ Agregar operarios</button>` : ""}
      </div>
      <div id="participants-table"></div>
    </div>

    <div class="tabs">
      <div class="tab-btn active" data-tab="edit">Editar</div>
      <div class="tab-btn" data-tab="history">Historial</div>
    </div>
    <div data-panel="edit" class="card">
      <p class="hint">Puede corregir cantidades, horarios o clasificacion en cualquier momento; los cambios quedan en el historial.</p>
      <button class="btn btn-sm" id="btn-edit">Editar actividad</button>
    </div>
    <div data-panel="history" class="card hidden">
      <div id="history-timeline"></div>
    </div>
  `;

  container.querySelector("#status-actions").innerHTML =
    (hasPermission("create", "approve", "create_reception") && a.status === "EN_CURSO"
      ? `<button class="btn btn-sm btn-primary" data-status="FINALIZADA">Finalizar</button> <button class="btn btn-sm btn-danger" data-status="CANCELADA">Cancelar</button>`
      : "");
  container.querySelectorAll("[data-status]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api.put(`/production/activities/${id}/status`, { status: btn.dataset.status });
        toast("Estado actualizado", "ok");
        renderActivityDetail(container, id);
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );

  container.querySelector("#participants-table").innerHTML = table(
    [
      { label: "Codigo", render: (p) => `<span class="mono">${esc(p.code)}</span>` },
      { label: "Nombre", key: "name" },
      { label: "", render: (p) => (hasPermission("create", "create_reception") && a.status !== "CANCELADA" ? `<button class="btn btn-sm btn-danger" data-remove-op="${p.operator_id}">Quitar</button>` : "") },
    ],
    a.participants,
    { emptyText: "Sin operarios asignados todavia" }
  );
  container.querySelectorAll("[data-remove-op]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api.del(`/production/activities/${id}/participants/${btn.dataset.removeOp}`);
      toast("Operario removido", "ok");
      renderActivityDetail(container, id);
    })
  );
  container.querySelector("#btn-add-op")?.addEventListener("click", () => {
    showModal(
      `<h3>Agregar operarios</h3>${operatorMultiPickerHTML({ label: "Operarios a agregar" })}<button class="btn btn-primary" id="btn-confirm-add" style="margin-top:12px">Agregar a la actividad</button>`,
      {
        onMount: (root) => {
          const picker = mountOperatorMultiPicker(root);
          root.querySelector("#btn-confirm-add").addEventListener("click", async () => {
            const ids = picker.getSelectedIds();
            if (!ids.length) { toast("Seleccione al menos un operario", "error"); return; }
            const res = await api.post(`/production/activities/${id}/participants`, { operator_ids: ids });
            if (res.overlap_warnings?.length) toast(`Agregado con ${res.overlap_warnings.length} alerta(s) de solapamiento`, "info");
            else toast("Operarios agregados", "ok");
            closeModal();
            renderActivityDetail(container, id);
          });
        },
      }
    );
  });

  container.querySelector("#btn-edit").addEventListener("click", () => openEditActivityModal(a, () => renderActivityDetail(container, id)));

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
    const events = await api.get(`/production/activities/${id}/history`);
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
}

function openEditActivityModal(a, onDone) {
  showModal(
    `<h3>Editar actividad</h3>
    <form id="f">
      <div class="form-grid">
        <div class="field"><label>Fecha</label><input type="date" name="activity_date" required value="${a.activity_date}" /></div>
        <div class="field"><label>Orden de trabajo</label><input name="work_order" value="${esc(a.work_order || "")}" /></div>
      </div>
      <div class="field"><label>Descripcion</label><input name="description" value="${esc(a.description || "")}" /></div>
      <div class="form-grid">
        <div class="field"><label>Hora de inicio</label><input type="time" name="start_time" required value="${a.start_time}" /></div>
        <div class="field"><label>Hora de finalizacion</label><input type="time" name="end_time" value="${a.end_time || ""}" /></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Cantidad producida</label><input name="qty_produced" type="number" step="any" value="${a.qty_produced}" required /></div>
        <div class="field"><label>Cantidad buena</label><input name="qty_good" type="number" step="any" value="${a.qty_good}" /></div>
        <div class="field"><label>Cantidad defectuosa</label><input name="qty_defective" type="number" step="any" value="${a.qty_defective}" /></div>
      </div>
      <div class="field"><label>Observaciones</label><input name="notes" value="${esc(a.notes || "")}" /></div>
      <div class="field"><label>Motivo del cambio (opcional, queda en el historial)</label><input name="reason" /></div>
      <button class="btn btn-primary" type="submit">Guardar cambios</button>
    </form>`,
    {
      onMount: (root) =>
        root.querySelector("#f").addEventListener("submit", async (e) => {
          e.preventDefault();
          const payload = Object.fromEntries(new FormData(e.target).entries());
          try {
            const res = await api.put(`/production/activities/${a.id}`, payload);
            if (res.overlap_warnings?.length) toast(`Guardado con ${res.overlap_warnings.length} alerta(s) de solapamiento`, "info");
            else toast("Actividad actualizada", "ok");
            closeModal();
            onDone?.();
          } catch (err) {
            toast(err.message, "error");
          }
        }),
    }
  );
}
