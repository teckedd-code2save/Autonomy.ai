// Minimal single-purpose connect page. It holds no secrets itself; the form
// posts to the operator-authenticated /v1/connections API.
export function connectPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Compute Gateway — Connect</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #e6edf3; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  main { width: min(480px, 92vw); }
  h1 { font-size: 1.1rem; font-weight: 600; }
  p.sub { color: #8b949e; font-size: 0.8rem; line-height: 1.5; }
  form { display: grid; gap: 0.75rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; }
  label { font-size: 0.75rem; color: #8b949e; display: grid; gap: 0.3rem; }
  input, select { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; padding: 0.55rem 0.7rem; font: inherit; }
  input:focus, select:focus { outline: 1px solid #58a6ff; border-color: #58a6ff; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 0.65rem; font: inherit; cursor: pointer; }
  button:hover { background: #2ea043; }
  #modal-only { display: none; }
  form[data-provider="modal"] #modal-only { display: grid; gap: 0.75rem; }
  form[data-provider="modal"] #hf-only { display: none; }
  #result { font-size: 0.8rem; white-space: pre-wrap; border-radius: 6px; padding: 0.75rem; display: none; }
  #result.ok { display: block; background: #12261e; border: 1px solid #238636; }
  #result.err { display: block; background: #2d1517; border: 1px solid #f85149; }
</style>
</head>
<body>
<main>
  <h1>Connect a compute provider</h1>
  <p class="sub">The credential is validated against the real provider, then written to the
  gateway's secret store. Agents only ever see the capability — never this value.</p>
  <form id="connect" data-provider="modal">
    <label>Provider
      <select id="provider">
        <option value="modal">Modal</option>
        <option value="huggingface">Hugging Face</option>
      </select>
    </label>
    <div id="modal-only">
      <label>Modal Token ID <input id="tokenId" autocomplete="off" required /></label>
      <label>Modal Token Secret <input id="tokenSecret" type="password" required /></label>
    </div>
    <div id="hf-only">
      <label>HF Token <input id="token" type="password" /></label>
      <label>HF Namespace (user or org) <input id="namespace" autocomplete="off" /></label>
    </div>
    <label>Operator key <input id="operatorKey" type="password" required /></label>
    <button type="submit">Validate &amp; connect</button>
  </form>
  <div id="result"></div>
</main>
<script>
const form = document.getElementById("connect");
const result = document.getElementById("result");
form.provider.addEventListener("change", () => { form.dataset.provider = form.provider.value; });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.className = ""; result.textContent = "";
  const provider = form.provider.value;
  const body = provider === "modal"
    ? { tokenId: form.tokenId.value, tokenSecret: form.tokenSecret.value }
    : { token: form.token.value, namespace: form.namespace.value };
  try {
    const res = await fetch("/v1/connections/" + provider, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + form.operatorKey.value,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    result.className = "ok";
    result.textContent = provider + " connected. status=" + data.connection.status
      + " store=" + data.connection.secretStore;
    form.tokenId.value = form.tokenSecret.value = form.token.value = "";
  } catch (error) {
    result.className = "err";
    result.textContent = "failed: " + error.message;
  }
});
</script>
</body>
</html>`;
}
