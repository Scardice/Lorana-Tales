interface LogSize {
  storedBytes?: number;
  encodedBytes?: number;
  compressedBytes?: number;
  decodedBytes?: number;
}

interface LogSummary {
  key: string;
  viewUrl?: string;
  name: string;
  client?: string;
  version?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  uploaderIp?: string;
  messageCount?: number;
  size?: LogSize;
}

interface LogListResponse {
  items: LogSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  query: string;
}

interface LogDetailResponse extends LogSummary {
  content?: string;
}

interface SessionResponse {
  authenticated: boolean;
  mode?: "root" | "account" | "none";
}

interface AccountUser { id:string; email:string; displayName:string; role:"user"|"admin"; status:"active"|"disabled"|"banned"; banReason:string; banUntil:string; projectCount?:number; }

interface DeleteResponse {
  deleted?: string[];
  missing?: string[];
  errors?: Array<{ key: string; error: string }>;
}

class AdminApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const state = {
  authenticated: false,
  authMode: "none" as "root" | "account" | "none",
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
  query: "",
  selected: new Set<string>(),
  currentDetailKey: "",
  currentDetailViewUrl: "",
};

const els = {
  loginView: requireElement<HTMLElement>("#loginView"),
  adminView: requireElement<HTMLElement>("#adminView"),
  logoutButton: requireElement<HTMLButtonElement>("#logoutButton"),
  loginForm: requireElement<HTMLFormElement>("#loginForm"),
  password: requireElement<HTMLInputElement>("#password"),
  loginError: requireElement<HTMLElement>("#loginError"),
  searchForm: requireElement<HTMLFormElement>("#searchForm"),
  searchInput: requireElement<HTMLInputElement>("#searchInput"),
  pageSizeSelect: requireElement<HTMLSelectElement>("#pageSizeSelect"),
  resetButton: requireElement<HTMLButtonElement>("#resetButton"),
  refreshButton: requireElement<HTMLButtonElement>("#refreshButton"),
  cleanupButton: requireElement<HTMLButtonElement>("#cleanupButton"),
  maintenanceButton: requireElement<HTMLButtonElement>("#maintenanceButton"),
  deleteSelectedButton: requireElement<HTMLButtonElement>(
    "#deleteSelectedButton",
  ),
  filterInfo: requireElement<HTMLElement>("#filterInfo"),
  selectionCount: requireElement<HTMLElement>("#selectionCount"),
  listStatus: requireElement<HTMLElement>("#listStatus"),
  logList: requireElement<HTMLElement>("#logList"),
  totalCount: requireElement<HTMLElement>("#totalCount"),
  pageInfo: requireElement<HTMLElement>("#pageInfo"),
  sizeInfo: requireElement<HTMLElement>("#sizeInfo"),
  pagerText: requireElement<HTMLElement>("#pagerText"),
  prevButton: requireElement<HTMLButtonElement>("#prevButton"),
  nextButton: requireElement<HTMLButtonElement>("#nextButton"),
  drawer: requireElement<HTMLElement>("#drawer"),
  closeDrawer: requireElement<HTMLButtonElement>("#closeDrawer"),
  openPainterButton: requireElement<HTMLButtonElement>("#openPainterButton"),
  rawExportButton: requireElement<HTMLButtonElement>("#rawExportButton"),
  deleteDetailButton: requireElement<HTMLButtonElement>("#deleteDetailButton"),
  detailName: requireElement<HTMLElement>("#detailName"),
  detailKey: requireElement<HTMLElement>("#detailKey"),
  detailCount: requireElement<HTMLElement>("#detailCount"),
  detailSize: requireElement<HTMLElement>("#detailSize"),
  detailClient: requireElement<HTMLElement>("#detailClient"),
  detailVersion: requireElement<HTMLElement>("#detailVersion"),
  detailTime: requireElement<HTMLElement>("#detailTime"),
  detailIp: requireElement<HTMLElement>("#detailIp"),
  detailContent: requireElement<HTMLElement>("#detailContent"),
  createUserForm: requireElement<HTMLFormElement>("#createUserForm"),
  newUserEmail: requireElement<HTMLInputElement>("#newUserEmail"),
  newUserName: requireElement<HTMLInputElement>("#newUserName"),
  newUserPassword: requireElement<HTMLInputElement>("#newUserPassword"),
  newUserRole: requireElement<HTMLSelectElement>("#newUserRole"),
  refreshUsersButton: requireElement<HTMLButtonElement>("#refreshUsersButton"),
  userStatus: requireElement<HTMLElement>("#userStatus"),
  userList: requireElement<HTMLElement>("#userList"),
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(value: number | undefined): string {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatTime(value: string | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getSizeStats(size?: LogSize): string[] {
  return [
    `存储 ${formatBytes(size?.storedBytes || 0)}`,
    `压缩 ${formatBytes(size?.compressedBytes || 0)}`,
    `内容 ${formatBytes(size?.decodedBytes || 0)}`,
  ];
}

function formatSizeStats(size?: LogSize): string {
  return getSizeStats(size).join(" / ");
}

function formatSizeStatsBlock(size?: LogSize): string {
  return getSizeStats(size)
    .map((line) => `<span>${line}</span>`)
    .join("");
}

type ToastType = "success" | "error" | "warning" | "info";

const toastIcons: Record<ToastType, string> = {
  success: "✓",
  error: "✗",
  warning: "!",
  info: "i",
};

function showAdminToast(message: string, type: ToastType = "info"): void {
  const host =
    document.getElementById("toast-host") ||
    (() => {
      const el = document.createElement("div");
      el.id = "toast-host";
      Object.assign(el.style, {
        position: "fixed",
        top: "22px",
        left: "50%",
        zIndex: "100",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
        pointerEvents: "none",
        width: "min(460px, calc(100vw - 32px))",
        transform: "translateX(-50%)",
      });
      document.body.appendChild(el);
      return el;
    })();

  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  const icon = document.createElement("span");
  icon.className = "toast__icon";
  icon.textContent = toastIcons[type];
  const text = document.createElement("span");
  text.textContent = message;
  el.append(icon, text);
  host.appendChild(el);

  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 220);
  }, 3000);
}

