import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createTestHarness } from "wrangler";

// Wrangler dev rewrites same-host Location headers to its local HTTP origin.
// A transparent test listener preserves the actual Worker's HTTPS redirects.
const harness = createTestHarness({
  workers: [{ configPath: process.argv[2] }],
});
await harness.listen();
const worker = harness.getWorker();
const server = createServer(async (request, response) => {
  try {
    const result = await worker.fetch(
      `http://${request.headers.host}${request.url}`,
      {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : Readable.toWeb(request),
        duplex: "half",
        redirect: "manual",
      },
    );
    response.statusCode = result.status;
    for (const [key, value] of result.headers) {
      if (key !== "set-cookie") response.setHeader(key, value);
    }
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader("set-cookie", cookies);
    if (result.body) Readable.fromWeb(result.body).pipe(response);
    else response.end();
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});
server.listen(Number(process.argv[3]), "127.0.0.1");
process.on("SIGTERM", async () => {
  server.close();
  await harness.close();
  process.exit(0);
});
