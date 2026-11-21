import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ethers } from "ethers";


const env = (k) => (process.env[k] ?? "").toString().trim();

function must(k) {
  const v = env(k);
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null, raw: text };
  } catch {
    return { ok: res.ok, status: res.status, data: { raw: text }, raw: text };
  }
}


async function fetchPricesUsd(symbols) {
  const map = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
  const ids = [...new Set(symbols.map((s) => map[s]).filter(Boolean))];
  if (ids.length === 0) return {};

  const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
    params: { ids: ids.join(","), vs_currencies: "usd" },
    timeout: 15000,
  });

  const out = {};
  if (data?.bitcoin?.usd != null) out.BTC = Number(data.bitcoin.usd);
  if (data?.ethereum?.usd != null) out.ETH = Number(data.ethereum.usd);
  if (data?.solana?.usd != null) out.SOL = Number(data.solana.usd);
  return out;
}

const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function writeNavSnapshot({ ts, nav_usd, meta }) {
  const r = await supabase.from("nav_snapshots").insert([{ ts, nav_usd, meta }]);
  if (r.error) throw new Error(`Supabase insert nav_snapshots failed: ${r.error.message}`);
}

async function writeWtdLiveSnapshot({ ts, pnl_usd, pnl_pct, nav_usd, note }) {
  const r = await supabase.from("wtd_live_snapshots").insert([
    { ts, pnl_usd, pnl_pct, nav_usd, note: note || null },
  ]);
  if (r.error) throw new Error(`Supabase insert wtd_live_snapshots failed: ${r.error.message}`);
}

async function getLatestNavSnapshot() {
  const r = await supabase
    .from("nav_snapshots")
    .select("ts, nav_usd, meta")
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (r.error) throw new Error(`Supabase read latest nav_snapshots failed: ${r.error.message}`);
  return r.data || null;
}

const MONEYFLOW_AXIS_BASE_URL =
  env("MONEYFLOW_AXIS_BASE_URL") || env("NEXT_PUBLIC_BASE_URL") || "https://moneyflow-axis.vercel.app";

async function fetchPnlWeek() {
  const base = MONEYFLOW_AXIS_BASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/public/pnl-week`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const j = await readJson(res);
  if (!j.ok) throw new Error(`pnl-week HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);

  const data = j.data || {};
  if (data.ok !== true || data.pnl_usd == null || data.pnl_pct == null || !Number.isFinite(Number(data.pnl_usd)) || !Number.isFinite(Number(data.pnl_pct))) {
    throw new Error("pnl-week did not return valid PnL; WTD snapshot was not written");
  }
  return {
    pnl_usd: num(data?.pnl_usd ?? data?.pnl ?? 0),
    pnl_pct: num(data?.pnl_pct ?? 0),
    raw: data,
  };
}

const OKX_API_KEY = must("OKX_API_KEY");
const OKX_API_SECRET = must("OKX_API_SECRET");
const OKX_API_PASSPHRASE = must("OKX_API_PASSPHRASE");
const OKX_BASE_URL = env("OKX_BASE_URL") || "https://www.okx.com";

function okxSign({ secret, timestamp, method, requestPath, body }) {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body || ""}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

async function okxCexRequest({ method, requestPath, bodyObj }) {
  const ts = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const sign = okxSign({ secret: OKX_API_SECRET, timestamp: ts, method, requestPath, body });

  const res = await fetch(`${OKX_BASE_URL}${requestPath}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": OKX_API_KEY,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": OKX_API_PASSPHRASE,
      "Content-Type": "application/json",
    },
    body: bodyObj ? body : undefined,
  });

  const j = await readJson(res);
  if (!j.ok) throw new Error(`OKX CEX HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);
  return j.data;
}

async function getOkxCexEquityUsdApprox() {
  const data = await okxCexRequest({ method: "GET", requestPath: "/api/v5/account/balance" });
  return num(data?.data?.[0]?.totalEq);
}

