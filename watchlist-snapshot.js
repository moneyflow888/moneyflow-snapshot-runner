import "dotenv/config";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const env = (k) => (process.env[k] ?? "").toString().trim();

function must(k) {
  const v = env(k);
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function fetchJson(url) {
  const { data } = await axios.get(url, {
    timeout: 20000,
    headers: { "User-Agent": "moneyflow-watchlist-runner/1.0" },
  });
  return data;
}

async function insertMetric({ asset, metric, value, source, raw }) {
  const n = num(value);
  if (n == null) throw new Error(`Invalid value: ${asset}/${metric}`);

  const r = await supabase.from("watchlist_metric_snapshots").insert([
    { asset, metric, value: n, source, raw },
  ]);

  if (r.error) throw new Error(`insert failed ${asset}/${metric}: ${r.error.message}`);
  console.log(`✅ ${asset}/${metric} = ${n}`);
}

async function main() {
  const rows = [];

  const ethena = await fetchJson("https://api.llama.fi/protocol/ethena");
  rows.push({
    asset: "ETHENA",
    metric: "tvl",
    value: ethena.tvl,
    source: "defillama_protocol_ethena",
    raw: ethena,
  });

  const stablecoins = await fetchJson(
    "https://stablecoins.llama.fi/stablecoins?includePrices=true"
  );

  const usde = stablecoins.peggedAssets?.find((x) => {
    const name = String(x.name || "").toLowerCase();
    const symbol = String(x.symbol || "").toLowerCase();
    return name.includes("usde") || symbol === "usde";
  });

  if (!usde) throw new Error("USDe not found");

  rows.push({
    asset: "USDE",
    metric: "supply",
    value: usde.circulating?.peggedUSD ?? usde.mcap,
    source: "defillama_stablecoins",
    raw: usde,
  });

  const yields = await fetchJson("https://yields.llama.fi/pools");

  const susde = yields.data?.find((x) => {
    const symbol = String(x.symbol || "").toLowerCase();
    const project = String(x.project || "").toLowerCase();
    return symbol.includes("susde") && project.includes("ethena");
  });

  if (!susde) throw new Error("sUSDe pool not found");

  rows.push({
    asset: "SUSDE",
    metric: "apy",
    value: susde.apy,
    source: "defillama_yields",
    raw: susde,
  });

  for (const row of rows) {
    await insertMetric(row);
  }

  console.log("✅ watchlist snapshot completed");
}

main().catch((e) => {
  console.error("❌ watchlist snapshot failed:", e);
  process.exit(1);
});
