export function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString("es-PE", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

export function fmtDate(d) {
  if (!d) return "—";
  const s = String(d);
  const datePart = s.slice(0, 10);
  const [y, m, day] = datePart.split("-");
  if (!y || !m || !day) return s;
  return `${day}/${m}/${y}`;
}

export function fmtDateTime(d) {
  if (!d) return "—";
  const dt = toLimaDate(d);
  if (!dt) return String(d).replace("T", " ").slice(0, 16);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCDate())}/${pad(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

/** Solo la hora (HH:MM), ya convertida a hora de Lima (UTC-5, Peru no tiene
 * horario de verano) -- para usar junto a una fecha que ya se muestra aparte. */
export function fmtTimeLima(d) {
  if (!d) return "—";
  const dt = toLimaDate(d);
  if (!dt) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

/** SQLite guarda created_at con datetime('now') = hora UTC, sin indicarlo
 * explicitamente en el texto ("YYYY-MM-DD HH:MM:SS"). Esta funcion lo
 * interpreta como UTC y le resta 5 horas (Lima, Peru = UTC-5 todo el ano),
 * devolviendo un Date cuyos metodos getUTC* ya dan la hora local de Lima. */
function toLimaDate(d) {
  const s = String(d).trim();
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const parsed = new Date(withZone);
  if (isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() - 5 * 60 * 60 * 1000);
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr.slice(0, 10));
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((target - today) / 86400000);
}

const STATUS_MAP = {
  // recepcion / despacho
  PENDIENTE: ["grey", "Pendiente"],
  EN_PROCESO: ["info", "En proceso"],
  OBSERVADO: ["warn", "Observado"],
  COMPLETADO: ["ok", "Completado"],
  BLOQUEADO: ["bad", "Bloqueado"],
  CANCELADO: ["bad", "Cancelado"],
  RESERVADO: ["info", "Reservado"],
  EN_PICKING: ["info", "En picking"],
  VERIFICADO: ["info", "Verificado"],
  DESPACHADO: ["ok", "Despachado"],
  CERRADO: ["ok", "Cerrado"],
  // calidad / stock
  DISPONIBLE: ["ok", "Disponible"],
  CUARENTENA: ["warn", "Cuarentena"],
  RECHAZADO: ["bad", "Rechazado"],
  DANADO: ["bad", "Danado"],
  UBICADO: ["ok", "Ubicado"],
  // ubicacion
  OCUPADA: ["info", "Ocupada"],
  MANTENIMIENTO: ["warn", "Mantenimiento"],
  // picking
  EN_PICKING2: ["info", "En picking"],
  PICKEADO: ["ok", "Pickeado"],
  DIFERENCIA: ["warn", "Diferencia"],
  NO_ENCONTRADO: ["bad", "No encontrado"],
  // reservas
  ACTIVA: ["info", "Activa"],
  CONSUMIDA: ["grey", "Consumida"],
  LIBERADA: ["grey", "Liberada"],
  ABIERTO: ["info", "Abierto"],
  CONTADO: ["warn", "Contado"],
  APROBADO: ["ok", "Aprobado"],
};

export function badge(status, labelOverride) {
  const [color, label] = STATUS_MAP[status] || ["grey", status || "—"];
  return `<span class="badge badge-${color}">${esc(labelOverride || label)}</span>`;
}

export function toast(msg, type = "info") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// Pila de modales: cada showModal() apila una capa nueva encima en vez de
// reemplazar el contenido anterior, para que un modal pueda abrir otro
// (por ejemplo "+ Nuevo cliente" dentro de "Nueva actividad") sin perder lo
// que el usuario ya habia llenado en el primero. closeModal() cierra solo la
// capa de encima.
const _modalStack = [];

export function showModal(innerHtml, { wide = false, onMount } = {}) {
  const root = document.getElementById("modal-root");
  root.classList.remove("hidden");
  const layer = document.createElement("div");
  layer.className = "modal-layer";
  layer.innerHTML = `
    <div class="modal-backdrop" data-close-modal></div>
    <div class="modal-box ${wide ? "modal-wide" : ""}">
      <span class="modal-close" data-close-modal>&times;</span>
      ${innerHtml}
    </div>`;
  root.appendChild(layer);
  _modalStack.push(layer);
  layer.querySelectorAll("[data-close-modal]").forEach((el) => el.addEventListener("click", closeModal));
  if (onMount) onMount(layer);
}

export function closeModal() {
  const root = document.getElementById("modal-root");
  const layer = _modalStack.pop();
  if (layer) layer.remove();
  if (_modalStack.length === 0) {
    root.classList.add("hidden");
    root.innerHTML = "";
  }
}

export function table(columns, rows, { rowAttrs, emptyText = "Sin registros" } = {}) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state">${esc(emptyText)}</div>`;
  }
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const attrs = rowAttrs ? rowAttrs(row) : "";
      const cells = columns.map((c) => `<td>${c.render ? c.render(row) : esc(row[c.key] ?? "—")}</td>`).join("");
      return `<tr ${attrs}>${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function simpleBar(label, value, max, color = "#2f5597") {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<div class="simple-bar-row">
    <div class="simple-bar-label">${esc(label)}</div>
    <div class="simple-bar-track"><div class="simple-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="simple-bar-value">${fmtNum(value)}</div>
  </div>`;
}
