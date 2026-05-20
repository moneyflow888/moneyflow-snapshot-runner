const MORPHO_EARN_URL =
  "https://app.morpho.org/api/positions/earn?userAddress=0xdAd1feDf4229ED9FE71a966a616691BF1c2C47a6&limit=500&skip=0&chainIds=1%2C8453%2C137%2C130%2C747474%2C42161%2C999%2C10%2C143%2C988%2C480%2C4217&orderBy=assetsUsd&orderDirection=DESC&faceting=true";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getMorphoPortfolio() {
  const res = await fetch(MORPHO_EARN_URL, {
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Morpho API failed: ${res.status}`);
  }

  const data = await res.json();

  const totalAssetsUsd = num(data?.totalAssetsUsd);

  if (totalAssetsUsd <= 0) {
    throw new Error("Morpho totalAssetsUsd invalid");
  }

  return {
    source_used: "morpho_earn_api",
    status: "OK",
    total_assets_usd: totalAssetsUsd,
    vaults: Array.isArray(data?.items)
      ? data.items.map((x) => ({
          name: x?.vault?.name ?? null,
          assets_usd: num(x?.assetsUsd),
          pnl_usd: num(x?.pnlUsd),
          asset_symbol: x?.vault?.asset?.symbol ?? null,
          chain_id: x?.vault?.chainId ?? null,
        }))
      : [],
    updated_at: new Date().toISOString(),
  };
}