function setBusy(
  button: HTMLButtonElement,
  busy: boolean,
  label?: string,
): void {
  if (label !== undefined) button.textContent = label;
  button.disabled = busy;
}

function closeDrawer(): void {
  state.currentDetailKey = "";
  state.currentDetailViewUrl = "";
  els.drawer.classList.add("hidden");
  els.drawer.setAttribute("aria-hidden", "true");
  els.openPainterButton.disabled = true;
}

function showLogin() {
  state.authenticated = false;
  state.authMode = "none";
  state.selected.clear();
  closeDrawer();
  els.loginView.classList.remove("hidden");
  els.adminView.classList.add("hidden");
  els.logoutButton.classList.add("hidden");
  updateSelectionUi();
  els.password.focus();
}

function showAdmin(mode: "root" | "account" = "root") {
  state.authenticated = true;
  state.authMode = mode;
  els.loginView.classList.add("hidden");
  els.adminView.classList.remove("hidden");
  els.logoutButton.classList.remove("hidden");
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = decodeURIComponent(document.cookie.split("; ").find((item) => item.startsWith("scardice_account_csrf="))?.split("=").slice(1).join("=") || "");
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    throw new AdminApiError(
      String(body.error || `HTTP ${response.status}`),
      response.status,
    );
  }
  return body as T;
}

