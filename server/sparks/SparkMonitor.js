import fs from "fs";
import path from "path";
import {
  SystemCollector,
  collectionWasSuccessful,
} from "../collectors/SystemCollector.js";
import { LlmProbe } from "../collectors/LlmProbe.js";
import { ComfyProbe } from "../collectors/ComfyProbe.js";
import { HermesProbe } from "../collectors/HermesProbe.js";
import { TailscaleProbe } from "../collectors/TailscaleProbe.js";
import { llmDaily } from "../collectors/LlmDaily.js";
import { HealthEvaluator } from "../health/HealthEvaluator.js";
import { sshExec } from "../collectors/ssh.js";
import {
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LIVENESS,
  POLL_INTERVAL_HERMES,
  POLL_INTERVAL_TAILSCALE,
  LLM_PORT,
  COMFY_PORT,
  HOST_PATHS,
  resolveFastPollIntervals,
} from "../config.js";

/**
 * Domains on a timer of their own that follow Settings → Poll interval
 * (unless pinned by env — see resolveFastPollIntervals). LLM and ComfyUI follow
 * it too but are armed only while their monitoring is on. Storage, liveness,
 * Tailnet, Hermes and the NV_ERR journal scan keep their own cadences.
 */
const FAST_TIMER_DOMAINS = ["gpu", "cpu", "network", "ram", "memory"];

/**
 * How often the resident-model helper (one read-only SSH round trip that asks
 * the unit's docker for vLLM containers) runs. Slow on purpose: loaded models
 * change rarely, and it is an SSH exec rather than an HTTP probe.
 */
const RESIDENT_MODELS_POLL_MS = 30_000;
/** A failed discovery keeps the last list this long (three polls) before it is cleared. */
const RESIDENT_MODELS_GRACE_MS = 3 * RESIDENT_MODELS_POLL_MS;

/**
 * Liveness retry schedule. Network failures widen gradually — a rebooting host
 * comes back on its own. Credential failures get a handful of quick attempts
 * and then effectively stop: they are a configuration problem, and hammering a
 * host that keeps refusing us is exactly how one mistyped unit produced ~60k
 * failed logins a day. The slow tail is kept so the unit recovers by itself
 * when the fix happens on the *remote* side (an authorized_keys entry added
 * there never touches this install), and editing the unit resets the count so
 * a local fix retries immediately.
 */
const LIVENESS_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
/** Quick attempts before a credential failure is treated as "stopped". */
const LIVENESS_AUTH_ATTEMPTS = 5;
/** Safety-net cadence once those attempts are spent: ~96 logins a day, not 60k. */
const LIVENESS_AUTH_IDLE_MS = 15 * 60_000;

/** True when the liveness error is a credential problem, not a network one. */
export function isSshAuthFailure(message) {
  return /permission denied|publickey|password|authentication/i.test(String(message || ""));
}

/** How long to wait before the next liveness attempt. */
export function nextLivenessDelayMs(failures, reason) {
  if (isSshAuthFailure(reason)) {
    if (failures >= LIVENESS_AUTH_ATTEMPTS) return LIVENESS_AUTH_IDLE_MS;
    return LIVENESS_BACKOFF_MS[Math.min(Math.max(failures, 1), LIVENESS_BACKOFF_MS.length) - 1];
  }
  const index = Math.min(Math.max(failures, 1), LIVENESS_BACKOFF_MS.length) - 1;
  return LIVENESS_BACKOFF_MS[index];
}

/** True once credential failures have used up their quick attempts. */
export function sshAuthGaveUp(failures) {
  return failures >= LIVENESS_AUTH_ATTEMPTS;
}

/** Short, human-readable liveness failure for the UI. */
export function livenessReason(err) {
  const raw = String(err?.message || err || "").trim();
  if (!raw) return "unreachable";
  if (/timed out|timeout|ETIMEDOUT/i.test(raw)) return "connection timed out";
  if (/ECONNREFUSED|refused/i.test(raw)) return "connection refused";
  if (/EHOSTUNREACH|no route|ENETUNREACH/i.test(raw)) return "no route to host";
  if (isSshAuthFailure(raw)) {
    return "SSH authentication failed — check the key or user for this unit";
  }
  return raw.split("\n")[0].slice(0, 140);
}

const ONLINE_GRACE_MS = 10000;

/** Auto-discovery kill-switch (LLM_AUTO_DISCOVER=0 disables). */
const LLM_AUTO_DISCOVER =
  !["0", "false", "off"].includes(
    String(process.env.LLM_AUTO_DISCOVER ?? "1").trim().toLowerCase(),
  );
/** Candidate env file listing the active lane port (dspark single source of truth). */
const LLM_ENV_FILE_CANDIDATES = [
  "/host/root/home/jw-vol/dspark-model-control/.env.dspark",
  "/host/root/home/jw-vol/deepseek-v4-spark/.env.dspark",
];
/**
 * Shared fleet API key cache (same key rotates across local lanes). Entries:
 * { key, expiresAt }. Never persisted here — persistence goes through the
 * registry callback so it lands in the encrypted secrets store.
 */
const _fleetKey = { value: null, expiresAt: 0 };
const FLEET_KEY_TTL_MS = 10 * 60 * 1000;

export function readEnvFileLanePort() {
  for (const p of LLM_ENV_FILE_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, "utf8");
      const m = txt.match(/^VLLM_PORT=(\d{1,5})$/m);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
      }
    } catch {
      /* best-effort */
    }
  }
  return null;
}

export function loadFleetKey() {
  if (_fleetKey.value && Date.now() < _fleetKey.expiresAt) return _fleetKey.value;
  for (const p of LLM_ENV_FILE_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, "utf8");
      const m = txt.match(/^VLLM_API_KEY=(\S+)$/m);
      if (m && m[1].trim()) {
        _fleetKey.value = m[1].trim();
        _fleetKey.expiresAt = Date.now() + FLEET_KEY_TTL_MS;
        return _fleetKey.value;
      }
    } catch {
      /* best-effort */
    }
  }
  return _fleetKey.value; // stale-but-usable beats nothing
}

/**
 * Lightweight /v1/models GET — the only request the discovery scan makes.
 * @returns {Promise<number>} HTTP status (0 on network failure)
 */
async function fetchLlmProbeStatus(host, port, apiKey) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2500);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`http://${host}:${port}/v1/models`, {
      signal: controller.signal,
      headers,
    });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

/**
 * SparkMonitor — one per Spark. Owns collectors + rate state + poll loop.
 * Exposes snapshot() for WebSocket pushed payload.
 *
 * LLM lane auto-discovery (head/standalone sparks): besides the configured
 * llmPorts, the monitor periodically scans a small candidate set — the
 * env-file VLLM_PORT (the dspark harness's active lane), the default LLM_PORT,
 * and any port that already has a stored API key — using a lightweight
 * /v1/models request. When a candidate answers, it is surfaced as an extra
 * live LLM panel (and its API key, if the scan had to adopt one, is persisted
 * via the onLlmPortDiscovered callback). This makes model swaps that change
 * the served port (8888 DeepSeek ⇄ 8889 Qwen ⇄ 8890 GLM) self-healing without
 * touching dashboard config. Disable with LLM_AUTO_DISCOVER=0 (env).
 */
