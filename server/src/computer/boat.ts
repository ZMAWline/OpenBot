/**
 * A computer each, on Boat (boat.dev).
 *
 * Boat rents out whole Linux VMs over an HTTP API, with Docker already on them, a snapshot taken when
 * one stops, and a way to publish a port at an HTTPS address. That is the three things a Bot's computer
 * needs from a host: somewhere to run the `agent-computer` image, a disk that keeps its logins between
 * runs, and an address this server can reach. So a Boat sandbox per Bot replaces a container per Bot,
 * and the deployment no longer needs a Docker socket of its own.
 *
 * WHAT RUNS INSIDE. The same `agent-computer` image the supervisor runs, started by `docker run` on the
 * sandbox, bound to the sandbox's loopback and published through Boat's port relay. Nothing about the
 * computer changes; only where it lives.
 *
 * THE LOCKS. Each sandbox is created `noEnv`, so it carries none of the Boat account's own secrets and
 * cannot act on the account or on another sandbox. Its port is published without Boat's own query-string
 * token, because every path here is `${base}${path}` and a query on the base would be lost; the
 * computer's own `COMPUTER_TOKEN`, which it refuses every call without, is what guards it, exactly as it
 * guards a computer on a remote Docker host. The token reaches the sandbox as a per-sandbox environment
 * variable rather than in a command line, so it never appears in Boat's command history.
 *
 * WHICH SANDBOX IS WHOSE. A sandbox is named `openbot-<deployment>-<bot>`, and the name is the only
 * record of the mapping, so nothing is stored here that a restart could lose. Two deployments sharing
 * one Boat account are kept apart by `DEPLOYMENT_ID`.
 *
 * NO CLIENT LIBRARY, for the same reason the Kubernetes provider has none: it is HTTP and JSON, this
 * needs eight calls of it, and the generated SDK would be a large dependency for that.
 */
import { createHash } from "node:crypto";
import type {
  ComputerLocation,
  ComputerProvider,
  ComputerUpdate,
} from "./provider";
import type { ComputerStatus } from "./schema";

export const DEFAULT_BOAT_BASE_URL = "https://boat.dev/api/v1";
export const DEFAULT_BOAT_COMPUTER_IMAGE =
  "ghcr.io/copilotkit/openbot-agent-computer:latest";

/** The port `agent-computer` listens on, inside its container and on the sandbox's loopback. */
const COMPUTER_PORT = 4100;
/** The container's name on its sandbox. One computer per sandbox, so it never needs to vary. */
const CONTAINER = "openbot-computer";

export class BoatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoatError";
  }
}

export type BoatMachineType = "small" | "default" | "large" | "xlarge";

export type BoatProviderOptions = {
  apiKey: string;
  /** The secret every computer requires. Without it, a published port would be an open browser. */
  computerToken: string;
  baseUrl?: string;
  /** The `agent-computer` image each sandbox runs. */
  image?: string;
  machineType?: BoatMachineType;
  /** How long a sandbox may go untouched before Boat stops it (and stops billing for it). */
  idleAfterMs?: number;
  /** Separates this deployment's sandboxes from another's on the same Boat account. */
  deploymentId?: string;
  /** Bill to a Boat organization instead of the key's personal wallet. */
  org?: string;
  /** `headless` or `headed`, passed through to the computer as the supervisor does. */
  browserMode?: string;
  /** Extra variables for the computer, as the supervisor passes `EGRESS_PROXY*` through. */
  passthroughEnv?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** How long `locate` waits for a sandbox to provision or resume. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting. Tests make it small. */
  pollMs?: number;
};

/** The parts of a Boat sandbox this file reads. */
export type BoatSandbox = {
  id: string;
  name?: string;
  state?: string;
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type HostResponse = { url?: string };
type CommandResult = {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

/** States in which a sandbox has a machine and will take commands. */
const LIVE = new Set(["ready", "idle", "running"]);
/** States on the way to LIVE. */
const COMING = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "resuming",
]);
/** States with no machine, from which `resume` brings it back. */
const STOPPED = new Set(["archived", "archiving", "stopped"]);

/**
 * The sandbox name for a Bot.
 *
 * Boat truncates names past 120 characters, and a truncated name would no longer match, so a long Bot
 * id is shortened here to a readable prefix plus a hash of the whole thing.
 */
export function boatSandboxName(botId: string, deploymentId?: string): string {
  const deployment = (deploymentId ?? "default")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 32);
  const name = `openbot-${deployment}-${botId}`;
  if (name.length <= 120) return name;
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 16);
  return `openbot-${deployment}-${botId.slice(0, 60)}-${hash}`;
}

/** The prefix every sandbox of this deployment carries, for `list`. */
function namePrefix(deploymentId?: string): string {
  return boatSandboxName("", deploymentId);
}

