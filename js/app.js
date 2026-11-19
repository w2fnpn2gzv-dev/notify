/* ============================================================
   Notify · 主逻辑
   ============================================================ */
const $ = (id) => document.getElementById(id);
const SELF_DESTRUCT_MS = 15 * 60 * 1000;
const RENDER_MAX = 200;      // 初始渲染条数（DOM 有上限，长会话不卡）
const RENDER_STEP = 200;     // 每次上翻增加渲染条数
const BOTTOM_SLACK = 140;    // 距底部多少像素内视为"贴底"

const state = {
  me: null,
  identity: null,
  pair: null,          // {convId, role, peerPub, title, ownerFp}
  key: null,           // AES 密钥（切后台即丢弃）
  msgs: [],            // 已解密的本地消息
  unsent: [],          // 发送失败、尚未同步的消息（切后台时少量保留）
  view: "note",
  unreadFirstId: null,
  pollTimer: null,
  tickTimer: null,
  tmpSeq: 0,
  audio: null,
  audioMsgId: null,
  remoteUnread: 0,
  hasMore: false,
  oldestAt: null,
  oldestId: null,
  newestAt: null,      // 增量轮询游标（只拉这之后的新消息）
  newestId: null,
  loadingOlder: false,
  windowSize: RENDER_MAX,
  pollBusy: false,
  bootAt: 0,
  netDown: false,
};

