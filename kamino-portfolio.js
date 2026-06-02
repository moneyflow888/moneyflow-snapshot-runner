const KAMINO_OWNER =
  "3SwVwDD7nmn3oXFSzyFG7vDQizZxGgLmiFBYYQGWDLui";

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

function getRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.history)) return data.history;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.result)) return data.result;
  return [];
}

function pickNumber(x, keys) {
  for (const key of keys) {
    const n = num(x?.[key]);
    if (n > 0) return n;
  }
  return 0;
}

function parseHistoryRows(data, sourceUsed) {
  const rawRows = getRows(data);

  if (rawRows.length === 0) {
    console.log("[kamino] raw response:", JSON.stringify(data).slice(0, 1000));
    throw new Error(`${sourceUsed} empty`);
  }

  console.log("[kamino] rows:", rawRows.length);
  console.log(
    "[kamino] latest sample:",
    JSON.stringify(rawRows[rawRows.length - 1]).slice(0, 1000)
  );

  const rows = rawRows
    .map((x) => {
      const klendUsd = pickNumber(x, ["klendUsd", "klend_usd", "klend"]);
      const kvaultsUsd = pickNumber(x, ["kvaultsUsd", "kvaults_usd", "kvaults"]);
      const strategiesUsd = pickNumber(x, [
        "strategiesUsd",
        "strategies_usd",
        "strategies",
      ]);
      const stakingUsd = pickNumber(x, ["stakingUsd", "staking_usd", "staking"]);

      return {
        created_on: x?.createdOn ?? x?.created_on ?? x?.timestamp ?? x?.ts ?? null,
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
