import { api } from "../api.js";
import { esc, fmtNum, badge, table, debounce } from "../utils.js";
import { navigate } from "../router.js";

function occClass(pct) {
  if (pct >= 85) return "high";
  if (pct >= 50) return "mid";
  return "";
}

function occColor(pct) {
  if (pct >= 85) return "var(--bad)";
  if (pct >= 50) return "var(--warn)";
  return "var(--ok)";
}

// Resumen global (KPI) de una zona: total, ocupadas, libres, % de ocupacion.
function renderZoneSummary(racks) {
  const total = racks.reduce((s, r) => s + r.total_positions, 0);
  const occ = racks.reduce((s, r) => s + r.occupied_positions, 0);
  const pct = total ? Math.round((occ / total) * 1000) / 10 : 0;
  return `
    <div class="zone-summary">
      <div class="zs-item"><div class="zs-num">${total}</div><div class="zs-label">Posiciones totales</div></div>
      <div class="zs-item"><div class="zs-num" style="color:${occColor(pct)}">${occ}</div><div class="zs-label">Ocupadas</div></div>
      <div class="zs-item"><div class="zs-num" style="color:var(--ok)">${total - occ}</div><div class="zs-label">Libres</div></div>
      <div class="zs-item"><div class="zs-num" style="color:${occColor(pct)}">${pct}%</div><div class="zs-label">Ocupacion global</div></div>
    </div>`;
}

// Dibuja el plano real del almacen en SVG: todos los racks son barras
// verticales de la MISMA altura, en una sola fila (sin division de mitad
// arriba/mitad abajo). Los racks que van "pegados" (tight_after=1, forman
// pareja con el anterior) se dibujan sin espacio entre ellos; el resto lleva
// el espacio de pasillo normal. Si la zona tiene una posicion marcada como
// "Patio de Despacho" (sin racks), se dibuja un bloque ancho y punteado ahi.
function renderFloorPlan(racks, zoneKey, patioGridCol) {
  if (!racks.some((r) => r.grid_col)) return ""; // fallback: zona sin layout de plano definido
  const patId = `fp-grid-${zoneKey}`;

  const MARGIN = 10, LABEL_H = 22, COL_W = 130, GAP = 16, TIGHT_GAP = 2, ROW_H = 300, PATIO_W = COL_W * 2.4;
  const topY = MARGIN + LABEL_H;

  // Posiciones ordenadas de izquierda a derecha: racks + el hueco del patio
  // intercalado en su lugar real (por grid_col).
  const items = [...racks.map((r) => ({ type: "rack", ...r }))];
  if (patioGridCol) items.push({ type: "patio", grid_col: patioGridCol, tight_after: 0 });
  items.sort((a, b) => a.grid_col - b.grid_col);

  let cursorX = MARGIN;
  const placed = items.map((it, i) => {
    if (i > 0) cursorX += it.tight_after ? TIGHT_GAP : GAP;
    const w = it.type === "patio" ? PATIO_W : COL_W;
    const x = cursorX;
    cursorX += w;
    return { ...it, x, w };
  });
  const svgW = cursorX + MARGIN;
  const svgH = topY + ROW_H + MARGIN;

  const shapes = placed
    .filter((it) => it.type === "rack")
    .map((r) => {
      const color = occColor(r.occupancy_pct);
      const textY0 = topY + 26;
      return `
        <g class="floor-plan-rack" data-rack="${r.id}" data-rack-code="${esc(r.code.toLowerCase())}" tabindex="0">
          <rect x="${r.x}" y="${topY}" width="${r.w}" height="${ROW_H}" fill="url(#${patId})" stroke="${color}" stroke-width="3" class="fp-svg-shape"/>
          <text x="${r.x + 12}" y="${textY0}" class="fp-svg-code">Rack ${esc(r.code)}</text>
          <text x="${r.x + 12}" y="${textY0 + 18}" class="fp-svg-sub">${esc(r.access_label)}</text>
          <text x="${r.x + 12}" y="${textY0 + 38}" class="fp-svg-pct" fill="${color}">${r.occupancy_pct}%</text>
          <text x="${r.x + 12}" y="${textY0 + 56}" class="fp-svg-sub">${r.occupied_positions}/${r.total_positions}</text>
          <title>Rack ${esc(r.code)}: ${r.total_positions} posiciones (${r.occupied_positions} ocupadas)</title>
        </g>`;
    })
    .join("");

  const patioItem = placed.find((it) => it.type === "patio");
  const patioBlock = patioItem
    ? `<g>
        <rect x="${patioItem.x}" y="${topY}" width="${patioItem.w}" height="${ROW_H}" fill="none" stroke="#b7bdc9" stroke-width="2" stroke-dasharray="6 5" rx="6"/>
        <text x="${patioItem.x + patioItem.w / 2}" y="${topY + ROW_H / 2}" text-anchor="middle" class="fp-svg-sub" style="font-size:12px">Patio de<tspan x="${patioItem.x + patioItem.w / 2}" dy="16">Despacho</tspan></text>
      </g>`
    : "";

  return `
    <div class="toolbar" style="margin:2px 0 10px">
      <input class="fp-filter" placeholder="Resaltar rack (ej: B)..." style="max-width:220px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
    </div>
    <div class="floor-plan-svg-wrap">
      <svg viewBox="0 0 ${svgW} ${svgH}" class="floor-plan-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="${patId}" width="13" height="18" patternUnits="userSpaceOnUse">
            <rect width="13" height="18" fill="#ffffff"/>
            <path d="M13,0 V18 M0,0 H13" stroke="#dfe3ea" stroke-width="1"/>
          </pattern>
        </defs>
        ${patioBlock}
        ${shapes}
      </svg>
    </div>
    <div class="floor-plan-legend">
      <span><span class="fp-legend-swatch" style="background:var(--ok)"></span>&lt;50% ocupado</span>
      <span><span class="fp-legend-swatch" style="background:var(--warn)"></span>50–84% ocupado</span>
      <span><span class="fp-legend-swatch" style="background:var(--bad)"></span>&ge;85% ocupado</span>
      <span>Racks pegados (sin espacio) = pareja de doble ingreso</span>
    </div>`;
}