/* ---------------- 基础工具 ---------------- */
function toast(msg, ms = 1900) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), ms);
}
/* 时间一律用服务器校正后的时间，手机时间不准也不会算错倒计时 */
const nowMs = () => (NotifyAPI ? NotifyAPI.now() : Date.now());
const nowISO = () => new Date(nowMs()).toISOString();
const pad = (n) => String(n).padStart(2, "0");
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDateTitle() {
  const d = new Date(nowMs());
  return `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六"[d.getDay()]}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 视图切换 ---------------- */
function showView(name) {
  state.view = name;
  ["note", "pair", "chat"].forEach((v) => {
    const el = $("view-" + v);
    if (el) el.classList.toggle("active", v === name);
  });
  clearInterval(pairWaitTimer);
  if (name === "chat") {
    $("chatDate").textContent = fmtDateTitle();
    $("chatTitle").textContent = (state.pair && state.pair.title) || "学习计划";
    state.windowSize = RENDER_MAX;
    // 切后台时暂存的"未发出"消息，回到聊天页立刻恢复，别让人以为已经发了
    if (state.unsent.length) { state.msgs.push(...state.unsent); state.unsent = []; }
    markUnreadAsRead();
    renderChat();
    scrollBottom();
    startFastPoll();
  } else {
    startSlowPoll();
  }
}

/* ---------------- 启动 ---------------- */
async function boot() {
  const isDemo = new URLSearchParams(location.search).has("demo");
  if (isDemo) { demoMode(); return; }

  state.bootAt = Date.now();

  // 加密能力检测：非 HTTPS / 非 localhost 下 WebCrypto 不可用，直接说清楚
  if (!NotifyCrypto.WEB_CRYPTO_OK) {
    toast("当前打开方式不支持加密，请用 Safari 或添加到主屏幕后打开", 6000);
    $("noteArea").placeholder = "请通过 https:// 或 localhost 打开（直接双击本地文件无效）";
    bindLock();
    return;
  }

  // 身份与配对
  try {
    state.identity = await NotifyCrypto.loadIdentity();
  } catch (e) {
    toast(e.message || "本机存储不可用，无法保存密钥", 6000);
  }
  state.pair = await NotifyCrypto.loadPair();
  await checkIdentityReset();

  // 登录（网络失败不阻塞界面，后台重试）
  loginWithRetry().then(async (ok) => {
    if (!ok) return;
    await NotifyAPI.syncTime();
    refreshBadge();
    pollOnce();
    setupPush();
  });

  showView("note");
  refreshBadge();
  startSlowPoll();
  NotifyAPI.purge();
  bindLock();
  bindNotePersistence();   // 记录本：载入上一次的内容 + 自动保存
  // 回到前台立即补一次，别等 10 秒
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { pollOnce(); refreshBadge(); }
  });
}

/* 身份被系统清理（iOS 会清理不常用网站的存储）后，旧配对已经无法解密：
   必须在启动时就识别出来，否则用户会看到"消息一条都打不开"却不知道为什么 */
async function checkIdentityReset() {
  if (!state.pair) return;
  const cur = state.identity && state.identity.fp;
  if (!cur) return;
  if (!state.pair.ownerFp) {
    // 老版本配对记录：补写标记，无法判断是否已重置
    state.pair.ownerFp = cur;
    await NotifyCrypto.savePair(state.pair);
    return;
  }
  if (state.pair.ownerFp !== cur) {
    await NotifyCrypto.clearPair();
    state.pair = null;
    state.key = null;
    setTimeout(() => toast("本机密钥已被系统重置，需要重新配对", 5000), 600);
  }
}

async function loginWithRetry() {
  for (let i = 0; i < 3; i++) {
    try {
      await NotifyAPI.ensureAuth();
      state.me = NotifyAPI.uid();
      state.netDown = false;
      return true;
    } catch (e) {
      state.netDown = true;
      if (i === 2) { toast(e.message || "网络连接失败，稍后会自动重试", 3600); return false; }
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  return false;
}

function bindLock() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) lockNow();
  });
  window.addEventListener("pagehide", lockNow);
}

/* ---------------- 记录本（首页笔记本）----------------
   内容自动保存到本机 localStorage：第二次打开、切后台回来都还在。
   只存本机、不上传服务器（和配对密钥一样的位置，换手机不带过去）。 */
let noteSaveTimer = null;

function bindNotePersistence() {
  const el = $("noteArea");
  if (!el) return;
  try { el.value = localStorage.getItem("notify-note") || ""; } catch {}
  el.addEventListener("input", () => {
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem("notify-note", el.value);
        const tip = document.querySelector(".note-saved");
        if (tip) {
          tip.classList.add("on");
          setTimeout(() => tip.classList.remove("on"), 1200);
        }
      } catch {}
    }, 500);
  });
}

function lockNow() {
  if (new URLSearchParams(location.search).has("demo")) return;
  // 保留尚未同步的消息（连同明文），否则用户会以为已经发出去了
  state.unsent = state.msgs.filter((m) => m.status === "failed");
  if (recorder) { recCancelled = true; stopRecord(); }   // 录音中切后台：立刻停麦
  const input = $("msgInput");
  if (input) input.value = "";                           // 输入框草稿也是明文，一并清掉
  if (state.view === "chat") {
    $("chatBody").innerHTML = "";
    state.msgs = [];
    state.windowSize = RENDER_MAX;
    state.unreadFirstId = null;
    state.oldestAt = null;
    state.oldestId = null;
    state.newestAt = null;
    state.newestId = null;
    state.hasMore = false;
    state.key = null;                  // 丢弃内存里的密钥
    if (state.audio) { state.audio.pause(); state.audio = null; state.audioMsgId = null; }
    showView("note");
  } else {
    state.msgs = [];
  }
  // 记录本内容不再清空：已自动保存在本机，重开/切后台回来都还在
}

/* ---------------- 轮询 ---------------- */
function startFastPoll() {
  clearInterval(state.pollTimer);
  pollOnce();
  state.pollTimer = setInterval(pollOnce, 2500);
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(tickCountdown, 1000);
}
function startSlowPoll() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;       // 后台不轮询，省电也少留痕
    pollOnce();
    refreshBadge();
  }, 10000);
  clearInterval(state.tickTimer);
}

async function pollOnce() {
  if (!state.pair || !state.pair.convId) return;
  if (state.pair.convId === "demo") return;      // 演示模式不发请求
  if (state.pollBusy) return;          // 上一次还没回来就别叠加
  if (document.hidden) return;
  state.pollBusy = true;
  try {
    if (!state.me && !(await LoginIfNeeded())) return;
    state.netDown = false;

    // 不在聊天页：只统计未读数（独立查询，不下载正文，不解密）
    if (state.view !== "chat") {
      try { state.remoteUnread = await NotifyAPI.countUnread(state.pair.convId, state.me); } catch {}
      refreshBadge();
      return;
    }

    const stick = isNearBottom();
    let changed = false;
    // 老消息的状态（已读/到期/撤回）每 4 轮刷一次，只取元数据，很轻
    if (++pollOnce._m >= 4) {
      pollOnce._m = 0;
      changed = (await syncMeta()) || changed;
      await checkPeerRejoin();          // 对方换新手机重连 → 本机自动换密钥
    }
    // 新消息只拉"比本地最新一条更新"的那一小段
    const rows = await pullNewRows();
    if (rows && rows.length) {
      state.hasMore = rows.length >= 200 || state.hasMore;
      changed = (await mergeRows(rows)) || changed;
    }
    if (changed) {
      renderChat(stick ? "bottom" : "keep");
    } else {
      refreshMeta();
      updateCountdowns();
    }
    refreshBadge();
    if (++pollOnce._n >= 30) { pollOnce._n = 0; NotifyAPI.purge(); }
    if (++pollOnce._t >= 120) { pollOnce._t = 0; NotifyAPI.syncTime(); }
  } catch (e) {
    if (e.offline) { state.netDown = true; }
    console.warn("拉取失败", e.message);
  } finally {
    state.pollBusy = false;
  }
}
pollOnce._n = 0;
pollOnce._t = 0;
pollOnce._m = 0;

/* 对方换新手机、凭口令重连后，房间 B 位公钥会被服务端替换。
   本机（A 方）在轮询里发现 pub_b 变化，就自动换用新密钥并刷新对方身份，
   不需要 A 做任何操作，聊天无缝继续 */
async function checkPeerRejoin() {
  if (!state.pair || !state.pair.peerPub || state.pair.role !== "a") return;
  if (state.pair.convId === "demo") return;
  try {
    const conv = await NotifyAPI.getConv(state.pair.convId);
    if (!conv || !conv.pub_b) return;
    if (JSON.stringify(conv.pub_b) === JSON.stringify(state.pair.peerPub)) return;
    state.pair.peerPub = conv.pub_b;
    const members = await NotifyAPI.listMembers(state.pair.convId).catch(() => []);
    if (members && members.length) {
      state.pair.peerUid = (members.find((m) => m.uid !== state.me) || {}).uid || state.pair.peerUid;
    }
    await NotifyCrypto.savePair(state.pair);
    state.key = await NotifyCrypto.deriveKey(state.identity.priv, conv.pub_b);
    toast("对方已在新设备重新配对，已自动切换密钥", 4000);
  } catch {}
}

/* 增量拉取：首次取最新一页；之后只取游标之后的新消息（长会话也不会重复下载历史） */
async function pullNewRows() {
  const convId = state.pair.convId;
  if (!state.newestAt) {
    const latest = await NotifyAPI.fetchLatest(convId);
    return (latest || []).slice().reverse();     // 服务端倒序返回，本地按正序吃
  }
  let out = [];
  let cur = { at: state.newestAt, id: state.newestId };
  for (let i = 0; i < 5; i++) {
    const rows = await NotifyAPI.fetchSince(convId, cur);
    if (!rows || !rows.length) break;
    out = out.concat(rows);
    if (rows.length < 200) break;               // 不足一页说明已经追平
    const last = rows[rows.length - 1];
    cur = { at: last.created_at, id: last.id };
  }
  return out;
}

/* 刷新老消息状态（已读 / 到期 / 撤回），不含密文 */
async function syncMeta() {
  if (!state.pair || state.pair.convId === "demo") return false;
  const rows = await NotifyAPI.fetchMeta(state.pair.convId);
  if (!rows) return false;
  const byId = new Map(state.msgs.map((m) => [String(m.id), m]));
  let changed = false;
  rows.forEach((r) => {
    const m = byId.get(String(r.id));
    if (!m) return;
    if (m.read_at !== r.read_at || m.expires_at !== r.expires_at || (!m.recalled && r.recalled)) {
      m.read_at = r.read_at;
      m.expires_at = r.expires_at;
      m.recalled = r.recalled || m.recalled;
      changed = true;
    }
  });
  return changed;
}

async function LoginIfNeeded() {
  try {
    await NotifyAPI.ensureAuth();
    state.me = NotifyAPI.uid();
    return true;
  } catch { return false; }
}

/* 合并服务器消息；返回 true 表示"需要重绘"（数量或可见内容变了） */
async function mergeRows(rows) {
  const index = new Map(state.msgs.map((m) => [String(m.id), m]));
  let dividerSet = state.unreadFirstId;
  let changed = false;

  for (const r of rows) {
    const key = String(r.id);
    const local = index.get(key);
    if (local) {
      // 元数据变化（已读、过期时间、撤回）也要反映出来
      if (local.read_at !== r.read_at || local.expires_at !== r.expires_at || (!local.recalled && r.recalled)) {
        local.read_at = r.read_at;
        local.expires_at = r.expires_at;
        local.recalled = r.recalled || local.recalled;
        changed = true;
      }
      continue;
    }
    const mine = r.sender === state.me;
    if (r.recalled) {
      if (!mine) {
        const tomb = {
          id: r.id, sender: r.sender, mine: false, kind: r.kind, data: {},
          created_at: r.created_at, read_at: r.read_at, expires_at: r.expires_at,
          recalled: true, status: "sent",
        };
        state.msgs.push(tomb); index.set(key, tomb); changed = true;
      }
      continue;
    }
    if (!state.key) continue;
    const data = await NotifyCrypto.decrypt(state.key, r.payload);
    if (!data) {
      // 解密失败：密钥是旧设备的（对方或本机换过手机）。显示锁定占位，
      // 不悄悄吞掉——用户得知道这条记录存在、只是本机解不开
      const lock = {
        id: r.id, sender: r.sender, mine, kind: "locked", data: {},
        created_at: r.created_at, read_at: r.read_at, expires_at: r.expires_at,
        recalled: false, status: "sent",
      };
      state.msgs.push(lock); index.set(key, lock); changed = true;
      if (!mergeRows._lockWarned) {
        mergeRows._lockWarned = true;
        toast("换设备前的加密消息本机解不开（密钥只在旧手机上），新消息不受影响", 4600);
      }
      if (!mine && !r.read_at && state.view === "chat") {
        NotifyAPI.markRead(lock.id).catch(() => {});
      }
      continue;
    }
    const msg = {
      id: r.id, sender: r.sender, mine, kind: r.kind, data,
      created_at: r.created_at, read_at: r.read_at, expires_at: r.expires_at,
      recalled: false, status: "sent",
    };
    if (!mine && !r.read_at && state.view === "chat") {
      if (!dividerSet) dividerSet = msg.id;
      msg.read_at = nowISO();
      msg.expires_at = new Date(nowMs() + SELF_DESTRUCT_MS).toISOString();
      NotifyAPI.markRead(msg.id).catch(() => {});
    }
    state.msgs.push(msg); index.set(key, msg); changed = true;
  }

  if (changed) {
    state.msgs.sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id))
    );
    if (state.msgs.length) {
      state.oldestAt = state.msgs[0].created_at;
      state.oldestId = state.msgs[0].id;
      // 游标只认服务器消息（tmp- 是本地待发，时间不可信）
      const real = state.msgs.filter((m) => !String(m.id).startsWith("tmp-"));
      if (real.length) {
        const last = real[real.length - 1];
        state.newestAt = last.created_at;
        state.newestId = last.id;
      }
    }
    if (dividerSet && !state.unreadFirstId && state.view === "chat") state.unreadFirstId = dividerSet;
  }
  return changed;
}

/* 滚到顶部：先把本地窗口扩大，本地没有了再去服务器翻页（消息不限量） */
async function loadMore() {
  if (state.loadingOlder || !state.pair || state.pair.convId === "demo") return;
  if (document.hidden) return;
  // 内容还没超过一屏时 scrollTop 恒为 0，每次滚动事件都会再次触发——
  // 形成「加载→重绘→再加载」的循环抖动（图片消息把内容撑高后尤其容易踩到）
  const box = $("chatBody");
  const canGrow = state.windowSize < state.msgs.length;
  if (box && box.scrollHeight <= box.clientHeight + 40 && !canGrow) return;
  if (canGrow) {
    state.windowSize = Math.min(state.msgs.length, state.windowSize + RENDER_STEP);
    renderChat("keep");
    return;
  }
  if (!state.hasMore || !state.oldestAt) return;
  state.loadingOlder = true;
  try {
    const rows = await NotifyAPI.fetchOlder(state.pair.convId, { at: state.oldestAt, id: state.oldestId });
    if (!rows || !rows.length) { state.hasMore = false; return; }
    state.hasMore = rows.length >= 200;
    await mergeRows(rows);
    state.windowSize = Math.min(state.msgs.length, state.windowSize + RENDER_STEP);
    renderChat("keep");
  } catch (e) {
    console.warn("加载更早消息失败", e.message);
  } finally {
    state.loadingOlder = false;
  }
}

function markUnreadAsRead() {
  if (state.pair && state.pair.convId === "demo") return;
  state.msgs.forEach((m) => {
    if (!m.mine && !m.read_at && !m.recalled) {
      m.read_at = nowISO();
      m.expires_at = new Date(nowMs() + SELF_DESTRUCT_MS).toISOString();
      NotifyAPI.markRead(m.id).catch(() => {});
    }
  });
  state.remoteUnread = 0;
}

/* ---------------- 渲染 ---------------- */
function visibleMessages() {
  const alive = state.msgs.filter((m) => !isExpired(m) && !(m.recalled && m.mine));
  return alive.slice(-state.windowSize);
}

/* mode: "bottom" 滚到底 / "keep" 保持当前阅读位置 / "none" 完全不动 */
/* 滑动期间冻结全量重绘：整棵 innerHTML 重建是滑动卡顿的最大来源。
   滑动中只记 dirty，停稳 250ms 后按待绘模式补绘一次 */
let chatScrolling = false;
let chatScrollTimer = null;
let chatPendingMode = null;

function renderChat(mode = "bottom") {
  if (chatScrolling) {
    chatPendingMode = (mode === "bottom" || chatPendingMode === "bottom") ? "bottom" : (chatPendingMode || mode);
    return;
  }
  renderChatNow(mode);
}

function endChatScroll() {
  clearTimeout(chatScrollTimer);
  if (!chatScrolling) return;
  chatScrolling = false;
  const mode = chatPendingMode || "keep";
  chatPendingMode = null;
  renderChat(mode);
}

function renderChatNow(mode) {
  const box = $("chatBody");  if (!box) return;
  const prevTop = box.scrollTop;
  const prevH = box.scrollHeight;
  const list = visibleMessages();

  /* 节点复用（两级）：
     ① 消息集合完全没变（只是已读/倒计时/撤回标记这类小状态变了）→ 一行 DOM 都不动；
     ② 只是在末尾多了新消息 → 只 append 新增节点，已有气泡原地保留。
     不重建的意义：图片气泡里的 <img> 不会被销毁重建——iOS 上重新解码一张
     接近 3MB 的 data URL 会有几十毫秒空白帧，反复重绘就是不停的闪烁/跳屏 */
  const keyOf = (m) => m.id + (m.recalled ? "R" : "") + (m.status || "") + (m.kind === "locked" ? "L" : "");
  const idsArr = list.map(keyOf);
  const tail = "#" + (state.unreadFirstId || "");
  const sig = idsArr.join("|") + tail;
  if (sig === box.dataset.sig) {
    refreshMeta();
    updateCountdowns();
    if (mode === "bottom") scrollBottom();
    return;
  }

  const prevIds = box.dataset.ids ? box.dataset.ids.split("\u0001") : null;
  const canAppend = !!(prevIds && prevIds.length && idsArr.length > prevIds.length
    && prevIds.every((v, i) => idsArr[i] === v)
    && (box.dataset.tail || "") === tail
    && !box.querySelector(".empty-chat")
    && !box.querySelector(".unread-divider"));

  box.dataset.sig = sig;
  box.dataset.ids = idsArr.join("\u0001");
  box.dataset.tail = tail;

  if (canAppend) {
    // 只追加新消息：已有气泡（含图片）原地不动，不重排、不重新解码
    const frag = document.createDocumentFragment();
    list.slice(prevIds.length).forEach((m) => {
      const node = buildBubble(m);
      if (node) frag.appendChild(node);
    });
    box.appendChild(frag);
    updateCountdowns();
    if (mode === "bottom") scrollBottom();
    return;
  }

  const frag = document.createDocumentFragment();

  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty-chat";
    e.textContent = "暂无消息，写点什么吧";
    frag.appendChild(e);
  } else {
    list.forEach((m) => {
      if (state.unreadFirstId === m.id) {
        const d = document.createElement("div");
        d.className = "unread-divider";
        d.innerHTML = `<div class="l"></div><div class="t"><span class="d"></span>新消息</div><div class="l"></div>`;
        frag.appendChild(d);
      }
      const node = buildBubble(m);
      if (node) frag.appendChild(node);
    });
  }
  box.innerHTML = "";
  box.appendChild(frag);
  updateCountdowns();
  if (mode === "keep") box.scrollTop = prevTop + (box.scrollHeight - prevH);
  else if (mode === "bottom") scrollBottom();
}

function buildBubble(m) {
  const row = document.createElement("div");
  row.className = "row" + (m.mine ? " mine" : "");
  if (m.recalled) {
    if (m.mine) return null;
    const tip = document.createElement("div");
    tip.className = "recalled-tip";
    tip.textContent = "对方撤回了一条消息";
    row.appendChild(tip);
    return row;
  }
  if (m.kind === "locked") {
    const tip = document.createElement("div");
    tip.className = "recalled-tip locked-tip";
    tip.textContent = "🔒 换设备前的加密消息（本机无法解密）";
    row.appendChild(tip);
    return row;
  }
  if (m.kind === "image") {
    const b = document.createElement("div");
    b.className = "bubble " + (m.mine ? "mine" : "hers") + " img-bubble";
    b.dataset.id = m.id;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    // 关键：用 w/h 预先占位。没有占位时 img 在解码前高度为 0，解码后突然撑开，
    // 每次重绘（轮询刷状态、发新消息）都会重复「塌陷→撑开」，画面就不停跳。
    // 老消息没有 w/h 时用默认占位，并在首次加载后把真实比例记回内存自愈。
    const d = m.data || {};
    const known = d.w > 0 && d.h > 0;
    img.style.aspectRatio = known ? `${d.w} / ${d.h}` : "4 / 3";
    img.dataset.ph = known ? "0" : "1";
    img.addEventListener("load", () => {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
      if (!(d.w > 0 && d.h > 0)) {
        d.w = img.naturalWidth;
        d.h = img.naturalHeight;
        img.style.aspectRatio = `${d.w} / ${d.h}`;
      }
    }, { once: true });
    img.src = d.d || "";
    b.appendChild(img);
    if (m.mine) b.insertAdjacentHTML("beforeend", metaHTML(m));
    attachLongPress(b, m);
    if (m.status === "failed") b.onclick = () => resendMessage(m);
    else bindImageTap(b, () => m.data.d);
    row.appendChild(b);
    return row;
  }
  if (m.kind === "voice") {
    const b = document.createElement("div");
    b.className = "bubble " + (m.mine ? "mine" : "hers") + " voice-bubble";
    b.dataset.id = m.id;
    b.innerHTML = `<div class="ply">▶</div><div class="wv">${waveBars()}</div><div class="dur">${Math.max(1, Math.round(m.data.dur || 1))}″</div>` +
      (m.mine ? metaHTML(m) : "");
    b.onclick = (e) => {
      if (e.target.closest(".meta")) return;
      if (m.status === "failed") resendMessage(m);
      else playVoice(m);
    };
    attachLongPress(b, m);
    row.appendChild(b);
    return row;
  }
  const b = document.createElement("div");
  b.className = "bubble " + (m.mine ? "mine" : "hers");
  b.dataset.id = m.id;
  b.innerHTML = `${esc(m.data.text || "")}${m.mine ? metaHTML(m) : ""}`;
  attachLongPress(b, m);
  if (m.status === "failed") b.onclick = () => resendMessage(m);
  row.appendChild(b);
  return row;
}

/* ---------------- 图片大图查看器 ----------------
   点图片气泡全屏查看；双击 / 双指捏合缩放（1~4 倍），放大后可拖动平移；
   点空白处或 ✕ 关闭。
   iOS 主屏幕 PWA 的合成 click 会被「键盘收起 → 布局回弹」等场景吞掉，
   因此点按一律用 touchstart/touchend 手动识别，桌面端保留 click。 */
function bindImageTap(el, getSrc) {
  let sx = 0, sy = 0, t0 = 0, moved = false;
  el.addEventListener("touchstart", (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    t0 = Date.now(); moved = false;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (e.touches[0] && (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10)) moved = true;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (moved || Date.now() - t0 > 350) return;              // 滑动 / 长按不算点按
    if (Date.now() < maskGuardUntil || $("mask").classList.contains("on")) return;
    e.preventDefault();                                      // 拦掉尾随合成 click，防止误触
    openImageViewer(getSrc());
  });
  el.addEventListener("click", () => {
    if (Date.now() < maskGuardUntil || $("mask").classList.contains("on")) return;
    openImageViewer(getSrc());
  });
}

function openImageViewer(src) {
  if (!src) return;
  let v = document.querySelector(".img-viewer");
  if (!v) {
    v = document.createElement("div");
    v.className = "img-viewer";
    v.innerHTML = `<div class="close">✕</div><div class="stage"><img alt="大图"></div><div class="hint">双指或双击可放大 · 点按空白处关闭</div>`;
    document.body.appendChild(v);
    bindViewerGestures(v);
  }
  v.querySelector("img").src = src;
  viewerReset(v);
  requestAnimationFrame(() => v.classList.add("on"));
}
function closeImageViewer() {
  const v = document.querySelector(".img-viewer");
  if (!v || !v.classList.contains("on")) return;
  v.classList.remove("on");
  setTimeout(() => v.remove(), 240);
}
function viewerReset(v) {
  const img = v.querySelector("img");
  img.style.transition = "transform .2s ease";
  img.style.transform = "";
}
function bindViewerGestures(v) {
  const img = v.querySelector("img");
  let s = 1, tx = 0, ty = 0, sx = 0, sy = 0, px = 0, py = 0, t0 = 0, lastTap = 0, pinch = 0, moved = false;
  let closeTimer = null;
  const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${s})`; };
  const reset = () => { s = 1; tx = 0; ty = 0; viewerReset(v); img.style.transform = ""; };
  v.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    } else {
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      px = tx; py = ty; t0 = Date.now(); moved = false;
    }
  }, { passive: true });
  v.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinch) {
      moved = true;
      const a = e.touches[0], b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (d > 0) {
        img.style.transition = "none";
        s = Math.min(4, Math.max(1, (s * d) / pinch));
        pinch = d;
        apply();
      }
    } else if (e.touches.length === 1 && s > 1) {
      moved = true;
      img.style.transition = "none";
      tx = px + e.touches[0].clientX - sx;
      ty = py + e.touches[0].clientY - sy;
      apply();
    }
  }, { passive: true });
  v.addEventListener("touchend", (e) => {
    if (e.touches.length) { pinch = 0; return; }   // 还有手指在屏上（捏合结束的一只）
    pinch = 0;
    if (e.target.closest(".close")) return;
    if (moved || Date.now() - t0 > 350) { cancelClose(); return; }
    e.preventDefault();                   // 拦掉合成 click，防止背景关闭被误触发
    const isDouble = Date.now() - lastTap < 300;
    lastTap = Date.now();
    if (isDouble) {
      cancelClose();
      if (s > 1) { reset(); }
      else {
        const t = e.changedTouches[0], r = img.getBoundingClientRect();
        s = 2.4;
        tx = (t.clientX - (r.left + r.width / 2)) * (1 - s);
        ty = (t.clientY - (r.top + r.height / 2)) * (1 - s);
        apply();
      }
      return;
    }
    if (s > 1) return;                    // 放大状态下点一下不关闭
    // 单击延时关闭：给双击留出识别窗口
    cancelClose();
    closeTimer = setTimeout(closeImageViewer, 320);
  });
  v.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    cancelClose();
    closeImageViewer();
  });
  v.addEventListener("click", (e) => {    // 桌面：点背景关闭
    if (!e.target.closest(".close")) closeImageViewer();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeImageViewer(); });
}

