// Server-rendered consent page for the MCP OAuth flow (oauthProvider.ts). Deliberately not part
// of the dashboard bundle: the flow has to work on an API-only install and on a dashboard build
// that predates it. Every interpolated value goes through esc(); the page ships a strict CSP and
// refuses to be framed, because this is the one screen where a click hands out data access.

export type AuthorizeField = { name: string; value: string };

export type AuthorizePageInput = {
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  redirectHost: string;
  // The origin the decision route redirects to after the form is submitted. Chromium applies
  // the page's form-action directive to redirects that follow a form submission, so the client's
  // callback origin has to be listed next to 'self' or the approval never reaches claude.ai.
  redirectOrigin: string;
  // The signed request bundle (oauthProvider.ts) carried through as hidden inputs.
  hidden: AuthorizeField[];
  // Loopback issuers have no HTTPS; the browser must still be told what it is approving.
  mode:
    | { kind: "disabled" }
    | { kind: "enabled"; signedIn: false }
    | { kind: "enabled"; signedIn: true; email: string; projects: { id: string; name: string }[] };
  error?: string | null;
  // The dashboard root, for the "sign in there" escape hatch when SSO is the only door.
  dashboardUrl: string;
};

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SCOPE_LABELS: Record<string, string> = {
  "mcp:read": "Read traces, sessions, signals, datasets, evaluations, prompts and insights",
};

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; background: #f6f7f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; }
  main { max-width: 440px; margin: 48px auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px 32px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0 0 12px; line-height: 1.45; color: #374151; font-size: 14px; }
  .muted { color: #6b7280; font-size: 13px; }
  ul { padding-left: 18px; margin: 0 0 16px; font-size: 14px; color: #374151; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input[type=text], input[type=password], input[type=email], select { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  button { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; font-size: 14px; cursor: pointer; }
  button.primary { background: #111827; color: #fff; border-color: #111827; }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px; }
  .radio { display: flex; align-items: center; gap: 8px; font-weight: 400; margin: 6px 0; }
  code { font-size: 12px; background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
`;

function shell(title: string, body: string, nonce: string, script = "", formAction = "'self'"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body>
</html>`;
}

function hiddenInputs(fields: AuthorizeField[]): string {
  return fields.map(f => `<input type="hidden" name="${esc(f.name)}" value="${esc(f.value)}">`).join("\n");
}

function scopeList(scopes: string[]): string {
  return `<ul>${scopes.map(s => `<li>${esc(SCOPE_LABELS[s] ?? s)}</li>`).join("")}</ul>`;
}

export function renderAuthorizePage(input: AuthorizePageInput, nonce: string): string {
  // The origin of a URL the provider already parsed and matched against the client's registered
  // redirect URIs; a CSP source list is space-separated, so it cannot smuggle a second source.
  const formAction = `'self' ${esc(input.redirectOrigin)}`;
  const client = input.clientUri
    ? `<a href="${esc(input.clientUri)}" rel="noreferrer">${esc(input.clientName)}</a>`
    : `<strong>${esc(input.clientName)}</strong>`;
  const intro = `<h1>Connect ${esc(input.clientName)} to AgentX</h1>
<p>${client} is asking to use this AgentX instance through its MCP connector. After you approve, the browser returns to <code>${esc(input.redirectHost)}</code>.</p>
<p class="muted">It will be able to:</p>${scopeList(input.scopes)}`;
  const error = input.error ? `<div class="error">${esc(input.error)}</div>` : "";

  if (input.mode.kind === "disabled") {
    const body = `${intro}${error}
<form method="post" action="/authorize/decision">
${hiddenInputs(input.hidden)}
<label for="api_key">Project API key</label>
<input id="api_key" name="api_key" type="password" autocomplete="off" required placeholder="agtx_local_...">
<p class="muted">This instance runs without dashboard sign-in, so the project API key (printed when the engine starts, and shown in the dashboard's settings) is what authorizes the connection. The key itself is never sent to ${esc(input.clientName)}.</p>
<div class="actions">
  <button type="submit" name="action" value="deny">Cancel</button>
  <button type="submit" name="action" value="approve" class="primary">Approve</button>
</div>
</form>`;
    return shell("Connect to AgentX", body, nonce, "", formAction);
  }

  if (!input.mode.signedIn) {
    const body = `${intro}${error}
<p><strong>Sign in to continue.</strong></p>
<form id="signin">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div id="signin-error" class="error" hidden></div>
<div class="actions"><button type="submit" class="primary">Sign in</button></div>
</form>
<p class="muted" style="margin-top:16px">Using single sign-on? <a href="${esc(input.dashboardUrl)}" target="_blank" rel="noreferrer">Sign in to the dashboard</a> in another tab, then reload this page.</p>`;
    // Same-origin call to the existing better-auth endpoint; the session cookie it sets is what
    // the reload picks up. No token ever touches this page.
    const script = `
document.getElementById("signin").addEventListener("submit", async function (event) {
  event.preventDefault();
  var errorBox = document.getElementById("signin-error");
  errorBox.hidden = true;
  try {
    var res = await fetch("/api/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: document.getElementById("email").value, password: document.getElementById("password").value })
    });
    if (!res.ok) {
      var text = await res.text();
      var message = "Sign-in failed";
      try { message = JSON.parse(text).message || message; } catch (e) {}
      errorBox.textContent = message;
      errorBox.hidden = false;
      return;
    }
    window.location.reload();
  } catch (e) {
    errorBox.textContent = "Sign-in failed: " + (e && e.message ? e.message : e);
    errorBox.hidden = false;
  }
});`;
    return shell("Sign in to AgentX", body, nonce, script);
  }

  const projects = input.mode.projects;
  const projectPicker =
    projects.length === 0
      ? `<div class="error">Your account has no projects to grant. Create one in the dashboard first.</div>`
      : `<label>Project to connect</label>
${projects
  .map(
    (p, i) =>
      `<label class="radio"><input type="radio" name="project_id" value="${esc(p.id)}" ${i === 0 ? "checked" : ""} required> ${esc(p.name)}</label>`
  )
  .join("\n")}`;
  const body = `${intro}${error}
<form method="post" action="/authorize/decision">
${hiddenInputs(input.hidden)}
<p class="muted">Signed in as <strong>${esc(input.mode.email)}</strong>.</p>
${projectPicker}
<div class="actions">
  <button type="submit" name="action" value="deny">Cancel</button>
  <button type="submit" name="action" value="approve" class="primary" ${projects.length === 0 ? "disabled" : ""}>Approve</button>
</div>
</form>`;
  return shell("Connect to AgentX", body, nonce, "", formAction);
}

export function renderMessagePage(title: string, message: string, nonce: string): string {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, nonce);
}
