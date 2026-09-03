import { api } from "../api.js";
import { esc, toast } from "../utils.js";

const REPORTS = [
  { key: "receptions-daily", label: "Recepcion diaria", hasDate: true },
  { key: "dispatches-daily", label: "Despacho diario", hasDate: true },
  { key: "stock-by-client", label: "Stock por cliente" },
  { key: "stock-by-product", label: "Stock por producto" },
  { key: "stock-by-lot", label: "Stock por lote" },
  { key: "stock-by-location", label: "Stock por ubicacion" },
  { key: "expirations", label: "Vencimientos" },
  { key: "defects", label: "Productos defectuosos" },
  { key: "movements", label: "Movimientos de inventario" },
  { key: "occupancy", label: "Ocupacion de almacen" },
];

export async function renderReports(container) {
  container.innerHTML = `
    <div class="card">
      <h3>Reportes disponibles</h3>
      <p class="muted">Descargue cualquier reporte en Excel (.xlsx) con un clic.</p>
      <div class="rack-grid">
        ${REPORTS.map(
          (r) => `<div class="rack-tile" data-report="${r.key}" data-hasdate="${r.hasDate ? 1 : 0}">
            <div class="rack-code">${esc(r.label)}</div>
            <div class="muted" style="font-size:11.5px;margin-top:4px">Descargar .xlsx &#8595;</div>
          </div>`
        ).join("")}
      </div>
    </div>
  `;
  container.querySelectorAll("[data-report]").forEach((tile) =>
    tile.addEventListener("click", async () => {
      const key = tile.dataset.report;
      const params = {};
      if (tile.dataset.hasdate === "1") {
        params.date = new Date().toISOString().slice(0, 10);
      }
      try {
        await api.downloadXlsx(`/reports/${key}`, params, `${key}.xlsx`);
        toast("Reporte descargado", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
}
