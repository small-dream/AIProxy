import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures", "stress");

function randomHost(i: number): string {
  const hosts = [
    "api.example.com", "cdn.example.com", "auth.example.com", "ws.example.com",
    "graphql.example.com", "rest.example.com", "static.example.com", "upload.example.com",
    "download.example.com", "gateway.example.com", "api.staging.example.com", "api.prod.example.com",
    "metrics.example.com", "admin.example.com", "webhook.example.com", "oauth.example.com",
    "sso.example.com", "cdn2.example.com", "media.example.com", "search.example.com",
    "api.v2.example.com", "notifications.example.com", "billing.example.com", "users.example.com",
    "orders.example.com", "products.example.com", "inventory.example.com", "shipping.example.com",
    "payments.example.com", "analytics.example.com", "logging.example.com", "config.example.com",
    "features.example.com", "experiments.example.com", "abtesting.example.com", "seo.example.com",
    "sitemap.example.com", "feeds.example.com", "proxy.example.com", "cache.example.com",
    "queue.example.com", "scheduler.example.com", "jobs.example.com", "tasks.example.com",
    "events.example.com", "audit.example.com", "compliance.example.com", "legal.example.com",
    "support.example.com", "docs.example.com",
  ];
  return hosts[i % hosts.length];
}

function randomPath(i: number): string {
  const paths = [
    "/api/v1/users", "/api/v1/orders", "/api/v1/products",
    "/api/v1/auth/login", "/api/v1/auth/token", "/api/v1/search",
    "/api/v2/graphql", "/api/v1/health", "/api/v1/metrics",
    "/api/v1/webhooks", "/static/js/app.js", "/static/css/main.css",
    "/api/v1/payments/charge", "/api/v1/shipping/track",
  ];
  return paths[i % paths.length];
}

function randomMethod(i: number): string {
  const methods = ["GET", "GET", "GET", "POST", "PUT", "DELETE", "PATCH"];
  return methods[i % methods.length];
}

function randomStatus(i: number): number {
  const statuses = [200, 200, 200, 200, 201, 204, 301, 400, 404, 500];
  return statuses[i % statuses.length];
}

function generateSessionSummaries(count: number) {
  const summaries = [];
  for (let i = 0; i < count; i++) {
    const host = randomHost(i);
    const path = randomPath(i);
    summaries.push({
      id: `session-${String(i).padStart(6, "0")}`,
      method: randomMethod(i),
      host,
      path,
      url: `https://${host}${path}`,
      scheme: "https",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http/1.1",
      statusCode: randomStatus(i),
      durationMs: Math.floor(Math.random() * 2000),
      sizeBytes: Math.floor(Math.random() * 500_000),
      responseMimeType: i % 3 === 0 ? "application/json" : "text/html",
      startedAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
    });
  }
  return summaries;
}

function generateWsMessages(count: number) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `ws-msg-${String(i).padStart(6, "0")}`,
      sessionId: "session-ws-test",
      direction: i % 2 === 0 ? "clientToServer" : "serverToClient",
      timestamp: new Date(Date.now() + i * 100).toISOString(),
      opcode: i % 10 === 0 ? "ping" : "text",
      payloadText: `Message ${i}: ${JSON.stringify({ data: "x".repeat(100), seq: i })}`,
      payloadSize: 100 + i,
      fin: true,
    });
  }
  return messages;
}

mkdirSync(FIXTURES_DIR, { recursive: true });

const summaries = generateSessionSummaries(10_000);
writeFileSync(join(FIXTURES_DIR, "10k-sessions.json"), JSON.stringify(summaries));

const wsMessages = generateWsMessages(1_000);
writeFileSync(join(FIXTURES_DIR, "1k-ws-messages.json"), JSON.stringify(wsMessages));

// 50MB text body + gzip variant
const chunk = "A".repeat(1024);
const largeBody = chunk.repeat(50 * 1024);
writeFileSync(join(FIXTURES_DIR, "50mb-body.txt"), largeBody);
writeFileSync(join(FIXTURES_DIR, "50mb-body.txt.gz"), gzipSync(Buffer.from(largeBody)));

console.log("Stress fixtures generated in", FIXTURES_DIR);