async function checkSession() {
  try {
    const session = await api<SessionResponse>("/admin/api/session");
    if (session.authenticated) {
      showAdmin(session.mode === "account" ? "account" : "root");
      await loadLogs();
      await loadUsers();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

async function login(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  els.loginError.textContent = "";
  try {
    await api<SessionResponse>("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ password: els.password.value }),
    });
    els.password.value = "";
    showAdmin("root");
    await loadLogs();
    await loadUsers();
  } catch (error) {
    const status = error instanceof AdminApiError ? error.status : 0;
    els.loginError.textContent =
      status === 429 ? "失败次数过多，请稍后再试。" : "密码不正确。";
  }
}

async function logout(): Promise<void> {
  await api<SessionResponse>(state.authMode === "account" ? "/api/account/logout" : "/admin/api/logout", { method: "POST", body: "{}" }).catch(
    () => {},
  );
  showLogin();
}

function updateFilterInfo(): void {
  els.filterInfo.textContent = state.query
    ? `筛选：${state.query}`
    : "最近上传";
}

function updateSelectionUi(): void {
  const count = state.selected.size;
  els.selectionCount.textContent = `已选 ${count}`;
  els.deleteSelectedButton.disabled = count === 0;
}

function renderList(items: LogSummary[]): void {
  updateFilterInfo();

  if (!items.length) {
    els.logList.classList.add("hidden");
    els.listStatus.classList.remove("hidden");
    els.listStatus.textContent = state.query
      ? "没有匹配的日志记录"
      : "暂无日志，最近上传会显示在这里";
    return;
  }

  els.listStatus.classList.add("hidden");
  els.logList.classList.remove("hidden");
  els.logList.innerHTML = items
    .map((item) => {
      const checked = state.selected.has(item.key) ? "checked" : "";
      return `
        <div class="log-row">
          <label class="check-cell" aria-label="选择 ${escapeHtml(item.name)}">
            <input type="checkbox" data-select="${escapeHtml(item.key)}" ${checked} />
          </label>
          <div class="log-name">
            <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
            <code>${escapeHtml(item.key)}</code>
          </div>
          <div class="metric">
            <span>消息条数</span>
            <strong>${Number(item.messageCount || 0).toLocaleString()}</strong>
          </div>
          <div class="metric metric--size">
            <span>占用空间</span>
            <strong class="metric-size-lines" aria-label="${escapeHtml(formatSizeStats(item.size))}">
              ${formatSizeStatsBlock(item.size)}
            </strong>
          </div>
          <div class="time">
            <span>上传时间</span>
            <strong>${escapeHtml(formatTime(item.createdAt))}</strong>
          </div>
          <div class="ip">
            <span>上传 IP</span>
            <strong>${escapeHtml(item.uploaderIp || "unknown")}</strong>
	          </div>
	          <div class="row-actions">
	            <button class="button primary" type="button" data-open="${escapeHtml(item.key)}">查看</button>
	            <button class="button danger" type="button" data-delete="${escapeHtml(item.key)}">删除</button>
	          </div>
        </div>
      `;
    })
    .join("");
}

function updatePager() {
  els.totalCount.textContent = state.total.toLocaleString();
  els.pageInfo.textContent = `${state.page} / ${state.totalPages}`;
  els.sizeInfo.textContent = String(state.pageSize);
  els.pagerText.textContent = `${state.page} / ${state.totalPages}`;
  els.prevButton.disabled = state.page <= 1;
  els.nextButton.disabled = state.page >= state.totalPages;
}

async function loadLogs() {
  els.listStatus.classList.remove("hidden");
  els.listStatus.textContent = "加载中";
  els.logList.classList.add("hidden");

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.query) params.set("q", state.query);

  try {
    const data = await api<LogListResponse>(
      `/admin/api/logs?${params.toString()}`,
    );
    state.page = data.page;
    state.pageSize = data.pageSize;
    state.total = data.total;
    state.totalPages = data.totalPages;
    renderList(data.items || []);
    updatePager();
    updateSelectionUi();
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) {
      showLogin();
      return;
    }
    els.listStatus.textContent = "加载失败";
  }
}

