import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  type BoatSandbox,
  boatSandboxName,
  createBoatComputerProvider,
  ensureScript,
} from "../src/computer/boat";
import { createComputerProvider } from "../src/computer/provider";

/**
 * A computer each, on Boat, against a pretend Boat.
 *
 * The fake keeps sandboxes in a map and answers the eight calls the provider makes, so these tests pin
 * what is asked of Boat (no account secrets, the token never in a command line, one sandbox per Bot even
 * when two calls race) without renting a machine.
 */
type Call = { method: string; path: string; body?: Record<string, unknown> };

function fakeBoat(
  options: {
    healthy?: boolean;
    commandExit?: number;
    initial?: BoatSandbox[];
  } = {},
) {
  const sandboxes = new Map<string, BoatSandbox & { env?: unknown }>();
  for (const sandbox of options.initial ?? [])
    sandboxes.set(sandbox.id, sandbox);
  const calls: Call[] = [];
  let next = 1;

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });

    if (url.host === "computer.boat.test") {
      return new Response(null, {
        status: options.healthy === false ? 503 : 200,
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");

    if (method === "GET" && path === "/sandboxes") {
      return Response.json({
        ok: true,
        type: "sandbox.list",
        sandboxes: [...sandboxes.values()],
        pageInfo: { hasMore: false, nextCursor: null, limit: 100 },
      });
    }
    if (method === "POST" && path === "/sandboxes") {
      const id = `sbx_${next++}`;
      sandboxes.set(id, {
        id,
        name: id,
        state: "ready",
        env: body?.env,
        createdAt: new Date(next).toISOString(),
      });
      return Response.json(
        { ok: true, type: "sandbox.created", sandbox: sandboxes.get(id) },
        { status: 202 },
      );
    }
    const match = path.match(/^\/sandboxes\/([^/]+)(\/[a-z]+)?$/);
    const sandbox = match ? sandboxes.get(match[1] ?? "") : undefined;
    if (!sandbox) return Response.json({ ok: false }, { status: 404 });
    const action = match?.[2];
    if (method === "PATCH" && !action) {
      Object.assign(sandbox, body);
      return Response.json({ ok: true, sandbox });
    }
    if (method === "GET" && !action)
      return Response.json({ ok: true, sandbox });
    if (method === "DELETE" && !action) {
      expect(new Headers(init?.headers).get("x-ascii-confirm-delete")).toBe(
        sandbox.id,
      );
      sandboxes.delete(sandbox.id);
      return Response.json({ ok: true, operation: {} }, { status: 202 });
    }
    if (action === "/stop") {
      sandbox.state = "archived";
      return Response.json({ ok: true, id: sandbox.id, status: "archived" });
    }
    if (action === "/resume") {
      sandbox.state = "ready";
      return Response.json({ ok: true, id: sandbox.id, status: "ready" });
    }
    if (action === "/commands") {
      return Response.json({
        ok: true,
        exitCode: options.commandExit ?? 0,
        stdout: "STARTED_AT=2026-10-12T10:00:00Z\n",
        stderr: options.commandExit ? "pull failed" : "",
        timedOut: false,
      });
    }
    if (action === "/host") {
      return Response.json({
        ok: true,
        type: "host",
        url: "https://computer.boat.test/?_token=secret-gate",
      });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, sandboxes };
}

function provider(fake: ReturnType<typeof fakeBoat>) {
  return createBoatComputerProvider({
    apiKey: "key",
    computerToken: "tok-123",
    deploymentId: "office",
    fetchImpl: fake.fetchImpl,
    pollMs: 1,
  });
}

describe("Boat computers", () => {
  test("a Bot's first call makes one sandbox with no account secrets and returns an ungated address", async () => {
    const fake = fakeBoat();
    const boat = provider(fake);

    const address = await boat.locate("knowledge");

    expect(address).toBe("https://computer.boat.test");
    const create = fake.calls.find(
      (c) => c.method === "POST" && c.path === "/sandboxes",
    );
    expect(create?.body?.noEnv).toBe(true);
    expect(create?.body?.env).toEqual({
      OPENBOT_COMPUTER_TOKEN: "tok-123",
      OPENBOT_BOT_ID: "knowledge",
    });
    const named = fake.calls.find((c) => c.method === "PATCH");
    expect(named?.body?.name).toBe("openbot-office-knowledge");
    const host = fake.calls.find((c) => c.path.endsWith("/host"));
    expect(host?.body).toMatchObject({
      port: 4100,
      public: true,
      localhost: true,
    });
  });

  test("the computer token never appears in a command Boat records", async () => {
    const fake = fakeBoat();
    await provider(fake).locate("knowledge");
    const commands = fake.calls.filter((c) => c.path.endsWith("/commands"));
    expect(commands.length).toBe(1);
    expect(JSON.stringify(commands)).not.toContain("tok-123");
  });

  test("two calls racing for a cold computer make one sandbox", async () => {
    const fake = fakeBoat();
    const boat = provider(fake);
    await Promise.all([boat.locate("a"), boat.locate("a")]);
    expect(
      fake.calls.filter((c) => c.method === "POST" && c.path === "/sandboxes")
        .length,
    ).toBe(1);
  });

  test("a warm computer is reused without touching Boat's API", async () => {
    const fake = fakeBoat();
    const boat = provider(fake);
    await boat.locate("a");
    const before = fake.calls.filter(
      (c) => !c.path.startsWith("/health"),
    ).length;
    await boat.locate("a");
    const apiCalls = fake.calls
      .slice(before)
      .filter((c) => c.path !== "/health");
    expect(apiCalls).toEqual([]);
  });

  test("a stopped sandbox is resumed, with the current token, rather than replaced", async () => {
    const fake = fakeBoat({
      initial: [{ id: "sbx_old", name: "openbot-office-a", state: "archived" }],
    });
    await provider(fake).locate("a");
    expect(
      fake.calls.some((c) => c.method === "POST" && c.path === "/sandboxes"),
    ).toBe(false);
    const resume = fake.calls.find(
      (c) => c.path === "/sandboxes/sbx_old/resume",
    );
    expect(resume?.body?.env).toMatchObject({
      OPENBOT_COMPUTER_TOKEN: "tok-123",
    });
  });

  test("stop keeps the sandbox, reset deletes it", async () => {
    const fake = fakeBoat();
    const boat = provider(fake);
    await boat.locate("a");
    expect(await boat.stop("a")).toEqual({ wasRunning: true });
    expect(fake.sandboxes.size).toBe(1);
    expect((await boat.status("a")).state).toBe("absent");
    expect(await boat.reset("a")).toEqual({ cleared: true });
    expect(fake.sandboxes.size).toBe(0);
  });

  test("list returns only this deployment's computers, by Bot id", async () => {
    const fake = fakeBoat({
      initial: [
        { id: "1", name: "openbot-office-knowledge", state: "ready" },
        { id: "2", name: "openbot-other-knowledge", state: "ready" },
        { id: "3", name: "my-own-sandbox", state: "ready" },
      ],
    });
    const listed = await provider(fake).list();
    expect(listed.map((c) => c.botId)).toEqual(["knowledge"]);
  });

  test("a computer that will not start says why", async () => {
    const fake = fakeBoat({ commandExit: 1 });
    await expect(provider(fake).locate("a")).rejects.toThrow("pull failed");
  });

  test("the run of the computer comes from its container", async () => {
    const fake = fakeBoat();
    const boat = provider(fake);
    await boat.locate("a");
    expect(await boat.sessionOf?.("a")).toBe("2026-10-12T10:00:00Z");
  });

  test("long Bot ids still fit Boat's 120-character names, and stay distinct", () => {
    const a = boatSandboxName(`${"x".repeat(200)}a`, "office");
    const b = boatSandboxName(`${"x".repeat(200)}b`, "office");
    expect(a.length).toBeLessThanOrEqual(120);
    expect(a).not.toBe(b);
  });

  test("the start script is valid bash and quotes what it is given", () => {
    const script = ensureScript({
      image: "ghcr.io/copilotkit/openbot-agent-computer:latest",
      browserMode: "headless",
      passthroughEnv: { EGRESS_PROXY_DEFAULT: "http://u:p'w@proxy:8080" },
      update: true,
    });
    const check = spawnSync("bash", ["-n"], { input: script });
    expect(check.status).toBe(0);
    expect(script).toContain(`'http://u:p'"'"'w@proxy:8080'`);
  });

  test("the deployment's provider factory builds it", () => {
    const built = createComputerProvider({
      provider: "boat",
      apiKey: "key",
      token: "tok",
      idleAfterMs: 60_000,
      allowPrivateHosts: false,
    });
    expect(built.name).toBe("boat");
    expect(built.isolation).toBe("per-bot");
  });
});
