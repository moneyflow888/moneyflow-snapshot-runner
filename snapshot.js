import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ethers } from "ethers";

/**
 * =========================================
 * Env helpers
 * =========================================
 */
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

/**
 * =========================================
 * Prices (CoinGecko)
 * =========================================
 */
async function fetchPricesUsd(symbols) {
  const map = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
  };

  const ids = [...new Set(symbols.map((s) => map[s]).filter(Boolean))];
  if (ids.length === 0) return {};

  const url = "https://api.coingecko.com/api/v3/simple/price";
  const { data } = await axios.get(url, {
    params: { ids: ids.join(","), vs_currencies: "usd" },
    timeout: 15000,
  });

  const out = {};
  if (data?.bitcoin?.usd != null) out.BTC = Number(data.bitcoin.usd);
  if (data?.ethereum?.usd != null) out.ETH = Number(data.ethereum.usd);
  if (data?.solana?.usd != null) out.SOL = Number(data.solana.usd);
  return out;
}

/**
 * =========================================
 * Supabase
 * =========================================
 */
const SUPABASE_URL = must("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = must("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function writeNavSnapshot({ ts, nav_usd, meta }) {
  const r = await supabase.from("nav_snapshots").insert([{ ts, nav_usd, meta }]);
  if (r.error) {
    throw new Error(`Supabase insert nav_snapshots failed: ${r.error.message}`);
  }
}

async function writeWtdLiveSnapshot({ ts, pnl_usd, pnl_pct, nav_usd, note }) {
  const r = await supabase.from("wtd_live_snapshots").insert([
    {
      ts,
      pnl_usd,
      pnl_pct,
      nav_usd,
      note: note || null,
    },
  ]);

  if (r.error) {
    throw new Error(`Supabase insert wtd_live_snapshots failed: ${r.error.message}`);
  }
}

/**
 * =========================================
 * MoneyFlow Axis public API
 * =========================================
 */
const MONEYFLOW_AXIS_BASE_URL =
  env("MONEYFLOW_AXIS_BASE_URL") || env("NEXT_PUBLIC_BASE_URL") || "https://moneyflow-axis.vercel.app";

async function fetchPnlWeek() {
  const base = MONEYFLOW_AXIS_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/api/public/pnl-week`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const j = await readJson(res);
  if (!j.ok) {
    throw new Error(`pnl-week HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);
  }

  const data = j.data || {};
  return {
    pnl_usd: num(data?.pnl_usd ?? data?.pnl ?? 0),
    pnl_pct: num(data?.pnl_pct ?? 0),
    raw: data,
  };
}