/** Single-quote a value for bash. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The script that makes sure this sandbox's computer is running, and prints when it started.
 *
 * IDEMPOTENT. It is run on every cold `locate`, so it starts a stopped container, replaces one that holds
 * an old token or a different image, creates one that is missing, and otherwise does nothing. The token
 * is read from the sandbox's environment, never written here.
 *
 * `update` set means pull the image first and replace the container if the pull brought new bytes.
 */
export function ensureScript(options: {
  image: string;
  browserMode?: string;
  passthroughEnv?: Record<string, string>;
  update?: boolean;
}): string {
  const extraEnv = [
    ...(options.browserMode
      ? [`-e COMPUTER_BROWSER_MODE=${shellQuote(options.browserMode)}`]
      : []),
    ...Object.entries(options.passthroughEnv ?? {}).map(
      ([key, value]) => `-e ${key}=${shellQuote(value)}`,
    ),
  ].join(" ");
  return [
    "set -eu",
    `IMAGE=${shellQuote(options.image)}`,
    `NAME=${CONTAINER}`,
    // Docker is on every Boat machine; whether this user may reach its socket without sudo varies.
    'if docker ps >/dev/null 2>&1; then D="docker"; else D="sudo docker"; fi',
    // `set -u` stops here, naming the variable, on a sandbox that was given no token.
    'WANT="$OPENBOT_COMPUTER_TOKEN"',
    options.update ? '$D pull -q "$IMAGE" >/dev/null' : "true",
    'if $D inspect "$NAME" >/dev/null 2>&1; then',
    `  HAVE=$($D inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n 's/^COMPUTER_TOKEN=//p')`,
    `  HAVE_IMAGE=$($D inspect -f '{{.Config.Image}}' "$NAME")`,
    `  RUNNING_ID=$($D inspect -f '{{.Image}}' "$NAME")`,
    `  LATEST_ID=$($D image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || echo none)`,
    '  if [ "$HAVE" != "$WANT" ] || [ "$HAVE_IMAGE" != "$IMAGE" ] || [ "$RUNNING_ID" != "$LATEST_ID" ]; then',
    '    $D rm -f "$NAME" >/dev/null',
    "    echo replaced >&2",
    "  fi",
    "fi",
    'if ! $D inspect "$NAME" >/dev/null 2>&1; then',
    '  $D image inspect "$IMAGE" >/dev/null 2>&1 || $D pull -q "$IMAGE" >/dev/null',
    `  $D run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:${COMPUTER_PORT}:${COMPUTER_PORT} \\`,
    '    -e COMPUTER_BOT_ID="$OPENBOT_BOT_ID" -e COMPUTER_TOKEN="$WANT" \\',
    `    ${extraEnv ? `${extraEnv} \\` : ""}`,
    `    -v openbot-profiles:/profiles -v openbot-workspace:/workspace "$IMAGE" >/dev/null`,
    "else",
    '  $D start "$NAME" >/dev/null',
    "fi",
    "for _ in $(seq 1 120); do",
    `  if curl -fsS http://127.0.0.1:${COMPUTER_PORT}/health >/dev/null 2>&1; then break; fi`,
    "  sleep 1",
    "done",
    `curl -fsS http://127.0.0.1:${COMPUTER_PORT}/health >/dev/null`,
    `echo "STARTED_AT=$($D inspect -f '{{.State.StartedAt}}' "$NAME")"`,
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function startedAtFrom(stdout: string | undefined): string | undefined {
  const match = (stdout ?? "").match(/STARTED_AT=(\S+)/);
  return match?.[1];
}

/** Give every Bot its own Boat sandbox. */
export function createBoatComputerProvider(
  options: BoatProviderOptions,
): ComputerProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BOAT_BASE_URL).replace(/\/$/, "");
  const image = options.image ?? DEFAULT_BOAT_COMPUTER_IMAGE;
  const readyTimeoutMs = options.readyTimeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 2_000;
  const ttlSeconds =
    options.idleAfterMs === undefined
      ? 30 * 60
      : Math.max(60, Math.round(options.idleAfterMs / 1000));

  /** Where each Bot's computer answers, while this process believes it is running. */
  const addresses = new Map<string, string>();
  /** When each Bot's container last started, which is how one run is told from the next. */
  const sessions = new Map<string, string>();
  /** One cold start per Bot at a time: two concurrent first calls must not make two sandboxes. */
  const inFlight = new Map<string, Promise<string>>();

  async function call<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T | undefined> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.org ? { "x-boat-org": options.org } : {}),
          ...(init.headers ?? {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(11 * 60_000),
      });
    } catch (error) {
      throw new BoatError(
        `Boat could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    if (response.status === 404) return undefined;
    const body = (await response.json().catch(() => null)) as
      | (T & { message?: string; code?: string })
      | null;
    if (!response.ok) {
      const code = body?.code ? ` ${body.code}` : "";
      const message = body?.message ? `: ${body.message}` : "";
      throw new BoatError(
        `Boat refused a request (${response.status}${code})${message}`,
      );
    }
    return (body ?? undefined) as T | undefined;
  }

  async function listAll(): Promise<BoatSandbox[]> {
    const found: BoatSandbox[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const body = await call<{
        sandboxes?: BoatSandbox[];
        pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
      }>(`/sandboxes?${query}`);
      found.push(...(body?.sandboxes ?? []));
      cursor = body?.pageInfo?.nextCursor;
      if (!body?.pageInfo?.hasMore || !cursor) break;
    }
    return found;
  }

  /** This Bot's sandbox, if it has one that is not gone for good. */
  async function find(botId: string): Promise<BoatSandbox | undefined> {
    const name = boatSandboxName(botId, options.deploymentId);
    const candidates = (await listAll()).filter(
      (sandbox) => sandbox.name === name && sandbox.state !== "cancelled",
    );
    // Newest first: should two ever exist, the one most recently made is the one in use.
    candidates.sort((a, b) =>
      String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
    );
    return candidates[0];
  }

  async function read(id: string): Promise<BoatSandbox | undefined> {
    const body = await call<{ sandbox?: BoatSandbox }>(`/sandboxes/${id}`);
    return body?.sandbox;
  }

  function computerEnv(botId: string): Record<string, string> {
    return {
      OPENBOT_COMPUTER_TOKEN: options.computerToken,
      OPENBOT_BOT_ID: botId,
    };
  }

  async function create(botId: string): Promise<BoatSandbox> {
    const name = boatSandboxName(botId, options.deploymentId);
    const body = await call<{ sandbox?: BoatSandbox }>("/sandboxes", {
      method: "POST",
      // The same key for the same Bot means a retried create returns the sandbox the first one made.
      headers: {
        "idempotency-key": createHash("sha256")
          .update(`${name}:${Date.now() - (Date.now() % 3_600_000)}`)
          .digest("hex"),
      },
      body: {
        noEnv: true,
        ttlSeconds,
        env: computerEnv(botId),
        ...(options.machineType ? { type: options.machineType } : {}),
        ...(options.org ? { org: options.org } : {}),
      },
    });
    const sandbox = body?.sandbox;
    if (!sandbox?.id) {
      throw new BoatError(
        `Boat answered the create for ${botId} with no sandbox.`,
      );
    }
    await call(`/sandboxes/${sandbox.id}`, { method: "PATCH", body: { name } });
    return { ...sandbox, name };
  }

  async function waitLive(id: string, botId: string): Promise<BoatSandbox> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const sandbox = await read(id);
      if (!sandbox) {
        throw new BoatError(`The Boat sandbox for ${botId} disappeared.`);
      }
      const state = sandbox.state ?? "";
      if (LIVE.has(state)) return sandbox;
      if (state === "error" || state === "cancelled") {
        throw new BoatError(
          `The Boat sandbox for ${botId} failed to start${sandbox.error ? `: ${sandbox.error}` : "."}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new BoatError(
          `The Boat sandbox for ${botId} was still "${state}" after ${Math.round(readyTimeoutMs / 1000)}s.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function run(id: string, command: string): Promise<CommandResult> {
    // A sandbox that has just resumed can refuse a command it never ran; that refusal is safe to resend.
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const result = await call<CommandResult>(`/sandboxes/${id}/commands`, {
          method: "POST",
          body: { command, timeoutSeconds: 600 },
        });
        return result ?? {};
      } catch (error) {
        const retryable =
          error instanceof BoatError &&
          /sandbox_starting|sandbox_not_ready|machine_not_running|\(503/.test(
            error.message,
          );
        if (!retryable || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

  async function ensureComputer(
    id: string,
    botId: string,
    update = false,
  ): Promise<{ startedAt?: string; replaced: boolean }> {
    const result = await run(
      id,
      ensureScript({
        image,
        update,
        ...(options.browserMode ? { browserMode: options.browserMode } : {}),
        ...(options.passthroughEnv
          ? { passthroughEnv: options.passthroughEnv }
          : {}),
      }),
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(-400);
      throw new BoatError(
        `The computer for ${botId} did not start on its Boat sandbox${result.timedOut ? " (timed out)" : ""}${detail ? `: ${detail}` : "."}`,
      );
    }
    const startedAt = startedAtFrom(result.stdout);
    if (startedAt) sessions.set(botId, startedAt);
    return {
      ...(startedAt ? { startedAt } : {}),
      replaced: /replaced/.test(result.stderr ?? ""),
    };
  }

  async function publish(id: string, botId: string): Promise<string> {
    const body = await call<HostResponse>(`/sandboxes/${id}/host`, {
      method: "POST",
      body: {
        port: COMPUTER_PORT,
        public: true,
        localhost: true,
        title: "OpenBot computer",
      },
    });
    if (!body?.url) {
      throw new BoatError(
        `Boat published no address for the computer of ${botId}.`,
      );
    }
    const url = new URL(body.url);
    // Never a gated URL: the base has paths appended to it, and the computer token is the gate.
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  /** Is the address we remember still a computer that answers? */
  async function answers(address: string): Promise<boolean> {
    try {
      const response = await doFetch(`${address}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function bringUp(botId: string): Promise<string> {
    let sandbox = await find(botId);
    if (!sandbox) {
      sandbox = await create(botId);
    } else if (STOPPED.has(sandbox.state ?? "")) {
      await call(`/sandboxes/${sandbox.id}/resume`, {
        method: "POST",
        // The env is resent so a rotated COMPUTER_TOKEN reaches a sandbox that slept through it.
        body: { ttlSeconds, env: computerEnv(botId) },
      });
    } else if (sandbox.state === "error") {
      await call(`/sandboxes/${sandbox.id}/recover`, {
        method: "POST",
        body: {},
      });
    }
    await waitLive(sandbox.id, botId);
    await ensureComputer(sandbox.id, botId);
    const address = await publish(sandbox.id, botId);
    addresses.set(botId, address);
    console.info(
      JSON.stringify({
        type: "computer-boat-ready",
        botId,
        sandbox: sandbox.id,
      }),
    );
    return address;
  }

  function stateOf(sandbox: BoatSandbox | undefined): ComputerStatus["state"] {
    const state = sandbox?.state ?? "";
    if (!sandbox || STOPPED.has(state) || state === "cancelled")
      return "absent";
    if (LIVE.has(state)) return "ready";
    if (COMING.has(state)) return "starting";
    return "starting";
  }

  return {
    name: "boat",
    isolation: "per-bot",

    async locate(botId: string): Promise<string> {
      const known = addresses.get(botId);
      if (known && (await answers(known))) return known;
      addresses.delete(botId);

      const pending = inFlight.get(botId);
      if (pending) return pending;
      const started = bringUp(botId).finally(() => inFlight.delete(botId));
      inFlight.set(botId, started);
      return started;
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const sandbox = await find(botId);
        const state = stateOf(sandbox);
        if (state === "ready") {
          const known = addresses.get(botId);
          // A machine that is up but whose computer has not been started yet is still starting.
          if (!known || !(await answers(known))) {
            return { botId, state: "starting" };
          }
        }
        if (sandbox?.state === "error") {
          return {
            botId,
            state: "unreachable",
            reason: sandbox.error ?? "Its Boat sandbox reported an error.",
          };
        }
        return { botId, state };
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Boat could not be asked about this computer.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const sandbox = await find(botId);
      addresses.delete(botId);
      sessions.delete(botId);
      if (!sandbox || stateOf(sandbox) === "absent")
        return { wasRunning: false };
      // Stopped, not deleted: Boat snapshots the disk, so the logins and files come back on resume.
      await call(`/sandboxes/${sandbox.id}/stop`, { method: "POST", body: {} });
      return { wasRunning: true };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const sandbox = await find(botId);
      addresses.delete(botId);
      sessions.delete(botId);
      if (!sandbox) return { cleared: false };
      // Deleted, snapshots and all. This is the one that is meant to lose the logins.
      await call(`/sandboxes/${sandbox.id}`, {
        method: "DELETE",
        headers: { "x-ascii-confirm-delete": sandbox.id },
      });
      return { cleared: true };
    },

    async list(): Promise<ComputerLocation[]> {
      const prefix = namePrefix(options.deploymentId);
      const mine = (await listAll()).filter(
        (sandbox) =>
          sandbox.name?.startsWith(prefix) && sandbox.state !== "cancelled",
      );
      return mine.map((sandbox) => {
        const botId = (sandbox.name ?? "").slice(prefix.length);
        const running = LIVE.has(sandbox.state ?? "");
        const url = addresses.get(botId);
        return {
          botId,
          status: running ? "running" : "stopped",
          ...(url ? { url } : {}),
          ...(sandbox.updatedAt ? { startedAt: sandbox.updatedAt } : {}),
        };
      });
    },

    async update(botId: string): Promise<ComputerUpdate> {
      const sandbox = await find(botId);
      if (!sandbox || stateOf(sandbox) === "absent") {
        // A stopped sandbox picks up the current image the next time it is woken.
        return { updated: false, wasRunning: false };
      }
      await waitLive(sandbox.id, botId);
      const { replaced } = await ensureComputer(sandbox.id, botId, true);
      return { updated: replaced, wasRunning: true, to: image };
    },

    async sessionOf(botId: string): Promise<string | undefined> {
      return sessions.get(botId);
    },
  };
}
