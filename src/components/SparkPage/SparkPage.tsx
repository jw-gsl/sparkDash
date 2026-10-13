import { useState, useEffect, useCallback, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { updateSpark, refreshSparkMetric, addLlmPort, removeLlmPort } from "../../api/client";
import { SparkHeader } from "./SparkHeader";
import { HealthList } from "../ui/HealthFindings";
import { SparkActions } from "./SparkActions";
import { GpuPanel } from "./GpuPanel";
import { CpuPanel } from "./CpuPanel";
import { RamPanel } from "./RamPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { TailscalePanel } from "./TailscalePanel";
import { SparkLayout, type LayoutBlock } from "./SparkLayout";
import { LlmPanel } from "./LlmPanel";
import { ComfyPanel } from "./ComfyPanel";
import { LlmModelsPanel } from "./LlmModelsPanel";
import { RocePanel } from "./RocePanel";
import { UnifiedMemoryPanel } from "./UnifiedMemoryPanel";
import "../../styles/spark.css";
import { vramContextFor } from "../../shared/vramBreakdown";

interface SparkPageProps {
  spark: SparkSnapshot;
  /** Every unit's snapshot — lets a worker find its head's LLM endpoint. */
  fleet?: SparkSnapshot[];
  temperatureUnit: "celsius" | "fahrenheit";
  /** Show "Copy image" in the benchmark dialogs (Settings, off by default). */
  benchShareImage?: boolean;
  /** GPU panel VRAM bar split by engine / system / free (Settings, on by default). */
  showVramBreakdown?: boolean;
  onEdit?: () => void;
}

type SparkView = "all" | "resources" | "services";

export function SparkPage({
  spark,
  fleet,
  temperatureUnit,
  benchShareImage = false,
  showVramBreakdown = true,
  onEdit,
}: SparkPageProps) {
  const { metrics } = spark;
  const [disabledDevices, setDisabledDevices] = useState<string[]>(spark.disabledDevices || []);
  const [disabledInterfaces, setDisabledInterfaces] = useState<string[]>(
    spark.disabledInterfaces || []
  );
  const [llmPorts, setLlmPorts] = useState<number[]>(spark.llmPorts ?? [spark.llmPort ?? 8888]);
  const [storagePollDisabled, setStoragePollDisabled] = useState<boolean>(
    spark.storagePollDisabled ?? false
  );
  const [showAddPort, setShowAddPort] = useState(false);
  const [newPortDraft, setNewPortDraft] = useState("");
  // Sync when spark data changes (WS push)
  useEffect(() => {
    setDisabledDevices(spark.disabledDevices || []);
  }, [spark.disabledDevices]);

  useEffect(() => {
    setDisabledInterfaces(spark.disabledInterfaces || []);
  }, [spark.disabledInterfaces]);

  useEffect(() => {
    if (spark.llmPorts) setLlmPorts(spark.llmPorts);
  }, [spark.llmPorts]);

  useEffect(() => {
    setStoragePollDisabled(spark.storagePollDisabled ?? false);
  }, [spark.storagePollDisabled]);

  const handleStoragePollModeChange = useCallback(
    async (disabled: boolean) => {
      setStoragePollDisabled(disabled);
      try {
        await updateSpark(spark.id, { storagePollDisabled: disabled });
        // When disabling auto-refresh, do one manual refresh immediately
        if (disabled) {
          refreshSparkMetric(spark.id, "storage").catch((err) =>
            console.error("Failed to refresh storage after disabling auto-refresh:", err)
          );
        }
      } catch (err) {
        console.error("Failed to update storage poll mode:", err);
        setStoragePollDisabled(!disabled); // revert
      }
    },
    [spark.id]
  );

  const handleAddPort = useCallback(
    async (portOverride?: number) => {
      const port = portOverride ?? parseInt(newPortDraft, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      if (llmPorts.includes(port)) {
        setNewPortDraft("");
        setShowAddPort(false);
        return;
      }
      try {
        const result = await addLlmPort(spark.id, port);
        setLlmPorts(result.llmPorts);
        setNewPortDraft("");
        setShowAddPort(false);
      } catch (err) {
        console.error("Failed to add LLM port:", err);
      }
    },
    [spark.id, newPortDraft, llmPorts]
  );

  const handleRemovePort = useCallback(async (port: number) => {
    try {
      const result = await removeLlmPort(spark.id, port);
      setLlmPorts(result.llmPorts);
    } catch (err) {
      console.error("Failed to remove LLM port:", err);
    }
  }, [spark.id]);

  const llmOn = isLlmMonitoringEnabled(spark);
  const comfyOn = Boolean(spark.comfyMonitoring);
  const tailscaleOn = Boolean(spark.tailscaleMonitoring);
  const showServices = llmOn || comfyOn;
  // Everything on one page: hardware and services together (no sub-tabs).
  const view: SparkView = showServices ? "all" : "resources";
  const showSvc = showServices && view !== "resources";
  // Models you start/stop with your own start.sh / stop.sh. Shown on every Spark and in every tab,
  // so it is always easy to find (a worker may have its own scripts too).
  const modelsPanel = <LlmModelsPanel spark={spark} />;
  const primaryPort = llmPorts[0];
  const extraPorts = llmPorts.slice(1);
  const unified = metrics.unifiedMemory;
  const showUnified = spark.kind !== "host" && unified != null && unified.total > 0;

  const renderLlmPanel = (port: number, portIndex: number, className?: string) => {
    // Match by the snapshot's own port so a panel never shows another port's
    // backend (stale-array window after adding/switching ports); fall back to
    // position for servers that don't yet report `port`.
    const llmMetrics =
      metrics.llm?.find((l) => l?.port != null && l.port === port) ??
      (metrics.llm?.[portIndex]?.port == null ? (metrics.llm?.[portIndex] ?? null) : null);
    const canRemove = portIndex > 0;
    return (
      <LlmPanel
        key={port}
        llm={llmMetrics}
        sparkId={spark.id}
        sparkName={spark.name}
        llmPort={port}
        llmPorts={llmPorts}
        hasApiKey={Boolean(spark.llmApiKeyPorts?.includes(port))}
        shareImage={benchShareImage}
        onRemovePort={canRemove ? handleRemovePort : undefined}
        className={className}
      />
    );
  };

  const addPort = llmOn ? (
    showAddPort ? (
      <div className="panel sp-add-port">
        <input
          type="number"
          min={1}
          max={65535}
          inputMode="numeric"
          placeholder="Port number"
          value={newPortDraft}
          onChange={(e) => setNewPortDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAddPort();
            }
          }}
          className="sp-input sp-input--port"
          autoFocus
        />
        <button
          type="button"
          onClick={() => void handleAddPort()}
          disabled={!newPortDraft.trim()}
          className="btn btn--sm btn--primary"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAddPort(false);
            setNewPortDraft("");
          }}
          className="btn btn--sm"
        >
          Cancel
        </button>
        <div className="sp-add-port__presets" role="group" aria-label="Server presets">
          <span className="sp-hint">Presets:</span>
          <button
            type="button"
            title="LM Studio default port"
            onClick={() => void handleAddPort(1234)}
            className="btn btn--sm"
          >
            LM Studio :1234
          </button>
          <button
            type="button"
            title="Ollama default port"
            onClick={() => void handleAddPort(11434)}
            className="btn btn--sm"
          >
            Ollama :11434
          </button>
          <button
            type="button"
            title="TensorFold default port"
            onClick={() => void handleAddPort(8888)}
            className="btn btn--sm"
          >
            TensorFold :8888
          </button>
        </div>
      </div>
    ) : (
      <button type="button" onClick={() => setShowAddPort(true)} className="sp-add-port-btn">
        + Add LLM port
      </button>
    )
  ) : null;

  const comfyPanel = comfyOn ? (
    <ComfyPanel
      comfy={metrics.comfy ?? null}
      comfyPort={spark.comfyPort ?? 8188}
      sparkId={spark.id}
      lanIp={spark.lanIp}
    />
  ) : null;

  // Every block is draggable; `col` + array order is the default arrangement. Narrow screens
  // stack everything in `mobileOrder` (GPU, memory, LLM first) until the user reorders.
  const blocks: LayoutBlock[] = [];
  const add = (id: string, col: LayoutBlock["col"], size: LayoutBlock["size"], mobileOrder: number, node: ReactNode) =>
    blocks.push({ id, col, size, mobileOrder, node });
  add(
    "gpu",
    "left",
    "wide",
    1,
    <GpuPanel
      gpu={metrics.gpu}
      vramContext={showVramBreakdown ? vramContextFor(spark, fleet) : null}
      sparkId={spark.id}
      temperatureUnit={temperatureUnit}
      chip={spark.hardware.gpuChip}
      hideMemory={showUnified}
    />
  );
  if (showUnified) add("memory", "left", "small", 2, <UnifiedMemoryPanel um={unified} gpu={metrics.gpu} llm={metrics.llm} />);
  add(
    "cpu",
    "left",
    "small",
    2,
    <CpuPanel cpu={metrics.cpu} hardware={spark.hardware} sparkId={spark.id} temperatureUnit={temperatureUnit} />
  );
  // Dedicated hosts have system RAM instead of a unified pool.
  if (spark.kind === "host") add("ram", "left", "small", 2, <RamPanel ram={metrics.ram} sparkId={spark.id} />);
  // Windows PCs have no launchers, so no Models block.
  if (spark.platform !== "windows") add("models", "left", "small", 2, modelsPanel);
  if (view === "all" && showSvc && llmOn && primaryPort != null) add(`llm:${primaryPort}`, "right", "wide", 3, renderLlmPanel(primaryPort, 0));
  if (view === "all" && showSvc && comfyPanel) add("comfy", "right", "wide", 4, comfyPanel);
  if (view === "all" && showSvc && llmOn) {
    extraPorts.forEach((port, j) => add(`llm:${port}`, "right", "wide", 10 + j, renderLlmPanel(port, j + 1)));
  }
  add(
    "storage",
    "right",
    "wide",
    7,
    <StoragePanel
      storage={metrics.storage}
      sparkId={spark.id}
      disabledDevices={disabledDevices}
      onDisabledChange={setDisabledDevices}
      storagePollDisabled={storagePollDisabled}
      onStoragePollModeChange={handleStoragePollModeChange}
    />
  );
  add(
    "network",
    "right",
    "wide",
    8,
    <NetworkPanel
      network={metrics.network}
      sparkId={spark.id}
      disabledInterfaces={disabledInterfaces}
      onDisabledChange={setDisabledInterfaces}
    />
  );
  if (metrics.roce && metrics.roce.devices.length > 0) add("roce", "right", "wide", 8, <RocePanel roce={metrics.roce} />);
  if (tailscaleOn) add("tailscale", "right", "wide", 9, <TailscalePanel tailscale={metrics.tailscale ?? null} />);

  return (
    <div className="sp">
      <SparkHeader spark={spark} onEdit={onEdit} />
      {/* Mobile-only action row (Update Hermes / Edit / Power) — desktop keeps them in the header. */}
      <SparkActions spark={spark} onEdit={onEdit} className="sp-mobile-actions flex sm:hidden" />
      {spark.online ? <HealthList findings={spark.health} /> : null}

      <SparkLayout blocks={blocks} rightFooter={view === "all" && showSvc ? addPort : null} />
    </div>
  );
}
