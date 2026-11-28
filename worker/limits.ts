// Per-isolate request counters for read routes. Writes keep using the D1 "rate" table, which
// holds across isolates; reads are far more frequent, and a D1 write per read would double the
// database's daily write budget. A single isolate serves most of one person's requests, so this
// stops a runaway tab or script without any storage cost.
const windows = new Map<string, { minute: number; hits: number }>();

export function allow(key: string, limit: number, now: number) {
  const minute = Math.floor(now / 60000);
  const entry = windows.get(key);
  if (!entry || entry.minute !== minute) {
    if (windows.size > 5000) for (const [k, v] of windows) if (v.minute !== minute) windows.delete(k);
    windows.set(key, { minute, hits: 1 });
    return true;
  }
  entry.hits += 1;
  return entry.hits <= limit;
}

// Requests a minute per person for each read route.
export const readLimits: Record<string, number> = {
  session: 60, workspace: 30, history: 60, search: 20, poll: 200, ice: 10, transport: 10,
  attachment: 600, avatar: 600, applogo: 600, admin: 30,
};

// Bytes one person may upload per UTC day.
export const dailyUploadBytes = 500_000_000;
