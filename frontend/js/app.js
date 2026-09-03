import { state, setSession, clearSession, hasPermission } from "./state.js";
import { api } from "./api.js";
import { addRoute, resolve, navigate, startRouter } from "./router.js";
import { esc, debounce, qs, qsa } from "./utils.js";

import { renderDashboard } from "./pages/dashboard.js";
import { renderClients } from "./pages/clients.js";
import { renderProducts } from "./pages/products.js";
import { renderWarehouseMap, renderRackDetail, renderLocationDetail } from "./pages/warehouse.js";
import { renderReceptionsList, renderReceptionDetail } from "./pages/receptions.js";
import { renderStock } from "./pages/stock.js";
import { renderDispatchesList, renderDispatchDetail } from "./pages/dispatches.js";
import { renderTraceability } from "./pages/traceability.js";
import { renderReports } from "./pages/reports.js";
import { renderUsers } from "./pages/users.js";
import { renderAudit } from "./pages/audit.js";
import { renderImporter } from "./pages/importer.js";
import { renderPhysicalInventoryList, renderPhysicalInventoryDetail } from "./pages/physical_inventory.js";
import { renderProductionToday } from "./pages/production/today.js";
import { renderActivitiesList, renderActivityDetail } from "./pages/production/activities.js";
import { renderProductionDashboard } from "./pages/production/dashboard.js";
import { renderProductionAnalytics } from "./pages/production/analytics.js";
import { renderProductionCatalogs } from "./pages/production/catalogs.js";

const NAV = [
  { section: "Operacion" },
  { path: "/dashboard", label: "Dashboard", icon: "&#9635;" },
  { path: "/recepciones", label: "Recepciones", icon: "&#8615;" },
  { path: "/despachos", label: "Despachos", icon: "&#8613;" },
  { path: "/almacen", label: "Mapa de almacen", icon: "&#8862;" },
  { path: "/stock", label: "Stock", icon: "&#128230;" },
  { path: "/trazabilidad", label: "Trazabilidad", icon: "&#8635;" },
  { path: "/inventario-fisico", label: "Inventario fisico", icon: "&#10003;" },
  { section: "Produccion / Maquila" },
  { path: "/produccion/hoy", label: "Produccion de hoy", icon: "&#9201;" },
  { path: "/produccion/actividades", label: "Actividades", icon: "&#128203;" },
  { path: "/produccion/dashboard", label: "Dashboard productividad", icon: "&#128200;" },
  { path: "/produccion/analitica", label: "Estandares y rankings", icon: "&#128300;" },
  { path: "/produccion/catalogos", label: "Operarios y mesas", icon: "&#128101;" },
  { section: "Datos maestros" },
  { path: "/clientes", label: "Clientes", icon: "&#128100;" },
  { path: "/productos", label: "Catalogo de productos", icon: "&#127991;" },
  { path: "/importar", label: "Importar Excel", icon: "&#8593;" },
  { section: "Analisis" },
  { path: "/reportes", label: "Reportes", icon: "&#128202;" },
  { path: "/auditoria", label: "Auditoria", icon: "&#128269;" },
  { section: "Administracion", adminOnly: true },
  { path: "/usuarios", label: "Usuarios", icon: "&#128100;", adminOnly: true },
];

function renderSidebar(activePath) {
  const sidebar = qs("#sidebar");
  const isAdmin = state.user?.role === "ADMIN";
  let html = `<div class="brand">CIANSE SAC<small>${esc(state.user?.role_name || "")}</small></div><nav>`;
  for (const item of NAV) {
    if (item.section) {
      if (item.adminOnly && !isAdmin) continue;
      html += `<div class="nav-section">${esc(item.section)}</div>`;
      continue;
    }
    if (item.adminOnly && !isAdmin) continue;
    const active = activePath.startsWith(item.path) ? "active" : "";
    html += `<a class="nav-link ${active}" href="#${item.path}"><span class="icon">${item.icon}</span>${esc(item.label)}</a>`;
  }
  html += `</nav><div class="user-box">
      <div><strong>${esc(state.user?.name || "")}</strong></div>
      <div class="role">${esc(state.user?.role_name || "")}</div>
      <div class="logout" id="btn-logout">Cerrar sesion</div>
    </div>`;
  sidebar.innerHTML = html;
  qs("#btn-logout").addEventListener("click", () => {
    clearSession();
    location.hash = "#/login";
    location.reload();
  });
}

function renderTopbar(title) {
  const topbar = qs("#topbar");
  topbar.innerHTML = `
    <div class="page-title">${esc(title)}</div>
    <div id="global-search">
      <span class="icon">&#128269;</span>
      <input id="search-input" placeholder="Buscar SKU, lote, cliente, guia, contenedor, ubicacion..." autocomplete="off" />
      <div id="search-results" class="hidden"></div>
    </div>`;
  const input = qs("#search-input");
  const resultsBox = qs("#search-results");
  const doSearch = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) {
      resultsBox.classList.add("hidden");
      return;
    }
    const { results } = await api.get("/search", { q: term });
    if (!results.length) {
      resultsBox.innerHTML = `<div class="sr-item muted">Sin resultados</div>`;
    } else {
      resultsBox.innerHTML = results
        .map((r) => `<div class="sr-item" data-url="${esc(r.url)}"><span class="sr-type">${esc(r.type)}</span>${esc(r.label)}</div>`)
        .join("");
    }
    resultsBox.classList.remove("hidden");
    qsa(".sr-item[data-url]", resultsBox).forEach((el) =>
      el.addEventListener("click", () => {
        resultsBox.classList.add("hidden");
        input.value = "";
        navigate(el.dataset.url);
      })
    );
  }, 250);
  input.addEventListener("input", doSearch);
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#global-search")) resultsBox.classList.add("hidden");
  });
}