/**
 * =========================================
 * OKX CEX (v5) signed request
 * =========================================
 */
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

  const url = `${OKX_BASE_URL}${requestPath}`;
  const res = await fetch(url, {
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

/** Trading account 的 totalEq */
async function getOkxCexEquityUsdApprox() {
  const data = await okxCexRequest({ method: "GET", requestPath: "/api/v5/account/balance" });
  return num(data?.data?.[0]?.totalEq);
}

/**
 * =========================================
 * Wallet addresses
 * =========================================
 */
const SOL_WALLET_ADDRESS = env("SOL_WALLET_ADDRESS");
const ETH_WALLET_ADDRESS = env("ETH_WALLET_ADDRESS");

/**
 * BTC 錢包地址
 * - 可用 env 覆蓋
 * - 沒設就直接用你提供的地址
 */
const BTC_WALLET_ADDRESS =
  env("BTC_WALLET_ADDRESS") || "bc1qxqkrlgtp4n7gqvy2nl60nsr57rsacd4keq0qlq";

/**
 * =========================================
 * Wallet RPC (ETH + SOL)
 * =========================================
 */
const SOLANA_RPC_URL = env("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";

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

/**
 * ---- Solana SPL mints ----
 */
const SOL_MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KZcQw2YQkM1Zq8hY1n9",
};

async function fetchSolWallet(ownerStr) {
  if (!ownerStr) return { assets: [] };

  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const owner = new PublicKey(ownerStr);

  const lamports = await connection.getBalance(owner);
  const sol = lamports / LAMPORTS_PER_SOL;

  const resp = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  const tokenAccounts = resp?.value || [];
  const mintToAmount = new Map();

  for (const ta of tokenAccounts) {
    const info = ta.account?.data?.parsed?.info;
    const mint = info?.mint;
    const uiAmount = Number(info?.tokenAmount?.uiAmount);
    if (!mint || !Number.isFinite(uiAmount) || uiAmount <= 0) continue;
    mintToAmount.set(mint, (mintToAmount.get(mint) || 0) + uiAmount);
  }

  const assets = [{ symbol: "SOL", amount: sol }];

  for (const [sym, mint] of Object.entries(SOL_MINTS)) {
    const amt = mintToAmount.get(mint) || 0;
    if (amt > 0) assets.push({ symbol: sym, amount: amt });
  }

  return { assets };
}

/**
 * ---- Ethereum ERC20 ----
 */
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
  if (!ownerStr) return { assets: [] };

  const provider = await makeWorkingEvmProvider();

  const wei = await provider.getBalance(ownerStr);
  const eth = Number(ethers.formatEther(wei));

  const assets = [{ symbol: "ETH", amount: eth }];

  for (const [sym, t] of Object.entries(EVM_TOKENS)) {
    try {
      const c = new ethers.Contract(t.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(ownerStr);
      const amt = Number(ethers.formatUnits(bal, t.decimals));
      if (Number.isFinite(amt) && amt > 0) assets.push({ symbol: sym, amount: amt });
    } catch (e) {
      console.log(`[rpc:eth:${sym}] failed (skip):`, e?.message || e);
    }
  }

  return { assets };
}

/**
 * =========================================
 * BTC wallet balance
 * =========================================
 * 使用公開 API：
 * - Blockstream
 * - mempool.space
 */
const BTC_ADDRESS_API_CANDIDATES = [
  "https://blockstream.info/api",
  "https://mempool.space/api",
];

async function fetchBtcWallet(address) {
  if (!address) return { assets: [], raw: null };

  let lastErr = null;

  for (const base of BTC_ADDRESS_API_CANDIDATES) {
    try {
      const url = `${base}/address/${encodeURIComponent(address)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const j = await readJson(res);
      if (!j.ok) throw new Error(`BTC address API HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);

      const chainFunded = num(j.data?.chain_stats?.funded_txo_sum);
      const chainSpent = num(j.data?.chain_stats?.spent_txo_sum);
      const mempoolFunded = num(j.data?.mempool_stats?.funded_txo_sum);
      const mempoolSpent = num(j.data?.mempool_stats?.spent_txo_sum);

      const sats = chainFunded - chainSpent + mempoolFunded - mempoolSpent;
      const btc = sats / 100_000_000;

      return {
        assets: [{ symbol: "BTC", amount: btc }],
        raw: {
          provider: base,
          sats,
          chainFunded,
          chainSpent,
          mempoolFunded,
          mempoolSpent,
        },
      };
    } catch (e) {
      lastErr = e;
      console.log(`[rpc:btc] provider failed ${base}:`, e?.message || e);
    }
  }

  throw lastErr || new Error("BTC wallet fetch failed");
}

/**
 * =========================================
 * OKX Web3 DeFi (倉位估值)
 * =========================================
 */
const OKX_WEB3_API_KEY = env("OKX_WEB3_API_KEY");
const OKX_WEB3_API_SECRET = env("OKX_WEB3_API_SECRET");
const OKX_WEB3_API_PASSPHRASE = env("OKX_WEB3_API_PASSPHRASE");
const OKX_WEB3_PROJECT = env("OKX_WEB3_PROJECT") || env("OKX_WEB3_PROJECT_ID") || "";

const OKX_WEB3_BASE_URL = env("OKX_WEB3_BASE_URL") || "https://web3.okx.com";
const OKX_WEB3_ETH_CHAIN_ID = env("OKX_WEB3_ETH_CHAIN_ID") || "1";
const OKX_WEB3_SOL_CHAIN_ID = env("OKX_WEB3_SOL_CHAIN_ID") || "501";

function web3Enabled() {
  return !!(OKX_WEB3_API_KEY && OKX_WEB3_API_SECRET && OKX_WEB3_API_PASSPHRASE);
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

  const url = `${OKX_WEB3_BASE_URL}${path}`;
  const res = await fetch(url, { method, headers, body });

  const j = await readJson(res);
  if (!j.ok) throw new Error(`OKX WEB3 HTTP ${j.status}: ${j.raw || JSON.stringify(j.data)}`);
  return j.data;
}

async function okxWeb3RequestWithRetry(args, maxRetry = 6) {
  let lastErr = null;

  for (let i = 0; i < maxRetry; i++) {
    try {
      return await okxWeb3Request(args);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      const is429 =
        msg.includes("HTTP 429") ||
        msg.includes("50011") ||
        msg.toLowerCase().includes("too many requests");

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

  const payload = {
    walletAddressList: [{ chainId: String(chainId), walletAddress: String(walletAddress) }],
  };

  const data = await okxWeb3RequestWithRetry({
    path: "/api/v5/defi/user/asset/platform/list",
    bodyObj: payload,
  });

  const list = data?.data?.walletIdPlatformList?.[0]?.platformList || [];
  const platforms = Array.isArray(list) ? list : [];

  const usd = platforms.reduce((acc, p) => acc + num(p?.currencyAmount), 0);

  return {
    usd,
    platforms: platforms.map((p) => ({
      platformName: p?.platformName,
      currencyAmount: num(p?.currencyAmount),
      investmentCount: p?.investmentCount,
    })),
  };
}

/**
 * =========================================
 * Main
 * =========================================
 */
async function main() {
  const ts = new Date().toISOString();

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
    btc_address: BTC_WALLET_ADDRESS ? "ok" : "(empty)",
    axis_base_url: MONEYFLOW_AXIS_BASE_URL ? "ok" : "(empty)",
  });

  // 1) OKX CEX
  const cexUsd = await getOkxCexEquityUsdApprox();

  // 2) Wallet RPC (ETH / SOL / BTC)
  let ethWallet = { assets: [] };
  let solWallet = { assets: [] };
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
  }

  try {
    btcWallet = await fetchBtcWallet(BTC_WALLET_ADDRESS);
  } catch (e) {
    console.log("[rpc:btc] failed (still ok):", e?.message || e);
  }

  // 3) OKX Web3 DeFi USD
  let ethDefi = { usd: 0, platforms: [] };
  let solDefi = { usd: 0, platforms: [] };

  if (web3Enabled()) {
    try {
      ethDefi = await getOkxWeb3DefiUsd({
        chainId: OKX_WEB3_ETH_CHAIN_ID,
        walletAddress: ETH_WALLET_ADDRESS,
      });
    } catch (e) {
      console.log("[web3 ETH] failed -> use 0. reason=", e?.message || e);
    }

    await sleep(250);

    try {
      solDefi = await getOkxWeb3DefiUsd({
        chainId: OKX_WEB3_SOL_CHAIN_ID,
        walletAddress: SOL_WALLET_ADDRESS,
      });
    } catch (e) {
      console.log("[web3 SOL] failed -> use 0. reason=", e?.message || e);
    }
  } else {
    console.log("[web3] disabled: missing OKX_WEB3_*");
  }

  /**
   * 4) Wallet valuation
   * - ETH / SOL / BTC 用 CoinGecko
   * - USDC / USDT assume 1 USD
   */
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

  // NAV = CEX + DeFi + Wallet
  const nav_usd =
    cexUsd +
    ethDefi.usd +
    solDefi.usd +
    ethWalletUsd +
    solWalletUsd +
    btcWalletUsd;

  const breakdown_rollup = {
    okx_cex_usd: cexUsd,
    okx_web3_defi_eth_usd: ethDefi.usd,
    okx_web3_defi_sol_usd: solDefi.usd,
    eth_wallet_usd: ethWalletUsd,
    sol_wallet_usd: solWalletUsd,
    btc_wallet_usd: btcWalletUsd,
  };

  const meta = {
    source:
      "okx_cex(totalEq) + okx_web3_defi(platform_list) + wallet_rpc(eth/sol + usdc/usdt + btc)",
    breakdown_rollup,
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
    },
  };

  console.log(`[${ts}] NAV(USD)=${nav_usd.toFixed(2)} breakdown=`, {
    ...breakdown_rollup,
    eth_wallet_detail: { ETH: ethAmount, USDC: ethUsdc, USDT: ethUsdt },
    sol_wallet_detail: { SOL: solAmount, USDC: solUsdc, USDT: solUsdt },
    btc_wallet_detail: { BTC: btcAmount },
  });

  // 5) 先寫 NAV
  await writeNavSnapshot({ ts, nav_usd, meta });
  console.log("✅ nav_snapshots inserted (with meta)");

  // 6) 再寫 WTD live snapshot
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