function waveBars() {
  let s = "";
  for (let i = 0; i < 14; i++) s += `<i style="height:${5 + Math.round(Math.abs(Math.sin(i * 1.7)) * 13)}px"></i>`;
  return s;
}

function statusLabel(m) {
  if (m.status === "sending") return "发送中";
  if (m.status === "failed") return "未能同步 · 点按重发";
  return m.read_at ? "已读" : "已发送";
}
function metaHTML(m) {
  return `<div class="meta ${m.read_at && m.status !== "failed" ? "read" : ""}" data-mid="${esc(m.id)}">
    <span class="st">${statusLabel(m)}</span>
    <span class="cd" data-exp="${esc(m.expires_at || "")}"></span></div>`;
}

/* 只更新"状态/倒计时"这类频繁变化的小字，不重建整棵 DOM */
function refreshMeta() {
  const nodes = document.querySelectorAll(".meta[data-mid]");
  if (!nodes.length) return;
  const byId = new Map(state.msgs.map((m) => [String(m.id), m]));
  nodes.forEach((el) => {
    const m = byId.get(el.dataset.mid);
    if (!m) return;
    const st = el.querySelector(".st");
    if (st) {
      const label = statusLabel(m);
      if (st.textContent !== label) st.textContent = label;
    }
    const cd = el.querySelector(".cd");
    if (cd) {
      const exp = m.expires_at || "";
      if (cd.dataset.exp !== exp) cd.dataset.exp = exp;
    }
    el.classList.toggle("read", !!(m.read_at && m.status !== "failed"));
  });
}

