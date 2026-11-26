const store = new Map();
const LIMIT = 100;

export function logAccess(studentId, entry) {
  const list = store.get(studentId) || [];
  list.push({ time: Date.now(), ...entry });
  if (list.length > LIMIT) list.shift();
  store.set(studentId, list);
}

export function getAccessLogs(studentId, limit = 50) {
  const list = store.get(studentId) || [];
  return list.slice(-limit).reverse();
}
