const routes = [];

export function addRoute(pattern, handler) {
  const paramNames = [];
  const regexStr = pattern
    .replace(/\/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "/([^/]+)";
    })
    .replace(/\//g, "\\/");
  routes.push({ regex: new RegExp("^" + regexStr + "$"), paramNames, handler });
}

export function navigate(path) {
  window.location.hash = "#" + path;
}

export async function resolve() {
  const hash = window.location.hash.slice(1) || "/dashboard";
  const [path, queryStr] = hash.split("?");
  const query = Object.fromEntries(new URLSearchParams(queryStr || ""));
  for (const r of routes) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      await r.handler(params, query);
      return;
    }
  }
  await routes.find((r) => r.regex.test("/dashboard"))?.handler({}, {});
}

export function startRouter() {
  window.addEventListener("hashchange", resolve);
}