/* 长按助手：容忍 ≤12px 抖动；触摸期间忽略合成鼠标事件，避免计时被重置 */
function hold(el, ms, fn) {
  if (!el) return;
  let timer = null, sx = 0, sy = 0, touching = false;
  const begin = (x, y) => { sx = x; sy = y; clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, ms); };
  const move = (x, y) => {
    if (timer && (Math.abs(x - sx) > 12 || Math.abs(y - sy) > 12)) { clearTimeout(timer); timer = null; }
  };
  const end = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("touchstart", (e) => {
    touching = true;
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  el.addEventListener("touchend", () => { touching = false; end(); });
  el.addEventListener("touchcancel", () => { touching = false; end(); });
  el.addEventListener("mousedown", (e) => { if (!touching) begin(e.clientX, e.clientY); });
  el.addEventListener("mousemove", (e) => { if (!touching) move(e.clientX, e.clientY); });
  el.addEventListener("mouseup", end);
  el.addEventListener("mouseleave", end);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

function attachLongPress(el, m) {
  hold(el, 520, () => {
    if (m.status === "sending" || m.status === "failed") { toast("这条还没同步，暂时不能撤回"); return; }
    if (m.mine && !m.recalled) openRecall(m);
    else toast(`发送于 ${fmtTime(m.created_at)}`);
  });
}

function isExpired(m) {
  return !!(m.expires_at && new Date(m.expires_at).getTime() <= nowMs());
}

function tickCountdown() {
  if (state.view !== "chat") return;
  const before = state.msgs.length;
  const hadExpired = state.msgs.some((m) => isExpired(m));
  if (hadExpired) {
    state.msgs = state.msgs.filter((m) => !isExpired(m));
    if (state.msgs.length !== before) { renderChat("keep"); return; }
  }
  updateCountdowns();
}

function updateCountdowns() {
  document.querySelectorAll(".cd").forEach((el) => {
    const exp = el.dataset.exp;
    if (!exp) { if (el.textContent) el.textContent = ""; return; }
    const left = new Date(exp).getTime() - nowMs();
    if (left <= 0) { if (el.textContent) el.textContent = ""; return; }
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    const txt = `${pad(mm)}:${pad(ss)}`;
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle("warn", left < 60000);
  });
}

function isNearBottom() {
  const box = $("chatBody");
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_SLACK;
}

function scrollBottom() {
  const box = $("chatBody");
  if (!box) return;
  // 直接赋值，不再等下一帧——之前用 rAF 会先画一帧旧位置再跳，视觉上就是"闪一下"
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 未读角标 ---------------- */
function refreshBadge() {
  const localUnread = state.msgs.filter((m) => !m.mine && !m.read_at && !m.recalled).length;
  const unread = Math.max(localUnread, state.remoteUnread || 0);
  const b = $("badge");
  if (!b) return;
  b.textContent = unread > 99 ? "99+" : String(unread);
  b.classList.toggle("hidden", unread === 0 || !state.pair);
  if (navigator.setAppBadge) {
    if (unread) navigator.setAppBadge(unread).catch(() => {});
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  }
}

/* ---------------- 发送 ---------------- */
async function ensurePairReady() {
  if (!state.pair) { showView("pair"); return false; }
  if (!state.pair.peerPub) { toast("等待对方输入口令加入…"); startPairWait(); return false; }
  if (!state.me && !(await LoginIfNeeded())) { toast("网络未连接，稍后再试"); return false; }
  if (!state.key) {
    try {
      state.key = await NotifyCrypto.deriveKey(state.identity.priv, state.pair.peerPub);
    } catch {
      toast("密钥不可用，请重新配对", 3600);
      return false;
    }
  }
  return true;
}

async function sendMessage(kind, data) {
  if (!(await ensurePairReady())) return;
  const tmpId = "tmp-" + ++state.tmpSeq;
  const local = {
    id: tmpId, sender: state.me, mine: true, kind, data,
    created_at: nowISO(), read_at: null, expires_at: null,
    recalled: false, status: "sending",
  };
  state.msgs.push(local);
  renderChat();

  for (let tries = 0; tries < 3; tries++) {
    try {
      const payload = await NotifyCrypto.encrypt(state.key, data);
      const row = await NotifyAPI.insertMessage(state.pair.convId, state.me, kind, payload);
      if (!row || !row.id) throw new Error("no-row");
      local.id = row.id;
      local.status = "sent";
      local.created_at = row.created_at;
      renderChat();
      NotifyAPI.notifyPeer(state.pair.peerUid);       // 锁屏推送（失败不影响消息）
      return;
    } catch (e) {
      if (tries < 2) await new Promise((r) => setTimeout(r, 700 * (tries + 1)));
      else {
        local.status = "failed";
        renderChat();
        toast("网络不稳，消息未能同步（点气泡可重发）", 2800);
      }
    }
  }
}

async function resendMessage(m) {
  if (m.status !== "failed" || !state.pair) return;
  if (!state.key) {
    try { state.key = await NotifyCrypto.deriveKey(state.identity.priv, state.pair.peerPub); }
    catch { toast("密钥不可用"); return; }
  }
  m.status = "sending";
  renderChat("keep");
  try {
    const payload = await NotifyCrypto.encrypt(state.key, m.data);
    const row = await NotifyAPI.insertMessage(state.pair.convId, state.me, m.kind, payload);
    m.id = row.id;
    m.created_at = row.created_at;
    m.status = "sent";
    renderChat("keep");
    NotifyAPI.notifyPeer(state.pair.peerUid);
  } catch {
    m.status = "failed";
    renderChat("keep");
    toast("仍然发送失败，检查网络");
  }
}

/* ---------------- Web Push（锁屏通知） ---------------- */
function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* 订阅推送。iOS 要求：已添加到主屏幕（standalone）且 iOS 16.4+；其他平台无此限制。
   ★ iOS 还有第二条硬性要求：订阅/授权必须发生在「用户手势」之后。
     启动时后台静默订阅在 iOS 上会被直接拒绝（权限弹窗都不会出现），
     这就是"收不到任何通知"的根因。所以这里只处理已授权的情况，
     未授权时等用户第一次点按（发消息/配对按钮/长按进入聊天）再弹窗，
     见 armPush()。失败一律静默——推送是增强能力，不能影响聊天本身。 */
async function setupPush() {
  if (setupPush._busy) return;
  setupPush._busy = true;
  try {
    if (!pushSupported()) return;
    if (!window.isSecureContext) return;
    const standalone = navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) return;   // iOS 浏览器内 tab 不支持推送
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    await subscribePush();
  } catch (e) { console.warn("push 订阅失败（不影响使用）", e); }
  finally { setupPush._busy = false; }
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/* 用户手势时刻调用（click / 长按结束）。iOS 上权限为「未询问」时，
   必须在这一刻同步发起 requestPermission，否则弹窗不出现 */
function armPush() {
  if (!pushSupported()) return;
  try {
    if (!window.isSecureContext) return;
    const standalone = navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) return;
    if (!("Notification" in window) || Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      const p = Notification.requestPermission();          // 同步发起，保住手势上下文
      p.then((res) => { if (res === "granted") setupPush(); });
      return;
    }
    setupPush();                                           // 已授权 → 确保已订阅
  } catch {}
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const VAPID = "BLrwcgcdO4NG24MSOupOy1TCnZidqYS5mgl0YirFbCKZn8ZC3zssRVixI8wbb0yZy_8jB2vCv1KffN5aDfpW0WE";
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8(VAPID),
    });
  }
  await NotifyAPI.savePushSub(sub.toJSON());
}

