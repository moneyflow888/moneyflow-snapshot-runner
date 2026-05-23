import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ethers } from "ethers";
import { getKaminoPortfolio } from "./kamino-portfolio.js";
import { getMorphoPortfolio } from "./morpho-portfolio.js";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function getBreakdownValue(meta, key) {
  return num(meta?.breakdown_rollup?.[key]);
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
  ONYC: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
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

async function makeWorkingEvmProvider() {
  const errors = [];

  for (const url of [...new Set(ETH_RPC_CANDIDATES)]) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      const bn = await Promise.race([
        p.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("RPC timeout")), 8000)),
      ]);
      if (typeof bn === "number") return p;
    } catch (e) {
      errors.push({ url, msg: e?.message || String(e) });
    }
  }

  throw new Error("No working EVM RPC:\n" + errors.map((x) => `- ${x.url}: ${x.msg}`).join("\n"));
}

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


/* 下一段一定直接接這個 */

const OKX_WEB3_API_KEY =
  env(
    "OKX_WEB3_API_KEY"
  );

const OKX_WEB3_API_SECRET = env("OKX_WEB3_API_SECRET");
const OKX_WEB3_API_PASSPHRASE = env("OKX_WEB3_API_PASSPHRASE");
const OKX_WEB3_PROJECT = env("OKX_WEB3_PROJECT") || env("OKX_WEB3_PROJECT_ID") || "";

const OKX_WEB3_BASE_URL = env("OKX_WEB3_BASE_URL") || "https://web3.okx.com";
const OKX_WEB3_ETH_CHAIN_ID = env("OKX_WEB3_ETH_CHAIN_ID") || "1";
const OKX_WEB3_SOL_CHAIN_ID = env("OKX_WEB3_SOL_CHAIN_ID") || "501";

function web3Enabled() {
  return !!(OKX_WEB3_API_KEY && OKX_WEB3_API_SECRET && OKX_WEB3_API_PASSPHRASE);
}

function isOkxWeb3RateLimitMessage(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("http 429") ||
    s.includes("50011") ||
    s.includes("too many requests") ||
    s.includes("rate limit")
  );
}