export function layout(activePath, title) {
  renderSidebar(activePath);
  renderTopbar(title);
  return qs("#content");
}

function setupRoutes() {
  addRoute("/login", async () => showLogin());
  addRoute("/dashboard", async () => renderDashboard(layout("/dashboard", "Dashboard")));
  addRoute("/clientes", async () => renderClients(layout("/clientes", "Clientes")));
  addRoute("/productos", async () => renderProducts(layout("/productos", "Catalogo de productos")));
  addRoute("/almacen", async () => renderWarehouseMap(layout("/almacen", "Mapa de almacen")));
  addRoute("/almacen/rack/:id", async (p) => renderRackDetail(layout("/almacen", "Detalle de rack"), p.id));
  addRoute("/almacen/ubicacion/:id", async (p) => renderLocationDetail(layout("/almacen", "Detalle de ubicacion"), p.id));
  addRoute("/recepciones", async () => renderReceptionsList(layout("/recepciones", "Recepciones")));
  addRoute("/recepciones/:id", async (p) => renderReceptionDetail(layout("/recepciones", "Recepcion"), p.id));
  addRoute("/stock", async (p, q) => renderStock(layout("/stock", "Consulta de stock"), q));
  addRoute("/despachos", async () => renderDispatchesList(layout("/despachos", "Despachos")));
  addRoute("/despachos/:id", async (p) => renderDispatchDetail(layout("/despachos", "Despacho"), p.id));
  addRoute("/trazabilidad", async () => renderTraceability(layout("/trazabilidad", "Trazabilidad")));
  addRoute("/trazabilidad/:lotId", async (p) => renderTraceability(layout("/trazabilidad", "Trazabilidad"), p.lotId));
  addRoute("/reportes", async () => renderReports(layout("/reportes", "Reportes")));
  addRoute("/usuarios", async () => renderUsers(layout("/usuarios", "Usuarios y roles")));
  addRoute("/auditoria", async () => renderAudit(layout("/auditoria", "Historial de auditoria")));
  addRoute("/importar", async () => renderImporter(layout("/importar", "Importar desde Excel")));
  addRoute("/inventario-fisico", async () => renderPhysicalInventoryList(layout("/inventario-fisico", "Inventario fisico")));
  addRoute("/inventario-fisico/:id", async (p) => renderPhysicalInventoryDetail(layout("/inventario-fisico", "Conteo de inventario"), p.id));

  addRoute("/produccion/hoy", async (p, q) => renderProductionToday(layout("/produccion/hoy", "Produccion de hoy"), q));
  addRoute("/produccion/actividades", async () => renderActivitiesList(layout("/produccion/actividades", "Actividades de produccion")));
  addRoute("/produccion/actividades/:id", async (p) => renderActivityDetail(layout("/produccion/actividades", "Actividad de produccion"), p.id));
  addRoute("/produccion/dashboard", async () => renderProductionDashboard(layout("/produccion/dashboard", "Dashboard de productividad")));
  addRoute("/produccion/analitica", async () => renderProductionAnalytics(layout("/produccion/analitica", "Estandares, rankings y comparaciones")));
  addRoute("/produccion/catalogos", async () => renderProductionCatalogs(layout("/produccion/catalogos", "Operarios, mesas y tipos de operacion")));
}

function showLogin() {
  qs("#app-shell").classList.add("hidden");
  const el = qs("#login-screen");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="login-card">
      <h1>CIANSE SAC</h1>
      <p class="subtitle">Control de Almacen, Recepcion, Despacho y Produccion / Maquila</p>
      <form id="login-form">
        <div class="field"><label>Correo</label><input type="email" id="login-email" required value="admin@almacen.com" /></div>
        <div class="field"><label>Contrasena</label><input type="password" id="login-password" required value="admin123" /></div>
        <div class="error-text hidden" id="login-error"></div>
        <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;margin-top:6px">Ingresar</button>
      </form>
      <div class="demo-creds">
        <strong>Usuarios de demostracion</strong><br/>
        admin@almacen.com / admin123 (Administrador)<br/>
        supervisor@almacen.com / super123 (Supervisor)
      </div>
    </div>`;
  qs("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = qs("#login-email").value;
    const password = qs("#login-password").value;
    const errBox = qs("#login-error");
    errBox.classList.add("hidden");
    try {
      const { token, user } = await api.post("/auth/login", { email, password });
      setSession(token, user);
      el.classList.add("hidden");
      qs("#app-shell").classList.remove("hidden");
      navigate("/dashboard");
      resolve();
    } catch (err) {
      errBox.textContent = err.message || "No se pudo iniciar sesion";
      errBox.classList.remove("hidden");
    }
  });
}

async function boot() {
  setupRoutes();
  startRouter();
  if (!state.token) {
    showLogin();
    return;
  }
  try {
    await api.get("/auth/me");
  } catch {
    showLogin();
    return;
  }
  qs("#login-screen").classList.add("hidden");
  qs("#app-shell").classList.remove("hidden");
  await resolve();
}

boot();