export async function renderWarehouseMap(container) {
  container.innerHTML = `<div class="empty-state">Cargando mapa de almacen...</div>`;
  const warehouses = await api.get("/warehouse/map");

  container.innerHTML = `
    <div class="card">
      <h3>Como leer una ubicacion</h3>
      <p class="hint" style="margin-bottom:0">Sistema de codigo: <strong>rack</strong> + <strong>nivel</strong> + <strong>posicion</strong>, todo junto y en minuscula, ej. "b3,8" = Rack B, Nivel 3, Posicion 8.
        Racks: A y H (laterales, pegados a pared), B/C, E/D y F/G (parejas del medio, 228 posiciones cada pareja) — 864 posiciones en total.
        Use el buscador de abajo para encontrar exactamente donde esta un producto.</p>
    </div>
    <div class="card">
      <h3>Buscar ubicacion de un producto</h3>
      <div class="toolbar" style="margin-bottom:6px">
        <input id="find-sku" placeholder="SKU o nombre de producto..." style="max-width:240px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
        <select id="find-client" style="padding:8px 10px;border:1px solid var(--line);border-radius:7px"><option value="">Todos los clientes</option></select>
        <input id="find-loc" placeholder="Codigo de ubicacion..." style="max-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:7px" />
      </div>
      <div id="find-results"></div>
    </div>
  `;

  const clients = await api.get("/clients");
  container.querySelector("#find-client").innerHTML =
    `<option value="">Todos los clientes</option>` + clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

  async function doFind() {
    const sku = container.querySelector("#find-sku").value.trim();
    const client_id = container.querySelector("#find-client").value;
    const location = container.querySelector("#find-loc").value.trim();
    if (!sku && !client_id && !location) {
      container.querySelector("#find-results").innerHTML = `<div class="hint">Escriba un SKU/producto, elija un cliente o un codigo de ubicacion.</div>`;
      return;
    }
    const rows = await api.get("/warehouse/find", { sku, client_id, location });
    container.querySelector("#find-results").innerHTML = table(
      [
        { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
        { label: "Producto", key: "product_description" },
        { label: "Cliente", key: "client_name" },
        { label: "Lote", render: (r) => esc(r.lot_code || "—") },
        { label: "Ubicacion (cardinal)", render: (r) => esc(r.cardinal_label) },
        { label: "Estado", render: (r) => badge(r.status) },
        { label: "Cantidad", render: (r) => fmtNum(r.qty) },
      ],
      rows,
      { emptyText: "Sin resultados. El producto puede no tener stock disponible o no estar ubicado todavia." }
    );
  }
  ["find-sku", "find-loc"].forEach((id) => container.querySelector(`#${id}`).addEventListener("input", debounce(doFind, 300)));
  container.querySelector("#find-client").addEventListener("change", doFind);

  if (!warehouses.length) {
    container.insertAdjacentHTML("beforeend", `<div class="empty-state">No hay almacenes configurados.</div>`);
    return;
  }

  container.insertAdjacentHTML(
    "beforeend",
    warehouses
      .map(
        (wh) => `
      <div class="card">
        <h3>${esc(wh.name)} <span class="muted" style="font-weight:400">(${esc(wh.code)})</span></h3>
        ${wh.zones
          .map((z) => {
            const plan = renderFloorPlan(z.racks, `${wh.id}-${z.id}`, z.patio_grid_col);
            if (plan) {
              return `
          <div class="zone-block">
            <h4>${esc(z.description || z.code)}</h4>
            <p class="hint">Plano real del almacen: cada barra es un rack (6 niveles). Los que estan pegados sin espacio forman pareja (doble ingreso); el resto tiene pasillo normal entre medio. Clic en un rack para ver el detalle.</p>
            ${renderZoneSummary(z.racks)}
            ${plan}
          </div>`;
            }
            return `
          <div class="zone-block">
            <h4>Zona ${esc(z.description || z.code)}</h4>
            <div class="rack-grid">
              ${z.racks
                .map(
                  (r) => `
                <div class="rack-tile" data-rack="${r.id}">
                  <div class="rack-code">Rack ${esc(r.code)}</div>
                  <div class="muted" style="font-size:11px">${esc(r.access_label || "")}</div>
                  <div class="muted" style="font-size:11.5px">${r.occupied_positions}/${r.total_positions} posiciones ocupadas</div>
                  <div class="occ-bar"><div class="occ-bar-fill ${occClass(r.occupancy_pct)}" style="width:${r.occupancy_pct}%"></div></div>
                  <div style="font-size:11.5px;font-weight:700">${r.occupancy_pct}% ocupado</div>
                </div>`
                )
                .join("")}
            </div>
          </div>`;
          })
          .join("")}
      </div>`
      )
      .join("")
  );

  container.querySelectorAll("[data-rack]").forEach((el) => {
    el.addEventListener("click", () => navigate(`/almacen/rack/${el.dataset.rack}`));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigate(`/almacen/rack/${el.dataset.rack}`);
      }
    });
  });

  // Filtro interactivo: escribir un codigo de rack (ej. "B1") atenua el resto
  // y resalta las coincidencias en tiempo real, sin recargar nada.
  container.querySelectorAll(".fp-filter").forEach((input) => {
    input.addEventListener("input", () => {
      const term = input.value.trim().toLowerCase();
      const plan = input.closest(".zone-block").querySelector(".floor-plan-svg");
      plan.querySelectorAll(".floor-plan-rack").forEach((tile) => {
        const match = !term || tile.dataset.rackCode.includes(term);
        tile.style.opacity = match ? "1" : "0.2";
        tile.style.filter = match ? "none" : "grayscale(80%)";
      });
    });
  });
}

