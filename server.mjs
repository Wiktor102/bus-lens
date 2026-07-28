import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const preferredPort = Number(process.env.PORT || 4173);
const maxPortAttempts = 10;
const types = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml" };

const server = http.createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent(request.url.split("?")[0]);
    const file = normalize(join(root, requested === "/" ? "index.html" : requested));
    if (!file.startsWith(normalize(root))) throw new Error("Forbidden");
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control":"no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type":"text/plain" });
    response.end("Not found");
  }
});

let port = preferredPort;
let attempts = 0;

server.on("error", error => {
  if (error.code === "EADDRINUSE" && attempts < maxPortAttempts) {
    port += 1;
    attempts += 1;
    console.log(`Port ${port - 1} is already in use; trying ${port}…`);
    server.listen(port, "127.0.0.1");
    return;
  }
  console.error(`Unable to start Bus Lens: ${error.message}`);
  process.exitCode = 1;
});

server.on("listening", () => {
  console.log(`Bus Lens running at http://127.0.0.1:${port}`);
});

server.listen(port, "127.0.0.1");