async function openDetail(key: string): Promise<void> {
  state.currentDetailKey = key;
  state.currentDetailViewUrl = "";
  els.drawer.classList.remove("hidden");
  els.drawer.setAttribute("aria-hidden", "false");
  els.detailName.textContent = "加载中";
  els.detailKey.textContent = key;
  els.detailCount.textContent = "0";
  els.detailSize.textContent = "0 B";
  els.detailClient.textContent = "unknown";
  els.detailVersion.textContent = "unknown";
  els.detailTime.textContent = "unknown";
  els.detailIp.textContent = "unknown";
  els.detailContent.textContent = "加载中";
  els.openPainterButton.disabled = true;

  try {
    const detail = await api<LogDetailResponse>(
      `/admin/api/logs/${encodeURIComponent(key)}`,
    );
    state.currentDetailKey = detail.key || key;
    state.currentDetailViewUrl = detail.viewUrl || "";
    els.detailName.textContent = detail.name || "unknown";
    els.detailKey.textContent = detail.key || key;
    els.detailCount.textContent = Number(
      detail.messageCount || 0,
    ).toLocaleString();
    els.detailSize.textContent = formatSizeStats(detail.size);
    els.detailClient.textContent = detail.client || "unknown";
    els.detailVersion.textContent = detail.version || "unknown";
    els.detailTime.textContent = formatTime(detail.createdAt);
    els.detailIp.textContent = detail.uploaderIp || "unknown";
    els.detailContent.textContent = detail.content || "";
    els.openPainterButton.disabled = !state.currentDetailViewUrl;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) {
      showLogin();
      return;
    }
    els.detailName.textContent = "读取失败";
    els.detailContent.textContent =
      error instanceof Error ? error.message : "unknown error";
  }
}

async function deleteKeys(keys: string[]): Promise<DeleteResponse | null> {
  if (!keys.length) return null;
  const label =
    keys.length === 1 ? "删除这条日志？" : `删除选中的 ${keys.length} 条日志？`;
  if (!window.confirm(label)) return null;

  const result = await api<DeleteResponse>("/admin/api/logs/delete", {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
  for (const key of keys) state.selected.delete(key);
  updateSelectionUi();
  return result;
}

async function deleteAndRefresh(keys: string[]): Promise<void> {
  try {
    const result = await deleteKeys(keys);
    if (!result) return;
    if (state.currentDetailKey && keys.includes(state.currentDetailKey)) {
      closeDrawer();
    }
    await loadLogs();
    const errorCount = result.errors?.length || 0;
    if (errorCount) showAdminToast(`有 ${errorCount} 条删除失败。`, "error");
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) {
      showLogin();
      return;
    }
    showAdminToast(
      error instanceof Error ? error.message : "删除失败",
      "error",
    );
  }
}

async function runCleanup(): Promise<void> {
  const original = els.cleanupButton.textContent || "清理过期";
  setBusy(els.cleanupButton, true, "清理中");
  try {
    const result = await api<{ deletedCount?: number }>("/admin/api/cleanup", {
      method: "POST",
      body: JSON.stringify({}),
    });
    await loadLogs();
    showAdminToast(
      `已清理 ${Number(result.deletedCount || 0).toLocaleString()} 条过期日志。`,
      "success",
    );
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) {
      showLogin();
      return;
    }
    showAdminToast(
      error instanceof Error ? error.message : "清理失败",
      "error",
    );
  } finally {
    setBusy(els.cleanupButton, false, original);
  }
}

async function runMaintenance(): Promise<void> {
  const original = els.maintenanceButton.textContent || "维护数据库";
  setBusy(els.maintenanceButton, true, "维护中");
  try {
    const result = await api<{ integrity?: string; vacuumed?: boolean }>(
      "/admin/api/database/maintenance",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    await loadLogs();
    showAdminToast(
      `数据库检查完成：${result.integrity || "unknown"}${result.vacuumed ? "，已执行 VACUUM" : ""}。`,
      "info",
    );
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) {
      showLogin();
      return;
    }
    showAdminToast(
      error instanceof Error ? error.message : "维护失败",
      "error",
    );
  } finally {
    setBusy(els.maintenanceButton, false, original);
  }
}

