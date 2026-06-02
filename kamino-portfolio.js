const KAMINO_OWNER =
  "3SwVwDD7nmn3oXFszyFG7vDQizZXgGLmiFBYYQGWDLui";

const KAMINO_YIELD_ID =
  "59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rangeParams() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);

  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(
    end.toISOString()
  )}`;
}

const HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0",
};

async function fetchJson(url) {
  console.log("[kamino] try:", url);

  const res = await fetch(url, {
    headers: HEADERS,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

function parseHistoryRows(data, sourceUsed) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${sourceUsed} empty`);
  }

  const rows = data
    .map((x) => {
      const klendUsd = num(x?.klendUsd);
      const kvaultsUsd = num(x?.kvaultsUsd);
      const strategiesUsd = num(x?.strategiesUsd);
      const stakingUsd = num(x?.stakingUsd);

      return {
        created_on: x?.createdOn ?? null,
        klend_usd: klendUsd,
        kvaults_usd: kvaultsUsd,
        strategies_usd: strategiesUsd,
        staking_usd: stakingUsd,
        net_value_usd: klendUsd + kvaultsUsd + strategiesUsd + stakingUsd,
      };
    })
    .filter((x) => x.net_value_usd > 0)
    .sort((a, b) => {
      return (
        new Date(a.created_on || 0).getTime() -
        new Date(b.created_on || 0).getTime()
      );
    });

  if (rows.length === 0) {
    throw new Error(`${sourceUsed} no valid net value`);
  }

  const latest = rows[rows.length - 1];

  return {
    source_used: sourceUsed,
    status: "OK",

    klend_usd: latest.klend_usd,
    kvaults_usd: latest.kvaults_usd,
    strategies_usd: latest.strategies_usd,
    staking_usd: latest.staking_usd,

    net_value_usd: latest.net_value_usd,
    updated_at: new Date().toISOString(),
  };
}

async function fetchOwnerNetValues() {
  const url = `https://api.kamino.finance/owners/${KAMINO_OWNER}/net-values/history?${rangeParams()}`;
  const data = await fetchJson(url);
  return parseHistoryRows(data, "kamino_owner_net_values_history");
}

async function fetchYieldHistory() {
  const url = `https://api.kamino.finance/yields/${KAMINO_YIELD_ID}/history?${rangeParams()}`;
  const data = await fetchJson(url);
  return parseHistoryRows(data, "kamino_yields_history");
}

export async function getKaminoPortfolio() {
  try {
    return await fetchOwnerNetValues();
  } catch (e) {
    console.warn("[kamino] owner net-values failed:", e?.message ?? e);
  }

  try {
    return await fetchYieldHistory();
  } catch (e) {
    console.warn("[kamino] yields history failed:", e?.message ?? e);
  }

  throw new Error("Kamino full net value unavailable");
}
