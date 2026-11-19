/* ============================================================
   Notify · 加密核心
   - ECDH P-256 密钥交换 → HKDF → AES-256-GCM
   - 私钥只存在本机 IndexedDB，永不上传
   - 记录"自己的公钥指纹"，用于识别系统清理存储导致的身份重置
   ============================================================ */
const NotifyCrypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const WEB_CRYPTO_OK = !!(self.crypto && self.crypto.subtle);
  const memoryFallback = {};   // IndexedDB 不可用时退化为内存（仅本次会话有效）

  /* ---------- base64（分块，避免大图爆栈） ---------- */
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---------- IndexedDB 极简封装（失败即降级，不抛给调用方） ---------- */
  let dbPromise = null;
  function openDB() {
    if (!("indexedDB" in self)) return Promise.reject(new Error("no-idb"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open("notify-db", 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb-error"));
      req.onblocked = () => reject(new Error("idb-blocked"));
    });
    return dbPromise;
  }
  function idbGet(k) {
    return openDB().then((db) => new Promise((res) => {
      try {
        const r = db.transaction("kv", "readonly").objectStore("kv").get(k);
        r.onsuccess = () => res(r.result ?? null);
        r.onerror = () => res(null);
      } catch { res(null); }
    })).catch(() => (k in memoryFallback ? memoryFallback[k] : null));
  }
  function idbSet(k, v) {
    memoryFallback[k] = v;
    return openDB().then((db) => new Promise((res) => {
      try {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(v, k);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
        tx.onabort = () => res(false);
      } catch { res(false); }
    })).catch(() => false);
  }
  function idbDel(k) {
    delete memoryFallback[k];
    return openDB().then((db) => new Promise((res) => {
      try {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").delete(k);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
      } catch { res(false); }
    })).catch(() => false);
  }

  /* ---------- 身份 ---------- */
  async function pubFingerprint(jwk) {
    if (!jwk) return null;
    const s = JSON.stringify({ crv: jwk.crv, x: jwk.x, y: jwk.y });
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
    return bufToB64(digest).slice(0, 16);
  }

  /* 搬家导入用：整份身份（公私钥对）写回本机 */
  async function saveIdentity(data) {
    if (!data || !data.priv || !data.pub) throw new Error("身份信息不完整");
    data.fp = data.fp || await pubFingerprint(data.pub);
    data.born = data.born || Date.now();
    await idbSet("identity", data);
    return data;
  }

  async function loadIdentity() {
    if (!WEB_CRYPTO_OK) throw new Error("当前环境不支持加密（需要 HTTPS 或 localhost）");
    const saved = await idbGet("identity");
    if (saved && saved.priv && saved.pub) {
      saved.fp = saved.fp || await pubFingerprint(saved.pub);
      return saved;
    }
    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]
    );
    const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const identity = {
      pub,
      priv: await crypto.subtle.exportKey("jwk", kp.privateKey),
      fp: await pubFingerprint(pub),
      born: Date.now(),
    };
    await idbSet("identity", identity);
    return identity;
  }

  /* ---------- 配对信息 ---------- */
  async function savePair(data) { await idbSet("pair", data); }
  async function loadPair() { return idbGet("pair"); }
  async function clearPair() { await idbDel("pair"); }

  /* ---------- 口令哈希（PBKDF2 + 每房间随机盐，服务器只见哈希） ---------- */
  async function hashCode(code, saltHex) {
    const salt = saltHex
      ? hexToBytes(saltHex)
      : enc.encode("notify-pairing-v1");           // 兼容旧固定盐
    const base = await crypto.subtle.importKey(
      "raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
      base, 256
    );
    return bufToB64(bits);
  }

  /* 建房用：生成 128 位随机盐（hex 字符串，存到房间记录里） */
  function newSalt() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- ECDH → AES-256-GCM ---------- */
  async function deriveKey(privJwk, pubJwk) {
    const priv = await crypto.subtle.importKey(
      "jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
    );
    const pub = await crypto.subtle.importKey(
      "jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, false, []
    );
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
    const hkdfBase = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("notify-salt-v1"), info: enc.encode("notify-msg-v1") },
      hkdfBase,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  /* ---------- 加密 / 解密 ---------- */
  async function encrypt(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))
    );
    return { iv: bufToB64(iv), data: bufToB64(data) };
  }
  async function decrypt(key, payload) {
    try {
      if (!payload || !payload.iv || !payload.data) return null;
      const iv = new Uint8Array(b64ToBuf(payload.iv));
      const data = b64ToBuf(payload.data);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      return null;
    }
  }

  /* ---------- 密钥指纹（6 位数字，供双方面对面核对） ---------- */
  async function fingerprint(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    const digest = await crypto.subtle.digest("SHA-256", raw);
    const bytes = new Uint8Array(digest);
    const n = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 1000000;
    return String(n).padStart(6, "0");
  }

  return {
    WEB_CRYPTO_OK,
    loadIdentity, saveIdentity, savePair, loadPair, clearPair,
    hashCode, newSalt, deriveKey, encrypt, decrypt, fingerprint, pubFingerprint,
    bufToB64, b64ToBuf,
  };
})();