export async function renderRackDetail(container, rackId) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const rack = await api.get(`/warehouse/racks/${rackId}`);

  const allLocs = rack.levels.flatMap((lvl) => lvl.locations);
  const total = allLocs.length;
  const occ = allLocs.filter((l) => l.occupied > 0).length;
  const blocked = allLocs.filter((l) => l.status === "BLOQUEADA" || l.status === "MANTENIMIENTO").length;
  const pct = total ? Math.round((occ / total) * 1000) / 10 : 0;

  container.innerHTML = `
    <div class="breadcrumb"><a data-nav="/almacen">Mapa de almacen</a> / Rack ${esc(rack.code)}</div>
    <div class="card">
      <div class="rack-detail-head">
        <div>
          <h3 style="margin-bottom:2px">Rack ${esc(rack.code)}</h3>
          <div class="muted" style="font-size:12.5px">${esc(rack.access_label)} &middot; 1 pallet por posicion</div>
        </div>
        <div class="level-jump">
          ${rack.levels.map((lvl) => `<a href="#nivel-${esc(lvl.code)}" class="level-jump-chip">${esc(lvl.code)}</a>`).join("")}
        </div>
      </div>
      ${renderZoneSummary([{ total_positions: total, occupied_positions: occ, occupancy_pct: pct }])}
      ${blocked ? `<div class="alert-row" style="margin-bottom:14px"><span>⚠</span> ${blocked} posicion(es) bloqueada(s) o en mantenimiento en este rack.</div>` : ""}
      ${rack.levels
        .map((lvl) => {
          const tiles = lvl.locations.map((loc) => {
            const cls = loc.status === "BLOQUEADA" || loc.status === "MANTENIMIENTO" ? "blocked" : loc.occupied > 0 ? "occ" : "";
            return `<div class="pos-tile ${cls}" data-loc="${loc.id}" title="${esc(loc.cardinal_label)}">
                <div class="pos-tile-top">
                  <span class="pallet-icon ${loc.occupied > 0 ? "filled" : ""}"></span>
                  <span class="pos-tile-code">${esc(loc.full_code)}</span>
                </div>
                <div class="pos-tile-qty">${loc.occupied ? fmtNum(loc.occupied) + " und" : "Vacio"}</div>
              </div>`;
          }).join("");
          const lvlOcc = lvl.locations.filter((l) => l.occupied > 0).length;
          return `
        <div class="level-block" id="nivel-${esc(lvl.code)}">
          <div class="level-head">
            <h4>Nivel ${esc(lvl.code)}</h4>
            <span class="muted" style="font-size:11.5px">${lvlOcc}/${lvl.locations.length} ocupadas</span>
          </div>
          <div class="pos-grid">${tiles}</div>
        </div>`;
        })
        .join("")}
    </div>`;
  container.querySelector("[data-nav]").addEventListener("click", () => navigate("/almacen"));
  container.querySelectorAll("[data-loc]").forEach((el) =>
    el.addEventListener("click", () => navigate(`/almacen/ubicacion/${el.dataset.loc}`))
  );
}

