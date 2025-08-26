// Universal proxy with:
// - HTTP + WebSocket support
// - Redirect rewriting so you don't "escape" the proxy
// - Pass-through Set-Cookie (sessions work)
// - Simple front-end (public/) that remembers targets via cookies

const express = require("express");
const cookieParser = require("cookie-parser");
const http = require("http");
const { createProxyServer } = require("http-proxy");
const { URL } = require("url");

const app = express();
app.use(cookieParser());
app.use(express.static("public")); // serves index.html UI

// Keep it simple & robust
const proxy = createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: true, // verify upstream TLS
  preserveHeaderKeyCase: true
});

// Helpful logs
proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err?.message || err);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  res.end("Proxy error");
});

// Pass through Set-Cookie, and rewrite redirects so they stay inside the proxy
proxy.on("proxyRes", (proxyRes, req, res) => {
  // Pass Set-Cookie back to the browser (critical for auth flows)
  const setCookie = proxyRes.headers["set-cookie"];
  if (setCookie) {
    // Don’t munge cookies; just forward them as-is
    res.setHeader("set-cookie", setCookie);
  }

  // Redirect rewriting: if upstream sends Location: https://origin/...
  // rewrite it to our proxy so the browser stays on this domain.
  const location = proxyRes.headers["location"];
  if (location) {
    try {
      const locUrl = new URL(location);
      // Build a proxied link that targets the FULL location URL
      // Using full URL in query keeps it simple and robust.
      const selfOrigin = `${req.protocol || "https"}://${req.headers.host}`;
      const rewritten = `${selfOrigin}/proxy?target=${encodeURIComponent(locUrl.toString())}`;
      proxyRes.headers["location"] = rewritten;
    } catch {
      // If not a valid absolute URL, leave it alone (relative redirects will follow through our proxy anyway)
    }
  }
});

// Small helper: extract target URL from query (?target=...)
function getTargetUrl(reqUrl) {
  const u = new URL(reqUrl, "http://placeholder"); // base won't be used for absolute URLs
  const t = u.searchParams.get("target");
  return t || null;
}

// Route: /proxy?target=<FULL_URL>
// We allow FULL URLs here (https://example.com/path?x=y)
app.use("/proxy", (req, res) => {
  const targetStr = getTargetUrl(req.url);
  if (!targetStr) {
    res.status(400).send("Missing ?target=<url>");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetStr);
  } catch {
    res.status(400).send("Invalid target URL");
    return;
  }

  // Remember last target in a cookie for UX
  try {
    res.cookie("last_target", targetUrl.origin, {
      httpOnly: false,
      sameSite: "Lax",
      maxAge: 1000 * 60 * 60 * 24 * 14 // 14 days
    });
  } catch {}

  // http-proxy wants an origin in 'target' and the path in req.url.
  // We temporarily rewrite req.url to the upstream path + search.
  const upstreamPath = targetUrl.pathname + targetUrl.search + targetUrl.hash;

  // Save original to restore later (not strictly required)
  const originalUrl = req.url;

  // Strip our /proxy?target=... and replace with the real upstream path
  req.url = upstreamPath;

  // Forward it
  proxy.web(req, res, { target: targetUrl.origin });
  
  // No need to restore req.url after; request lifecycle ends here.
});

// WebSocket upgrades: same /proxy?target=wss://... pattern
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url, "http://placeholder");
    const targetStr = reqUrl.searchParams.get("target");
    if (!targetStr) {
      socket.destroy();
      return;
    }
    const targetUrl = new URL(targetStr);

    // For WS, http-proxy reads the path from req.url too:
    // set req.url to upstream path before handing off.
    req.url = targetUrl.pathname + targetUrl.search + targetUrl.hash;

    proxy.ws(req, socket, head, { target: targetUrl.origin });
  } catch (e) {
    console.error("WS upgrade error:", e?.message || e);
    socket.destroy();
  }
});

// A convenience redirect: visiting /go?u=<url> sets a cookie history and jumps to /proxy?target=<url>
app.get("/go", (req, res) => {
  const u = req.query.u;
  if (!u) return res.redirect("/");
  // Append to simple cookie-based history (comma-separated)
  const current = (req.cookies.recent_targets || "").split(",").filter(Boolean);
  if (!current.includes(u)) current.unshift(u);
  const trimmed = current.slice(0, 8); // keep last 8
  res.cookie("recent_targets", trimmed.join(","), { httpOnly: false, sameSite: "Lax", maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.redirect(`/proxy?target=${encodeURIComponent(u)}`);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("✅ Proxy listening on", PORT);
});