/* ---------------- 撤回 ---------------- */
let recallTarget = null;
let maskGuardUntil = 0;   // 弹窗刚出现时，手指抬起产生的 click 不应把它关掉

function openRecall(m) {
  maskGuardUntil = Date.now() + 500;
  recallTarget = m;
  $("recallQuote").textContent =
    m.kind === "text" ? String(m.data.text || "").slice(0, 80)
    : m.kind === "image" ? "[图片]" : "[语音]";
  $("mask").classList.add("on");
  $("recallSheet").classList.add("on");
}
function closeSheets() {
  $("mask").classList.remove("on");
  $("recallSheet").classList.remove("on");
  $("settingsSheet").classList.remove("on");
  $("moveSheet").classList.remove("on");
}

async function doRecall() {
  if (!recallTarget) return;
  const m = recallTarget;
  closeSheets();
  try {
    await NotifyAPI.recall(m.id);
    m.recalled = true;
    m.data = {};
    state.msgs = state.msgs.filter((x) => x.id !== m.id);
    renderChat("keep");
    toast("已撤回");
  } catch (e) {
    toast(e.offline ? "网络不可用，请稍后重试" : "撤回失败，请重试");
  }
  recallTarget = null;
}

/* ---------------- 语音 ---------------- */
let recorder = null, recChunks = [], recStartAt = 0, recCancelled = false, recCancelY = 0;
let recToken = 0, recPending = false, recLimitTimer = null;
const REC_MAX_MS = 60000;

async function startRecord(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (recorder || recPending) return;
  recPending = true;
  const token = ++recToken;
  if (!(await ensurePairReady())) { recPending = false; return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    recPending = false;
    toast("需要麦克风权限：请在 设置 → Safari → 麦克风 中允许");
    return;
  }
  // 授权弹窗期间用户已经松手 → 立刻关麦，别让麦克风空转
  if (token !== recToken) {
    stream.getTracks().forEach((t) => t.stop());
    recPending = false;
    return;
  }
  try {
    const mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm";
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recChunks = [];
    recorder.ondataavailable = (ev) => ev.data.size && recChunks.push(ev.data);
    recorder.start();
    recStartAt = Date.now();
    recCancelled = false;
    $("recHint").classList.add("on");
    $("recHint").textContent = "● 正在录音… 上滑取消";
    // 60 秒自动结束，避免录出超大文件把消息撑爆
    recLimitTimer = setTimeout(() => { if (recorder) stopRecord(true); }, REC_MAX_MS);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    toast("录音失败，请重试");
  } finally {
    recPending = false;
  }
}

function moveRecord(e) {
  if (!recorder) return;
  const y = e.touches ? e.touches[0].clientY : e.clientY;
  recCancelled = y < recCancelY - 60;
  $("recHint").textContent = recCancelled ? "松开取消" : "● 正在录音… 上滑取消";
}

async function stopRecord(auto = false) {
  recToken++;                     // 让还在等授权的 startRecord 失效
  clearTimeout(recLimitTimer);
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  const dur = Math.max(1, Math.round((Date.now() - recStartAt) / 1000));
  await new Promise((res) => {
    rec.onstop = res;
    try { rec.stop(); } catch { res(); }
  });
  try { rec.stream.getTracks().forEach((t) => t.stop()); } catch {}
  $("recHint").classList.remove("on");
  if (recCancelled) { toast("已取消"); return; }
  if (auto) toast("已到 60 秒上限，自动发送", 1600);
  try {
    const blob = new Blob(recChunks, { type: rec.mimeType });
    const buf = await blob.arrayBuffer();
    const b64 = NotifyCrypto.bufToB64(buf);
    await sendMessage("voice", { d: b64, mime: rec.mimeType, dur });
  } catch {
    toast("语音处理失败");
  }
}