function renderUsers(items: AccountUser[]): void {
  els.userList.innerHTML = items.map((user) => `<article class="user-row" data-user-id="${escapeHtml(user.id)}">
    <div class="user-row__name"><strong>${escapeHtml(user.displayName || user.email)}</strong><small>${escapeHtml(user.email)}</small></div>
    <span class="pill">${user.role === "admin" ? "管理员" : "用户"}</span>
    <span class="pill">${user.status === "banned" ? `已封禁：${escapeHtml(user.banReason)}` : user.status === "disabled" ? "已停用" : "正常"}</span>
    <div class="user-row__actions"><button class="button" data-user-action="edit">编辑</button><button class="button" data-user-action="password">改密码</button><button class="button warning" data-user-action="status">${user.status === "active" ? "封禁/停用" : "恢复"}</button><button class="button danger" data-user-action="delete">删除</button></div>
  </article>`).join("");
  els.userList.querySelectorAll<HTMLElement>("[data-user-action]").forEach((button) => button.addEventListener("click", () => {
    const row = button.closest<HTMLElement>("[data-user-id]"); const user = items.find((item) => item.id === row?.dataset.userId); if (user) manageUser(user, button.dataset.userAction || "");
  }));
}

async function loadUsers(): Promise<void> {
  els.userStatus.classList.remove("hidden"); els.userStatus.textContent = "加载账户…";
  try {
    const data = await api<{items:AccountUser[]}>("/admin/api/users?pageSize=100");
    renderUsers(data.items || []); els.userStatus.classList.toggle("hidden", !!data.items?.length); if (!data.items?.length) els.userStatus.textContent = "还没有账户";
  } catch (error) {
    els.userList.innerHTML = ""; els.userStatus.textContent = error instanceof AdminApiError && error.status === 404 ? "账户功能未开启" : "账户读取失败";
  }
}

async function manageUser(user: AccountUser, action: string): Promise<void> {
  try {
    if (action === "edit") {
      const email = prompt("邮箱", user.email); if (email === null) return; const displayName = prompt("显示名", user.displayName); if (displayName === null) return; const role = prompt("角色：admin 或 user", user.role); if (role !== "admin" && role !== "user") return;
      await api(`/admin/api/users/${encodeURIComponent(user.id)}`, { method:"PATCH", body:JSON.stringify({ email, displayName, role }) });
    } else if (action === "password") {
      const password = prompt("输入至少 10 位的新密码。用户下次登录必须修改。", ""); if (!password) return;
      await api(`/admin/api/users/${encodeURIComponent(user.id)}/password`, { method:"POST", body:JSON.stringify({ password, mustChangePassword:true }) });
    } else if (action === "status") {
      if (user.status !== "active") await api(`/admin/api/users/${encodeURIComponent(user.id)}/status`, { method:"POST", body:JSON.stringify({ status:"active" }) });
      else { const type = prompt("输入 banned 封禁，或 disabled 停用", "banned"); if (type !== "banned" && type !== "disabled") return; const reason = prompt(type === "banned" ? "封禁理由（必填）" : "停用备注", ""); if (type === "banned" && !reason?.trim()) { showAdminToast("封禁必须填写理由", "warning"); return; } const until = type === "banned" ? prompt("可选：解封时间（ISO 日期）；留空为永久", "") : ""; await api(`/admin/api/users/${encodeURIComponent(user.id)}/status`, { method:"POST", body:JSON.stringify({ status:type, reason, until }) }); }
    } else if (action === "delete") {
      const projectAction = prompt("用户工程如何处理：archive（归档）、delete（删除）或 transfer（转移）", "archive"); if (!projectAction || !["archive","delete","transfer"].includes(projectAction)) return; let transferUserId=""; if(projectAction==="transfer"){transferUserId=prompt("接收用户 ID","")||"";if(!transferUserId)return}if(!confirm(`确定删除 ${user.email}？工程处理：${projectAction}`))return;await api(`/admin/api/users/${encodeURIComponent(user.id)}`,{method:"DELETE",body:JSON.stringify({projectAction,transferUserId})});
    }
    showAdminToast("账户操作完成", "success"); await loadUsers();
  } catch (error) { showAdminToast(error instanceof Error ? error.message : "账户操作失败", "error"); }
}

