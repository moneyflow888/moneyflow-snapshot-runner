const KAMINO_OWNER =
  "3SwVwDD7nmn3oXFszyFG7vDQizZXgGLmiFBYYQGWDLui";

const KAMINO_PNL_URL =
  "https://api.kamino.finance/v2/kamino-market/47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8/obligations/F1oMNKJ6iue2QbpE4SBfSjNNXbpAMKjy5BNSDQMw4FA4/pnl/?pnlMode=current_obligation&useStakeRate=false&programId=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";

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

async function fetchOwnerNetValue() {
  const url = getKaminoHistoryUrl();
  console.log("[kamino] owner net-values url:", url);

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Kamino owner net-values failed: ${res.status}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Kamino owner net-values empty");
  }

  const latest = data[data.length - 1];

  const klendUsd = num(latest?.klendUsd);
  const kvaultsUsd = num(latest?.kvaultsUsd);
  const strategiesUsd = num(latest?.strategiesUsd);
  const stakingUsd = num(latest?.stakingUsd);

  const netValueUsd = klendUsd + kvaultsUsd + strategiesUsd + stakingUsd;

  if (netValueUsd <= 0) {
    throw new Error("Kamino owner net value invalid");
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

async function fetchObligationPnl() {
  const res = await fetch(KAMINO_PNL_URL, {
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Kamino PNL failed: ${res.status}`);
  }

  const data = await res.json();

  const pnlUsd = num(data?.usd);
  const investedUsd = num(data?.invested?.usd);
  const netValueUsd = investedUsd + pnlUsd;

  if (netValueUsd <= 0) {
    throw new Error("Kamino PNL net value invalid");
  }

  return {
    source_used: "kamino_obligation_pnl",
    status: "OK",
    invested_usd: investedUsd,
    pnl_usd: pnlUsd,
    net_value_usd: netValueUsd,
    updated_at: new Date().toISOString(),
  };
}

export async function getKaminoPortfolio() {
  try {
    return await fetchOwnerNetValue();
  } catch (e) {
    console.warn("[kamino] owner net-values failed:", e?.message ?? e);
  }

  return await fetchObligationPnl();
}