function playVoice(m) {
  if (state.audio && state.audioMsgId === m.id) {
    const loud = state.audio.volume < 0.9;
    state.audio.volume = loud ? 1 : 0.45;
    toast(loud ? "大音量" : "小音量（听筒级）", 900);
    return;
  }
  if (state.audio) { state.audio.pause(); state.audio = null; }
  if (!m.data.d) { toast("这条语音已失效"); return; }
  const a = new Audio(`data:${m.data.mime || "audio/mp4"};base64,${m.data.d}`);
  a.volume = 0.45;
  a.play().catch(() => toast("当前设备无法播放这种格式的语音"));
  state.audio = a;
  state.audioMsgId = m.id;
  a.onended = () => { state.audio = null; state.audioMsgId = null; };
  toast("小音量播放 · 再点一次切大音量", 1200);
}

/* ---------------- 图片 ---------------- */
async function handleImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(hei[cf])$/i.test(file.name || "")) {
    toast("请选择图片文件");
    return;
  }
  // 统一用 <img> 解码：浏览器会自动按 EXIF 把竖拍照片转正
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  } catch {
    URL.revokeObjectURL(url);
    toast("这张图无法读取（可能是 HEIC 格式）");
    return;
  }
  const max = 1000;
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) { URL.revokeObjectURL(url); toast("图片尺寸异常"); return; }
  const ratio = Math.min(1, max / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * ratio));
  const h = Math.max(1, Math.round(nh * ratio));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  let dataUrl;
  try { dataUrl = c.toDataURL("image/jpeg", 0.62); }
  catch { toast("图片处理失败"); return; }
  if (dataUrl.length > 3_500_000) {   // 约 2.6MB，超过就别发了
    toast("图片太大，换一张试试");
    return;
  }
  await sendMessage("image", { d: dataUrl, w, h });
}

/* ---------------- 配对流程 ---------------- */
let pairWaitTimer = null;

function pairCode() {
  const v = ($("codeInput").value || "").replace(/\D/g, "");
  if (v.length !== 6) { toast("请输入 6 位数字口令"); return null; }
  return v;
}

/* 兜底：本机还有旧配对记录，但服务端房间已经不存在
   （被清理 / 被重连顶替）。自动清掉本地记录，让建房/加入能直接继续，
   不需要用户去手动「清除本地数据」。网络失败时不误清。 */
async function stalePairCleared() {
  if (!state.pair || !state.pair.convId || !state.pair.peerPub || state.pair.convId === "demo") return;
  try {
    const members = await NotifyAPI.listMembers(state.pair.convId);
    if (members && members.length) return;         // 房间还在，正常拦截
    await NotifyAPI.leaveConv().catch(() => {});
    await NotifyCrypto.clearPair();
    clearPass();
    state.pair = null; state.key = null; state.msgs = [];
    toast("原房间已失效，本机记录已自动清除", 3000);
  } catch {}
}

async function createPair() {
  // 输入框留空时自动生成 6 位口令并显示，用户直接把屏幕上的数字告诉对方
  if (!($("codeInput").value || "").trim()) {
    const auto = String(Math.floor(Math.random() * 900000) + 100000);
    $("codeInput").value = auto;
  }
  const code = pairCode();
  if (!code) return;
  await stalePairCleared();
  if (state.pair && state.pair.convId && state.pair.peerPub) {
    $("pairStatus").textContent = "这台设备已经在一个房间里了，不能再建新房";
    return;
  }
  if (!state.me && !(await LoginIfNeeded())) {
    $("pairStatus").textContent = "网络未连接，稍后再试";
    return;
  }
  $("pairStatus").textContent = "正在创建…";
  $("pairCreate").disabled = true;
  try {
    const salt = NotifyCrypto.newSalt();                 // 每个房间一把独立随机盐
    const hash = await NotifyCrypto.hashCode(code, salt);
    const convId = await NotifyAPI.rpc("create_conv", { p_code_hash: hash, p_salt: salt, p_pub: state.identity.pub });
    state.pair = { convId, role: "a", peerPub: null, title: "学习计划", ownerFp: state.identity.fp };
    await NotifyCrypto.savePair(state.pair);
    savePass(code);
    $("pairStatus").innerHTML =
      "口令已创建：<b>" + code + "</b>（30 分钟内输入有效）<br>" +
      "⚠️ 请记好这 6 位数字：换手机、换网址全靠它重连（建房 <b>3 天内</b>有效），<b>忘记 = 永久失联</b>。<br>" +
      "现在把它当面或用别的方式告诉她";
    startPairWait();
  } catch (e) {
    $("pairStatus").textContent = "创建失败：" + (e.message || "网络错误");
  } finally {
    $("pairCreate").disabled = false;
  }
}

async function joinPair() {
  const code = pairCode();
  if (!code) return;
  await stalePairCleared();
  if (state.pair && state.pair.convId && state.pair.peerPub) {
    $("pairStatus").textContent = "这台设备已经在一个房间里了，不能再加入别的房间";
    return;
  }
  if (!state.me && !(await LoginIfNeeded())) {
    $("pairStatus").textContent = "网络未连接，稍后再试";
    return;
  }
  $("pairStatus").textContent = "正在加入…";
  $("pairJoin").disabled = true;
  try {
    // 先取房间盐（盐不是秘密，可以公开）；拿不到说明对方还没建房或口令已过期
    const salt = await NotifyAPI.rpc("pairing_salt", {});
    if (!salt) throw new Error("对方还没创建房间，或口令已过期（30 分钟）");
    const hash = await NotifyCrypto.hashCode(code, salt);
    const convId = await NotifyAPI.rpc("join_conv", { p_code_hash: hash, p_pub: state.identity.pub });
    if (!convId) throw new Error("口令无效、已被使用或已过期");
    const conv = await NotifyAPI.getConv(convId);
    if (!conv || !conv.pub_a) throw new Error("房间信息读取失败，请重试");
    const key = await NotifyCrypto.deriveKey(state.identity.priv, conv.pub_a);
    const members = await NotifyAPI.listMembers(convId).catch(() => []);
    const peerUid = (members || []).find((m) => m.uid !== state.me)?.uid || null;
    state.pair = { convId, role: "b", peerPub: conv.pub_a, peerUid, title: "学习计划", ownerFp: state.identity.fp };
    await NotifyCrypto.savePair(state.pair);
    savePass(code);
    state.key = key;
    const fp = await NotifyCrypto.fingerprint(key);
    $("pairStatus").innerHTML = "配对成功！密钥指纹 " + fp + "<br>口令已自动存入本机，随时可在设置里查看";
    setTimeout(() => { state.windowSize = RENDER_MAX; showView("chat"); pollOnce(); }, 700);
  } catch (e) {
    $("pairStatus").textContent = "加入失败：" + (e.message || "口令无效");
  } finally {
    $("pairJoin").disabled = false;
  }
}