async function okxWeb3Request({ path, bodyObj }) {
  if (!web3Enabled()) {
    throw new Error("Missing OKX_WEB3_API_KEY / OKX_WEB3_API_SECRET / OKX_WEB3_API_PASSPHRASE");
  }

  const method = "POST";
  const ts = new Date().toISOString();
  const body = JSON.stringify(bodyObj || {});
  const requestPath = path;

  const sign = okxSign({
    secret: OKX_WEB3_API_SECRET,
    timestamp: ts,
    method,
    requestPath,
    body,
  });

  const headers = {
    "OK-ACCESS-KEY": OKX_WEB3_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": OKX_WEB3_API_PASSPHRASE,
    "Content-Type": "application/json",
  };

  if (OKX_WEB3_PROJECT) headers["OK-ACCESS-PROJECT"] = OKX_WEB3_PROJECT;

  const res = await fetch(`${OKX_WEB3_BASE_URL}${path}`, { method, headers, body });
  const j = await readJson(res);

  if (!j.ok) throw new Error(`OKX WEB3 HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);

  const code = String(j?.data?.code ?? "");
  if (code && code !== "0") {
    const msg = j?.data?.msg || j?.data?.message || j?.raw || JSON.stringify(j?.data);
    throw new Error(`OKX WEB3 API code ${code}: ${msg}`);
  }

  return j.data;
}

async function okxWeb3RequestWithRetry(args, maxRetry = 6) {
  let lastErr = null;

  for (let i = 0; i < maxRetry; i++) {
    try {
      return await okxWeb3Request(args);
    } catch (e) {
      lastErr = e;
      const is429 = isOkxWeb3RateLimitMessage(e?.message || "");

      if (is429) {
        const wait = 800 * Math.pow(2, i) + Math.floor(Math.random() * 250);
        console.log(`[OKX_WEB3] 429 retry ${i + 1}/${maxRetry} wait ${wait}ms`);
        await sleep(wait);
        continue;
      }

      throw e;
    }
  }

  throw lastErr;
}

async function getOkxWeb3DefiUsd({ chainId, walletAddress }) {
  if (!walletAddress) return { usd: 0, platforms: [] };

  const data = await okxWeb3RequestWithRetry({
    path: "/api/v5/defi/user/asset/platform/list",
    bodyObj: {
      walletAddressList: [{ chainId: String(chainId), walletAddress: String(walletAddress) }],
    },
  });

  const platforms = data?.data?.walletIdPlatformList?.[0]?.platformList || [];
  const usd = Array.isArray(platforms)
    ? platforms.reduce((acc, p) => acc + num(p?.currencyAmount), 0)
    : 0;

  return {
    usd,
    platforms: Array.isArray(platforms)
      ? platforms.map((p) => ({
          platformName: p?.platformName,
          currencyAmount: num(p?.currencyAmount),
          investmentCount: p?.investmentCount,
        }))
      : [],
  };
}

async function main() {
  const ts = new Date().toISOString();
  const latestSnapshot = await getLatestNavSnapshot();

  console.log("[env-check]", {
    supabase_url: SUPABASE_URL ? "ok" : "missing",
    supabase_key: SUPABASE_SERVICE_ROLE_KEY ? "ok" : "missing",
    okx_cex_key: OKX_API_KEY ? "ok" : "missing",
    okx_cex_pass: OKX_API_PASSPHRASE ? "ok" : "missing",
    okx_web3_key: OKX_WEB3_API_KEY ? "ok" : "(disabled)",
    okx_web3_secret: OKX_WEB3_API_SECRET ? "ok" : "(disabled)",
    okx_web3_pass: OKX_WEB3_API_PASSPHRASE ? "ok" : "(disabled)",
    okx_web3_project: OKX_WEB3_PROJECT ? "ok" : "(empty)",
    eth_address: ETH_WALLET_ADDRESS ? "ok" : "(empty)",
    sol_address: SOL_WALLET_ADDRESS ? "ok" : "(empty)",
    sol_rpc_count: SOLANA_RPC_URLS.length,
sol_rpc_urls: SOLANA_RPC_URLS,

btc_address: BTC_WALLET_ADDRESS ? "ok" : "(empty)",
    axis_base_url: MONEYFLOW_AXIS_BASE_URL ? "ok" : "(empty)",
    onyc_price_usd: env("ONYC_PRICE_USD") || "1.10",
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

  let ethDefi = { usd: 0, platforms: [] };
  let solDefi = { usd: 0, platforms: [] };

  let web3EthStatus = "disabled";
  let web3SolStatus = "disabled";
  let web3EthError = null;
  let web3SolError = null;
  let web3EthUsedFallback = false;
  let web3SolUsedFallback = false;

  let morphoStatus = "pending";
  let morphoError = null;
  let morphoUsedFallback = false;

  let kaminoStatus = "pending";
  let kaminoError = null;
  let kaminoUsedFallback = false;

  const prevEthDefiUsd = getBreakdownValue(latestSnapshot?.meta, "okx_web3_defi_eth_usd");
  const prevSolDefiUsd = getBreakdownValue(latestSnapshot?.meta, "okx_web3_defi_sol_usd");

  try {
    const morpho = await getMorphoPortfolio();

    ethDefi = {
      usd: morpho.total_assets_usd,
      platforms: [
        {
          platformName: "Morpho",
          currencyAmount: morpho.total_assets_usd,
          vaults: morpho.vaults || [],
        },
      ],
    };

    morphoStatus = "ok";
    web3EthStatus = "morpho_ok";

    console.log("[morpho] success:", morpho.total_assets_usd);
  } catch (e) {
    morphoStatus = "fallback_okx";
    morphoError = e?.message || String(e);
    morphoUsedFallback = true;

    console.log("[morpho] failed -> use OKX ETH fallback:", morphoError);

    if (!web3Enabled()) {
      web3EthStatus = "ERROR";
      web3EthError = "Morpho failed and OKX Web3 is disabled";
      throw new Error("Morpho failed and OKX Web3 is disabled");
    }

    try {
      ethDefi = await getOkxWeb3DefiUsd({
        chainId: OKX_WEB3_ETH_CHAIN_ID,
        walletAddress: ETH_WALLET_ADDRESS,
      });

      web3EthStatus = "okx_fallback_ok";
      web3EthUsedFallback = true;

      console.log("[web3 ETH] OKX fallback success:", ethDefi.usd);
    } catch (okxErr) {
      web3EthStatus = "ERROR";
      web3EthError = okxErr?.message || String(okxErr);

      console.log("[morpho+okx] BOTH FAILED", {
        morpho_error: morphoError,
        okx_error: web3EthError,
      });

      throw new Error("Morpho + OKX ETH both failed");
    }
  }

  await sleep(350);

  try {
    const kamino = await getKaminoPortfolio();

    solDefi = {
      usd: kamino.net_value_usd,
      platforms: [
        {
          platformName: "Kamino",
          currencyAmount: kamino.net_value_usd,
        },
      ],
    };

    kaminoStatus = "ok";
    web3SolStatus = "kamino_ok";

    console.log("[kamino] success:", kamino.net_value_usd);
  } catch (e) {
    kaminoStatus = "fallback_okx";
    kaminoError = e?.message || String(e);
    kaminoUsedFallback = true;

    console.log("[kamino] failed -> use OKX SOL fallback:", kaminoError);

    if (!web3Enabled()) {
      web3SolStatus = "ERROR";
      web3SolError = "Kamino failed and OKX Web3 is disabled";
      throw new Error("Kamino failed and OKX Web3 is disabled");
    }

    try {
      solDefi = await getOkxWeb3DefiUsd({
        chainId: OKX_WEB3_SOL_CHAIN_ID,
        walletAddress: SOL_WALLET_ADDRESS,
      });

      web3SolStatus = "okx_fallback_ok";
      web3SolUsedFallback = true;

      console.log("[web3 SOL] OKX fallback success:", solDefi.usd);
    } catch (okxErr) {
      web3SolStatus = "ERROR";
      web3SolError = okxErr?.message || String(okxErr);

      console.log("[kamino+okx] BOTH FAILED", {
        kamino_error: kaminoError,
        okx_error: web3SolError,
      });

      throw new Error("Kamino + OKX SOL both failed");
    }
  }

  const ethAmount = Number(ethWallet.assets?.find((x) => x.symbol === "ETH")?.amount || 0);
  const solAmount = Number(solWallet.assets?.find((x) => x.symbol === "SOL")?.amount || 0);
  const btcAmount = Number(btcWallet.assets?.find((x) => x.symbol === "BTC")?.amount || 0);

  const ethUsdc = Number(ethWallet.assets?.find((x) => x.symbol === "USDC")?.amount || 0);
  const ethUsdt = Number(ethWallet.assets?.find((x) => x.symbol === "USDT")?.amount || 0);

  const solUsdc = Number(solWallet.assets?.find((x) => x.symbol === "USDC")?.amount || 0);
  const solUsdt = Number(solWallet.assets?.find((x) => x.symbol === "USDT")?.amount || 0);
  const solOnyc = Number(solWallet.assets?.find((x) => x.symbol === "ONYC")?.amount || 0);

  const onycPriceUsd = num(env("ONYC_PRICE_USD")) > 0 ? num(env("ONYC_PRICE_USD")) : 1.10;
  const onycWalletUsd = solOnyc * onycPriceUsd;

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

  prices.ONYC = onycPriceUsd;

  const nav_usd =
    cexUsd +
    ethDefi.usd +
    solDefi.usd +
    ethWalletUsd +
    solWalletUsd +
    btcWalletUsd +
    onycWalletUsd;

  const previousNavUsd = num(latestSnapshot?.nav_usd);
  const navDropPct = previousNavUsd > 0 ? ((previousNavUsd - nav_usd) / previousNavUsd) * 100 : 0;

  const breakdown_rollup = {
    okx_cex_usd: cexUsd,
    okx_web3_defi_eth_usd: ethDefi.usd,
    okx_web3_defi_sol_usd: solDefi.usd,
    eth_wallet_usd: ethWalletUsd,
    sol_wallet_usd: solWalletUsd,
    btc_wallet_usd: btcWalletUsd,
    onyc_wallet_usd: onycWalletUsd,
  };

  const meta = {
  source:
    "okx_cex(totalEq) + morpho_or_okx_web3_eth + kamino_or_okx_web3_sol + wallet_rpc(eth/sol + usdc/usdt + btc + onyc)",
  breakdown_rollup,

 rpc_wallet_status: {
  eth_wallet_usd: "error",
  sol_wallet_usd: "fallback",
  btc_wallet_usd: "ok",
},

  morpho: {
      status: morphoStatus,
      source_used: morphoStatus === "ok" ? "morpho_earn_api" : "okx_web3_fallback",
      used_fallback: morphoUsedFallback,
      error: morphoError,
      net_value_usd: ethDefi.usd,
      updated_at: ts,
    },

    kamino: {
      status: kaminoStatus,
      source_used: kaminoStatus === "ok" ? "kamino_portfolio" : "okx_web3_fallback",
      used_fallback: kaminoUsedFallback,
      error: kaminoError,
      net_value_usd: solDefi.usd,
      updated_at: ts,
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
      onyc_wallet_usd: onycWalletUsd,
      eth: { ETH: ethAmount, USDC: ethUsdc, USDT: ethUsdt },
      sol: { SOL: solAmount, USDC: solUsdc, USDT: solUsdt, ONYC: solOnyc },
      btc: { BTC: btcAmount },
      prices_used: prices,
    },

    okx_web3_platforms: {
      eth: ethDefi.platforms,
      sol: solDefi.platforms,
    },

    btc_wallet_debug: btcWallet.raw || null,

    debug: {
      okx_web3_project_present: !!OKX_WEB3_PROJECT,
      okx_web3_base_url: OKX_WEB3_BASE_URL,
      chainIds: { eth: OKX_WEB3_ETH_CHAIN_ID, sol: OKX_WEB3_SOL_CHAIN_ID },
      btc_wallet_address: BTC_WALLET_ADDRESS,
      axis_base_url: MONEYFLOW_AXIS_BASE_URL,
      onyc_mint: SOL_MINTS.ONYC,
      onyc_price_usd: onycPriceUsd,

      sol_rpc: {
        rpc_urls_count: SOLANA_RPC_URLS.length,
        wallet_fetch: solWallet.debug || null,
      },

      previous_snapshot: latestSnapshot
        ? {
            ts: latestSnapshot.ts,
            nav_usd: previousNavUsd,
            okx_web3_defi_eth_usd: prevEthDefiUsd,
            okx_web3_defi_sol_usd: prevSolDefiUsd,
          }
        : null,

      web3_fetch: {
        morpho: {
          status: morphoStatus,
          used_fallback: morphoUsedFallback,
          error: morphoError,
        },
        kamino: {
          status: kaminoStatus,
          used_fallback: kaminoUsedFallback,
          error: kaminoError,
        },
        eth: {
          status: web3EthStatus,
          used_fallback: web3EthUsedFallback,
          error: web3EthError,
        },
        sol: {
          status: web3SolStatus,
          used_fallback: web3SolUsedFallback,
          error: web3SolError,
        },
      },

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
    sol_wallet_detail: { SOL: solAmount, USDC: solUsdc, USDT: solUsdt, ONYC: solOnyc },
    btc_wallet_detail: { BTC: btcAmount },
    prices_used: prices,
    sol_rpc: meta.debug.sol_rpc,
    web3_fetch: meta.debug.web3_fetch,
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
    console.log("[wtd-live-snapshot] failed (still ok):", e?.message || e);
  }
}

main().catch((e) => {
  console.error("❌ runner failed:", e);
  process.exit(1);
});
