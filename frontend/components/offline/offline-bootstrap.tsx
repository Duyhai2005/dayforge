"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  approveBuildUpdate,
  beginBuildUpdate,
  cancelPreparedBuildUpdate,
  DATABASE_VERSION,
  initializeBuildGate,
  openVaultDatabase,
  readBuildGate,
  switchBuildUpdate,
  type BuildGate,
} from "../../lib/storage/vault";
import type { UUID } from "../../lib/sync/protocol";

const BUILD_ID = process.env.NEXT_PUBLIC_DAYFORGE_BUILD_ID ?? "development";
const SCHEMA_VERSION = DATABASE_VERSION;

interface BuildManifest {
  build_id: string;
  protocol_version: 1;
  schema_version: number;
  routes: string[];
}

interface WorkerBuildInfo {
  buildId: string;
  schemaVersion: number;
}

interface BootstrapState {
  gate: BuildGate | null;
  updateBuild: WorkerBuildInfo | null;
  error: string | null;
  updateError: string | null;
  frozen: boolean;
  updateBusy: boolean;
}

interface BuildGateContextValue {
  buildId: string;
  gate: BuildGate | null;
  ready: boolean;
}

const BuildGateContext = createContext<BuildGateContextValue>({ buildId: BUILD_ID, gate: null, ready: false });

export function useBuildGate(): BuildGateContextValue {
  return useContext(BuildGateContext);
}

function parseManifestInfo(value: unknown): WorkerBuildInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.build_id !== "string" || !Number.isInteger(record.schema_version) ||
      !Array.isArray(record.routes) || !record.routes.includes("/work") || !record.routes.includes("/milestones")) return null;
  return { buildId: record.build_id, schemaVersion: record.schema_version as number };
}

function parseWorkerInfo(value: unknown): WorkerBuildInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.buildId !== "string" || !Number.isInteger(record.schemaVersion)) return null;
  return { buildId: record.buildId, schemaVersion: record.schemaVersion as number };
}

async function readServerBuild(): Promise<WorkerBuildInfo | null> {
  const response = await fetch("/dayforge-build.json", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return null;
  const value = await response.json() as unknown;
  const info = parseManifestInfo(value);
  if (!info || response.headers.get("X-Dayforge-Build") !== info.buildId ||
      (value as BuildManifest).protocol_version !== 1) return null;
  return info;
}

function askWorker(worker: ServiceWorker, message: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("The service worker did not respond in time"));
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function getWorkerBuild(worker: ServiceWorker | null): Promise<WorkerBuildInfo | null> {
  if (!worker) return null;
  try {
    return parseWorkerInfo(await askWorker(worker, { type: "DAYFORGE_GET_BUILD" }, 5_000));
  } catch {
    return null;
  }
}

function hasUnsavedFormInput(): boolean {
  for (const element of Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']"))) {
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value !== element.defaultValue) return true;
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== element.defaultValue) return true;
    } else if (element instanceof HTMLSelectElement) {
      if (Array.from(element.options).some((option) => option.selected !== option.defaultSelected)) return true;
    } else if (element.matches("[data-dayforge-dirty='true']")) return true;
  }
  return false;
}

function isGateReady(gate: BuildGate | null): boolean {
  return gate?.phase === "running" && gate.approved_build === BUILD_ID && gate.schema_version === SCHEMA_VERSION;
}

