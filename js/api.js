/* ============================================================
   Notify · 与 Supabase 通信（纯 REST，不依赖任何 CDN）
   要点：
   - 所有请求带超时，弱网/断网不会永久挂起
   - access_token 过期（1 小时）自动刷新并重试，App 不会“突然不再收发”
   - 用响应头 Date 校正服务器时间，手机时间不准也不会算错倒计时
   ============================================================ */
const NotifyAPI = (() => {
  const BASE = "https://wsaxywdhyhbkyhxehxzu.supabase.co";
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzYXh5d2RoeWhia3loeGVoeHp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MjQ3ODcsImV4cCI6MjExMDUwMDc4N30.WaQFJ37uf03cnWzioAgr8zrgTzHlqpep_PCX28ryTz8";

  const TIMEOUT_MS = 12000;
  let session = null;       // { access_token, refresh_token, user }
  let skew = 0;             // 服务器时间 - 本机时间（毫秒）
  let refreshing = null;    // 正在刷新的 Promise（并发去重）

  /* ---------- 本地会话（localStorage 可能被隐私模式禁用） ---------- */
  const LS_OK = (() => {
    try { localStorage.setItem("__n", "1"); localStorage.removeItem("__n"); return true; }
    catch { return false; }
  })();

  function saveSession(s) {
    session = s;
    if (s && LS_OK) { try { localStorage.setItem("notify-session", JSON.stringify(s)); } catch {} }
  }
  function loadSession() {
    if (!LS_OK) return null;
    const raw = localStorage.getItem("notify-session");
    if (!raw) return null;
    try { session = JSON.parse(raw); } catch { session = null; }
    return session;
  }
  function clearSession() {
    session = null;
    if (LS_OK) try { localStorage.removeItem("notify-session"); } catch {}
  }

  /* ---------- 请求核心 ---------- */
  function headers(json = true) {
    const h = { apikey: ANON };
    if (json) h["Content-Type"] = "application/json";
    h.Authorization = `Bearer ${session ? session.access_token : ANON}`;
    return h;
  }

  function noteServerTime(res) {
    // Date 是 CORS 安全响应头，可直接读取；用它校正本机时钟偏差
    const d = res.headers.get("date");
    if (!d) return;
    const server = new Date(d).getTime();
    if (!Number.isNaN(server)) skew = server - Date.now();
  }

  async function fetchWithTimeout(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal, cache: "no-store" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(path, opts = {}, retried = false) {
    let res;
    try {
      res = await fetchWithTimeout(BASE + path, {
        ...opts,
        headers: { ...headers(opts.body !== undefined), ...(opts.headers || {}) },
      });
    } catch (e) {
      const err = new Error(e.name === "AbortError" ? "网络超时，请检查连接" : "网络连接失败");
      err.offline = true;
      throw err;
    }
    noteServerTime(res);

    // 令牌过期 → 刷新后重试一次（否则运行 1 小时后会彻底收不到消息）
    if (res.status === 401 && !retried) {
      const ok = await refreshSession();
      if (ok) return request(path, opts, true);
    }

    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = (body && (body.message || body.error_description || body.hint)) || `HTTP ${res.status}`;
      const err = new Error(friendly(msg, res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function friendly(msg, status) {
    if (status === 429) return "操作太频繁，请稍后再试";
    if (/duplicate key/i.test(msg)) return "操作重复，请重试";
    if (/JWT expired/i.test(msg)) return "登录已过期，请重新打开 App";
    if (/Failed to fetch|Load failed/i.test(msg)) return "网络连接失败";
    return msg;
  }

  /* ---------- 匿名登录 ---------- */
  async function refreshSession() {
    if (!session || !session.refresh_token) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await fetchWithTimeout(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: ANON, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!r.ok) return false;
        const s = await r.json();
        if (!s.access_token) return false;
        saveSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: s.user || session.user });
        return true;
      } catch { return false; } finally { refreshing = null; }
    })();
    return refreshing;
  }

  async function ensureAuth() {
    loadSession();
    if (session && session.user) return session;
    if (await refreshSession()) return session;
    // 新建匿名身份
    let r;
    try {
      r = await fetchWithTimeout(`${BASE}/auth/v1/signup`, {
        method: "POST",
        headers: { apikey: ANON, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (e) {
      const err = new Error(e.name === "AbortError" ? "网络超时，请稍后重试" : "网络连接失败，请检查网络");
      throw err;
    }
    noteServerTime(r);
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.access_token) {
      if (r.status === 429) throw new Error("注册过于频繁，请稍后再试");
      throw new Error("无法创建身份：请在 Supabase 后台开启 Anonymous sign-ins");
    }
    saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
    return session;
  }

  const uid = () => (session && session.user ? session.user.id : null);
  const hasSession = () => !!(session && session.user);

  /* 搬家导入用：写入会话并立即刷新验证。
     成功 → 返回 true（token 已换新）；失败 → 网络不佳或这份包已失效 */
  async function restoreSession(s) {
    if (!s || !s.refresh_token) return false;
    saveSession(s);
    return refreshSession();
  }

  /* ---------- 时间 ---------- */
  const now = () => Date.now() + skew;
  const nowISO = () => new Date(now()).toISOString();
  /* 用服务器时间校正本机时钟：手机时间被改过也不会算错 15 分钟倒计时 */
  async function syncTime() {
    try {
      const t = await rpc("server_now", {});
      if (!t) return;
      const ms = new Date(t).getTime();
      if (!Number.isNaN(ms)) skew = ms - Date.now();
    } catch {}
  }
  const skewMs = () => skew;

  /* ---------- RPC ---------- */
  const rpc = (fn, args) =>
    request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args || {}) });

  /* ---------- 数据表 ---------- */
  async function listMembers(convId) {
    return request(`/rest/v1/members?conv_id=eq.${convId}&select=*`);
  }
  async function getConv(convId) {
    const rows = await request(`/rest/v1/conv?id=eq.${convId}&select=*`);
    return rows && rows[0];
  }
  const PAGE = 200;

  /* 首次进入：取最新一页 */
  function fetchLatest(convId) {
    return request(`/rest/v1/msgs?conv_id=eq.${convId}&select=*&order=created_at.desc,id.desc&limit=${PAGE}`);
  }
  /* 向前翻页：比游标更早的消息 */
  function fetchOlder(convId, cursor) {
    const at = encodeURIComponent(cursor.at), id = encodeURIComponent(cursor.id);
    return request(
      `/rest/v1/msgs?conv_id=eq.${convId}&select=*&order=created_at.desc,id.desc&limit=${PAGE}` +
      `&or=(created_at.lt.${at},and(created_at.eq.${at},id.lt.${id}))`
    );
  }
  /* 增量：只取游标之后的新消息（升序）。轮询只拉这一小段，不重复下载历史 */
  function fetchSince(convId, cursor) {
    const at = encodeURIComponent(cursor.at), id = encodeURIComponent(cursor.id);
    return request(
      `/rest/v1/msgs?conv_id=eq.${convId}&select=*&order=created_at.asc,id.asc&limit=${PAGE}` +
      `&or=(created_at.gt.${at},and(created_at.eq.${at},id.gt.${id}))`
    );
  }
  /* 只取元数据（已读/到期/撤回），不含密文，用来刷新老消息的状态 */
  function fetchMeta(convId) {
    return request(
      `/rest/v1/msgs?conv_id=eq.${convId}&select=id,read_at,expires_at,recalled` +
      `&order=created_at.desc,id.desc&limit=${PAGE}`
    );
  }
  /* 统计未读数：单独查一次，不受"只取最新 200 条"的分页影响，角标永远准 */
  async function countUnread(convId, me) {
    const q = `/rest/v1/msgs?conv_id=eq.${convId}&sender=neq.${me}&read_at=is.null&recalled=is.false&select=id&limit=200`;
    const rows = await request(q);
    return Array.isArray(rows) ? rows.length : 0;
  }
  async function insertMessage(convId, sender, kind, payload) {
    const rows = await request(`/rest/v1/msgs`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ conv_id: convId, sender, kind, payload }]),
    });
    return rows && rows[0];
  }
  /* 已读回执 / 撤回 / 退出房间：全部走服务器函数，时间由服务器盖章 */
  const markRead = (id) => rpc("mark_read", { p_id: id });
  const recall = (id) => rpc("recall_message", { p_id: id });
  const leaveConv = () => rpc("leave_conv", {});
  async function purge() {
    try { await rpc("purge_expired", {}); } catch {}
  }

  /* ---------- Web Push ---------- */
  /* 订阅信息上报（一台设备一条，重复订阅覆盖） */
  async function savePushSub(subJson) {
    const me = uid();
    if (!me || !subJson || !subJson.endpoint) return;
    await raw("/rest/v1/push_subs", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ uid: me, sub: subJson }]),
    });
  }

  /* 通知对方：调 Edge Function（通知里不含消息内容） */
  async function notifyPeer(peerUid) {
    if (!peerUid) return;
    let s;
    try { s = await ensureAuth(); } catch { return; }
    if (!s || !s.access_token) return;
    try {
      await fetch(`${BASE}/functions/v1/send-push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uid: peerUid }),
      });
    } catch {}     // 推送失败不影响消息本身
  }

  return {
    BASE, ANON, ensureAuth, uid, hasSession, rpc, now, nowISO, syncTime, skewMs,
    listMembers, getConv, fetchLatest, fetchOlder, fetchSince, fetchMeta, countUnread, insertMessage,
    markRead, recall, leaveConv, purge, savePushSub, notifyPeer,
    loadSession, clearSession, saveSession, restoreSession, LS_OK,
  };
})();
