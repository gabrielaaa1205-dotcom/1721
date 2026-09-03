import { state, clearSession } from "./state.js";

const BASE = "/api";

async function request(method, path, { json, params, formData } = {}) {
  let url = BASE + path;
  if (params) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    if (qs) url += "?" + qs;
  }
  const headers = {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  let body;
  if (formData) {
    body = formData;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  if (res.status === 401) {
    clearSession();
    window.location.hash = "#/login";
    throw new Error("Sesion expirada");
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || "Error de solicitud");
      err.data = data;
      throw err;
    }
    return data;
  }
  if (!res.ok) throw new Error("Error de solicitud (" + res.status + ")");
  return res;
}

export const api = {
  get: (path, params) => request("GET", path, { params }),
  post: (path, json) => request("POST", path, { json }),
  put: (path, json) => request("PUT", path, { json }),
  del: (path) => request("DELETE", path),
  upload: (path, formData) => request("POST", path, { formData }),
  async downloadXlsx(path, params, filename) {
    let url = BASE + path;
    const qs = new URLSearchParams({ ...(params || {}), format: "xlsx" }).toString();
    url += "?" + qs;
    const headers = {};
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error("No se pudo generar el archivo");
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename || "reporte.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  },
};