const SOL_WALLET_ADDRESS = env("SOL_WALLET_ADDRESS");
const ETH_WALLET_ADDRESS = env("ETH_WALLET_ADDRESS");

const BTC_WALLET_ADDRESS =
  env("BTC_WALLET_ADDRESS") || "bc1qxqkrlgtp4n7gqvy2nl60nsr57rsacd4keq0qlq";

/**
 * SOL RPC 備援清單
 *
 * GitHub Secrets 建議新增：
 * SOLANA_RPC_URLS=https://你的helius_rpc,https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com
 *
 * 如果你還沒新增 SOLANA_RPC_URLS，
 * 這裡也會相容舊的 SOLANA_RPC_URL。
 */
const SOLANA_RPC_URLS = (
  env("SOLANA_RPC_URLS") ||
  env("SOLANA_RPC_URL") ||
  "https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ETH_RPC_URLS = (env("ETH_RPC_URLS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ETH_RPC_CANDIDATES = [
  ...ETH_RPC_URLS,
  env("ETH_RPC_URL"),
  "https://ethereum.publicnode.com",
  "https://eth.llamarpc.com",
].filter(Boolean);

const SOL_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KZcQw2YQkM1Zq8hY1n9",
};

async function getWorkingSolConnection() {
  let lastErr = null;

  for (const url of [...new Set(SOLANA_RPC_URLS)]) {
    try {
      const connection = new Connection(url, "confirmed");

      await Promise.race([
        connection.getVersion(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SOL RPC timeout")), 8000)
        ),
      ]);

      console.log("[rpc:sol] OK:", url);
      return { connection, rpcUrl: url };
    } catch (e) {
      lastErr = e;
      console.log("[rpc:sol] failed:", url, e?.message || e);
    }
  }

  throw lastErr || new Error("No working SOL RPC");
}

async function fetchSolWallet(ownerStr) {
  if (!ownerStr) {
    return {
      assets: [],
      debug: {
        status: "empty_wallet_address",
        rpc_used: null,
        error: null,
      },
    };
  }

  const { connection, rpcUrl } = await getWorkingSolConnection();
  const owner = new PublicKey(ownerStr);

  const lamports = await Promise.race([
    connection.getBalance(owner),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SOL getBalance timeout")), 12000)
    ),
  ]);

  const sol = lamports / LAMPORTS_PER_SOL;

  const resp = await Promise.race([
    connection.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SOL getParsedTokenAccountsByOwner timeout")), 12000)
    ),
  ]);

  const mintToAmount = new Map();

  for (const ta of resp?.value || []) {
    const info = ta.account?.data?.parsed?.info;
    const mint = info?.mint;
    const uiAmount = Number(info?.tokenAmount?.uiAmount);
    if (!mint || !Number.isFinite(uiAmount) || uiAmount <= 0) continue;
    mintToAmount.set(mint, (mintToAmount.get(mint) || 0) + uiAmount);
  }

  const assets = [];

  if (sol > 0) {
    assets.push({ symbol: "SOL", amount: sol });
  }

  for (const [sym, mint] of Object.entries(SOL_MINTS)) {
    const amt = mintToAmount.get(mint) || 0;
    if (amt > 0) assets.push({ symbol: sym, amount: amt });
  }

  return {
    assets,
    debug: {
      status: "ok",
      rpc_used: rpcUrl,
      token_accounts_count: resp?.value?.length || 0,
      error: null,
    },
  };
}

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

const EVM_TOKENS = {
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
};

