// ─── Shared profile picker ──────────────────────────────────────────────────
// `User` (db/models.py) is a named profile, NOT an account — this app has
// deliberately had zero auth/password, and that stance is kept here: the
// "current user" is just a plain id remembered in localStorage, not a
// security boundary. Used by index.html (chart filter persistence),
// shadow.html (per-user media/progress) and settings.html (the picker
// itself + config forms).
//
// Exposes window.UserLib = { getCurrentUserId, mountPicker }.
// Dispatches a `window` CustomEvent('phonexa:user-changed', {detail:{userId}})
// whenever the active profile changes, so any page-specific code (filter
// restore, shadowing media list, …) can re-fetch its own per-user state.

const UserLib = (() => {
  const STORAGE_KEY = 'phonexa.currentUserId';
  let usersCache = null; // [{id, name, createdAt}, ...] — refetched on demand

  async function fetchUsers() {
    const res = await fetch('/api/v1/users');
    usersCache = res.ok ? await res.json() : [];
    return usersCache;
  }

  async function createUser(name) {
    const res = await fetch('/api/v1/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create profile');
    const user = await res.json();
    usersCache = [...(usersCache || []), user];
    return user;
  }

  function setCurrentUserId(id) {
    localStorage.setItem(STORAGE_KEY, String(id));
    window.dispatchEvent(new CustomEvent('phonexa:user-changed', { detail: { userId: id } }));
  }

  // Resolves the active profile id, auto-creating a "default" profile the
  // very first time the app is used on a machine (no users exist yet) and
  // falling back to the first known profile if the stored id is stale.
  async function getCurrentUserId() {
    const users = usersCache || await fetchUsers();
    const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    if (stored && users.some(u => u.id === stored)) return stored;
    if (users.length) {
      localStorage.setItem(STORAGE_KEY, String(users[0].id));
      return users[0].id;
    }
    const created = await createUser('default');
    localStorage.setItem(STORAGE_KEY, String(created.id));
    return created.id;
  }

  // Renders a small <select> + "+ New profile" control into `container`
  // (an element or id string). Safe to call multiple times/from multiple
  // pages — each call builds its own independent DOM.
  async function mountPicker(container) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    const users = usersCache || await fetchUsers();
    const currentId = await getCurrentUserId();

    el.innerHTML = '';
    const select = document.createElement('select');
    select.className = 'user-picker-select';
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name;
      if (u.id === currentId) opt.selected = true;
      select.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New profile…';
    select.appendChild(newOpt);

    select.addEventListener('change', async () => {
      if (select.value === '__new__') {
        const name = (prompt('New profile name:') || '').trim();
        if (!name) { select.value = String(currentId); return; }
        try {
          const user = await createUser(name);
          setCurrentUserId(user.id);
          mountPicker(el); // re-render with the new profile selected
        } catch (e) {
          alert(e.message);
          select.value = String(currentId);
        }
        return;
      }
      setCurrentUserId(parseInt(select.value, 10));
    });
    el.appendChild(select);
  }

  return { getCurrentUserId, mountPicker };
})();
