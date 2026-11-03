// The person's own Sui wallet, through the Wallet Standard. Edith never sees a private key:
// the wallet signs the sign-in message once, and then each payment the person approves.
import { getWallets, signTransaction } from "@mysten/wallet-standard";
import { Transaction } from "@mysten/sui/transactions";

const REMEMBERED = "edith.wallet";
const can = (wallet, ...features) => features.some((f) => f in wallet.features);

const usable = (wallet) =>
  can(wallet, "standard:connect") && can(wallet, "sui:signPersonalMessage", "sui:signMessage") && can(wallet, "sui:signTransaction", "sui:signTransactionBlock") &&
  wallet.chains.some((c) => c.startsWith("sui:"));

export class WalletError extends Error {
  constructor(message, { declined = false } = {}) {
    super(message);
    this.declined = declined;
  }
}

// Wallets phrase a refusal in many ways; all of them mean the person said no.
function isDeclined(err) {
  return err?.code === 4001 || /reject|denied|declin|cancel|user (closed|abort)/i.test(String(err?.message ?? err));
}

function wrap(err, action) {
  if (err instanceof WalletError) return err;
  if (isDeclined(err)) return new WalletError(`You declined ${action} in your wallet.`, { declined: true });
  return new WalletError(`Your wallet couldn't complete ${action}${err?.message ? `: ${err.message}` : "."}`);
}

const remember = (name) => { try { localStorage.setItem(REMEMBERED, name); } catch { /* storage unavailable */ } };
const recalled = () => { try { return localStorage.getItem(REMEMBERED); } catch { return null; } };
const forget = () => { try { localStorage.removeItem(REMEMBERED); } catch { /* storage unavailable */ } };

export function createWallets(network) {
  const registry = getWallets();
  const chain = `sui:${network}`;
  let wallet = null;
  let account = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  // Extensions can register after the page has loaded. If the wallet used last time shows up late,
  // reconnect it silently once someone has asked for that.
  let waitingFor = null;
  registry.on("register", (...added) => {
    if (!wallet && waitingFor && added.some((w) => w.name === waitingFor)) reconnect();
    notify();
  });
  registry.on("unregister", notify);

  const list = () => registry.get().filter(usable);

  function use(next, accounts) {
    wallet = next;
    account = accounts[0] ?? null;
    if (!account) throw new WalletError(`${next.name} didn't share an account. Unlock it and try again.`);
    remember(next.name);
    next.features["standard:events"]?.on("change", ({ accounts: changed }) => {
      if (changed) account = changed[0] ?? null;
      notify();
    });
    notify();
    return account.address;
  }

  async function connect(next) {
    try {
      const { accounts } = await next.features["standard:connect"].connect();
      return use(next, accounts);
    } catch (err) {
      throw wrap(err, "the connection");
    }
  }

  // Reconnects the wallet used last time without a prompt, if it allows that.
  async function reconnect() {
    const name = recalled();
    const next = name && list().find((w) => w.name === name);
    waitingFor = next ? null : name;
    if (!next) return null;
    try {
      const { accounts } = await next.features["standard:connect"].connect({ silent: true });
      return accounts.length ? use(next, accounts) : null;
    } catch {
      return null;
    }
  }

  async function disconnect() {
    forget();
    waitingFor = null;
    try { await wallet?.features["standard:disconnect"]?.disconnect(); } catch { /* already gone */ }
    wallet = null;
    account = null;
    notify();
  }

  async function signMessage(text) {
    if (!wallet || !account) throw new WalletError("Connect a wallet first.");
    const message = new TextEncoder().encode(text);
    try {
      if (wallet.features["sui:signPersonalMessage"]) {
        return (await wallet.features["sui:signPersonalMessage"].signPersonalMessage({ message, account, chain })).signature;
      }
      return (await wallet.features["sui:signMessage"].signMessage({ message, account })).signature;
    } catch (err) {
      throw wrap(err, "the sign-in");
    }
  }

  // The exact transfer a quote asks for, signed but not sent. Edith checks it, then the provider settles it.
  async function signTransfer({ payTo, amount }) {
    if (!wallet || !account) throw new WalletError("Connect a wallet first.");
    const tx = new Transaction();
    tx.setSender(account.address);
    const [coin] = tx.splitCoins(tx.gas, [BigInt(amount)]);
    tx.transferObjects([coin], payTo);
    try {
      const { bytes, signature } = await signTransaction(wallet, { transaction: tx, account, chain });
      return { transaction: bytes, signature };
    } catch (err) {
      throw wrap(err, "the payment");
    }
  }

  return {
    list,
    connect,
    reconnect,
    disconnect,
    signMessage,
    signTransfer,
    get current() { return wallet ? { name: wallet.name, icon: wallet.icon, address: account?.address ?? null } : null; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