async function fetchEthWallet(ownerStr) {
  if (!ownerStr) {
    return { assets: [] };
  }

  let lastAssets = [];

  for (const url of [...new Set(ETH_RPC_CANDIDATES)]) {
    try {
      console.log("[rpc:eth] try:", url);

      const provider = new ethers.JsonRpcProvider(url);

      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("ETH RPC timeout")),
            8000
          )
        ),
      ]);

      const wei =
        await provider.getBalance(
          ownerStr
        );

      const eth =
        Number(
          ethers.formatEther(wei)
        );

      const assets = [];

      assets.push({
        symbol: "ETH",
        amount: eth,
      });

      for (const [sym, t] of Object.entries(EVM_TOKENS)) {
        try {
          const c =
            new ethers.Contract(
              t.address,
              ERC20_ABI,
              provider
            );

          const bal =
            await c.balanceOf(
              ownerStr
            );

          const amt =
            Number(
              ethers.formatUnits(
                bal,
                t.decimals
              )
            );

          if (
            Number.isFinite(amt)
            && amt > 0
          ) {
            assets.push({
              symbol: sym,
              amount: amt,
            });
          }

        } catch {}
      }

      const ethAmt =
        Number(
          assets.find(
            x=>x.symbol==="ETH"
          )?.amount || 0
        );

      const usdc =
        Number(
          assets.find(
            x=>x.symbol==="USDC"
          )?.amount || 0
        );

      const usdt =
        Number(
          assets.find(
            x=>x.symbol==="USDT"
          )?.amount || 0
        );

      const allZero =
        ethAmt<=0 &&
        usdc<=0 &&
        usdt<=0;

      if (allZero) {
        console.log(
          "[rpc:eth] empty -> try next:",
          url
        );

        lastAssets = assets;

        continue;
      }

      console.log(
        "[rpc:eth] success:",
        url
      );

      return {
        assets
      };

    } catch(e){

      console.log(
        "[rpc:eth] failed:",
        url,
        e?.message || e
      );

    }
  }

  return {
    assets:lastAssets
  };
}

/* =========================
   BTC wallet fallback
========================= */

const BTC_ADDRESS_API_CANDIDATES = [
  "https://blockstream.info/api",
  "https://mempool.space/api",
];

async function fetchBtcFromProvider({
  base,
  address
}) {

  const res =
    await fetch(
      `${base}/address/${encodeURIComponent(address)}`,
      {
        method:"GET",
        headers:{
          Accept:"application/json"
        }
      }
    );

  const j =
    await readJson(res);

  if(!j.ok){

    throw new Error(
      `BTC API HTTP ${j.status}`
    );

  }

  const chainFunded =
    num(
      j.data?.chain_stats?.funded_txo_sum
    );

  const chainSpent =
    num(
      j.data?.chain_stats?.spent_txo_sum
    );

  const mempoolFunded =
    num(
      j.data?.mempool_stats?.funded_txo_sum
    );

  const mempoolSpent =
    num(
      j.data?.mempool_stats?.spent_txo_sum
    );

  const sats =
    chainFunded
    -chainSpent
    +mempoolFunded
    -mempoolSpent;

  const btc =
    sats/100000000;

  return {

    btc,

    raw:{

      provider:base,

      sats,

      chainFunded,

      chainSpent,

      mempoolFunded,

      mempoolSpent

    }

  };

}


async function fetchBtcWallet(
  address
){

  if(!address){

    return {
      assets:[],
      raw:null
    };

  }

  let lastZero=null;

  let lastErr=null;


  for(
    const base
    of BTC_ADDRESS_API_CANDIDATES
  ){

    try{

      console.log(
        "[rpc:btc] try:",
        base
      );

      const r=
        await fetchBtcFromProvider({

          base,

          address

        });


      if(
        r.btc>0
      ){

        console.log(
          "[rpc:btc] success:",
          base,
          r.btc
        );

        return {

          assets:[
            {
              symbol:"BTC",
              amount:r.btc
            }
          ],

          raw:{
            ...r.raw,

            status:"ok",

            used_zero_confirmation:false
          }

        };

      }


      console.log(
        "[rpc:btc] zero -> try next:",
        base
      );

      lastZero={

        assets:[
          {
            symbol:"BTC",
            amount:0
          }
        ],

        raw:{

          ...r.raw,

          status:"zero_confirming",

          used_zero_confirmation:true

        }

      };


    }catch(e){

      lastErr=e;

      console.log(

        "[rpc:btc] failed:",

        base,

        e?.message||e

      );

    }

  }


  if(lastZero){

    console.log(
      "[rpc:btc] confirmed zero"
    );

    return {

      assets:[
        {
          symbol:"BTC",
          amount:0
        }
      ],

      raw:{

        ...lastZero.raw,

        status:"confirmed_zero",

        error:
          lastErr?.message
          ||null

      }

    };

  }


  throw (

    lastErr ||

    new Error(
      "BTC fetch failed"
    )

  );

}


