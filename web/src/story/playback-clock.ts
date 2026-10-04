/** One pausable virtual clock for text, media waits and delayed effects.
 * Self-contained so the offline HTML embeds this exact implementation.
 */
export function createPlaybackClock() {
  let sequence = 0, paused = false, rate = 1, stamp = performance.now(), elapsed = 0;
  const tasks = new Map<number, { at: number; callback: () => void; cancel?: () => void; native?: ReturnType<typeof setTimeout> }>();
  function now() { const real = performance.now(); if (!paused) elapsed += (real - stamp) * rate; stamp = real; return elapsed; }
  function arm(id: number) {
    const task = tasks.get(id); if (!task) return;
    clearTimeout(task.native);
    if (paused) return;
    task.native = setTimeout(() => { if (paused || !tasks.has(id)) return; tasks.delete(id); now(); task.callback(); }, Math.max(0, task.at - now()) / rate);
  }
  function schedule(callback: () => void, ms: number, cancel?: () => void) { const id = ++sequence; tasks.set(id, { at: now() + Math.max(0, ms), callback, cancel }); arm(id); return id; }
  function clear(id: number) { const task = tasks.get(id); if (!task) return; clearTimeout(task.native); tasks.delete(id); task.cancel?.(); }
  function clearAll() { for (const id of [...tasks.keys()]) clear(id); }
  function setPaused(value: boolean) { now(); paused = value; for (const id of tasks.keys()) arm(id); }
  function setRate(value: number) { now(); rate = Math.max(.1, Number(value) || 1); for (const id of tasks.keys()) arm(id); }
  function wait(ms: number) { return new Promise<boolean>(resolve => schedule(() => resolve(true), ms, () => resolve(false))); }
  return { setTimeout: schedule, clearTimeout: clear, clearAll, setPaused, setRate, wait, now, has: (id: number) => tasks.has(id), get paused() { return paused; } };
}