/** A finding stays this long after its rule last raised it, so a reading near a threshold does not flap. */
export const HEALTH_CLEAR_HOLD_MS = 90_000;

const HEALTH_LABELS = {
  thermal: "GPU temperature",
  "low-power": "GPU power draw",
  memory: "Unified memory",
  concurrency: "Model concurrency",
  "link-speed": "Network link speed",
  "roce-link": "RoCE link",
  "roce-loss": "RoCE packet loss",
};

export class SparkMonitor {
  /**
   * @param {object} spark
   * @param {{ onWolMac?: (sparkId: string, mac: string) => void, onHermesChange?: () => void, resolveHeadModelId?: ((headId: string) => string | null), pollIntervalMs?: number }} [options]
   *   pollIntervalMs: Settings → Poll interval; drives the fast collector timers.
   */
  constructor(spark, options = {}) {
    this.spark = spark;
    this._onWolMac = typeof options.onWolMac === "function" ? options.onWolMac : null;
    this._onHermesChange =
      typeof options.onHermesChange === "function" ? options.onHermesChange : null;
    // Fleet event log sink: ({ type, severity, message, data? }) => void.
    // Only state *transitions* are reported (never the first baseline sample).
    this._onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    /** @type {boolean | null} null until the first liveness result (baseline). */
    this._prevOnline = null;
    /** @type {boolean | null} null until the first successful GPU sample. */
    this._prevThermal = null;
    /** Health rules + their sample-streak state; findings go out in snapshot().health. */
    this._healthEval = new HealthEvaluator();
    this._health = [];
    this._prevHealthIds = null;
    // Resolver for worker derived label: maps a head spark id to its live
    // LLM model id (or null when unknown). Wired by index.js from the monitor
    // map; never writes back to registry config (derived display only).
    this._resolveHeadModelId =
      typeof options.resolveHeadModelId === "function" ? options.resolveHeadModelId : null;
    this.collector = new SystemCollector(spark);

    // One LLM probe per port — none when LLM monitoring is off
    this.llmProbes = new Map();
    if (this._llmMonitoringEnabled(spark)) {
      for (const port of this._llmPorts()) {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }

    // Lane auto-discovery (head/standalone only, when enabled):
    // ports surfaced by the scan that are NOT in config llmPorts.
    this._discoveredPorts = new Set();
    this._lastScanAt = 0;
    this._scanInflight = false;
    this._onLlmPortDiscovered =
      typeof options.onLlmPortDiscovered === "function"
        ? options.onLlmPortDiscovered
        : null;

    /** @type {ComfyProbe | null} */
    this.comfyProbe = this._comfyMonitoringEnabled(spark)
      ? new ComfyProbe(spark, this._comfyPort(spark))
      : null;

    /** @type {TailscaleProbe | null} */
    this.tailscaleProbe = this._tailscaleMonitoringEnabled(spark)
      ? new TailscaleProbe(spark)
      : null;

    /** @type {HermesProbe | null} */
    this.hermesProbe = this._hermesMonitoringEnabled(spark)
      ? new HermesProbe(spark)
      : null;
    // Hermes status is surfaced in the snapshot (not under `metrics`) and is
    // always present so the UI never has to special-case a missing field.
    this._hermes = {
      monitoring: this._hermesMonitoringEnabled(spark),
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      // idle | running | success | error
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    // Online status from dedicated liveness checks (not metric poll success)
    this.online = false;
    this.lastOnlineOk = 0;
    /** Why liveness last failed — surfaced so a broken unit is diagnosable. */
    this.offlineReason = null;
    /** Consecutive liveness failures, used for the retry backoff. */
    this._livenessFailures = 0;
    /** Earliest timestamp for the next liveness attempt (0 = now). */
    this._nextLivenessAt = 0;
    /** Whether collector polls are currently suspended (logged once). */
    this._pollsPaused = false;

    // System uptime seconds (from /proc/uptime), null when offline
    this._uptimeSeconds = null;

    // Cached metrics per domain — never null objects for UI safety
    this._metrics = {
      gpu: this.collector._defaultGpu(),
      cpu: this.collector._defaultCpu(),
      ram: this.collector._defaultRam(),
      storage: [],
      network: this.collector._defaultNetwork(),
      roce: null,
      unifiedMemory: this.collector._defaultUnifiedMemory(),
      llm: [],
      residentModels: [],
      comfy: null,
      tailscale: null,
    };
    this._lastUpdate = {};
    /** domain → epoch ms of the last poll that returned real data (see _domainSucceeded). Not in snapshot(): it would defeat the broadcast cache. */
    this._lastSuccess = {};
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    /**
     * Last poll (epoch ms) in which each LLM port generated or prefilled
     * tokens. In-memory only — null again after a restart until traffic.
     * @type {Map<number, number>}
     */
    this._llmLastActiveAt = new Map();

    // Hardware summary: kind "spark" uses the static DGX Spark specs; kind
    // "host" (dedicated GPU Linux box) detects real hardware once in the
    // background so the header doesn't mislabel the machine as a Spark.
    this._hardwareSummary = this._staticHardwareSummary(spark);
    this._stopped = false;
    if (spark?.kind === "host") {
      void (spark.platform === "windows" ? this.collector.detectWindowsHardware() : this.collector.detectHardware())
        .then((detected) => {
          if (this._stopped || !detected) return;
          this._hardwareSummary = { ...this._hardwareSummary, ...detected };
        })
        .catch(() => {});
    }

    // Timers
    /** Per-domain cadence for the fast collectors (ms). */
    this._fastIntervals = resolveFastPollIntervals(options.pollIntervalMs);
    /** @type {Record<string, ReturnType<typeof setInterval>>} fast domain → timer */
    this._domainTimers = {};
    this._intervals = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._llmIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._comfyIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._hermesIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._tailscaleIntervalId = null;
    this._running = false;
    this._runGeneration = 0;
    /** @type {Record<string, boolean | symbol>} in-flight domain guards */
    this._inflight = {};
  }

  /** Hot-update config without tearing down poll loops / rate baselines. */
  updateConfig(spark) {
    // A unit edit is the user telling us something changed — most often the key
    // or user — so the credential backoff starts over and the next liveness
    // attempt is immediate.
    this._livenessFailures = 0;
    this._nextLivenessAt = 0;
    const wasLlm = this._llmMonitoringEnabled(this.spark);
    const wasComfy = this._comfyMonitoringEnabled(this.spark);
    const prevComfyPort = this._comfyPort(this.spark);
    const wasHermes = this._hermesMonitoringEnabled(this.spark);
    const wasTailscale = this._tailscaleMonitoringEnabled(this.spark);
    this.collector.invalidatePendingCollections();
    this._runGeneration += 1;
    this._inflight = {};
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    this.spark = spark;
    this.collector.spark = spark;

    // Rebuild LLM probe map — add new ports, remove stale ones, update
    // existing. Config ports first (order = frontend panel order), then any
    // auto-discovered lanes that are not already in config (discovery is
    // display-only and survives config hot-updates).
    const cfgPorts = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const ports = this._llmMonitoringEnabled()
      ? [...cfgPorts, ...Array.from(this._discoveredPorts).filter((p) => !cfgPorts.includes(p))]
      : [];
    if (!this._llmMonitoringEnabled()) this._discoveredPorts = new Set();
    const prevProbes = this.llmProbes;
    this.llmProbes = new Map();
    for (const port of ports) {
      const existing = prevProbes.get(port);
      if (existing) {
        existing.spark = spark;
        existing.setPort(port);
        this.llmProbes.set(port, existing);
      } else {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }
    for (const [port, probe] of prevProbes) {
      if (!this.llmProbes.has(port)) probe.dispose?.();
    }
    for (const p of cfgPorts) this._discoveredPorts.delete(p);
    if (!this._llmMonitoringEnabled()) {
      this._metrics.llm = [];
    }
    if (!this._residentModelsEnabled()) {
      this._metrics.residentModels = [];
      delete this._lastSuccess.residentModels;
    }

    // ComfyUI probe — create / update / clear
    if (this._comfyMonitoringEnabled()) {
      const port = this._comfyPort();
      if (this.comfyProbe) {
        this.comfyProbe.setTarget(spark, port);
      } else {
        this.comfyProbe = new ComfyProbe(spark, port);
      }
    } else {
      if (this.comfyProbe) {
        try {
          this.comfyProbe.dispose();
        } catch {
          /* ignore */
        }
      }
      this.comfyProbe = null;
      this._metrics.comfy = null;
    }

    // Tailscale probe — create / update / clear
    if (this._tailscaleMonitoringEnabled()) {
      if (this.tailscaleProbe) {
        this.tailscaleProbe.setTarget(spark);
      } else {
        this.tailscaleProbe = new TailscaleProbe(spark);
      }
    } else {
      this.tailscaleProbe = null;
      this._metrics.tailscale = null;
    }

    // Hermes probe — create / update / clear
    if (this._hermesMonitoringEnabled()) {
      if (this.hermesProbe) {
        this.hermesProbe.setTarget(spark);
      } else {
        this.hermesProbe = new HermesProbe(spark);
      }
    } else {
      this.hermesProbe = null;
      this._hermes.status = "idle";
    }
    this._hermes.monitoring = this._hermesMonitoringEnabled();
    if (this._running && wasHermes !== this._hermesMonitoringEnabled()) {
      this._restartHermesPollInterval();
    }

    // Toggle LLM poll interval when monitoring enablement flips
    if (this._running && wasLlm !== this._llmMonitoringEnabled()) {
      this._restartLlmPollInterval();
    }
    const comfyOn = this._comfyMonitoringEnabled();
    const comfyPortChanged = comfyOn && prevComfyPort !== this._comfyPort();
    if (this._running && (wasComfy !== comfyOn || comfyPortChanged)) {
      this._restartComfyPollInterval();
    }
    if (this._running && wasTailscale !== this._tailscaleMonitoringEnabled()) {
      this._restartTailscalePollInterval();
    }
  }

  /**
   * Workers: never. Head: always. Standalone: llmMonitoring (default true).
   * @param {object} [spark]
   */
  _llmMonitoringEnabled(spark = this.spark) {
    const role = spark?.role || (spark?.workerNode ? "worker" : "standalone");
    if (role === "worker") return false;
    if (role === "head") return true;
    return spark?.llmMonitoring !== false;
  }

  /** Resident-model discovery: LLM monitoring on, remote, and a Linux host. */
  _residentModelsEnabled(spark = this.spark) {
    if (!this._llmMonitoringEnabled(spark)) return false;
    if (spark?.isLocal) return false;
    return spark?.platform !== "windows" && spark?.platform !== "darwin";
  }

  /**
   * Live LLM model id from this monitor's own probes (first non-empty
   * modelId on an AVAILABLE entry across ports), or null when unknown /
   * offline / protected. Protected/auth-failure snapshots can retain a
   * previous modelId with available:false — those entries are skipped so a
   * dead or locked head never yields a stale model (fail-closed).
   * @returns {string | null}
   */
  headLlmModelId() {
    if (!this.online) return null;
    const llm = this._metrics?.llm;
    if (!Array.isArray(llm)) return null;
    for (const entry of llm) {
      if (entry?.available !== true) continue;
      const id = typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
      if (id) return id;
    }
    return null;
  }

  /**
   * Derived worker label: mirror the head's live served model. Display-only —
   * never written back to registry config. Non-null only when ALL hold:
   * role is worker, workerHeadId points at another spark, and the resolver
   * yields a non-empty model id. A hand-written workerLabel (non-empty) is a
   * manual override and takes display priority in the frontend; it does not
   * suppress this derived value.
   * @returns {string | null}
   */
  workerDerivedLabel() {
    const spark = this.spark || {};
    const role = spark.role || (spark.workerNode ? "worker" : "standalone");
    if (role !== "worker") return null;
    const headId = typeof spark.workerHeadId === "string" ? spark.workerHeadId.trim() : "";
    if (!headId || headId === spark.id) return null;
    if (typeof this._resolveHeadModelId !== "function") return null;
    let model = null;
    try {
      model = this._resolveHeadModelId(headId);
    } catch {
      return null;
    }
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  /** Start or clear the LLM poll timer based on monitoring flag. */
  _restartLlmPollInterval() {
    if (this._llmIntervalId != null) {
      clearInterval(this._llmIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._llmIntervalId);
      this._llmIntervalId = null;
    }
    if (this._llmMonitoringEnabled() && this._running) {
      this._llmIntervalId = this._armDomainTimer("llm");
      void this._pollDomain("llm");
    }
  }

  /**
   * Opt-in ComfyUI monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _comfyMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.comfyMonitoring);
  }

  /** @param {object} [spark] */
  _comfyPort(spark = this.spark) {
    const n = Number(spark?.comfyPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }

  /** Start or clear the ComfyUI poll timer based on monitoring flag. */
  _restartComfyPollInterval() {
    if (this._comfyIntervalId != null) {
      clearInterval(this._comfyIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._comfyIntervalId);
      this._comfyIntervalId = null;
    }
    if (this._comfyMonitoringEnabled() && this._running) {
      this._comfyIntervalId = this._armDomainTimer("comfy");
      void this._pollDomain("comfy");
    }
  }

  /**
   * Opt-in tailnet monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _tailscaleMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.tailscaleMonitoring);
  }

  /** Start or clear the tailnet poll timer based on monitoring flag. */
  _restartTailscalePollInterval() {
    if (this._tailscaleIntervalId != null) {
      clearInterval(this._tailscaleIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._tailscaleIntervalId);
      this._tailscaleIntervalId = null;
    }
    if (this._tailscaleMonitoringEnabled() && this._running) {
      this._tailscaleIntervalId = setInterval(
        () => this._pollDomain("tailscale"),
        POLL_INTERVAL_TAILSCALE
      );
      this._intervals.push(this._tailscaleIntervalId);
      void this._pollDomain("tailscale");
    }
  }

  /**
   * Opt-in Hermes Agent monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _hermesMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.hermesMonitoring);
  }

  /** Start or clear the Hermes update-check timer when monitoring flips. */
  _restartHermesPollInterval() {
    if (this._hermesIntervalId != null) {
      clearInterval(this._hermesIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._hermesIntervalId);
      this._hermesIntervalId = null;
    }
    if (this._hermesMonitoringEnabled() && this._running) {
      this._hermesIntervalId = setInterval(
        () => this._pollDomain("hermes"),
        POLL_INTERVAL_HERMES
      );
      this._intervals.push(this._hermesIntervalId);
      void this._pollDomain("hermes");
    }
  }

  /**
   * Record which LLM ports served tokens in this poll and return the probe
   * results with `lastActiveAt` (epoch ms, or null if never seen serving
   * since the server started) on each entry. Ports no longer probed are
   * forgotten so a re-added port does not resurface an old timestamp.
   * @param {Array<{ port: number }>} probes  same order as `results`
   * @param {Array<Record<string, unknown>>} results
   */
  _stampLlmLastActive(probes, results) {
    const now = Date.now();
    const ports = new Set();
    const stamped = results.map((entry, i) => {
      const port = probes[i]?.port;
      if (port == null || !entry || typeof entry !== "object") return entry;
      ports.add(port);
      const gen = Number(entry.generationTps);
      const pre = Number(entry.prefillTps);
      if ((Number.isFinite(gen) && gen > 0) || (Number.isFinite(pre) && pre > 0)) {
        this._llmLastActiveAt.set(port, now);
      }
      return { ...entry, lastActiveAt: this._llmLastActiveAt.get(port) ?? null };
    });
    for (const port of this._llmLastActiveAt.keys()) {
      if (!ports.has(port)) this._llmLastActiveAt.delete(port);
    }
    return stamped;
  }

  /** Returns array of LLM ports from spark config. */
  _llmPorts() {
    const raw = this.spark?.llmPorts;
    if (Array.isArray(raw)) {
      const ports = raw
        .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      return ports.length > 0 ? ports : [LLM_PORT];
    }
    // Legacy single port
    const n = Number(this.spark?.llmPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
    return [LLM_PORT];
  }

  /** Repeating poll of one domain at its current cadence; tracked for stop(). */
  _armDomainTimer(domain) {
    const id = setInterval(() => this._pollDomain(domain), this._fastIntervals[domain]);
    this._intervals.push(id);
    return id;
  }

  _clearTimer(id) {
    clearInterval(id);
    this._intervals = this._intervals.filter((other) => other !== id);
  }

  /**
   * Apply a new Settings → Poll interval. Only timers whose cadence actually
   * changes are re-armed, and nothing else is touched: in-flight guards, the
   * run generation, liveness backoff and the offline pause all carry over, so
   * a poll already running is neither duplicated nor discarded.
   * @param {number} pollIntervalMs
   */
  setPollInterval(pollIntervalMs) {
    const prev = this._fastIntervals;
    this._fastIntervals = resolveFastPollIntervals(pollIntervalMs);
    if (!this._running) return;
    for (const domain of FAST_TIMER_DOMAINS) {
      if (prev[domain] === this._fastIntervals[domain]) continue;
      if (this._domainTimers[domain] != null) this._clearTimer(this._domainTimers[domain]);
      this._domainTimers[domain] = this._armDomainTimer(domain);
    }
    if (this._llmIntervalId != null && prev.llm !== this._fastIntervals.llm) {
      this._clearTimer(this._llmIntervalId);
      this._llmIntervalId = this._armDomainTimer("llm");
    }
    if (this._comfyIntervalId != null && prev.comfy !== this._fastIntervals.comfy) {
      this._clearTimer(this._comfyIntervalId);
      this._comfyIntervalId = this._armDomainTimer("comfy");
    }
  }

  /**
   * Kick off a lane-discovery scan at most once every 15 s (fire-and-forget).
   * Only for local head/standalone sparks with LLM monitoring on.
   */
  _maybeDiscoverLane() {
    if (!LLM_AUTO_DISCOVER || this._scanInflight || !this._running) return;
    if (!this.spark?.isLocal || !this._llmMonitoringEnabled()) return;
    const now = Date.now();
    if (now - this._lastScanAt < 15_000) return;
    this._lastScanAt = now;
    this._scanInflight = true;
    this._scanLanes().catch((err) => {
      console.error(`[SparkMonitor] ${this.spark?.id} lane discovery error:`, err?.message || err);
    }).finally(() => {
      this._scanInflight = false;
    });
  }

  /**
   * Scan candidate ports not already covered by a probe; surface any that
   * answer /v1/models. Candidates: the dspark env-file VLLM_PORT (single
   * source of truth for the active lane), default LLM_PORT, and every port
   * with a stored API key. A 200 (open) or 401 (protected) means an engine
   * is serving there.
   *
   * API key bootstrap: a 401 without a stored key makes the scan try the
   * shared fleet key from the env file; on success it notifies
   * onLlmPortDiscovered(sparkId, port, key) so index.js persists it in the
   * encrypted secrets store.
   */
  async _scanLanes() {
    const spark = this.spark;
    const host = spark.lanIp || "127.0.0.1";
    const keys = spark.llmApiKeys || {};
    const candidates = new Set();
    const envPort = readEnvFileLanePort();
    if (envPort) candidates.add(envPort);
    candidates.add(LLM_PORT);
    for (const k of Object.keys(keys)) {
      const n = parseInt(k, 10);
      if (Number.isInteger(n)) candidates.add(n);
    }
    // Drop anything already covered by a configured or discovered probe
    for (const p of this.llmProbes.keys()) candidates.delete(p);
    if (candidates.size === 0) {
      // Nothing new to look for — but prune stale discovered ports that
      // stopped serving so a stopped lane doesn't linger forever.
      await this._pruneDiscovered();
      return;
    }

    for (const port of candidates) {
      const storedKey =
        keys[String(port)] != null ? String(keys[String(port)]).trim() : "";
      let status = await fetchLlmProbeStatus(
        spark.isLocal ? "127.0.0.1" : host,
        port,
        storedKey || null,
      );
      let adoptedKey = null;
      if (status === 401 && !storedKey) {
        const fleet = loadFleetKey();
        if (fleet) {
          const s2 = await fetchLlmProbeStatus(
            spark.isLocal ? "127.0.0.1" : host,
            port,
            fleet,
          );
          if (s2 === 200) {
            status = 200;
            adoptedKey = fleet;
          }
        }
      }
      if (status !== 200 && status !== 401) continue;

      // Lane is live — create its probe, surface it, adopt key if needed
      const probe = new LlmProbe(spark, port);
      if (adoptedKey) {
        spark.llmApiKeys = { ...(spark.llmApiKeys || {}), [String(port)]: adoptedKey };
        probe.spark = spark;
        try {
          if (this._onLlmPortDiscovered) {
            this._onLlmPortDiscovered(spark.id, port, adoptedKey);
          }
        } catch (err) {
          console.error(
            `[SparkMonitor] ${spark.id} discovery key-persist failed for :${port}:`,
            err?.message || err,
          );
        }
      }
      this.llmProbes.set(port, probe);
      this._discoveredPorts.add(port);
      console.log(
        `[SparkMonitor] ${spark.id} discovered LLM lane :${port}${adoptedKey ? " (adopted fleet key)" : ""}`,
      );
    }
    await this._pruneDiscovered();
  }

  /** Drop discovered ports whose server stopped answering (config ports stay). */
  async _pruneDiscovered() {
    if (this._discoveredPorts.size === 0) return;
    const host = this.spark.isLocal ? "127.0.0.1" : this.spark.lanIp || "127.0.0.1";
    const keys = this.spark.llmApiKeys || {};
    for (const port of Array.from(this._discoveredPorts)) {
      const key = keys[String(port)] != null ? String(keys[String(port)]).trim() : "";
      const status = await fetchLlmProbeStatus(host, port, key || null);
      if (status === 200 || status === 401) continue;
      this._discoveredPorts.delete(port);
      const probe = this.llmProbes.get(port);
      if (probe) {
        try {
          probe.dispose?.();
        } catch {
          /* ignore */
        }
        this.llmProbes.delete(port);
      }
      // Drop the transient metrics slot too so snapshot zipping stays clean
      if (Array.isArray(this._metrics.llm)) {
        const idx = Array.from(this.llmProbes.keys()).length;
        if (this._metrics.llm.length > idx) this._metrics.llm = this._metrics.llm.slice(0, idx);
      }
      console.log(`[SparkMonitor] ${this.spark.id} dropped discovered LLM lane :${port}`);
    }
  }

  /** Start background polling. */
  start() {
    if (this._running) return;
    this._runGeneration += 1;
    this._running = true;
    this._stopped = false;
    this._poll();
    for (const domain of FAST_TIMER_DOMAINS) {
      this._domainTimers[domain] = this._armDomainTimer(domain);
    }
    this._intervals.push(setInterval(() => this._pollDomain("storage"), POLL_INTERVAL_STORAGE));
    this._intervals.push(setInterval(() => this._pollDomain("residentModels"), RESIDENT_MODELS_POLL_MS));
    this._restartLlmPollInterval();
    this._restartComfyPollInterval();
    this._restartHermesPollInterval();
    this._restartTailscalePollInterval();
    // Liveness on a slightly slower cadence
    this._intervals.push(setInterval(() => this._checkOnline(), POLL_INTERVAL_LIVENESS));
    console.log(`[SparkMonitor] ${this.spark.id} started`);
  }

  /** Stop background polling. */
  stop() {
    this.collector.invalidatePendingCollections();
    this._runGeneration += 1;
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    this._running = false;
    this._stopped = true;
    for (const id of this._intervals) clearInterval(id);
    this._intervals = [];
    this._domainTimers = {};
    this._llmIntervalId = null;
    this._comfyIntervalId = null;
    this._hermesIntervalId = null;
    this._tailscaleIntervalId = null;
    this._inflight = {};
    for (const probe of this.llmProbes.values()) {
      try {
        probe.dispose();
      } catch {
        /* ignore */
      }
    }
    if (this.comfyProbe) {
      try {
        this.comfyProbe.dispose();
      } catch {
        /* ignore */
      }
    }
    console.log(`[SparkMonitor] ${this.spark.id} stopped`);
  }

  /** Return a full snapshot of this Spark's metrics. */
  snapshot() {
    const ports = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const comfyOn = this._comfyMonitoringEnabled();
    const tailscaleOn = this._tailscaleMonitoringEnabled();
    return {
      id: this.spark.id,
      name: this.spark.name,
      kind: this.spark.kind || "spark",
      platform: this.spark.platform || "linux",
      online: this.online,
      /** Last liveness failure, or null. "offline" with no reason is a bug. */
      offlineReason: this.online ? null : this.offlineReason,
      uptime: this._uptimeSeconds,
      lanIp: this.spark.lanIp || "",
      isLocal: Boolean(this.spark.isLocal),
      disabledDevices: this.spark.disabledDevices || [],
      disabledInterfaces: this.spark.disabledInterfaces || [],
      storagePollDisabled: Boolean(this.spark.storagePollDisabled),
      workerNode: Boolean(this.spark.workerNode),
      role: this.spark.role || (this.spark.workerNode ? "worker" : "standalone"),
      workerLabel: this.spark.workerLabel || null,
      workerHeadId: this.spark.workerHeadId || null,
      // Derived display label (head model mirror). Raw workerLabel above is
      // untouched — frontend prefers a non-empty manual label over this.
      workerDerivedLabel: this.workerDerivedLabel(),
      llmMonitoring: this._llmMonitoringEnabled(),
      llmPort: ports[0] ?? LLM_PORT,
      // Include auto-discovered lanes (probe map is the truth for zipping
      // with metrics.llm); config ports keep their order first.
      llmPorts: Array.from(this.llmProbes.keys()),
      llmApiKeyPorts: Array.isArray(this.spark.llmApiKeyPorts)
        ? this.spark.llmApiKeyPorts
        : Object.keys(this.spark.llmApiKeys || {})
            .map((p) => parseInt(p, 10))
            .filter((n) => Number.isInteger(n)),
      comfyMonitoring: comfyOn,
      comfyPort: this._comfyPort(),
      tailscaleMonitoring: tailscaleOn,
      hermes: this._hermes,
      health: this._health,
      hardware: this._hardwareSummary,
      metrics: {
        // NOTE: no `timestamp` here on purpose. The broadcast path skips
        // snapshots whose JSON is byte-identical to the previous one (see
        // startBroadcast); a per-snapshot Date.now() would defeat that cache,
        // forcing a broadcast + frontend re-render every tick even when all
        // measured values are unchanged. The frontend does not consume a
        // metrics timestamp; the WS receive time can serve if one is ever
        // needed.
        gpu: this._metrics.gpu,
        cpu: this._metrics.cpu,
        ram: this._metrics.ram,
        storage: this._metrics.storage,
        network: this._metrics.network,
        roce: this._metrics.roce ?? null,
        unifiedMemory: this._metrics.unifiedMemory,
        llm: this._metrics.llm,
        residentModels: this._metrics.residentModels,
        comfy: comfyOn ? this._metrics.comfy : null,
        tailscale: tailscaleOn ? this._metrics.tailscale : null,
      },
    };
  }

  // ─── Uptime helper ─────────────────────────────────────────
  /** Read system uptime from /proc/uptime (local or via SSH). */
  async _readUptime() {
    if (this.spark.platform === "windows" && !this.spark.isLocal) {
      return this.collector.readWindowsUptime();
    }
    let content;
    if (this.spark.isLocal) {
      const mapped = path.join(HOST_PATHS.PROC, "uptime");
      content = fs.readFileSync(mapped, "utf8");
    } else {
      content = await sshExec(this.spark, "cat /proc/uptime");
    }
    const parts = content.trim().split(/\s+/);
    const secs = parseFloat(parts[0]);
    return Number.isFinite(secs) ? Math.floor(secs) : null;
  }

  /** Report an event to the fleet log; never throws into the poll loop. */
  _emit(event) {
    if (!this._onEvent) return;
    try {
      this._onEvent({ sparkId: this.spark.id, sparkName: this.spark.name || this.spark.id, ...event });
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} event error:`, err?.message);
    }
  }

  _noteOnline(next) {
    const prev = this._prevOnline;
    this._prevOnline = next;
    if (prev == null || prev === next) return;
    const name = this.spark.name || this.spark.id;
    this._emit(
      next
        ? { type: "spark.online", severity: "success", message: `${name} came online` }
        : { type: "spark.offline", severity: "warn", message: `${name} went offline` }
    );
  }

  /** Re-run the health rules, emit events for changes (never for the first baseline). */
  _updateHealth(domain = "other") {
    try {
      const ev = this._healthEval;
      const findings = ev.evaluate(
        {
          gpu: this._metrics.gpu,
          unifiedMemory: this._metrics.unifiedMemory,
          network: this._metrics.network,
          roce: this._metrics.roce,
          llm: this._metrics.llm,
        },
        domain
      );
      // A reading that hovers around a threshold (a GPU at 85 °C, memory near 3 GB) would
      // raise and clear its finding every few seconds, and log an event each time. Keep a
      // finding for HEALTH_CLEAR_HOLD_MS after the rule last raised it.
      const now = this._healthNow();
      const held = this._holdFindings(findings, now);
      this._health = held;
      const name = this.spark.name || this.spark.id;
      for (const e of ev.pendingEvents) this._emit(e);
      const ids = new Set(held.map((f) => f.id));
      const prev = this._prevHealthIds;
      this._prevHealthIds = ids;
      if (prev == null) return;
      for (const f of held) {
        if (prev.has(f.id) || f.id === "xid" || f.id === "oom") continue;
        this._emit({
          type: `health.${f.id}`,
          severity: f.severity === "critical" ? "error" : "warn",
          message: `${name}: ${f.title} — ${f.detail}`,
        });
      }
      for (const id of prev) {
        if (ids.has(id) || id === "xid" || id === "oom") continue;
        this._emit({ type: "health.cleared", severity: "success", message: `${name}: ${HEALTH_LABELS[id] ?? id} is back to normal` });
      }
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} health error:`, err?.message);
    }
  }

  /** Wall clock for the health hold; a method so tests can drive it. */
  _healthNow() {
    return Date.now();
  }

  /**
   * Findings the rules raised now, plus those raised within the last HEALTH_CLEAR_HOLD_MS
   * that no longer hold (shown with their last detail until the hold runs out).
   */
  _holdFindings(findings, now) {
    this._healthSeen ??= new Map();
    for (const f of findings) this._healthSeen.set(f.id, { finding: f, at: now });
    const out = [...findings];
    const present = new Set(findings.map((f) => f.id));
    for (const [id, rec] of this._healthSeen) {
      if (present.has(id)) continue;
      // The kernel-error findings keep their own one-hour memory in the evaluator.
      if (now - rec.at < HEALTH_CLEAR_HOLD_MS && id !== "xid" && id !== "oom") out.push(rec.finding);
      else this._healthSeen.delete(id);
    }
    return out;
  }

  /**
   * Did this poll return real data? Collectors catch their own errors and answer with
   * zeroed defaults, so "the poll finished" says nothing about the data (a stuck
   * nvidia-smi, an SSH session that logs in but cannot run the command).
   */
  _domainSucceeded(domain, result) {
    switch (domain) {
      case "gpu":
      case "cpu":
        return collectionWasSuccessful(result);
      case "ram":
      case "memory":
        return Number(result?.total) > 0;
      case "network":
        return Array.isArray(result?.interfaces) && result.interfaces.length > 0;
      case "storage":
        return Array.isArray(result) && result.length > 0;
      case "residentModels":
        return Array.isArray(result);
      case "llm":
        return Array.isArray(result); // an engine that is down is still a successful probe
      default:
        return false;
    }
  }

  /** domain → epoch ms of the last poll that returned real data (for the Prometheus export). */
  lastSuccess() {
    const out = { ...this._lastSuccess };
    // A domain that is no longer polled must not age forever and trip a "stuck" alert.
    if (this.spark.storagePollDisabled) delete out.storage;
    if (!this._llmMonitoringEnabled()) delete out.llm;
    return out;
  }

  _noteThrottle(gpu) {
    if (!collectionWasSuccessful(gpu)) return;
    const thermal = gpu?.throttle?.reason === "thermal" && Boolean(gpu?.throttle?.active);
    const prev = this._prevThermal;
    this._prevThermal = thermal;
    if (prev == null || prev === thermal) return;
    const name = this.spark.name || this.spark.id;
    const temp = Number.isFinite(gpu?.temperature) ? ` (${Math.round(gpu.temperature)}°C)` : "";
    this._emit(
      thermal
        ? { type: "gpu.throttle.thermal", severity: "warn", message: `${name} started thermal throttling${temp}` }
        : { type: "gpu.throttle.cleared", severity: "success", message: `${name} stopped thermal throttling${temp}` }
    );
  }

  // ─── Liveness ─────────────────────────────────────────────
  async _checkOnline() {
    if (!this._running || this._inflight.online) return;
    // Backoff gate: a unit that keeps refusing us is probed on a widening
    // schedule (see _scheduleNextLiveness) instead of every 5 seconds forever.
    if (Date.now() < this._nextLivenessAt) return;
    const runGeneration = this._runGeneration;
    const checkToken = Symbol("online");
    this._inflight.online = checkToken;
    const isCurrentRun = () =>
      this._running && this._runGeneration === runGeneration;
    const local = this.spark.isLocal;
    let uptimeSeconds = this._uptimeSeconds;
    try {
      if (local) {
        await this.collector.pingHost();
        if (!isCurrentRun()) return;
        this.online = true;
        this.lastOnlineOk = Date.now();
        // Non-fatal — uptime stays at its previous value or null
        try {
          uptimeSeconds = await this._readUptime();
        } catch {
          /* ignore */
        }
      } else {
        // One SSH round trip, not two. Reading /proc/uptime already proves the
        // session came up, so the separate `echo ok` probe told us nothing the
        // uptime read doesn't — and on a remote Spark every probe is a full
        // login, which is the expensive half of this loop.
        uptimeSeconds = await this._readUptime();
        // The generation gate below (after the await) is the commit guard.
      }
      if (!isCurrentRun()) return;
      this.online = true;
      this.offlineReason = null;
      this._livenessFailures = 0;
      this._nextLivenessAt = 0;
      this.lastOnlineOk = Date.now();
      this._uptimeSeconds = uptimeSeconds;
      this._noteOnline(true);
    } catch (err) {
      if (!isCurrentRun()) return;
      this._livenessFailures += 1;
      const reason = livenessReason(err);
      this.offlineReason =
        isSshAuthFailure(reason) && sshAuthGaveUp(this._livenessFailures)
          ? `${reason} (paused after ${this._livenessFailures} attempts — edit the unit to retry now)`
          : reason;
      this._nextLivenessAt = Date.now() + nextLivenessDelayMs(this._livenessFailures, this.offlineReason);
      if (!this.lastOnlineOk || Date.now() - this.lastOnlineOk > ONLINE_GRACE_MS) {
        this.online = false;
        this._uptimeSeconds = null;
        this._invalidateSshMetrics();
        this._noteOnline(false);
      }
    } finally {
      if (this._inflight.online === checkToken) {
        this._inflight.online = false;
      }
    }
  }

  /**
   * A remote unit stayed unreachable past the grace period: its SSH-backed
   * cached metrics are stale, so replace them with the honest "no data"
   * defaults instead of serving the last good reading indefinitely. HTTP-only
   * domains (llm, comfy) keep polling and keep their own state.
   */
  _invalidateSshMetrics() {
    if (this.spark.isLocal) return;
    const c = this.collector;
    // Their data is gone; the series must restart from the first fresh poll after recovery.
    for (const key of ["gpu", "cpu", "ram", "memory", "network", "storage", "roce"]) delete this._lastSuccess[key];
    this._metrics.gpu = c._defaultGpu();
    this._metrics.cpu = c._defaultCpu();
    this._metrics.ram = c._defaultRam();
    this._metrics.storage = [];
    this._metrics.network = c._defaultNetwork();
    this._metrics.roce = null;
    this._metrics.unifiedMemory = c._defaultUnifiedMemory();
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
  }

  // ─── Polling ──────────────────────────────────────────────
  async _poll() {
    if (!this._running) return;
    await Promise.all([
      this._checkOnline(),
      this._pollDomain("gpu"),
      this._pollDomain("cpu"),
      this._pollDomain("network"),
      this._pollDomain("storage"),
      this._pollDomain("ram"),
      this._pollDomain("memory"),
      this._pollDomain("llm"),
      this._pollDomain("comfy"),
      this._pollDomain("hermes"),
      this._pollDomain("tailscale"),
      this._pollDomain("residentModels"),
    ]);
  }

  async _pollDomain(domain) {
    if (!this._running || this._inflight[domain]) return;
    // A remote unit that just failed liveness is unreachable for everything —
    // metrics, tunnels, SSH commands. Polling it anyway is how one broken unit
    // produced ~60k failed SSH logins a day: every domain interval fired, every
    // attempt failed, nothing backed off. Local units are exempt (their checks
    // read /proc and /sys and are cheap and honest about partial failures).
    // HTTP-only probes (LLM, ComfyUI) do not use SSH, so a failed SSH liveness
    // check must not freeze them: the engine may be reachable on its own.
    const sshBacked = domain !== "llm" && domain !== "comfy";
    if (sshBacked && !this.spark.isLocal && !this.online) {
      if (!this._pollsPaused) {
        this._pollsPaused = true;
        console.log(
          `[SparkMonitor] ${this.spark.id}: unreachable (${this.offlineReason || "no liveness"}) — pausing collector polls`
        );
      }
      return;
    }
    if (sshBacked && this._pollsPaused) {
      this._pollsPaused = false;
      console.log(`[SparkMonitor] ${this.spark.id}: reachable again — resuming collector polls`);
    }
    // Skip storage auto-poll when disabled for this spark
    if (domain === "storage" && this.spark.storagePollDisabled) return;
    // Worker nodes: no local LLM API
    if (domain === "llm" && !this._llmMonitoringEnabled()) return;
    // Resident models are discovered over SSH, so only for units whose LLM
    // monitoring is on (never workers) and that are remote Linux hosts.
    if (domain === "residentModels" && !this._residentModelsEnabled()) return;
    if (domain === "comfy" && !this._comfyMonitoringEnabled()) return;
    if (domain === "hermes" && !this._hermesMonitoringEnabled()) return;
    if (domain === "tailscale" && !this._tailscaleMonitoringEnabled()) return;
    const runGeneration = this._runGeneration;
    const pollToken = Symbol(domain);
    this._inflight[domain] = pollToken;
    try {
      let result;
      let roce;
      switch (domain) {
        case "residentModels":
          result = await this.collector.probeResidentModels(); // null = could not tell
          break;
        case "gpu":
          result = await this.collector.collectGpu();
          break;
        case "cpu":
          result = await this.collector.collectCpu();
          break;
        case "ram":
          result = await this.collector.collectRam();
          break;
        case "network":
          result = await this.collector.collectNetwork();
          // RoCE rides the network tick: it throttles itself, never fails the poll and never
          // holds the network result for more than a moment (a wedged NIC can stall ethtool).
          // `undefined` = could not read this time: keep the previous value.
          roce = await Promise.race([
            this.collector.collectRoce().catch(() => undefined),
            new Promise((resolve) => setTimeout(() => resolve(undefined), 3000).unref?.()),
          ]);
          break;
        case "storage":
          result = await this.collector.collectStorage();
          break;
        case "memory":
          result = await this.collector.collectUnifiedMemory();
          break;
        case "llm": {
          // Lane auto-discovery: cheap env-file + /v1/models scan may add a
          // probe for a port that started serving since config was written.
          this._maybeDiscoverLane();
          // Snapshot the probe list up-front: discovery is fire-and-forget
          // and must not shift indices mid-tick.
          const tickProbes = Array.from(this.llmProbes.values());
          // Probe all ports in parallel
          result = await Promise.all(tickProbes.map((probe) => probe.probe()));
          // Tag results with ports; the write-back stage maps to LlmDaily
          this._lastLlmTickPorts = tickProbes.map((p) => p.port);
          break;
        }
        case "comfy":
          result = this.comfyProbe ? await this.comfyProbe.probe() : null;
          break;
        case "tailscale":
          result = this.tailscaleProbe ? await this.tailscaleProbe.probe() : null;
          break;
        case "hermes":
          result = this.hermesProbe ? await this.hermesProbe.check() : null;
          break;
      }
      // Re-check after the await — `stop()`/`updateSpark()` may have torn
      // this monitor down mid-flight. Writing `_metrics` on a dead monitor
      // isn't user-visible (monitors.delete already happened) but it's a
      // latent class of bug worth killing, and a replaced monitor could
      // otherwise race the tail-end await onto the wrong object.
      if (!this._running || this._runGeneration !== runGeneration) return;
      switch (domain) {
        case "residentModels":
          // A failed discovery (result null) must neither look like "no models" nor
          // flap the card: keep the previous list until it is a few polls old.
          if (result !== null) {
            this._metrics.residentModels = result;
          } else if (Date.now() - (this._lastSuccess.residentModels ?? 0) > RESIDENT_MODELS_GRACE_MS) {
            this._metrics.residentModels = [];
          }
          break;
        case "gpu":
          this._metrics.gpu = result;
          this._metricCollectionSuccessful.gpu = collectionWasSuccessful(result);
          this._noteThrottle(result);
          this._updateHealth("gpu");
          break;
        case "cpu":
          this._metrics.cpu = result;
          this._metricCollectionSuccessful.cpu = collectionWasSuccessful(result);
          break;
        case "ram":
          this._metrics.ram = result;
          break;
        case "network":
          this._metrics.network = result;
          if (roce !== undefined) this._metrics.roce = roce;
          this._updateHealth();
          if (result?.wolMac && this._onWolMac) {
            try {
              this._onWolMac(this.spark.id, result.wolMac);
            } catch (err) {
              console.error(`[SparkMonitor] ${this.spark.id} wolMac persist error:`, err.message);
            }
          }
          break;
        case "storage":
          this._metrics.storage = result;
          break;
        case "memory":
          this._metrics.unifiedMemory = result;
          this._updateHealth();
          break;
        case "llm":
          {
            const ports = this._lastLlmTickPorts || [];
            const probes = ports.map((p) => this.llmProbes.get(p));
            this._metrics.llm = this._stampLlmLastActive(probes, result);
            this._updateHealth();
            for (let i = 0; i < result.length; i++) {
              const port = ports[i];
              if (port != null) llmDaily.record(this.spark.id, port, result[i]);
            }
          }
          break;
        case "comfy":
          this._metrics.comfy = result;
          break;
        case "tailscale":
          this._metrics.tailscale = result;
          break;
        case "hermes":
          this.applyHermesCheck(result);
          break;
      }
      this._lastUpdate[domain] = Date.now();
      if (this._domainSucceeded(domain, result)) this._lastSuccess[domain] = this._lastUpdate[domain];
      // RoCE keeps its last good sample through a few failed reads: stamp it with when it was
      // actually read, so a stalled RoCE read ages instead of looking fresh.
      if (domain === "network" && roce?.sampledAt) this._lastSuccess.roce = roce.sampledAt;
    } catch (err) {
      if (
        this._running &&
        this._runGeneration === runGeneration &&
        (domain === "gpu" || domain === "cpu")
      ) {
        this._metricCollectionSuccessful[domain] = false;
      }
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} poll error:`, err.message);
    } finally {
      if (this._inflight[domain] === pollToken) {
        this._inflight[domain] = false;
      }
    }
  }

  /** Manually refresh a single domain, bypassing auto-poll guards. */
  async refreshDomain(domain) {
    if (domain !== "storage") return this._pollDomain(domain);
    if (!this._running || this._inflight[domain]) return;
    const runGeneration = this._runGeneration;
    const refreshToken = Symbol(domain);
    this._inflight[domain] = refreshToken;
    try {
      const result = await this.collector.collectStorage();
      if (!this._running || this._runGeneration !== runGeneration) return;
      this._metrics.storage = result;
      this._lastUpdate[domain] = Date.now();
      if (this._domainSucceeded(domain, result)) this._lastSuccess[domain] = this._lastUpdate[domain];
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} refresh error:`, err.message);
    } finally {
      if (this._inflight[domain] === refreshToken) {
        this._inflight[domain] = false;
      }
    }
  }

  // ─── Hermes Agent ─────────────────────────────────────────
  /**
   * Apply a Hermes check result to monitor state. Fires onHermesChange (force
   * broadcast) only when a user-meaningful field actually changed, so idle
   * re-checks do not spam the WS.
   * @param {object|null} result
   */
  applyHermesCheck(result) {
    if (!result || !this._running) return;
    const prev = this._hermes;
    const changed =
      result.updateAvailable !== prev.updateAvailable ||
      result.installed !== prev.installed ||
      result.version !== prev.version;
    this._hermes = {
      ...prev,
      installed: result.installed,
      version: result.version,
      updateAvailable: result.updateAvailable,
      behindCommits: result.behindCommits,
      checkedAt: result.checkedAt,
      error: result.error ?? null,
    };
    // A clean check self-heals the transient one-shot update job status, so a
    // "success / error" flag never lingers past the following poll cycle.
    if (!result.error && this._hermes.status !== "running") {
      this._hermes.status = "idle";
    }
    if (prev.updateAvailable === false && result.updateAvailable === true) {
      const name = this.spark.name || this.spark.id;
      const n = Number.isFinite(result.behindCommits) && result.behindCommits > 0
        ? ` (${result.behindCommits} commit${result.behindCommits === 1 ? "" : "s"} behind)`
        : "";
      this._emit({
        type: "hermes.update.available",
        severity: "info",
        message: `Hermes update available on ${name}${n}`,
        data: { version: result.version ?? null },
      });
    }
    if (changed) this._notifyHermesChange();
  }

  /**
   * Kick off `hermes update` in the background. Returns immediately; progress
   * and result are surfaced through the snapshot + onHermesChange broadcast.
   * @returns {{ started: boolean, reason?: string }}
   */
  runHermesUpdate() {
    if (!this.hermesProbe) {
      return { started: false, reason: "Hermes Agent monitoring is disabled for this Spark" };
    }
    if (this._hermes.status === "running") {
      return { started: false, reason: "An update is already running" };
    }
    this._hermes = {
      ...this._hermes,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this._notifyHermesChange();
    // Defer the long-running SSH work so the broadcast above lands first.
    void (async () => {
      try {
        const res = await this.hermesProbe.update();
        if (!this._running) return;
        if (res?.ok) {
          this._hermes = {
            ...this._hermes,
            status: "success",
            installed: res.installed,
            version: res.version,
            error: null,
            finishedAt: res.finishedAt ?? Date.now(),
          };
          this._emit({
            type: "hermes.update.success",
            severity: "success",
            message: `Hermes updated on ${this.spark.name || this.spark.id}${res.version ? ` to ${res.version}` : ""}`,
          });
          // Refresh update availability right away (don't wait for the next poll).
          try {
            const check = await this.hermesProbe.check();
            if (this._running && check) {
              this._hermes = {
                ...this._hermes,
                installed: check.installed,
                version: check.version,
                updateAvailable: check.updateAvailable,
                behindCommits: check.behindCommits,
                checkedAt: check.checkedAt,
                error: check.error ?? null,
              };
            }
          } catch {
            /* keep the success result if the follow-up check fails */
          }
        } else {
          this._hermes = {
            ...this._hermes,
            status: "error",
            error: res?.error || res?.output?.slice(-400) || "hermes update failed",
            finishedAt: res?.finishedAt ?? Date.now(),
          };
          this._emit({
            type: "hermes.update.error",
            severity: "error",
            message: `Hermes update failed on ${this.spark.name || this.spark.id}`,
          });
        }
      } catch (err) {
        if (!this._running) return;
        this._hermes = {
          ...this._hermes,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        };
        this._emit({
          type: "hermes.update.error",
          severity: "error",
          message: `Hermes update failed on ${this.spark.name || this.spark.id}`,
        });
      }
      this._notifyHermesChange();
    })();
    return { started: true };
  }

  _notifyHermesChange() {
    if (typeof this._onHermesChange !== "function") return;
    try {
      this._onHermesChange(this.spark.id);
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} hermes change error:`, err.message);
    }
  }

  // ─── Hardware summary ─────────────────────────────────────
  /**
   * Static summary used for kind "spark" (DGX Spark specs) and as the
   * pre-detection fallback for kind "host". kind "host" is then enriched
   * with real hardware from `detectHardware()` once available.
   */
  _staticHardwareSummary(spark) {
    if (spark?.kind === "host") {
      return {
        device: spark.platform === "windows" ? "Windows GPU host" : "Linux GPU host",
        cpuModel: null,
        cpuCores: null,
        totalMemoryGB: null,
        gpuChip: null,
        cudaDriver: null,
        storageModel: null,
      };
    }
    return {
      device: "NVIDIA DGX Spark",
      cpuModel: "GB10",
      cpuCores: 20,
      totalMemoryGB: 128,
      gpuChip: "GB10",
      cudaDriver: null,
      storageModel: null,
    };
  }
}
