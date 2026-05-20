const KAMINO_PNL_URL =
  "https://api.kamino.finance/v2/kamino-market/47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8/obligations/F1oMNKJ6iue2QbpE4SBfSjNNXbpAMKjy5BNSDQMw4FA4/pnl/?pnlMode=current_obligation&useStakeRate=false&programId=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getKaminoPortfolio() {
  const res = await fetch(
    KAMINO_PNL_URL
  );

  if (!res.ok) {
    throw new Error(
      `Kamino API failed ${res.status}`
    );
  }

  const data = await res.json();

  const pnlUsd =
    num(data?.usd);

  const investedUsd =
    num(data?.invested?.usd);

  const netValueUsd =
    investedUsd + pnlUsd;

  if (netValueUsd <= 0) {
    throw new Error(
      "invalid net value"
    );
  }

  return {
    source:"kamino",

    investedUsd,

    pnlUsd,

    netValueUsd
  };
}