export function OfflineBootstrap({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [state, setState] = useState<BootstrapState>({ gate: null, updateBuild: null, error: null, updateError: null, frozen: false, updateBusy: false });
  const databaseRef = useRef<IDBDatabase | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const frozenEpochRef = useRef<UUID | null>(null);

  const refresh = useCallback(async () => {
    try {
      const production = process.env.NODE_ENV === "production";
      const database = await openVaultDatabase(BUILD_ID);
      databaseRef.current?.close();
      databaseRef.current = database;
      let gate = await readBuildGate(database) ?? null;
      let updateBuild: WorkerBuildInfo | null = null;
      let serverBuild: WorkerBuildInfo | null = null;
      if (production) {
        try { serverBuild = await readServerBuild(); } catch { /* Offline startup uses the durable approved build. */ }
      } else {
        serverBuild = { buildId: BUILD_ID, schemaVersion: SCHEMA_VERSION };
      }
      if (!gate) {
        if (production && (!serverBuild || serverBuild.buildId !== BUILD_ID || serverBuild.schemaVersion !== SCHEMA_VERSION)) {
          throw new Error("A matching online build manifest is required to initialize the local build gate");
        }
        gate = await initializeBuildGate(database, BUILD_ID, SCHEMA_VERSION);
      }

      if (production && "serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration("/");
        registrationRef.current = registration ?? null;
        const desiredWorker = serverBuild ?? (gate.target_build
          ? { buildId: gate.target_build, schemaVersion: gate.target_schema_version ?? gate.schema_version }
          : gate.approved_build === BUILD_ID ? { buildId: BUILD_ID, schemaVersion: SCHEMA_VERSION } : null);

        if (desiredWorker) {
          const currentWorker = registrationRef.current?.waiting ?? registrationRef.current?.active ?? null;
          const currentInfo = await getWorkerBuild(currentWorker);
          if (!currentInfo || currentInfo.buildId !== desiredWorker.buildId || currentInfo.schemaVersion !== desiredWorker.schemaVersion) {
            const url = new URL("/sw.js", window.location.origin);
            url.searchParams.set("build", desiredWorker.buildId);
            url.searchParams.set("schema", String(desiredWorker.schemaVersion));
            try {
              registrationRef.current = await navigator.serviceWorker.register(url, { scope: "/", updateViaCache: "none" });
            } catch (error) {
              if (gate.phase !== "running" || gate.approved_build !== BUILD_ID) throw error;
            }
          }
        }

        const currentRegistration = registrationRef.current;
        const candidate = currentRegistration?.waiting ?? currentRegistration?.installing ?? null;
        const info = await getWorkerBuild(candidate);
        if (info && info.buildId !== gate.approved_build) updateBuild = info;

        if (gate.phase === "switching" && gate.target_build && gate.update_epoch) {
          const activeWorker = navigator.serviceWorker.controller ?? currentRegistration?.active ?? null;
          const activeInfo = await getWorkerBuild(activeWorker);
          const waitingInfo = await getWorkerBuild(currentRegistration?.waiting ?? null);
          const updater = activeInfo?.buildId === gate.target_build ? activeWorker :
            waitingInfo?.buildId === gate.target_build ? currentRegistration?.waiting ?? null : null;
          if (updater) {
            if (activeInfo?.buildId === gate.target_build) {
              gate = await finalizeBuildSwitch(database, gate, activeInfo) ?? gate;
            } else {
              updater.postMessage({ type: "DAYFORGE_SKIP_WAITING", updateEpoch: gate.update_epoch });
            }
          } else if (currentRegistration?.installing) {
            const installing = currentRegistration.installing;
            const updateEpoch = gate.update_epoch;
            const activateWhenInstalled = () => {
              if (installing.state === "installed") {
                installing.postMessage({ type: "DAYFORGE_SKIP_WAITING", updateEpoch });
              }
            };
            installing.addEventListener("statechange", activateWhenInstalled);
            activateWhenInstalled();
          }
        }
        if (gate.phase === "running" && gate.approved_build !== BUILD_ID) {
          const activeInfo = await getWorkerBuild(navigator.serviceWorker.controller);
          if (activeInfo?.buildId === gate.approved_build && activeInfo.schemaVersion === gate.schema_version) {
            window.location.reload();
          }
        }
      }

      const frozen = gate.phase !== "running" && gate.approved_build === BUILD_ID;
      if (frozen) {
        frozenEpochRef.current = gate.update_epoch;
        window.dispatchEvent(new CustomEvent("dayforge:pause-writers", { detail: { updateEpoch: gate.update_epoch } }));
      }
      setState((current) => ({ ...current, gate, updateBuild, error: null, updateError: null, frozen, updateBusy: false }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Local build gate is unavailable", updateBusy: false }));
    }
  }, []);

  const finalizeSwitch = useCallback(async (): Promise<void> => {
    const database = databaseRef.current;
    if (!database) return;
    const gate = await readBuildGate(database);
    if (!gate || gate.phase !== "switching" || !gate.target_build || !gate.update_epoch) return;
    const active = await getWorkerBuild(navigator.serviceWorker.controller);
    if (!active || active.buildId !== gate.target_build || active.schemaVersion !== gate.target_schema_version) return;
    if (database.version !== active.schemaVersion) {
      window.location.reload();
      return;
    }
    await finalizeBuildSwitch(database, gate, active);
  }, []);

  const startUpdate = useCallback(async (): Promise<void> => {
    const database = databaseRef.current;
    const registration = registrationRef.current;
    if (!database || !registration) return;
    setState((current) => ({ ...current, updateBusy: true, error: null }));
    let preparationEpoch: UUID | null = null;
    let preparationWorker: ServiceWorker | null = null;
    try {
      let gate = await readBuildGate(database);
      if (!gate) throw new Error("The local build gate is unavailable");
      let worker = registration.waiting;
      let target = await getWorkerBuild(worker);
      if (!worker) {
        worker = registration.active;
        target = await getWorkerBuild(worker);
      }
      if (!worker || !target || target.schemaVersion < gate.schema_version) {
        throw new Error("This update cannot downgrade the local vault schema");
      }

      let preparing = gate;
      if (gate.phase === "running") {
        const started = await beginBuildUpdate(database, gate.revision, gate.approved_build, target.buildId, target.schemaVersion);
        if (!started) throw new Error("Build gate changed in another tab; retry the update");
        preparing = started;
      } else if (gate.phase !== "preparing" || gate.target_build !== target.buildId || !gate.update_epoch) {
        throw new Error("A different update is already in progress");
      }
      if (!preparing.update_epoch) throw new Error("Update epoch is missing");
      preparationEpoch = preparing.update_epoch;
      preparationWorker = worker;

      const handshake = await askWorker(worker, {
        type: "DAYFORGE_PREPARE_UPDATE",
        targetBuild: target.buildId,
        updateEpoch: preparing.update_epoch,
      });
      if (!handshake || typeof handshake !== "object" || !(handshake as { ready?: boolean }).ready) {
        const latest = await readBuildGate(database);
        if (latest?.phase === "preparing" && latest.update_epoch === preparing.update_epoch) {
          await cancelPreparedBuildUpdate(database, latest.revision, preparing.update_epoch);
        }
        worker.postMessage({ type: "DAYFORGE_CANCEL_PREPARE", updateEpoch: preparing.update_epoch });
        throw new Error("One or more tabs have unsaved input or did not respond; update was deferred");
      }

      const switching = await switchBuildUpdate(database, preparing.revision, preparing.update_epoch);
      if (!switching) {
        const latest = await readBuildGate(database);
        if (latest?.phase === "preparing" && latest.update_epoch === preparing.update_epoch) {
          await cancelPreparedBuildUpdate(database, latest.revision, preparing.update_epoch);
        }
        worker.postMessage({ type: "DAYFORGE_CANCEL_PREPARE", updateEpoch: preparing.update_epoch });
        throw new Error("Build gate changed during update preparation");
      }
      frozenEpochRef.current = switching.update_epoch;
      setState((current) => ({ ...current, gate: switching, frozen: true, updateBusy: false }));
      const activation = await askWorker(worker, { type: "DAYFORGE_SKIP_WAITING", updateEpoch: switching.update_epoch });
      if (!activation || typeof activation !== "object" || !(activation as { accepted?: boolean }).accepted) {
        throw new Error("The waiting worker rejected this build switch");
      }
      await finalizeSwitch();
      const afterHandshake = await readBuildGate(database);
      if (afterHandshake?.phase === "switching" && afterHandshake.update_epoch === switching.update_epoch) {
        const updateEpoch = switching.update_epoch;
        window.setTimeout(() => {
          void readBuildGate(database).then((latest) => {
            if (latest?.phase === "switching" && latest.update_epoch === updateEpoch) window.location.reload();
          }).catch(() => undefined);
        }, 1_000);
      }
    } catch (error) {
      if (preparationEpoch && preparationWorker) {
        const latest = database ? await readBuildGate(database).catch(() => undefined) : undefined;
        if (latest?.phase === "preparing" && latest.update_epoch === preparationEpoch) {
          await cancelPreparedBuildUpdate(database, latest.revision, preparationEpoch).catch(() => null);
          preparationWorker.postMessage({ type: "DAYFORGE_CANCEL_PREPARE", updateEpoch: preparationEpoch });
        }
      }
      await refresh();
      setState((current) => ({ ...current, updateError: error instanceof Error ? error.message : "Unable to prepare the update", updateBusy: false }));
    }
  }, [finalizeSwitch, refresh]);

  useEffect(() => {
    void refresh();
    if (process.env.NODE_ENV !== "production") return;
    const onMessage = async (event: MessageEvent) => {
      const message = event.data as { type?: string; updateEpoch?: UUID; buildId?: string; schemaVersion?: number; reason?: string } | null;
      if (!message?.type) return;
      if (message.type === "DAYFORGE_UPDATE_READY" && message.buildId && Number.isInteger(message.schemaVersion)) {
        const info = { buildId: message.buildId, schemaVersion: message.schemaVersion as number };
        setState((current) => info.buildId !== current.gate?.approved_build ? { ...current, updateBuild: info } : current);
        const database = databaseRef.current;
        if (database) {
          void readBuildGate(database).then((gate) => {
            if (gate?.phase !== "switching" || gate.target_build !== info.buildId || !gate.update_epoch) return;
            const waiting = registrationRef.current?.waiting;
            if (waiting) waiting.postMessage({ type: "DAYFORGE_SKIP_WAITING", updateEpoch: gate.update_epoch });
            else window.setTimeout(() => void refresh(), 250);
          }).catch(() => undefined);
        }
      }
      if (message.type === "DAYFORGE_INSTALL_FAILED" && typeof message.reason === "string") {
        setState((current) => ({ ...current, updateError: `Không thể chuẩn bị bản offline: ${message.reason}` }));
      }
      if (message.type === "DAYFORGE_PREPARE_CLIENT") {
        const port = event.ports[0];
        if (!port || !message.updateEpoch) return;
        let ready = false;
        try {
          const gate = databaseRef.current ? await readBuildGate(databaseRef.current) : undefined;
          ready = Boolean(gate?.phase === "preparing" && gate.update_epoch === message.updateEpoch && !hasUnsavedFormInput());
        } catch {
          ready = false;
        }
        if (ready) {
          frozenEpochRef.current = message.updateEpoch;
          setState((current) => ({ ...current, frozen: true }));
          const drainPromises: Promise<unknown>[] = [];
          window.dispatchEvent(new CustomEvent("dayforge:pause-writers", {
            detail: {
              updateEpoch: message.updateEpoch,
              waitUntil: (promise: Promise<unknown>) => drainPromises.push(Promise.resolve(promise)),
            },
          }));
          try {
            await Promise.all(drainPromises);
          } catch {
            ready = false;
          }
        }
        port.postMessage({ ready, updateEpoch: message.updateEpoch, buildId: BUILD_ID });
      }
      if (message.type === "DAYFORGE_RESUME_CLIENT" && message.updateEpoch === frozenEpochRef.current) {
        frozenEpochRef.current = null;
        setState((current) => ({ ...current, frozen: false }));
        window.dispatchEvent(new CustomEvent("dayforge:resume-writers", { detail: { updateEpoch: message.updateEpoch } }));
      }
    };
    const onControllerChange = () => { void finalizeSwitch().then(refresh).catch(() => undefined); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("pageshow", onPageShow);
      databaseRef.current?.close();
      databaseRef.current = null;
    };
  }, [finalizeSwitch, refresh]);

  const gate = state.gate;
  const compatible = isGateReady(gate);
  const preparation = gate?.phase === "preparing" && gate.approved_build === BUILD_ID;
  const switching = gate?.phase === "switching";
  const blocked = process.env.NODE_ENV === "production" && (!compatible || Boolean(state.error));

  return (
    <BuildGateContext.Provider value={{ buildId: BUILD_ID, gate, ready: compatible }}>
      <div className="offline-app" aria-busy={!gate || state.updateBusy}>
        <div className="offline-app-content" inert={blocked || state.frozen}>
          {children}
        </div>
        {state.updateBuild && state.updateBuild.buildId !== gate?.approved_build && !state.frozen && !blocked && (
          <aside className="offline-update-banner" role="status">
            <span>{state.updateError ?? `Đã tải bản cập nhật ${state.updateBuild.buildId}. Dữ liệu local cần được chuẩn bị trước khi chuyển.`}</span>
            <button type="button" disabled={state.updateBusy} onClick={() => void startUpdate()}>
              {state.updateBusy ? "Đang chuẩn bị…" : "Cập nhật"}
            </button>
          </aside>
        )}
        {blocked && (
          <div className="offline-build-gate" role="alert" aria-live="assertive">
            <p className="calendar-kicker">DAYFORGE</p>
            <h1>{state.error ? "Không thể mở kho local" : "Đang chờ build được duyệt"}</h1>
            <p>
              {preparation
                ? "Các tab đang dừng ghi để chuẩn bị cập nhật. Nếu có tab đang nhập liệu hoặc không phản hồi, bản cập nhật sẽ được hoãn."
                : switching
                  ? "Đang hoàn tất chuyển build. Kho local vẫn bị khóa ghi cho tới khi worker và metadata cùng phiên bản."
                  : state.error ?? "Build hiện tại chưa được cho phép mở dữ liệu local. Kết nối mạng và hoàn tất cập nhật trước."}
            </p>
            {state.updateBuild && state.updateBuild.buildId !== gate?.approved_build && !state.frozen && (
              <button type="button" disabled={state.updateBusy} onClick={() => void startUpdate()}>
                {state.updateBusy ? "Đang chuẩn bị…" : "Chuẩn bị bản cập nhật"}
              </button>
            )}
          </div>
        )}
        {state.frozen && !blocked && (
          <div className="offline-update-freeze" role="status" aria-live="polite">
            Đang tạm dừng ghi local để chuyển build an toàn.
          </div>
        )}
      </div>
    </BuildGateContext.Provider>
  );
}

async function finalizeBuildSwitch(database: IDBDatabase, initial: BuildGate, active: WorkerBuildInfo): Promise<BuildGate | null> {
  if (initial.phase !== "switching" || !initial.target_build || !initial.update_epoch ||
      active.buildId !== initial.target_build || active.schemaVersion !== initial.target_schema_version ||
      database.version !== active.schemaVersion || initial.schema_version !== database.version) return null;
  const approved = await approveBuildUpdate(database, initial.revision, initial.update_epoch);
  const current = approved ?? await readBuildGate(database);
  if (current?.phase === "running" && current.approved_build === active.buildId) {
    window.location.reload();
    return current;
  }
  return null;
}
