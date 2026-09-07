/**
 * auth.js — Token management, session guard, logout
 * Must be loaded FIRST (before api.js) in index.html
 *
 * Storage keys (localStorage):
 *   ragbot_token        — JWT bearer token
 *   ragbot_user_id      — numeric user id
 *   ragbot_username     — login username
 *   ragbot_display_name — human-readable name
 *   ragbot_is_admin     — "true" | "false"
 *   ragbot_expires_at   — ISO datetime string
 */

// ── Session guard — redirect to login if no valid token ──────────────────────
(function () {
  const token     = localStorage.getItem("ragbot_token");
  const expiresAt = localStorage.getItem("ragbot_expires_at");

  function goLogin() {
    window.location.replace("login.html");
  }

  if (!token) { goLogin(); return; }

  // Client-side expiry check (server also validates)
  if (expiresAt) {
    const exp = new Date(expiresAt).getTime();
    if (Date.now() >= exp) {
      localStorage.clear();
      goLogin();
      return;
    }
  }
})();

// ── Auth helpers exposed globally ─────────────────────────────────────────────

const Auth = (function () {

  function getToken()       { return localStorage.getItem("ragbot_token") || ""; }
  function getUserId()      { return parseInt(localStorage.getItem("ragbot_user_id") || "0", 10); }
  function getUsername()    { return localStorage.getItem("ragbot_username") || ""; }
  function getDisplayName() { return localStorage.getItem("ragbot_display_name") || getUsername(); }
  function isAdmin()        { return localStorage.getItem("ragbot_is_admin") === "true"; }

  async function logout() {
    const token = getToken();
    try {
      await fetch(
        (window.location.protocol === "http:" || window.location.protocol === "https:"
          ? window.location.origin + "/api"
          : "http://localhost:8000/api") + "/auth/logout",
        {
          method:  "POST",
          headers: { "Authorization": "Bearer " + token },
        }
      );
    } catch (_) { /* ignore network errors during logout */ }
    localStorage.clear();
    window.location.replace("login.html");
  }

  return { getToken, getUserId, getUsername, getDisplayName, isAdmin, logout };
})();
