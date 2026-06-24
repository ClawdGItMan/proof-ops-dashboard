// Server-side read layer. Reads go straight to PostgREST with the public ANON key
// (RLS allows anon SELECT, denies all anon writes — see 0001_dashboard.sql). No
// @supabase/supabase-js dependency: plain fetch keeps the bundle tiny and the data
// shaping in one place.
//
// N+1 guard: regardless of how many markets the bot runs, this assembles the whole
// dashboard in a FIXED 4 reads (state, orders, control, audit) and groups in memory.
// It never issues one query per market.

import type {
  AuditRow,
  BotStateRow,
  ControlRow,
  DashboardData,
  MarketView,
  OpenOrderRow,
} from "./types";

const AUDIT_GLOBAL_LIMIT = 300; // newest events across all markets, sliced to 50/market below
const AUDIT_PER_MARKET = 50;

// Live-session fence (ELO-68). The audit_log is append-only and carries NO account
// column, so after an account migration (ELO-62: OLD→NEW) the old account's fill
// events — plus historical inferred/phantom fills — keep surfacing in the fill view
// even though the live bot (a fresh upsert into bot_state) is flat. Set
// DASHBOARD_FILLS_SINCE_MS to the cutover epoch (ms) and the audit read is scoped to
// events at-or-after it, so the fill view reflects only the current live account.
// Unset → no fence (original behaviour). Non-destructive: hides, never deletes; bump
// the env on each future migration. Durable account-tagging is the follow-up (ELO-67).
function fillsSinceMs(): number | null {
  const raw = process.env.DASHBOARD_FILLS_SINCE_MS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function env(): { url: string; anon: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  }
  return { url: url.replace(/\/$/, ""), anon };
}

async function read<T>(path: string): Promise<T[]> {
  const { url, anon } = env();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    // Always fresh — this is a live ops view, never cache the read.
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`supabase read ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T[];
}

function groupBy<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Assemble the full dashboard in 4 reads. `now` is injected so the value is testable. */
export async function fetchDashboard(now: number): Promise<DashboardData> {
  const [states, orders, controls] = await Promise.all([
    read<BotStateRow>("bot_state?select=*&order=market.asc"),
    read<OpenOrderRow>("open_orders?select=*&order=market.asc,side.asc,price.asc"),
    read<ControlRow>("bot_control?select=*"),
  ]);

  // Filter requested markets if DASHBOARD_MARKETS is set; else show every published market.
  const allow = (process.env.DASHBOARD_MARKETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const markets = new Set<number>(
    allow.length > 0 ? allow : states.map((s) => s.market),
  );

  // One audit read, newest-first, restricted to the shown markets, then sliced per market.
  // Optionally fenced to the current live session (ELO-68) so stale pre-migration /
  // phantom fills don't surface in the fill view.
  const marketList = [...markets];
  const since = fillsSinceMs();
  const fence = since !== null ? `&ts=gte.${since}` : "";
  const audit =
    marketList.length > 0
      ? await read<AuditRow>(
          `audit_log?select=*&market=in.(${marketList.join(",")})${fence}&order=ts.desc&limit=${AUDIT_GLOBAL_LIMIT}`,
        )
      : [];

  const ordersByMarket = groupBy(orders, (o) => o.market);
  const auditByMarket = groupBy(audit, (a) => a.market);
  const stateByMarket = new Map(states.map((s) => [s.market, s]));
  const controlByMarket = new Map(controls.map((c) => [c.market, c]));

  const views: MarketView[] = marketList
    .sort((a, b) => a - b)
    .map((market) => ({
      market,
      state: stateByMarket.get(market) ?? null,
      orders: ordersByMarket.get(market) ?? [],
      audit: (auditByMarket.get(market) ?? []).slice(0, AUDIT_PER_MARKET),
      control: controlByMarket.get(market) ?? null,
    }));

  return { markets: views, fetchedAt: now };
}
