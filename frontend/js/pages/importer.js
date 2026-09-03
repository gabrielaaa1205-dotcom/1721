import { api } from "../api.js";
import { esc, fmtNum, table, toast } from "../utils.js";
import { state } from "../state.js";

export async function renderImporter(container) {
  const batches = await api.get("/import/batches");
  container.innerHTML = `
    <div class="card">
      <h3>Importar Excel historico (CRP / CDP)</h3>
      <p class="muted">Suba el archivo de Control de Recepcion (CRP) o Control de Despacho (CDP). El sistema detecta las hojas,
        normaliza el nombre de cliente, valida cada fila y muestra un resumen antes de escribir nada en la base de datos.</p>
      <form id="upload-form">
        <div class="form-grid">
          <div class="field"><label>Tipo de archivo</label>
            <select name="batch_type"><option value="CRP">CRP — Control de Recepcion</option><option value="CDP">CDP — Control de Despacho</option></select>
          </div>
          <div class="field"><label>Archivo (.xlsx o .xlsb)</label><input type="file" name="file" accept=".xlsx,.xlsb" required /></div>
        </div>
        <button class="btn btn-primary" type="submit">1. Validar archivo</button>
      </form>
      <div id="validation-result"></div>
    </div>
    <div class="card">
      <h3>Historial de importaciones</h3>
      <div id="batches-table"></div>
    </div>
  `;

  container.querySelector("#batches-table").innerHTML = table(
    [
      { label: "Archivo", key: "source_file" },
      { label: "Tipo", key: "batch_type" },
      { label: "Fecha", render: (r) => (r.imported_at || "").slice(0, 16) },
      { label: "Usuario", render: (r) => esc(r.imported_by_name || "—") },
      { label: "Validos", key: "valid_count" },
      { label: "Advertencias", key: "warning_count" },
      { label: "Errores", key: "error_count" },
      { label: "Duplicados", key: "duplicate_count" },
    ],
    batches,
    { emptyText: "Aun no se ha importado ningun archivo" }
  );

  container.querySelector("#upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const resultBox = container.querySelector("#validation-result");
    resultBox.innerHTML = `<div class="empty-state">Analizando archivo...</div>`;
    try {
      const res = await api.upload("/import/validate", fd);
      renderValidationResult(res, fd.get("batch_type"));
    } catch (err) {
      resultBox.innerHTML = `<div class="error-text">${esc(err.message)}</div>`;
    }
  });

  function renderValidationResult(res, batchType) {
    const resultBox = container.querySelector("#validation-result");
    const s = res.summary;
    resultBox.innerHTML = `
      <div class="kpi-grid" style="margin-top:16px">
        <div class="kpi-card accent-ok"><div class="kpi-label">Validos</div><div class="kpi-value">${fmtNum(s.valid)}</div></div>
        <div class="kpi-card accent-warn"><div class="kpi-label">Advertencias</div><div class="kpi-value">${fmtNum(s.warning)}</div></div>
        <div class="kpi-card accent-bad"><div class="kpi-label">Errores (no se importan)</div><div class="kpi-value">${fmtNum(s.error)}</div></div>
        <div class="kpi-card"><div class="kpi-label">Duplicados</div><div class="kpi-value">${fmtNum(s.duplicate)}</div></div>
      </div>
      <h4>Vista previa (primeras ${res.preview.length} de ${res.total_rows} filas)</h4>
      ${table(
        [
          { label: "Hoja", key: "sheet" },
          { label: "Estado", render: (r) => `<span class="badge badge-${r.status === "valid" ? "ok" : r.status === "warning" ? "warn" : r.status === "error" ? "bad" : "grey"}">${r.status}</span>` },
          { label: "Cliente", render: (r) => esc(r.client_name || "—") },
          { label: "SKU", render: (r) => esc(r.sku || "—") },
          { label: "Descripcion", render: (r) => esc((r.description || "").slice(0, 40)) },
          { label: "Lote", render: (r) => esc(r.lot_code || "—") },
          { label: "Fecha", render: (r) => esc(r.date || "—") },
          { label: "Mensajes", render: (r) => esc(r.messages.join(" · ")) },
        ],
        res.preview
      )}
      ${s.error > 0 ? `<p class="hint">Las filas con error NO se importaran. Las filas duplicadas se omiten automaticamente.</p>` : ""}
      <button class="btn btn-primary" id="btn-confirm">2. Confirmar e importar ${fmtNum(s.valid + s.warning)} filas</button>
    `;
    resultBox.querySelector("#btn-confirm").addEventListener("click", async () => {
      try {
        const result = await api.post("/import/confirm", { token: res.token });
        toast(`Importacion completa: ${result.headers_created} documentos, ${result.items_created} lineas`, "ok");
        renderImporter(container);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
}
