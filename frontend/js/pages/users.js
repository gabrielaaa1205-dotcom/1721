import { api } from "../api.js";
import { table, esc, badge, showModal, closeModal, toast } from "../utils.js";

export async function renderUsers(container) {
  const roles = await api.get("/roles");
  container.innerHTML = `
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-primary" id="btn-new">+ Nuevo usuario</button></div>
    <div class="card"><div id="tbl"></div></div>`;

  async function load() {
    const users = await api.get("/users");
    container.querySelector("#tbl").innerHTML = table(
      [
        { label: "Nombre", key: "name" },
        { label: "Correo", key: "email" },
        { label: "Rol", key: "role_name" },
        { label: "Estado", render: (u) => (u.active ? `<span class="badge badge-ok">Activo</span>` : `<span class="badge badge-grey">Inactivo</span>`) },
        { label: "", render: (u) => `<button class="btn btn-sm" data-edit="${u.id}">Editar</button>` },
      ],
      users
    );
    container.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => openEditModal(users.find((u) => u.id == b.dataset.edit)))
    );
  }

  function openEditModal(user) {
    showModal(
      `<h3>Editar usuario</h3>
      <form id="f">
        <div class="field"><label>Nombre</label><input value="${esc(user.name)}" disabled /></div>
        <div class="field"><label>Rol</label><select name="role_id">${roles.map((r) => `<option value="${r.id}" ${r.code === user.role ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>
        <div class="field"><label><input type="checkbox" name="active" ${user.active ? "checked" : ""} style="width:auto;margin-right:6px" />Activo</label></div>
        <div class="field"><label>Nueva contrasena (opcional)</label><input type="password" name="password" /></div>
        <button class="btn btn-primary" type="submit">Guardar</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            await api.put(`/users/${user.id}`, {
              role_id: fd.get("role_id"),
              active: fd.get("active") ? 1 : 0,
              password: fd.get("password") || undefined,
            });
            toast("Usuario actualizado", "ok");
            closeModal();
            load();
          }),
      }
    );
  }

  function openNewModal() {
    showModal(
      `<h3>Nuevo usuario</h3>
      <form id="f">
        <div class="field"><label>Nombre</label><input name="name" required /></div>
        <div class="field"><label>Correo</label><input name="email" type="email" required /></div>
        <div class="field"><label>Rol</label><select name="role_id">${roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Contrasena</label><input name="password" type="password" required /></div>
        <button class="btn btn-primary" type="submit">Crear</button>
      </form>`,
      {
        onMount: (root) =>
          root.querySelector("#f").addEventListener("submit", async (e) => {
            e.preventDefault();
            const payload = Object.fromEntries(new FormData(e.target).entries());
            try {
              await api.post("/users", payload);
              toast("Usuario creado", "ok");
              closeModal();
              load();
            } catch (err) {
              toast(err.message, "error");
            }
          }),
      }
    );
  }

  container.querySelector("#btn-new").addEventListener("click", openNewModal);
  await load();
}
