// Only non-secret browser preferences and an allowlisted destination live here.
function preference(store: () => Storage, key: string) {
  return {
    read() { try { return store().getItem(key) } catch { return null } },
    write(value?: string) { try { if (value === undefined) store().removeItem(key); else store().setItem(key, value) } catch { /* Disabled storage is advisory. */ } },
  }
}
export const authStorage = {
  org: preference(() => localStorage, 'workbase:org'),
  language: preference(() => localStorage, 'workbase:language'),
  returnTo: preference(() => sessionStorage, 'workbase.returnTo'),
}