async function createUser(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  try { await api("/admin/api/users", { method:"POST", body:JSON.stringify({ email:els.newUserEmail.value, displayName:els.newUserName.value, password:els.newUserPassword.value, role:els.newUserRole.value, mustChangePassword:true }) }); els.createUserForm.reset(); showAdminToast("用户已创建", "success"); await loadUsers(); }
  catch (error) { showAdminToast(error instanceof Error ? error.message : "创建失败", "error"); }
}

function exportCurrentRaw(): void {
  if (!state.currentDetailKey) return;
  window.location.href = `/admin/api/logs/${encodeURIComponent(state.currentDetailKey)}/raw`;
}

function openCurrentPainter(): void {
  if (!state.currentDetailViewUrl) return;
  window.open(state.currentDetailViewUrl, "_blank", "noopener,noreferrer");
}

els.loginForm.addEventListener("submit", login);
els.createUserForm.addEventListener("submit", createUser);
els.refreshUsersButton.addEventListener("click", loadUsers);
els.logoutButton.addEventListener("click", logout);
els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = els.searchInput.value.trim();
  state.pageSize = Number(els.pageSizeSelect.value);
  state.page = 1;
  loadLogs();
});
els.resetButton.addEventListener("click", () => {
  els.searchInput.value = "";
  state.query = "";
  state.page = 1;
  loadLogs();
});
els.refreshButton.addEventListener("click", () => {
  loadLogs();
});
els.cleanupButton.addEventListener("click", runCleanup);
els.maintenanceButton.addEventListener("click", runMaintenance);
els.deleteSelectedButton.addEventListener("click", () => {
  deleteAndRefresh([...state.selected]);
});
els.pageSizeSelect.addEventListener("change", () => {
  state.pageSize = Number(els.pageSizeSelect.value);
  state.page = 1;
  loadLogs();
});
els.prevButton.addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  loadLogs();
});
els.nextButton.addEventListener("click", () => {
  if (state.page >= state.totalPages) return;
  state.page += 1;
  loadLogs();
});
els.logList.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const select = target?.closest<HTMLInputElement>("[data-select]");
  if (select) {
    const key = select.getAttribute("data-select") || "";
    if (select.checked) state.selected.add(key);
    else state.selected.delete(key);
    updateSelectionUi();
    return;
  }

  const deleteButton = target?.closest<HTMLElement>("[data-delete]");
  if (deleteButton) {
    const key = deleteButton.getAttribute("data-delete");
    if (key) deleteAndRefresh([key]);
    return;
  }

  const button = target?.closest<HTMLElement>("[data-open]");
  if (!button) return;
  const key = button.getAttribute("data-open");
  if (key) openDetail(key);
});
els.closeDrawer.addEventListener("click", () => {
  closeDrawer();
});
els.rawExportButton.addEventListener("click", exportCurrentRaw);
els.openPainterButton.addEventListener("click", openCurrentPainter);
els.deleteDetailButton.addEventListener("click", () => {
  if (state.currentDetailKey) deleteAndRefresh([state.currentDetailKey]);
});
els.drawer.addEventListener("click", (event) => {
  if (event.target === els.drawer) closeDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

checkSession();
