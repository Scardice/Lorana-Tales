const DEFAULT_WARNING =
  "操作已被安全系统拦截\n\n拦截ID：SIC-LOCAL-000000000000\n如果认为是误报，请向系统管理员报告拦截ID。\n\n原因：\n由于本次上传的日志包含危险的注入代码，已被安全系统拦截，请求内容以及IP已经被记录，请规范个人行为。\n\n> “Hey bro, what the fuck are you doing? Stop dreaming about being a hacker, you low-tech noob! 👎👎👎 Wake up, the floor is freezing!”——某人\n\n原因详情：\n```text\n未提供检测详情\n```";

type ParsedWarning = {
  interceptId: string;
  reason: string;
  quote: string;
  detail: string;
};

async function fetchServerWarning(interceptId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/security/intercepts/${encodeURIComponent(interceptId)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { warningText?: string };
    return typeof body.warningText === "string" ? body.warningText : null;
  } catch {
    return null;
  }
}

async function readWarningText(): Promise<string> {
  const params = new URLSearchParams(window.location.search);
  const interceptId = params.get("intercept_id");
  if (interceptId) {
    const serverWarning = await fetchServerWarning(interceptId);
    if (serverWarning) return serverWarning;
  }
  return sessionStorage.getItem("scardiceSecurityWarning") || DEFAULT_WARNING;
}

function parseWarning(text: string): ParsedWarning {
  const codeMatch = /```(?:text)?\s*([\s\S]*?)```/.exec(text);
  const quoteMatch = /^>\s*(.+)$/m.exec(text);
  const idMatch = /^拦截ID：(.+)$/m.exec(text);
  const reasonMatch = /原因：\s*([\s\S]*?)\n\s*>/m.exec(text);
  return {
    interceptId: idMatch?.[1]?.trim() || "SIC-UNKNOWN",
    reason:
      reasonMatch?.[1]?.trim() ||
      "由于本次操作触发安全策略，已被安全系统拦截。",
    quote:
      quoteMatch?.[1] ||
      "“Hey bro, what the fuck are you doing? Stop dreaming about being a hacker, you low-tech noob! 👎👎👎 Wake up, the floor is freezing!”——某人",
    detail: codeMatch?.[1]?.trim() || "未提供检测详情",
  };
}

function appendText<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  text: string,
  className = "",
) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

async function render() {
  const root = document.getElementById("security-warning");
  if (!root) return;

  const warning = parseWarning(await readWarningText());
  const shell = document.createElement("section");
  shell.className = "warning-shell";

  const masthead = document.createElement("div");
  masthead.className = "masthead";
  const logo = document.createElement("img");
  logo.src = "/icon.png";
  logo.alt = "";
  masthead.appendChild(logo);
  appendText(masthead, "span", "SECURITY INTERCEPT", "eyebrow");
  shell.appendChild(masthead);

  appendText(shell, "h1", "操作已被安全系统拦截");

  const record = document.createElement("div");
  record.className = "record";
  appendText(record, "span", "拦截ID", "record-label");
  appendText(record, "code", warning.interceptId, "record-id");
  shell.appendChild(record);

  appendText(
    shell,
    "p",
    "如果认为是误报，请向系统管理员报告拦截ID。",
    "report-note",
  );

  appendText(shell, "h2", "原因");
  appendText(shell, "p", warning.reason, "lead");

  const quote = document.createElement("blockquote");
  quote.textContent = warning.quote;
  shell.appendChild(quote);

  appendText(shell, "h2", "原因详情");
  const code = document.createElement("pre");
  const codeInner = document.createElement("code");
  codeInner.textContent = warning.detail;
  code.appendChild(codeInner);
  shell.appendChild(code);

  const actions = document.createElement("div");
  actions.className = "actions";
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "返回首页";
  actions.appendChild(back);
  shell.appendChild(actions);

  root.replaceChildren(shell);
}

const style = document.createElement("style");
style.textContent = `
  :root {
    color-scheme: dark;
    --bg: #101214;
    --panel: #171b1f;
    --ink: #f2f0e8;
    --muted: #a7adb4;
    --line: #303841;
    --alert: #ff4d2e;
    --amber: #f6c453;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    min-height: 100vh;
    background:
      linear-gradient(90deg, rgba(255, 77, 46, 0.18) 0 1px, transparent 1px 100%),
      linear-gradient(0deg, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 100%),
      var(--bg);
    background-size: 42px 42px;
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  #security-warning {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 18px;
  }

  .warning-shell {
    width: min(920px, 100%);
    border: 1px solid var(--line);
    border-left: 6px solid var(--alert);
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
    padding: clamp(24px, 5vw, 52px);
  }

  .masthead,
  .record {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .masthead {
    margin-bottom: 22px;
  }

  .masthead img {
    width: 38px;
    height: 38px;
  }

  .eyebrow,
  .record-label {
    color: var(--amber);
    font-size: 12px;
    letter-spacing: 0;
  }

  h1 {
    margin: 0;
    color: var(--alert);
    font-size: clamp(32px, 7vw, 72px);
    line-height: 0.95;
    letter-spacing: 0;
  }

  .record {
    margin-top: 24px;
    flex-wrap: wrap;
  }

  .record-id {
    color: #f8d8d0;
    font-size: clamp(14px, 2vw, 18px);
  }

  .report-note {
    margin: 10px 0 28px;
    color: var(--muted);
  }

  .lead {
    max-width: 760px;
    margin: 10px 0 0;
    color: var(--ink);
    font-size: clamp(16px, 2vw, 20px);
    line-height: 1.75;
  }

  blockquote {
    margin: 28px 0;
    padding: 16px 18px;
    border-left: 3px solid var(--amber);
    color: var(--amber);
    background: rgba(246, 196, 83, 0.08);
  }

  h2 {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 15px;
    letter-spacing: 0;
  }

  pre {
    margin: 0;
    max-height: min(44vh, 420px);
    overflow: auto;
    border: 1px solid var(--line);
    background: #080a0c;
    padding: 18px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  code {
    color: #f8d8d0;
    font: inherit;
    line-height: 1.55;
  }

  .actions {
    margin-top: 28px;
  }

  .actions a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 42px;
    padding: 0 18px;
    border: 1px solid var(--alert);
    color: var(--ink);
    text-decoration: none;
    background: rgba(255, 77, 46, 0.12);
  }

  .actions a:hover {
    background: rgba(255, 77, 46, 0.22);
  }
`;
document.head.appendChild(style);
render();
