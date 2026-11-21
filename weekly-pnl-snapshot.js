// MF only: reconcile missing archives for the latest 15 completed Taipei weeks.
const DAY = 86400000;
export function weekKeys(now = new Date(), count = 15) {
  const local = new Date(now.getTime() + 8 * 3600000);
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ((local.getUTCDay() + 6) % 7) * DAY;
  return Array.from({ length: count }, (_, i) => new Date(monday - (i + 1) * 7 * DAY).toISOString().slice(0, 10));
}
export async function runWeekly({ baseUrl, secret, weekKey = '', force = false, now = new Date(), request = fetch }) {
  if (!baseUrl || !secret) throw new Error('Missing MONEYFLOW_AXIS_BASE_URL or CRON_SECRET');
  if (weekKey && (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey) || !Number.isFinite(Date.parse(`${weekKey}T00:00:00Z`)) || new Date(`${weekKey}T00:00:00Z`).toISOString().slice(0, 10) !== weekKey || new Date(`${weekKey}T00:00:00Z`).getUTCDay() !== 1)) throw new Error('week_key must be a valid Monday');
  const keys = weekKey ? [weekKey] : weekKeys(now);
  const failures = [];
  for (const key of keys) {
    try {
      const res = await request(`${baseUrl.replace(/\/+$/, '')}/api/admin/weekly-pnl-snapshot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ week_key: key, force }), signal: AbortSignal.timeout(45000),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? 'Snapshot failed'}`);
      console.log(`${key}: ${body.skipped ? 'already archived' : 'archived'}`);
    } catch (e) { failures.push(`${key}: ${e.message}`); }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runWeekly({ baseUrl: process.env.MONEYFLOW_AXIS_BASE_URL, secret: process.env.CRON_SECRET,
    weekKey: process.env.WEEK_KEY?.trim(), force: process.env.FORCE === 'true' })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