async function main() {
  const ts = new Date().toISOString();
  const latestSnapshot = await getLatestNavSnapshot();

  console.log("[env-check]", {
    supabase_url: SUPABASE_URL ? "ok" : "missing",
    supabase_key: SUPABASE_SERVICE_ROLE_KEY ? "ok" : "missing",
    okx_cex_key: OKX_API_KEY ? "ok" : "missing",
    okx_cex_pass: OKX_API_PASSPHRASE ? "ok" : "missing",
    eth_address: ETH_WALLET_ADDRESS ? "ok" : "(empty)",
    sol_address: SOL_WALLET_ADDRESS ? "ok" : "(empty)",
    sol_rpc_count: SOLANA_RPC_URLS.length,
sol_rpc_urls: SOLANA_RPC_URLS,

btc_address: BTC_WALLET_ADDRESS ? "ok" : "(empty)",
    axis_base_url: MONEYFLOW_AXIS_BASE_URL ? "ok" : "(empty)",
    previous_nav_present: !!latestSnapshot,
  });

  const cexUsd = await getOkxCexEquityUsdApprox();

  let ethWallet = { assets: [] };
  let solWallet = {
    assets: [],
    debug: {
      status: "not_started",
      rpc_used: null,
      error: null,
    },
  };
  let btcWallet = { assets: [], raw: null };

  try {
    ethWallet = await fetchEthWallet(ETH_WALLET_ADDRESS);
  } catch (e) {
    console.log("[rpc:eth] failed (still ok):", e?.message || e);
  }

  try {
    solWallet = await fetchSolWallet(SOL_WALLET_ADDRESS);
  } catch (e) {
    console.log("[rpc:sol] failed (still ok):", e?.message || e);
    solWallet = {
      assets: [],
      debug: {
        status: "failed",
        rpc_used: null,
        error: e?.message || String(e),
      },
    };
  }

  try {
    btcWallet = await fetchBtcWallet(BTC_WALLET_ADDRESS);
  } catch (e) {
    console.log("[rpc:btc] failed (still ok):", e?.message || e);
  }

  const ethAmount = Number(ethWallet.assets?.find((x) => x.symbol === "ETH")?.amount || 0);
  const solAmount = Number(solWallet.assets?.find((x) => x.symbol === "SOL")?.amount || 0);
  const btcAmount = Number(btcWallet.assets?.find((x) => x.symbol === "BTC")?.amount || 0);

  const ethUsdc = Number(ethWallet.assets?.find((x) => x.symbol === "USDC")?.amount || 0);
  const ethUsdt = Number(ethWallet.assets?.find((x) => x.symbol === "USDT")?.amount || 0);

  const solUsdc = Number(solWallet.assets?.find((x) => x.symbol === "USDC")?.amount || 0);
  const solUsdt = Number(solWallet.assets?.find((x) => x.symbol === "USDT")?.amount || 0);


  let prices = {};
  let ethWalletUsd = 0;
  let solWalletUsd = 0;
  let btcWalletUsd = 0;

  try {
    prices = await fetchPricesUsd(["BTC", "ETH", "SOL"]);

    ethWalletUsd = ethAmount * (prices.ETH || 0) + ethUsdc + ethUsdt;
    solWalletUsd = solAmount * (prices.SOL || 0) + solUsdc + solUsdt;
    btcWalletUsd = btcAmount * (prices.BTC || 0);
  } catch (e) {
    console.log("[prices] failed -> wallet usd uses stablecoins only:", e?.message || e);
    ethWalletUsd = ethUsdc + ethUsdt;
    solWalletUsd = solUsdc + solUsdt;
    btcWalletUsd = 0;
  }


  const nav_usd =
    cexUsd +
    ethWalletUsd +
    solWalletUsd +
    btcWalletUsd;

  const previousNavUsd = num(latestSnapshot?.nav_usd);
  const navDropPct = previousNavUsd > 0 ? ((previousNavUsd - nav_usd) / previousNavUsd) * 100 : 0;

  const breakdown_rollup = {
    okx_cex_usd: cexUsd,
    eth_wallet_usd: ethWalletUsd,
    sol_wallet_usd: solWalletUsd,
    btc_wallet_usd: btcWalletUsd,
  };

  const meta = {
  source: "okx_cex(totalEq) + wallet_rpc(eth/sol + usdc/usdt + btc)",
  breakdown_rollup,

 rpc_wallet_status: {
  eth_wallet_usd:
    ethWallet.assets?.length > 0
      ? "ok"
      : "error",

  sol_wallet_usd:
    solWallet.debug?.status === "ok"
      ? "ok"
      : solWallet.debug?.status === "failed" ||
          solWallet.debug?.status === "empty_wallet_address"
        ? "error"
        : "fallback",

  btc_wallet_usd:
    btcWallet.raw?.status === "ok"
      ? "ok"
      : btcWallet.raw?.status
        ? "fallback"
        : "error",
},

    rpc_wallet_assets: {
      eth: ethWallet.assets,
      sol: solWallet.assets,
      btc: btcWallet.assets,
    },

    rpc_wallet_usd: {
      eth_wallet_usd: ethWalletUsd,
      sol_wallet_usd: solWalletUsd,
      btc_wallet_usd: btcWalletUsd,
      eth: { ETH: ethAmount, USDC: ethUsdc, USDT: ethUsdt },
      sol: { SOL: solAmount, USDC: solUsdc, USDT: solUsdt },
      btc: { BTC: btcAmount },
      prices_used: prices,
    },

    btc_wallet_debug: btcWallet.raw || null,

    debug: {
      btc_wallet_address: BTC_WALLET_ADDRESS,
      axis_base_url: MONEYFLOW_AXIS_BASE_URL,

      sol_rpc: {
        rpc_urls_count: SOLANA_RPC_URLS.length,
        wallet_fetch: solWallet.debug || null,
      },

      previous_snapshot: latestSnapshot
        ? {
            ts: latestSnapshot.ts,
            nav_usd: previousNavUsd,
          }
        : null,

      nav_guard: {
        previous_nav_usd: previousNavUsd,
        current_nav_usd: nav_usd,
        nav_drop_pct: navDropPct,
      },
    },
  };

  console.log(`[${ts}] NAV(USD)=${nav_usd.toFixed(2)} breakdown=`, {
    ...breakdown_rollup,
    eth_wallet_detail: { ETH: ethAmount, USDC: ethUsdc, USDT: ethUsdt },
    btc_wallet_detail: { BTC: btcAmount },
    prices_used: prices,
    sol_rpc: meta.debug.sol_rpc,
    previous_nav_usd: previousNavUsd,
    nav_drop_pct: navDropPct,
  });

  await writeNavSnapshot({ ts, nav_usd, meta });
  console.log("✅ nav_snapshots inserted (with meta)");

  try {
    const pnlWeek = await fetchPnlWeek();

    await writeWtdLiveSnapshot({
      ts,
      pnl_usd: pnlWeek.pnl_usd,
      pnl_pct: pnlWeek.pnl_pct,
      nav_usd,
      note: "snapshot-runner",
    });

    console.log("✅ wtd_live_snapshots inserted", {
      pnl_usd: pnlWeek.pnl_usd,
      pnl_pct: pnlWeek.pnl_pct,
    });
  } catch (e) {
    throw new Error(`NAV saved but WTD snapshot failed: ${e?.message || e}`);
  }
}

main().catch((e) => {
  console.error("❌ runner failed:", e);
  process.exit(1);
});
