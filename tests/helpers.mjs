import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const php = process.env.PHP_BINARY || "php";
export const testToken = "token-exclusivo-de-teste-sem-validade";

export async function mockService(t) {
  const requests = [];
  const state = { status: 200, body: JSON.stringify({ text_description: "Resposta técnica de teste." }), delay: 0 };
  const server = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, headers: request.headers, url: request.url, body: JSON.parse(body) });
    if (state.delay) await delay(state.delay);
    response.writeHead(state.status, { "Content-Type": "application/json" });
    response.end(state.body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { requests, state, url: "http://127.0.0.1:" + server.address().port + "/text_description/" };
}

async function freePort() {
  const socket = createTcpServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

export async function startPhp(t, { upstream, directory = root, router = true, timeout = "120", settings = {}, storageDir, authorize = true } = {}) {
  const port = await freePort();
  const storage = storageDir || await mkdtemp(join(tmpdir(), "iapcdas-usage-"));
  const args = ["-S", "127.0.0.1:" + port, "-t", directory + "/public"];
  if (router) args.push(root + "/tests/router.php");
  const child = spawn(php, args, {
    cwd: directory,
    env: {
      ...process.env,
      // Nunca herdar credenciais reais do ambiente nos testes.
      PCDAS_TOKEN: router ? testToken : "",
      IAPCDAS_TEST_UPSTREAM: upstream || "",
      IAPCDAS_TEST_TIMEOUT: timeout,
      IAPCDAS_TEST_SETTINGS: JSON.stringify({ ...settings, storage_dir: storage }),
      IAPCDAS_TEST_AUTHORIZE: authorize ? "allow" : "deny",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError;
  child.on("error", error => { spawnError = error; });
  child.stdout.on("data", data => { logs = (logs + data).slice(-6000); });
  child.stderr.on("data", data => { logs = (logs + data).slice(-6000); });
  t.after(async () => {
    if (child.exitCode !== null || spawnError) return;
    await new Promise(resolve => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  });
  if (!storageDir) t.after(() => rm(storage, { recursive: true, force: true }));
  const url = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error("PHP encerrou: " + logs);
    try {
      const response = await fetch(url + "/api/chatpcdas.php");
      if (response.status === 405) return { url, logs: () => logs };
    } catch {}
    await delay(30);
  }
  throw new Error("PHP não iniciou: " + logs);
}
