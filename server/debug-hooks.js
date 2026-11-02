/** Diagnostics must never interrupt capture, evidence fencing or provider handling. */
export function debugCall(recorder, method, ...args) {
  try {
    const result = recorder?.[method]?.(...args);
    if (result && typeof result.then === 'function') { result.catch(() => {}); return null; }
    return result;
  } catch { return null; }
}
