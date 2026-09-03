export const state = {
  token: localStorage.getItem("wms_token") || null,
  user: JSON.parse(localStorage.getItem("wms_user") || "null"),
};

export function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("wms_token", token);
  localStorage.setItem("wms_user", JSON.stringify(user));
}

export function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("wms_token");
  localStorage.removeItem("wms_user");
}

export function hasPermission(...perms) {
  const rolePerms = {
    ADMIN: ["*"],
    SUPERVISOR: ["view", "create", "edit", "approve", "quality", "adjust", "locate", "move", "count", "pick", "dispatch"],
    RECEPCION: ["view", "create_reception", "edit_reception", "quality", "locate"],
    ALMACEN: ["view", "locate", "move", "count", "quality", "edit"],
    PICKING: ["view", "pick", "dispatch"],
    CONSULTA: ["view"],
  };
  const mine = rolePerms[state.user?.role] || [];
  if (mine.includes("*")) return true;
  return perms.some((p) => mine.includes(p));
}
