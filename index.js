// Universal proxy with:
// - HTTP + WebSocket support
// - Redirect rewriting -> keep user on proxy domain
// - Cookie Domain rewriting -> sessions bind to proxy domain
// - Strips CSP headers -> fewer client-side blocks
// - Minimal frontend (public/) with cookie-saved recents

const express = require("express");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const http = require("http");
const { createProxyServer } = require("http-proxy");
const { URL } = require("url");

const app = express();
app.use(cookieParser());
app.use(morgan("tiny"));
app.use(express.static("public")); // serves index.html + assets

// ---- Config (optional allowlist) ----
const ALLOWLIST = null; // e.g., ["discord.com", "web.whatsapp.com"]

function allowedHost(hostname) {
  if (!ALLOWLIST) return true;
  return ALLOWLIST.some(h => h === hostname || hostname.endsWith(`.${h}`));
}

// Create a single proxy instance
const proxy = createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: true,
  preserveHeaderKeyCase: true
});

// Errors -> 502
proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err?.message || err);
  try {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end("Proxy error");
  } catch {}
});

// Pass-through + rewrite on responses
proxy.on("proxyRes", (proxyRes, req, res) => {
  // Strip CSP & frame protections that can break proxied apps
  delete proxyRes.headers["content-security-policy"];
  delete proxyRes.headers["content-security-policy-report-only"];
  delete proxyRes.headers["x-frame-options"];

  // Keep redirects on our domain
  const loc = proxyRes.headers["location"];
  if (loc) {
    try {
      const absolute = new URL(loc, req._targetOrigin || undefined);
      const selfOrigin = `${req._proto || "https"}://${req.headers.host}`;
      proxyRes.headers["location"] =
        `/proxy?url=${encodeURIComponent(absolute.toString())}`;
    } catch {
      // leave relative redirects as-is; browser will hit our /proxy path
    }
  }

  // Cookie domain rewriting so sessions stick to our domain
  const setCookies = proxyRes.headers["set-cookie"];
  if (setCookies) {
    const host = req.headers.host;
    proxyRes.headers["set-cookie"] = setCookies.map((c) => {
      // Force cookies to bind to our host
      c = c.replace(/;\s*Domain=[^;]*/i, `; Domain=${host}`);
      // SameSite=None helps cross-origin-ish flows; keep Secure for HTTPS
      if (!/;\s*SameSite=/i.test(c)) c += "; SameSite=None";
      if (!/;\s*Secure/i.test(c)) c += "; Secure";
      return c;
    });
  }
});

// Ensure upstream sees "normal" browser-ish headers
proxy.on("proxyReq", (proxyReq, req) => {
  const upstreamOrigin = req._targetOrigin;
  if (upstreamOrigin) {
    proxyReq.setHeader("origin", upstreamOrigin);
    proxyReq.setHeader("referer", upstreamOrigin + "/");
    // you can also set a UA if needed:
    if (!req.headers["user-agent"]) {
      proxyReq.setHeader(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
      );
    }
  }
});

// Helper: parse ?url
function parseTargetFromReq(fullUrl, base = "http://placeholder") {
  const u = new URL(fullUrl, base);
  const raw = u.searchParams.get("url");
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// ---- HTTP Proxy endpoint ----
// Usage: /proxy?url=<FULL_URL>
app.use("/proxy", (req, res) => {
  const targetUrl = parseTargetFromReq(req.url, "http://proxy.local");
  if (!targetUrl) return res.status(400).send("Missing or invalid ?url=");

  if (!allowedHost(targetUrl.hostname)) {
    return res.status(403).send("Target host not allowed.");
  }

  // Remember last target origin for convenience
  res.cookie("last_target", targetUrl.origin, {
    httpOnly: false,
    sameSite: "Lax",
    maxAge: 1000 * 60 * 60 * 24 * 14
  });

  // Stash context for hooks
  req._targetOrigin = targetUrl.origin;
  req._proto = (req.headers["x-forwarded-proto"] || "").split(",")[0] || req.protocol || "https";

  // Rewrite req.url to upstream path so http-proxy forwards correctly
  req.url = targetUrl.pathname + targetUrl.search + targetUrl.hash;

  proxy.web(req, res, {
    target: targetUrl.origin,
    autoRewrite: true
  });
});

// ---- WebSocket Proxy upgrade ----
// Same pattern: /proxy?url=wss://gateway.discord.gg/?v=10&encoding=json
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  const targetUrl = parseTargetFromReq(req.url, "http://proxy.local");
  if (!targetUrl) return socket.destroy();

  if (!allowedHost(targetUrl.hostname)) return socket.destroy();

  req._targetOrigin = targetUrl.origin;
  // For WS, ensure path sent upstream is only the target path/search/hash
  req.url = targetUrl.pathname + targetUrl.search + targetUrl.hash;

  proxy.ws(req, socket, head, {
    target: targetUrl.origin
  });
});

// Convenience: simple redirector that also maintains a small "recents" cookie
app.get("/go", (req, res) => {
  const u = req.query.u;
  if (!u) return res.redirect("/");
  try {
    const abs = new URL(u);
    const current = (req.cookies.recent_targets || "").split(",").filter(Boolean);
    if (!current.includes(abs.toString())) current.unshift(abs.toString());
    res.cookie("recent_targets", current.slice(0, 8).join(","), {
      httpOnly: false,
      sameSite: "Lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
    });
    res.redirect(`/proxy?url=${encodeURIComponent(abs.toString())}`);
  } catch {
    res.redirect("/");
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Proxy listening on ${PORT}`);
});