export async function renderLocationDetail(container, locId) {
  container.innerHTML = `<div class="empty-state">Cargando...</div>`;
  const loc = await api.get(`/warehouse/locations/${locId}`);
  container.innerHTML = `
    <div class="breadcrumb"><a data-nav="/almacen">Mapa de almacen</a> / ${esc(loc.full_code)}</div>
    <div class="card">
      <h3>${esc(loc.cardinal_label)}</h3>
      <div class="muted mono" style="margin-bottom:10px">${esc(loc.full_code)}</div>
      <div class="tag-row" style="margin-bottom:14px">
        ${badge(loc.status)}
        <span class="muted">Capacidad: ${loc.capacity ? fmtNum(loc.capacity) + " unidades" : "sin limite"}</span>
      </div>
      <h4>Contenido actual</h4>
      <div id="loc-contents"></div>
    </div>`;
  container.querySelector("[data-nav]").addEventListener("click", () => navigate("/almacen"));
  container.querySelector("#loc-contents").innerHTML = table(
    [
      { label: "SKU", render: (r) => `<span class="mono">${esc(r.sku_code)}</span>` },
      { label: "Producto", key: "product_description" },
      { label: "Cliente", key: "client_name" },
      { label: "Lote", render: (r) => esc(r.lot_code || "—") },
      { label: "Vencimiento", render: (r) => (r.expiration_date ? r.expiration_date.slice(0, 10) : "—") },
      { label: "Estado", render: (r) => badge(r.status) },
      { label: "Cantidad", render: (r) => fmtNum(r.qty) },
    ],
    loc.contents,
    { emptyText: "Ubicacion vacia" }
  );
}
