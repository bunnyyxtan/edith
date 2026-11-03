import "./content.css";

const path = location.pathname.replace(/\/$/, "") || "/";
const header = document.querySelector("[data-content-header]");
if (header) header.innerHTML = `
  <a class="nav-logo" href="/" aria-label="Edith home"><img src="/mark.svg" alt="" width="30" height="30"><span>Edith</span></a>
  <nav aria-label="Main navigation">
    <a href="/">Home</a><a href="/docs" ${path.startsWith("/docs") ? 'aria-current="page"' : ""}>Documentation</a>
    <a href="https://github.com/bunnyyxtan/edith" target="_blank" rel="noopener noreferrer">GitHub</a>
  </nav>
  <a class="btn btn--small" href="/app">Open Edith</a>`;

const footer = document.querySelector("[data-content-footer]");
if (footer) footer.innerHTML = `
  <div class="content-footer-inner">
    <div><a class="nav-logo" href="/"><img src="/mark.svg" alt="" width="30" height="30"><span>Edith</span></a><p>Payment memory for AI agents, with every transfer approved by its owner.</p></div>
    <nav aria-label="Product links"><h2>Product</h2><a href="/app">Application</a><a href="/docs">Documentation</a><a href="https://github.com/bunnyyxtan/edith" target="_blank" rel="noopener noreferrer">GitHub</a></nav>
    <nav aria-label="Resource links"><h2>Resources</h2><a href="/docs/getting-started">Getting Started</a><a href="/docs/agents">Agent Integration</a><a href="/docs/payments">Payments &amp; Memory</a></nav>
    <nav aria-label="Legal links"><h2>Legal</h2><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/cookies">Cookie Policy</a></nav>
  </div>`;

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy)?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1800);
    } catch {
      button.textContent = "Select the code to copy";
    }
  });
}