function startPairWait() {
  clearInterval(pairWaitTimer);
  let emptyHits = 0;
  pairWaitTimer = setInterval(async () => {
    if (!state.pair || !state.pair.convId || state.pair.convId === "demo") return;
    if (document.hidden) return;
    try {
      const members = await NotifyAPI.listMembers(state.pair.convId);
      if (!members) return;
      if (members.length === 0) {
        // 自己是成员却查不到任何成员 → 房间已被服务端清理（口令 30 分钟没人用）
        if (++emptyHits >= 2) {
          clearInterval(pairWaitTimer);
          state.pair = null;
          state.key = null;
          await NotifyCrypto.clearPair();
          clearPass();
          $("pairStatus").textContent = "口令已过期（30 分钟未使用），请重新创建";
        }
        return;
      }
      emptyHits = 0;
      if (members.length >= 2) {
        clearInterval(pairWaitTimer);
        const conv = await NotifyAPI.getConv(state.pair.convId);
        if (!conv || !conv.pub_b) return;
        state.pair.peerPub = conv.pub_b;
        const members = await NotifyAPI.listMembers(state.pair.convId).catch(() => []);
        state.pair.peerUid = (members || []).find((m) => m.uid !== state.me)?.uid || null;
        await NotifyCrypto.savePair(state.pair);
        state.key = await NotifyCrypto.deriveKey(state.identity.priv, conv.pub_b);
        const fp = await NotifyCrypto.fingerprint(state.key);
        $("pairStatus").textContent = "对方已加入，配对成功！指纹 " + fp;
        setTimeout(() => { state.windowSize = RENDER_MAX; showView("chat"); }, 800);
      }
    } catch {}
  }, 3000);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  hold($("noteTitle"), 1000, async () => {
    armPush();                                             // 进入聊天这一刻顺带补订阅
    if (!state.pair || !state.pair.peerPub) {
      showView("pair");
      if (!state.pair) $("pairStatus").textContent = "";
      else startPairWait();
      return;
    }
    if (!state.key) {
      try { state.key = await NotifyCrypto.deriveKey(state.identity.priv, state.pair.peerPub); }
      catch { toast("密钥不可用，请重新配对"); return; }
    }
    state.unreadFirstId = null;
    state.windowSize = RENDER_MAX;
    showView("chat");
    pollOnce();
  });

  hold($("editBtn"), 2000, openSettings);

  if ($("pairBack")) $("pairBack").onclick = () => showView("note");
  $("backBtn").onclick = () => showView("note");
  $("chatBody").addEventListener("scroll", () => {
    // 注意：滚动事件里绝不 blur——聚焦输入框时 iOS 也会触发聊天区滚动，
    // 在这里收键盘会导致"键盘刚弹出来就消失、没法打字"。
    // 收键盘只认"手指按在消息区上"，见下面 touchstart。
    // 滑动开始/继续：冻结重绘，停稳 250ms 后补绘
    chatScrolling = true;
    clearTimeout(chatScrollTimer);
    chatScrollTimer = setTimeout(endChatScroll, 250);
    // 顶到 60px 内开始加载更早的消息（节流 400ms，避免逐帧触发）
    const now = Date.now();
    if ($("chatBody").scrollTop < 60 && now - (loadMore._t || 0) > 400) {
      loadMore._t = now;
      loadMore();
    }
  }, { passive: true });
  $("chatBody").addEventListener("touchstart", () => {
    // 手指点在消息区上 = 用户要翻记录，主动收起键盘
    const ae = document.activeElement;
    if (ae && ae.id === "msgInput") $("msgInput").blur();
    chatScrolling = true;
    clearTimeout(chatScrollTimer);
    chatScrollTimer = setTimeout(endChatScroll, 400);
  }, { passive: true });
  $("pairCreate").onclick = () => { armPush(); createPair(); };
  $("pairJoin").onclick = () => { armPush(); joinPair(); };
  $("mask").onclick = () => {
    if (Date.now() < maskGuardUntil) return;   // 忽略"长按松手"带出来的那一次点击
    closeSheets();
  };
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheets));
  $("recallConfirm").onclick = doRecall;

  $("inputbar").addEventListener("submit", async (e) => {
    e.preventDefault();
    armPush();                                             // iOS：借这次点击完成通知授权/订阅
    const el = $("msgInput");
    const v = el.value.trim();
    if (!v) return;
    if (v.length > 4000) { toast("单条最多 4000 字"); return; }
    el.value = "";
    el.style.height = "auto";
    await sendMessage("text", { text: v });
  });
  $("msgInput").addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(110, this.scrollHeight) + "px";
  });
  // 聚焦/失焦只做「钉底」，键盘高度完全由 kbFollow 每帧自动跟随，无状态可卡
  $("msgInput").addEventListener("focus", () => setTimeout(scrollBottom, 320));
  $("msgInput").addEventListener("blur", () => setTimeout(() => { if (isNearBottom()) scrollBottom(); }, 220));

  $("imgInput").onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) await handleImage(f);
  };

  const mic = $("micBtn");
  mic.addEventListener("touchstart", (e) => { recCancelY = e.touches[0].clientY; startRecord(e); }, { passive: false });
  mic.addEventListener("touchmove", moveRecord, { passive: true });
  mic.addEventListener("touchend", () => stopRecord());
  mic.addEventListener("touchcancel", () => { recCancelled = true; stopRecord(); });
  mic.addEventListener("mousedown", (e) => { recCancelY = e.clientY; startRecord(e); });
  mic.addEventListener("mousemove", moveRecord);
  mic.addEventListener("mouseup", () => stopRecord());
}

/* ---------------- 房间口令（本机留存，设置里随时可看） ----------------
   之前口令「用完即丢」：忘了就永久失联。现在存一份在本机 localStorage，
   设置页随时查看/复制——这是「忘了口令」最实用的保险。
   它不上传服务器；换手机后想继续能查看，走搬家流程会一并带过去。 */
const PASS_KEY = "notify-pass";
function savePass(code) { try { localStorage.setItem(PASS_KEY, String(code || "")); } catch {} }
function loadPass() { try { return localStorage.getItem(PASS_KEY) || ""; } catch { return ""; } }
function clearPass() { try { localStorage.removeItem(PASS_KEY); } catch {} }

/* ---------------- 搬家（导出 / 导入整间房） ----------------
   密钥与会话都存在本机、且绑定在当前网址上——换手机、换网址时
   它们不会自动跟过去。搬家包把「身份密钥 + 房间信息 + 登录会话 +
   记录本 + 口令」打包成一串文本：旧设备导出、新环境粘贴导入，
   房间原样恢复，不重新配对，历史消息继续可读。
   ⚠️ 包里含私钥与会话令牌，等于房间的全部钥匙，只能交给自己的新设备。 */
function moveBundle() {
  let sessionRaw = null;
  try { sessionRaw = localStorage.getItem("notify-session"); } catch {}
  return {
    v: 1, app: "notify", at: Date.now(),
    identity: state.identity || null,
    pair: state.pair || null,
    session: sessionRaw ? JSON.parse(sessionRaw) : null,
    note: (() => { try { return localStorage.getItem("notify-note") || ""; } catch { return ""; } })(),
    pass: loadPass(),
  };
}

async function buildMoveBundle() {
  if (!state.identity || !state.pair || !state.pair.convId || state.pair.convId === "demo") {
    throw new Error("这台设备还没有可搬家的房间");
  }
  const json = JSON.stringify(moveBundle());
  return "NTFY1-" + NotifyCrypto.bufToB64(new TextEncoder().encode(json));
}

