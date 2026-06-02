const KAMINO_OWNER =
  "3SwVwDD7nmn3oXFszyFG7vDQizZXgGLmiFBYYQGWDLui";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getKaminoHistoryUrl() {
  const end = new Date();

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);

  return `https://api.kamino.finance/owners/${KAMINO_OWNER}/net-values/history?start=${encodeURIComponent(
    start.toISOString()
  )}&end=${encodeURIComponent(end.toISOString())}`;
}

export async function getKaminoPortfolio() {
  const res = await fetch(getKaminoHistoryUrl(), {
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Kamino API failed: ${res.status}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Kamino history empty");
  }

  const latest = data[data.length - 1];

  const klendUsd = num(latest?.klendUsd);
  const kvaultsUsd = num(latest?.kvaultsUsd);
  const strategiesUsd = num(latest?.strategiesUsd);
  const stakingUsd = num(latest?.stakingUsd);

  const netValueUsd =
    klendUsd + kvaultsUsd + strategiesUsd + stakingUsd;

  if (netValueUsd <= 0) {
    throw new Error("Kamino net value invalid");
  }

  return {
    source_used: "kamino_owner_net_values_history",
    status: "OK",

    klend_usd: klendUsd,
    kvaults_usd: kvaultsUsd,
    strategies_usd: strategiesUsd,
    staking_usd: stakingUsd,

    net_value_usd: netValueUsd,
    updated_at: new Date().toISOString(),
  };
}
