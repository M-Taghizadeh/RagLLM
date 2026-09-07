/**
 * users.js — Admin user management panel (#section-users)
 */
(function () {

  // DOM refs
  const tableBody$    = document.getElementById("usersTableBody");
  const addUserBtn$   = document.getElementById("addUserBtn");
  const backdrop$     = document.getElementById("userFormBackdrop");
  const formTitle$    = document.getElementById("userFormTitle");
  const formId$       = document.getElementById("userFormId");
  const formUsername$ = document.getElementById("userFormUsername");
  const formDisplay$  = document.getElementById("userFormDisplayName");
  const formPwd$      = document.getElementById("userFormPassword");
  const formPwdNote$  = document.getElementById("userFormPwdNote");
  const formIsAdmin$  = document.getElementById("userFormIsAdmin");
  const formIsActive$ = document.getElementById("userFormIsActive");
  const formActiveRow$= document.getElementById("userFormActiveRow");
  const formStatus$   = document.getElementById("userFormStatus");
  const formSave$     = document.getElementById("userFormSave");
  const formCancel$   = document.getElementById("userFormCancel");
  const formClose$    = document.getElementById("userFormClose");

  // ── Load users ──────────────────────────────────────────────────
  async function loadUsers() {
    tableBody$.innerHTML = `<tr><td colspan="7" class="users-table-loading"><span class="docs-spinner"></span> در حال بارگذاری...</td></tr>`;
    try {
      const data = await apiGet("/auth/users");
      renderTable(data);
    } catch (err) {
      tableBody$.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger);padding:24px">❌ خطا: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderTable(users) {
    if (!users.length) {
      tableBody$.innerHTML = `<tr><td colspan="7" class="users-table-loading">هیچ کاربری یافت نشد.</td></tr>`;
      return;
    }
    tableBody$.innerHTML = "";
    const myId = Auth.getUserId();

    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td><code>${escHtml(u.username)}</code></td>
        <td>${escHtml(u.display_name)}</td>
        <td>${u.is_admin
          ? `<span class="user-badge admin">مدیر</span>`
          : `<span class="user-badge normal">کاربر</span>`}</td>
        <td>${u.is_active
          ? `<span class="user-badge active">فعال</span>`
          : `<span class="user-badge inactive">غیرفعال</span>`}</td>
        <td style="font-size:11px;direction:ltr">${fmtDate(u.created_at)}</td>
        <td>
          <div style="display:flex;gap:5px">
            <button class="btn-edit" data-id="${u.id}" data-action="edit" type="button">ویرایش</button>
            ${u.id !== myId
              ? `<button class="btn-danger" data-id="${u.id}" data-action="delete" type="button">حذف</button>`
              : `<span style="font-size:11px;color:var(--ink-muted)">(شما)</span>`}
          </div>
        </td>`;

      tr.querySelector("[data-action='edit']")?.addEventListener("click", () => openForm("edit", u));
      tr.querySelector("[data-action='delete']")?.addEventListener("click", () => confirmDelete(u, tr));
      tableBody$.appendChild(tr);
    });
  }

  // ── Confirm delete inline ────────────────────────────────────────
  function confirmDelete(user, tr) {
    const origHTML = tr.innerHTML;
    tr.innerHTML = `
      <td colspan="7" style="padding:10px 16px;background:var(--danger-dim)">
        <span style="font-size:13px;font-weight:600;color:var(--danger)">حذف کاربر «${escHtml(user.username)}»؟ تمام داده‌های آن نیز پاک می‌شود.</span>
        <span style="display:inline-flex;gap:6px;margin-right:12px">
          <button class="btn-danger confirm-yes" type="button">بله، حذف</button>
          <button class="btn-secondary confirm-no"  type="button">انصراف</button>
        </span>
      </td>`;

    tr.querySelector(".confirm-no").addEventListener("click", () => {
      tr.innerHTML = origHTML;
      tr.querySelector("[data-action='edit']")?.addEventListener("click", () => openForm("edit", user));
      tr.querySelector("[data-action='delete']")?.addEventListener("click", () => confirmDelete(user, tr));
    });
    tr.querySelector(".confirm-yes").addEventListener("click", async () => {
      try {
        await apiDelete(`/auth/users/${user.id}`);
        tr.remove();
      } catch (err) {
        tr.innerHTML = origHTML;
        alert("خطا در حذف: " + err.message);
      }
    });
  }

  // ── Form open/close ──────────────────────────────────────────────
  function openForm(mode, user = null) {
    formId$.value       = user ? String(user.id) : "";
    formUsername$.value = user ? user.username    : "";
    formDisplay$.value  = user ? user.display_name: "";
    formPwd$.value      = "";
    formIsAdmin$.checked  = user ? user.is_admin   : false;
    formIsActive$.checked = user ? user.is_active  : true;

    formTitle$.textContent = mode === "edit" ? "ویرایش کاربر" : "کاربر جدید";
    formPwdNote$.textContent = mode === "edit" ? "(اختیاری — برای تغییر رمز)" : "(حداقل ۶ کاراکتر)";
    formUsername$.disabled  = mode === "edit";   // can't change username
    formActiveRow$.style.display = mode === "edit" ? "flex" : "none";
    setStatus(formStatus$, "", "");

    backdrop$.classList.add("open");
    backdrop$.removeAttribute("aria-hidden");
    setTimeout(() => (mode === "edit" ? formDisplay$ : formUsername$).focus(), 60);
  }

  function closeForm() {
    backdrop$.classList.remove("open");
    backdrop$.setAttribute("aria-hidden", "true");
  }

  formClose$.addEventListener("click",  closeForm);
  formCancel$.addEventListener("click", closeForm);
  backdrop$.addEventListener("click", e => { if (e.target === backdrop$) closeForm(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && backdrop$.classList.contains("open")) closeForm();
  });

  // ── Save ─────────────────────────────────────────────────────────
  formSave$.addEventListener("click", async () => {
    const id          = formId$.value;
    const displayName = formDisplay$.value.trim();
    const password    = formPwd$.value;
    const isAdmin     = formIsAdmin$.checked;
    const isActive    = formIsActive$.checked;
    const username    = formUsername$.value.trim();

    if (!id && (!username || username.length < 3)) {
      setStatus(formStatus$, "نام کاربری حداقل ۳ کاراکتر باشد.", "warn"); return;
    }
    if (!id && (!password || password.length < 6)) {
      setStatus(formStatus$, "رمز عبور حداقل ۶ کاراکتر باشد.", "warn"); return;
    }
    if (id && password && password.length < 6) {
      setStatus(formStatus$, "رمز عبور حداقل ۶ کاراکتر باشد.", "warn"); return;
    }

    formSave$.disabled = true;
    clearStatus(formStatus$);

    try {
      if (id) {
        const body = { display_name: displayName, is_admin: isAdmin, is_active: isActive };
        if (password) body.password = password;
        await apiPatch(`/auth/users/${id}`, body);
      } else {
        await apiPost("/auth/users", {
          username, password, display_name: displayName, is_admin: isAdmin,
        });
      }
      closeForm();
      loadUsers();
    } catch (err) {
      setStatus(formStatus$, "خطا: " + err.message, "error");
    } finally {
      formSave$.disabled = false;
    }
  });

  // ── Section activation ────────────────────────────────────────────
  document.addEventListener("sectionActivated", e => {
    if (e.detail && e.detail.section === "users") loadUsers();
  });

  // ── Wire add button ───────────────────────────────────────────────
  addUserBtn$.addEventListener("click", () => openForm("create"));

})();