async function applyMoveBundle(text) {
  const raw = (text || "").trim();
  if (!raw.startsWith("NTFY1-")) throw new Error("不是有效的搬家包（应以 NTFY1- 开头）");
  let b;
  try { b = JSON.parse(new TextDecoder().decode(NotifyCrypto.b64ToBuf(raw.slice(6)))); }
  catch { throw new Error("搬家包内容损坏，请在旧设备上重新导出"); }
  if (b.app !== "notify" || !b.identity || !b.pair || !b.pair.convId) {
    throw new Error("搬家包内容不完整，请在旧设备上重新导出");
  }
  // 校验登录会话还活着（refresh token 只在旧设备停止使用后才安全可用）
  if (b.session && b.session.refresh_token) {
    const ok = await NotifyAPI.restoreSession(b.session);
    if (!ok) {
      const go = confirm("会话校验未通过（网络不佳，或这份包导出后旧设备仍在使用会互相顶替）。仍要继续导入吗？");
      if (!go) throw new Error("已取消导入");
    }
  }
  await NotifyCrypto.saveIdentity(b.identity);
  await NotifyCrypto.savePair(b.pair);
  try {
    if (b.session) localStorage.setItem("notify-session", JSON.stringify(b.session));
    localStorage.setItem("notify-note", b.note || "");
    savePass(b.pass || "");
  } catch {}
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

let moveMode = "export";
function openMoveSheet(mode) {
  moveMode = mode;
  const sheet = $("moveSheet");
  maskGuardUntil = Date.now() + 500;
  closeSheets();
  $("moveText").value = "";
  if (mode === "export") {
    $("moveTitle").textContent = "搬家 · 导出这间房";
    $("moveTip").innerHTML =
      "下面这串文本 = 房间的全部钥匙（含私钥和登录信息）。<br>" +
      "复制后保存到只有你自己能拿到的地方（备忘录/私密笔记），<b>不要发给任何人</b>；" +
      "在新设备上点「粘贴搬家包恢复」即可原样恢复。<br><b>导入成功后旧设备会停止收发（钥匙搬家了）。</b>";
    $("moveBtn").textContent = "复制全部";
    $("mask").classList.add("on");
    sheet.classList.add("on");
    buildMoveBundle().then((t) => { $("moveText").value = t; })
      .catch((e) => { $("moveText").value = ""; toast(e.message || "导出失败", 3200); });
  } else {
    $("moveTitle").textContent = "搬家 · 恢复房间";
    $("moveTip").innerHTML =
      "把旧设备导出的搬家包（NTFY1- 开头的一串文本）粘贴到下面，点「恢复房间」。<br>" +
      "恢复后房间、口令、记录本与历史消息全部原样回来，无需重新配对。";
    $("moveBtn").textContent = "恢复房间";
    $("mask").classList.add("on");
    sheet.classList.add("on");
  }
}

function bindMove() {
  $("moveBtn").onclick = async () => {
    if (moveMode === "export") {
      const t = $("moveText").value;
      if (!t) { toast("还没有生成搬家包", 2000); return; }
      toast((await copyText(t)) ? "已复制，请妥善保存（用完建议删除）" : "复制失败，请长按文本手动全选复制", 3000);
      return;
    }
    // 导入
    const btn = $("moveBtn");
    const raw = $("moveText").value;
    if (!raw.trim()) { toast("请先粘贴搬家包", 2000); return; }
    btn.disabled = true;
    try {
      await applyMoveBundle(raw);
      closeSheets();
      toast("房间已恢复，正在进入…", 2400);
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      toast(e.message || "导入失败", 3600);
    } finally {
      btn.disabled = false;
    }
  };
  $("pairRestore").onclick = () => openMoveSheet("import");
  $("setMove").onclick = () => openMoveSheet("export");
  $("setPass").onclick = async () => {
    const p = loadPass();
    if (!p) { toast("本机没有留存口令"); return; }
    toast((await copyText(p)) ? "口令已复制" : "复制失败", 2000);
  };
}

/* ---------------- 设置 ---------------- */
async function openSettings() {
  maskGuardUntil = Date.now() + 500;
  $("setTitle").value = (state.pair && state.pair.title) || "学习计划";
  $("setFp").textContent = state.key ? await NotifyCrypto.fingerprint(state.key) : "—";
  const p = loadPass();
  $("setPass").textContent = p ? p : (state.pair ? "未留存（重新配对后会自动保存）" : "—");
  $("mask").classList.add("on");
  $("settingsSheet").classList.add("on");
}

function bindSettings() {
  bindMove();
  $("setTitle").addEventListener("change", async () => {
    const v = $("setTitle").value.trim() || "学习计划";
    if (!state.pair) { toast("还没有配对"); return; }
    state.pair.title = v;
    await NotifyCrypto.savePair(state.pair);
    $("chatTitle").textContent = v;
    toast("标题已更新");
  });
  $("setReset").onclick = async () => {
    if (!confirm("清除后需要重新配对，聊天记录也会消失。确定？")) return;
    try { await NotifyAPI.leaveConv(); } catch {}
    await NotifyCrypto.clearPair();
    state.pair = null; state.key = null; state.msgs = [];
    clearPass();
    location.reload();
  };
}

/* ---------------- 键盘跟随（微信式，无状态）----------------
   不再「记住键盘高度」「按 focus/blur 切状态」——任何有状态的方案都会卡死
   （键盘被手势收起时输入栏浮在半空 / 动画中途锁死偏小高度）。
   改为每帧读取 visualViewport，把输入栏钉在「真实可视区底部」：
       kb = innerHeight − vv.height − vv.offsetTop
   键盘弹起、收起、切换高度、被 iOS 顶推、手势下滑收起——全部自动跟随，
   没有任何可卡死的状态；offsetTop 项还能自动补偿 iOS 把页面往上顶的推力。
   Android 等原生收缩环境 innerHeight 会自己变小，kb≈0，自动退化为原生行为。 */
/* iOS 聚焦输入框前会做「预判滚动」把页面顶飞——所有输入框一律 preventScroll，
   输入栏本来就钉在键盘上方，Safari 无需滚动，推力从此消失 */
["HTMLInputElement", "HTMLTextAreaElement"].forEach((t) => {
  const p = window[t] && window[t].prototype;
  if (p && p.focus) {
    const orig = p.focus;
    p.focus = function (opts) { return orig.call(this, Object.assign({ preventScroll: true }, opts || {})); };
  }
});
let kbCur = -1, fvRaf = 0, healBusy = false, maxVH = window.innerHeight;
function kbFollow() {
  const vv = window.visualViewport;
  const ae = document.activeElement;
  const editing = !!(ae && ae.matches && ae.matches("input,textarea"));
  let kb = 0;
  if (vv) {
    // offsetTop 只在「确实在编辑」时参与补偿：它反映 iOS 把页面往上顶的推力，
    // 但非编辑态下参与计算会与布局互相影响（自激），所以那里一律不取
    const raw = window.innerHeight - vv.height - (editing ? (vv.offsetTop || 0) : 0);
    const fromVv = Math.round(raw);
    if (editing || fromVv > 100) kb = fromVv > 0 ? Math.min(fromVv, window.innerHeight) : 0;
    // 不编辑时的跟随只做「别让键盘盖住输入栏」的兜底；无键盘时 kb 必为 0，
    // 不存在任何会卡死的状态
    if (Math.abs(kb - kbCur) <= 2) return kb;    // 2px 死区：抖动的读数不落盘
  }
  if (kb === kbCur) return kb;
  kbCur = kb;
  const st = document.documentElement.style;
  st.setProperty("--kb", kb + "px");
  st.setProperty("--safe-b", kb > 0 ? "0px" : "env(safe-area-inset-bottom,0px)");
  // 注意：这里绝不调用 scrollBottom()。帧循环里滚动会改变 iOS 的视觉视口
  // 平移量（offsetTop），反过来又改变上面的 kb 计算 —— 自激振荡，表现为
  // 「聊天内容自己不停上下跳」。钉底只在 focus / 发送 / 新消息到达时做。
  return kb;
}
(function kbLoop() { kbFollow(); requestAnimationFrame(kbLoop); })();
function healViewport() {               // 视口卡缩自愈（翻转显示强制 WebKit 重算）
  if (healBusy) return;
  healBusy = true;
  document.body.style.display = "none";
  void document.body.offsetHeight;
  document.body.style.display = "";
  setTimeout(() => { healBusy = false; fitViewport(); }, 150);
}
function fitViewport() {
  if (fvRaf) return;
  fvRaf = requestAnimationFrame(() => {
    fvRaf = 0;
    maxVH = Math.max(maxVH, window.innerHeight);
    // 布局高度恒等于 innerHeight，不再随键盘压缩——键盘占位全部由
    // 输入栏跟随（--kb）承担，布局本身永远稳定
    document.documentElement.style.setProperty("--app-h", window.innerHeight + "px");
    const ae = document.activeElement;
    const editing = !!(ae && ae.matches && ae.matches("input,textarea"));
    // 键盘收起后视口仍卡在收缩态（iOS 已知 bug，底部灰带）→ 自愈
    if (!editing && maxVH - window.innerHeight > 60) healViewport();
  });
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("scroll", () => {
    // 读实时值（不读缓存）：键盘刚收起的那一帧也不误拉
    if (window.scrollY && kbFollow() > 0) window.scrollTo(0, 0);
  });
}
window.addEventListener("resize", fitViewport);
window.addEventListener("orientationchange", () => setTimeout(fitViewport, 200));
fitViewport();

/* ---------------- 演示模式（?demo=1，仅用于预览） ---------------- */
function demoMode() {
  state.pair = { convId: "demo", role: "a", peerPub: {}, title: "学习计划", ownerFp: "demo" };
  const t = Date.now();
  const mk = (mine, kind, data, ago, read, exp) => ({
    id: "d" + Math.random().toString(36).slice(2, 7),
    sender: mine ? "me" : "other",
    mine, kind, data,
    created_at: new Date(t - ago).toISOString(),
    read_at: read ? new Date(t - ago + 800).toISOString() : null,
    expires_at: exp ? new Date(t + exp).toISOString() : null,
    recalled: false, status: "sent",
  });
  state.msgs = [
    mk(false, "text", { text: "晚上一起去江边跑步吗？🏃" }, 600000, true, 820000),
    mk(true, "text", { text: "好呀，七点半老地方见" }, 540000, true, 760000),
    { id: "drec", sender: "other", mine: false, kind: "text", data: {}, created_at: new Date(t - 460000).toISOString(), read_at: null, expires_at: null, recalled: true, status: "sent" },
    mk(false, "image", { d: "icons/icon-512.png" }, 400000, true, 600000),
    mk(false, "voice", { dur: 8, mime: "audio/mp4", d: "" }, 200000, false, null),
    mk(true, "text", { text: "那我先去收拾一下～" }, 30000, false, 47000),
  ];
  state.unreadFirstId = state.msgs[4].id;
  showView("chat");
  renderChat();
}

/* ---------------- 启动 ---------------- */
bindEvents();
bindSettings();
fitViewport();
boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
