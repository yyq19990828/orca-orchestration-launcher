import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  BookDown,
  ChevronRight,
  Crosshair,
  Ellipsis,
  ExternalLink,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  X,
} from "lucide-react";
import {
  acknowledgeStopEvent,
  decideWorkerPermission,
  fetchActivity,
  fetchDag,
  fetchResumePreview,
  fetchRunStatus,
  fetchWorkers,
  focusWorker,
  openFullTab,
  replyToMessage,
  resolveGate,
  resumeWorkerSession,
  retryWorker,
  stopWorker,
} from "../api";
import {
  installPluginSkill,
  isOrcaPluginFrame,
  openActivityStream,
  reconnectPluginViewer,
} from "../bridge/orcaBridge";
import {
  effectiveHarness,
  initConfig,
  setRunId as persistRunId,
  useConfig,
  useReadiness,
} from "../harness";
import { useT } from "../i18n";
import { useColorScheme } from "../theme";
import type {
  ActivityEvent,
  ActivitySnapshot,
  DagNode,
  DagResponse,
  NativeResumePreviewView,
  NativeResumeResultView,
  RunStatus,
  TaskStatus,
  WorkerRowView,
} from "../types";
import { useRunHealth } from "../useRunHealth";
import { usePageVisible } from "../visibility";
import { ChatPanel } from "./ChatPanel";
import { useDecisionDialog } from "./DecisionDialog";
import { EmptyRunState } from "./EmptyRunState";
import { ExecControls } from "./ExecControls";
import { HarnessAvatar } from "./HarnessAvatar";
import { NodeSessionPanel } from "./NodeSessionPanel";
import { RunHealthBadge } from "./RunHealthBadge";
import { RunPicker, type RunListReadState } from "./RunPicker";
import { StatusGlyph, isGatePending, statusTokenVars } from "./statusUi";
import { useCoordinatorControl } from "./useCoordinatorControl";
import { WorkerOutputDockView } from "./WorkerOutputDockView";
import "./sidebar-app.css";

type SidebarTab = "tasks" | "inbox" | "activity";
type DetailTab = "messages" | "session" | "output";
type TaskFilter = "all" | "dispatched" | "blocked" | "failed" | "completed";
type StreamState = "connecting" | "live" | "error";

const PRIMARY_TABS: readonly SidebarTab[] = ["tasks", "inbox", "activity"];
const DETAIL_TABS: readonly DetailTab[] = ["messages", "session", "output"];
const POLL_ACTIVE_MS = 2_500;
const POLL_IDLE_MS = 10_000;

function isWorkerSucceeded(w: WorkerRowView): boolean {
  return w.dispatchStatus === "completed" || w.workerState === "succeeded";
}

function isWorkerExitedUnfinished(w: WorkerRowView): boolean {
  return w.projection?.liveness?.verdict === "exited" && !isWorkerSucceeded(w);
}

function isFocusableLocalWorker(w: WorkerRowView): boolean {
  return (
    w.projection?.liveness?.verdict === "live" &&
    w.projection?.host?.kind === "local" &&
    Boolean(w.agentTerminalHandle) &&
    !w.agentTerminalHandle?.startsWith("orca_session_id:") &&
    !w.agentTerminalHandle?.startsWith("chat:")
  );
}

/**
 * Pick the single active actionable failed/stopped Dispatch for a Task, or null
 * if the Task is already completed or has a live/succeeded replacement Dispatch.
 * Prevents historical pre-retry/pre-resume attempts from lingering in Pending
 * or offering Resume on an already-finished Task.
 */
function pickActionableFailedWorker(
  task: DagNode | undefined,
  taskWorkers: readonly WorkerRowView[],
): WorkerRowView | null {
  if (task?.status === "completed") return null;
  if (
    taskWorkers.some(
      (w) => isWorkerSucceeded(w) || w.projection?.liveness?.verdict === "live",
    )
  ) {
    return null;
  }
  const exited = taskWorkers.filter(isWorkerExitedUnfinished);
  if (exited.length === 0) return null;
  if (task?.dispatchId) {
    const current = exited.find((w) => w.dispatchId === task.dispatchId);
    if (current) return current;
  }
  return exited.reduce((best, cur) => {
    const bestTs = Date.parse(best.projection?.evidence?.lastObservedAt ?? "") || 0;
    const curTs = Date.parse(cur.projection?.evidence?.lastObservedAt ?? "") || 0;
    return curTs >= bestTs ? cur : best;
  });
}

function formatShortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function handleTablistKeyDown<T extends string>(
  event: ReactKeyboardEvent<HTMLDivElement>,
  tabs: readonly T[],
  current: T,
  onSelect: (next: T) => void,
): void {
  const idx = tabs.indexOf(current);
  if (idx < 0) return;
  let nextIdx: number | null = null;
  if (event.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIdx = 0;
  else if (event.key === "End") nextIdx = tabs.length - 1;
  if (nextIdx === null) return;
  event.preventDefault();
  const next = tabs[nextIdx];
  onSelect(next);
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons[nextIdx]?.focus();
}

function positionMenuFallback(menu: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const pad = 8;
  const maxLeft = Math.max(pad, window.innerWidth - menuRect.width - pad);
  const left = Math.min(maxLeft, Math.max(pad, rect.right - menuRect.width));
  const fitsBelow = rect.bottom + 4 + menuRect.height <= window.innerHeight - pad;
  const top = fitsBelow
    ? rect.bottom + 4
    : Math.max(pad, rect.top - menuRect.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

interface OverflowMenuProps {
  inPlugin: boolean;
  refreshing: boolean;
  reconnecting: boolean;
  installingSkill: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onInstallSkill: () => void;
  onOpenSettings: () => void;
}

/**
 * Accessible overflow menu using native Popover + Command Invoker + Focusgroup
 * (with feature-detected fallbacks for non-invoker / non-focusgroup / non-anchor engines).
 */
function SidebarOverflowMenu({
  inPlugin,
  refreshing,
  reconnecting,
  installingSkill,
  onRefresh,
  onReconnect,
  onInstallSkill,
  onOpenSettings,
}: OverflowMenuProps) {
  const t = useT();
  const idPrefix = useId();
  const triggerId = `${idPrefix}-more-trigger`;
  const menuId = `${idPrefix}-more-menu`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const enterOnOpenRef = useRef(false);
  const pointerPressedRef = useRef(false);
  const [expanded, setExpanded] = useState(false);

  const getEnabledItems = useCallback((): HTMLButtonElement[] => {
    const group = groupRef.current;
    if (!group) return [];
    return [...group.querySelectorAll<HTMLButtonElement>("button")].filter(
      (btn) => !btn.disabled && btn.getAttribute("aria-disabled") !== "true",
    );
  }, []);

  const closeAndRestore = useCallback((fromPointer: boolean) => {
    const pop = popoverRef.current;
    const trigger = triggerRef.current;
    if (trigger) {
      try {
        trigger.focus({ focusVisible: !fromPointer } as FocusOptions);
      } catch {
        trigger.focus();
      }
    }
    if (pop && pop.matches(":popover-open")) {
      pop.hidePopover?.();
    }
  }, []);

  // Install focusgroup ARIA + arrow-key fallback only when native focusgroup is absent.
  useEffect(() => {
    const group = groupRef.current;
    if (!group || "focusGroup" in HTMLElement.prototype) return;
    group.setAttribute("role", "menu");
    group.querySelectorAll("button:not([role])").forEach((item) => {
      item.setAttribute("role", "menuitem");
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = getEnabledItems();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : current < 0
              ? 0
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      items[next]?.focus({ preventScroll: true });
    };
    group.addEventListener("keydown", onKeyDown, true);
    return () => group.removeEventListener("keydown", onKeyDown, true);
  }, [getEnabledItems, inPlugin]);

  // Sync aria-expanded, keyboard-open focus entry, and non-anchor positioning on toggle.
  useEffect(() => {
    const pop = popoverRef.current;
    if (!pop) return;
    const onToggle = (evt: Event) => {
      const open = (evt as ToggleEvent).newState === "open";
      setExpanded(open);
      if (!open) {
        enterOnOpenRef.current = false;
        pointerPressedRef.current = false;
        return;
      }
      if (!CSS.supports("position-area", "block-end") && triggerRef.current) {
        positionMenuFallback(pop, triggerRef.current);
      }
      const shouldEnter = enterOnOpenRef.current || !pointerPressedRef.current;
      enterOnOpenRef.current = false;
      pointerPressedRef.current = false;
      if (shouldEnter) {
        getEnabledItems()[0]?.focus({ preventScroll: true });
      } else if (triggerRef.current) {
        try {
          triggerRef.current.focus({ focusVisible: false } as FocusOptions);
        } catch {
          triggerRef.current.focus();
        }
      }
    };
    pop.addEventListener("toggle", onToggle);
    return () => pop.removeEventListener("toggle", onToggle);
  }, [getEnabledItems]);

  // Close menu if focus moves outside the trigger/menu system (e.g., Tab).
  useEffect(() => {
    if (!expanded) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      popoverRef.current?.hidePopover?.();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [expanded]);

  const handleTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if ("commandForElement" in HTMLButtonElement.prototype) return;
    event.preventDefault();
    const pop = popoverRef.current;
    const trigger = triggerRef.current;
    if (!pop || !trigger) return;
    if (pop.matches(":popover-open")) {
      closeAndRestore(pointerPressedRef.current);
    } else {
      enterOnOpenRef.current = event.detail === 0;
      (pop as HTMLElement & { showPopover: (opts?: { source?: HTMLElement }) => void }).showPopover({
        source: trigger,
      });
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    const pop = popoverRef.current;
    if (!pop) return;
    if (pop.matches(":popover-open")) {
      getEnabledItems()[0]?.focus({ preventScroll: true });
    } else {
      enterOnOpenRef.current = true;
      pointerPressedRef.current = false;
      triggerRef.current?.click();
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestore(false);
    } else if (event.key === "Tab") {
      popoverRef.current?.hidePopover?.();
    } else if (event.key === "Home" || event.key === "End") {
      const items = getEnabledItems();
      if (items.length === 0) return;
      event.preventDefault();
      (event.key === "Home" ? items[0] : items[items.length - 1])?.focus({ preventScroll: true });
    }
  };

  const runItem = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    closeAndRestore(event.detail !== 0);
    action();
  };

  return (
    <>
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        className="odag-sb__icon-btn"
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-label={t("sb.moreMenuAria")}
        title={t("sb.moreMenuAria")}
        {...({ commandfor: menuId, command: "toggle-popover" } as Record<string, string>)}
        onPointerDown={(e) => {
          e.preventDefault();
          pointerPressedRef.current = true;
        }}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      <div
        id={menuId}
        ref={popoverRef}
        className="odag-sb__menu-pop"
        {...({ popover: "auto" } as Record<string, string>)}
        onKeyDown={handleMenuKeyDown}
      >
        <div
          ref={groupRef}
          className="odag-sb__menu"
          aria-labelledby={triggerId}
          {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
        >
          <button
            type="button"
            disabled={refreshing}
            onClick={(e) => runItem(e, onRefresh)}
          >
            <RefreshCw size={13} className={refreshing ? "odag-sb__spin" : undefined} aria-hidden="true" />
            <span>{t("sb.refresh")}</span>
          </button>
          {inPlugin && (
            <button
              type="button"
              disabled={reconnecting}
              onClick={(e) => runItem(e, onReconnect)}
            >
              <PlugZap size={13} aria-hidden="true" />
              <span>{reconnecting ? t("sb.reconnecting") : t("sb.reconnect")}</span>
            </button>
          )}
          <hr />
          {inPlugin && (
            <button
              type="button"
              disabled={installingSkill}
              onClick={(e) => runItem(e, onInstallSkill)}
            >
              <BookDown size={13} aria-hidden="true" />
              <span>{t("sb.skill.title")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={(e) => runItem(e, onOpenSettings)}
          >
            <Settings size={13} aria-hidden="true" />
            <span>{t("sb.openSettings")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Streamlined companion UI designed for Orca's narrow right-sidebar panel
 * (320-450px). Provides a single-column segmented Run progress strip, 3 flat
 * tabs (Tasks / Pending / Live), a drill-in single-task inspector (Messages /
 * Session / Output + Focus / Stop / Retry / native Resume), a compact overflow
 * menu, and a docked status bar footer.
 */
export default function SidebarApp() {
  const t = useT();
  const scheme = useColorScheme();
  const config = useConfig();
  const readiness = useReadiness();
  const visible = usePageVisible();
  const dialog = useDecisionDialog();
  const withControl = useCoordinatorControl();
  const idPrefix = useId();
  const inPlugin = isOrcaPluginFrame();

  const [hydrated, setHydrated] = useState(false);
  const [runListRead, setRunListRead] = useState<RunListReadState>({ loaded: false, error: null });
  const runId = config.runId ?? "";
  const [dag, setDag] = useState<DagResponse | null>(null);
  const [workers, setWorkers] = useState<WorkerRowView[]>([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [startingRunId, setStartingRunId] = useState<string | null>(null);
  const { health: runHealth, refresh: refreshRunHealth } = useRunHealth(runId);
  const [tab, setTab] = useState<SidebarTab>("tasks");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("messages");
  const [selectedOutputDispatchId, setSelectedOutputDispatchId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [resumePreview, setResumePreview] = useState<NativeResumePreviewView | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumePickedSession, setResumePickedSession] = useState("");
  const [resumeReceipt, setResumeReceipt] = useState<NativeResumeResultView | null>(null);
  const [execActionHost, setExecActionHost] = useState<HTMLDivElement | null>(null);

  const pollGen = useRef(0);
  const refreshInFlightRef = useRef(false);
  const pollIntervalRef = useRef(POLL_ACTIVE_MS);

  // Apply light/dark attribute cleanly so scrollbar and status tokens stay synced.
  useEffect(() => {
    document.documentElement.dataset.theme = scheme.rendered;
  }, [scheme.rendered]);

  // Hydrate shared workspace config once on mount.
  useEffect(() => {
    let alive = true;
    void initConfig()
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const pickRun = useCallback((next: string) => {
    setSelectedTaskId(null);
    setSelectedOutputDispatchId(null);
    setActionError(null);
    setWorkersError(null);
    setResumePreview(null);
    setResumeReceipt(null);
    persistRunId(next);
  }, []);

  // Poll DAG, workers, and process-local coordinator status without overlapping
  // in-flight requests so slow CLI reads never stack up concurrent subprocesses.
  const refreshAll = useCallback(async (opts?: { force?: boolean }) => {
    if (refreshInFlightRef.current && !opts?.force) return;
    refreshInFlightRef.current = true;
    const gen = ++pollGen.current;
    try {
      try {
        const nextStatus = await fetchRunStatus().catch(() => null);
        if (gen !== pollGen.current) return;
        if (nextStatus) setStatus(nextStatus);
      } catch {
        // Ignore transient status fetch failure.
      }
      if (!runId) {
        setDag(null);
        setWorkers([]);
        setActivity(null);
        setWorkersError(null);
        return;
      }
      try {
        const [nextDag, nextWorkers] = await Promise.all([
          fetchDag(runId),
          fetchWorkers(runId).catch((e) => {
            if (gen === pollGen.current) setWorkersError(String((e as Error)?.message ?? e));
            return null;
          }),
        ]);
        if (gen !== pollGen.current) return;
        setDag(nextDag);
        if (nextWorkers) {
          setWorkers(nextWorkers.workers);
          setWorkersError(null);
        }
        setWorkersLoading(false);
      } catch (e) {
        if (gen === pollGen.current) {
          setActionError(String((e as Error)?.message ?? e));
        }
      }
    } finally {
      if (gen === pollGen.current) refreshInFlightRef.current = false;
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    setWorkersLoading(true);
    void refreshAll({ force: true });
  }, [runId, refreshAll]);

  // Serial visibility-gated polling loop: schedules the next poll only after
  // the previous one settles, and backs off when the Run is idle/completed.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: number | undefined;
    const schedule = () => {
      if (!alive) return;
      timer = window.setTimeout(() => {
        if (!alive) return;
        void refreshAll().finally(schedule);
      }, pollIntervalRef.current);
    };
    schedule();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visible, refreshAll]);

  // Live Activity Stream (SSE in browser preview, worker push in Orca plugin frame).
  useEffect(() => {
    if (!runId || !visible) return;
    let cancelled = false;
    setStreamState("connecting");
    void fetchActivity(runId)
      .then((snap) => {
        if (!cancelled) setActivity(snap);
      })
      .catch(() => {});
    const close = openActivityStream(runId, {
      onOpen: () => {
        if (!cancelled) setStreamState("live");
      },
      onSnapshot: (snapshot) => {
        if (!cancelled) {
          setActivity(snapshot);
          setStreamState("live");
        }
      },
      onError: () => {
        if (!cancelled) setStreamState("error");
      },
    });
    return () => {
      cancelled = true;
      close();
    };
  }, [runId, visible]);

  const nodes = useMemo(() => dag?.nodes ?? [], [dag]);
  const edges = useMemo(() => dag?.edges ?? [], [dag]);
  const gates = useMemo(() => dag?.gates ?? [], [dag]);

  const labelsById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const n of nodes) map[n.id] = n.label || n.id;
    return map;
  }, [nodes]);

  const taskIds = useMemo(() => nodes.map((n) => n.id), [nodes]);

  const counts = useMemo(() => {
    let running = 0;
    let blocked = 0;
    let failed = 0;
    let done = 0;
    let ready = 0;
    for (const n of nodes) {
      if (n.status === "dispatched") running++;
      else if (n.status === "blocked") blocked++;
      else if (n.status === "failed") failed++;
      else if (n.status === "completed") done++;
      else if (n.status === "ready") ready++;
    }
    return { total: nodes.length, running, blocked, failed, done, ready };
  }, [nodes]);

  const nodeById = useMemo(() => {
    const map = new Map<string, DagNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  const workersByTask = useMemo(() => {
    const map = new Map<string, WorkerRowView[]>();
    for (const w of workers) {
      const list = map.get(w.taskId) ?? [];
      list.push(w);
      map.set(w.taskId, list);
    }
    return map;
  }, [workers]);

  // O(M) single pass for latest task activity summary instead of copying+reversing per card.
  const latestSummaryByTask = useMemo(() => {
    const map = new Map<string, string>();
    const events = activity?.events;
    if (!events) return map;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.taskId && ev.summary && !map.has(ev.taskId)) {
        map.set(ev.taskId, ev.summary);
      }
    }
    return map;
  }, [activity]);

  const pendingGates = useMemo(() => gates.filter((g) => isGatePending(g)), [gates]);
  const pendingInbox = useMemo(() => {
    if (status?.runId !== runId) return [];
    return status.inbox.pending.filter((item) => {
      if (!item.taskId) return true;
      const task = nodeById.get(item.taskId);
      // Historical stop_event notifications from pre-retry attempts are superseded once the Task completes.
      if (task?.status === "completed" && item.kind === "stop_event") return false;
      return true;
    });
  }, [status, runId, nodeById]);
  const failedWorkers = useMemo(() => {
    const actionable: WorkerRowView[] = [];
    for (const [taskId, taskWorkers] of workersByTask) {
      const picked = pickActionableFailedWorker(nodeById.get(taskId), taskWorkers);
      if (picked) actionable.push(picked);
    }
    return actionable;
  }, [workersByTask, nodeById]);
  const pendingCount = pendingGates.length + pendingInbox.length + failedWorkers.length;

  // Back off polling interval when the Run is completely idle/settled.
  const isRunActive = Boolean(
    (status?.running && status.runId === runId) ||
    counts.running > 0 ||
    counts.ready > 0 ||
    pendingCount > 0 ||
    startingRunId === runId,
  );
  pollIntervalRef.current = isRunActive ? POLL_ACTIVE_MS : POLL_IDLE_MS;

  const filteredNodes = useMemo(() => {
    if (filter === "all") return nodes;
    return nodes.filter((n) => n.status === filter);
  }, [nodes, filter]);

  const selectedTask: DagNode | null = useMemo(
    () => (selectedTaskId ? nodeById.get(selectedTaskId) ?? null : null),
    [nodeById, selectedTaskId],
  );

  const selectedTaskWorkers = useMemo(
    () => (selectedTask ? workersByTask.get(selectedTask.id) ?? [] : []),
    [selectedTask, workersByTask],
  );

  const liveSelectedWorker = useMemo(
    () => selectedTaskWorkers.find(isFocusableLocalWorker) ?? null,
    [selectedTaskWorkers],
  );

  const stoppableSelectedWorker = useMemo(
    () =>
      selectedTaskWorkers.find(
        (w) =>
          w.projection?.liveness?.verdict === "live" &&
          w.supervision === "supervised" &&
          !w.projection?.parent,
      ) ?? null,
    [selectedTaskWorkers],
  );

  const resumableWorker = useMemo(
    () => (selectedTask ? pickActionableFailedWorker(selectedTask, selectedTaskWorkers) : null),
    [selectedTask, selectedTaskWorkers],
  );

  // Reset transient resume UI only when switching to a different task — never on 2.5s polls.
  useEffect(() => {
    setResumePreview(null);
    setResumePickedSession("");
    setResumeReceipt(null);
    setSelectedOutputDispatchId(null);
  }, [selectedTaskId]);

  // Fill a default output dispatch when entering a task or when the previous selection disappears,
  // preserving the operator's chosen historical attempt across periodic polls.
  useEffect(() => {
    if (!selectedTaskId) return;
    setSelectedOutputDispatchId((current) => {
      if (current && selectedTaskWorkers.some((w) => w.dispatchId === current)) {
        return current;
      }
      if (selectedTaskWorkers.length === 0) return null;
      return (
        (selectedTask?.dispatchId &&
          selectedTaskWorkers.find((w) => w.dispatchId === selectedTask.dispatchId)?.dispatchId) ||
        selectedTaskWorkers[selectedTaskWorkers.length - 1]?.dispatchId ||
        null
      );
    });
  }, [selectedTaskId, selectedTask?.dispatchId, selectedTaskWorkers]);

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    setActionError(null);
    try {
      await Promise.all([refreshAll({ force: true }), refreshRunHealth()]);
    } finally {
      setManualRefreshing(false);
    }
  }, [refreshAll, refreshRunHealth]);

  const handleReconnect = useCallback(async () => {
    if (!inPlugin) return;
    setReconnecting(true);
    setActionError(null);
    try {
      const ok = await reconnectPluginViewer();
      if (!ok) {
        setActionError(t("sb.reconnectFailed"));
      } else {
        await Promise.all([refreshAll({ force: true }), refreshRunHealth()]);
      }
    } catch (e) {
      setActionError(String((e as Error)?.message ?? e));
    } finally {
      setReconnecting(false);
    }
  }, [inPlugin, refreshAll, refreshRunHealth, t]);

  const handleInstallSkill = useCallback(async () => {
    const title = t("sb.skill.title");
    const confirmed = await dialog.confirm({
      title,
      message: t("sb.skill.confirm"),
      confirmLabel: t("sb.skill.apply"),
    });
    if (!confirmed) return;

    setInstallingSkill(true);
    try {
      const receipt = await installPluginSkill().catch(() => null);
      await dialog.alert({
        title,
        message: receipt
          ? (receipt.installed || receipt.upToDate ? t("sb.skill.result", receipt) : t("sb.skill.noTargets"))
          : t("sb.skill.failed"),
      });
    } finally {
      setInstallingSkill(false);
    }
  }, [dialog, t]);

  const handleOpenTab = useCallback(async (hash?: string) => {
    setActionError(null);
    try {
      await openFullTab(hash);
    } catch (e) {
      setActionError(String((e as Error)?.message ?? e));
    }
  }, []);

  const openTaskDetail = useCallback((taskId: string, initialTab: DetailTab = "messages") => {
    setSelectedTaskId(taskId);
    setDetailTab(initialTab);
    setActionError(null);
  }, []);

  const handleFocusTerminal = useCallback(
    async (dispatchId: string) => {
      if (!runId) return;
      setBusyKey(`focus:${dispatchId}`);
      setActionError(null);
      try {
        await focusWorker(dispatchId, runId);
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [runId],
  );

  const handleStopWorker = useCallback(
    async (worker: WorkerRowView) => {
      if (!runId) return;
      const why = worker.projection?.stage?.detail ?? worker.workerState ?? worker.dispatchStatus;
      const confirmed = await dialog.confirm({
        title: t("worker.stopDialogTitle"),
        message: t("worker.stopMessage", { id: worker.dispatchId, why }),
        confirmLabel: t("worker.stopConfirm"),
        tone: "danger",
      });
      if (!confirmed) return;
      setBusyKey(`stop:${worker.dispatchId}`);
      setActionError(null);
      try {
        await stopWorker(worker.dispatchId, worker.runId || runId);
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [dialog, refreshAll, runId, t],
  );

  const handleRetryWorker = useCallback(
    async (task: DagNode, worker: WorkerRowView) => {
      const confirmed = await dialog.confirm({
        title: t("sb.retryConfirmTitle"),
        message: t("sb.retryConfirmMessage", {
          task: task.label || task.id,
          id: worker.dispatchId,
        }),
        confirmLabel: t("sb.retryWorker"),
      });
      if (!confirmed) return;
      setBusyKey(`retry:${worker.dispatchId}`);
      setActionError(null);
      try {
        await retryWorker(worker.dispatchId);
        setResumePreview(null);
        setResumeReceipt(null);
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [dialog, refreshAll, t],
  );

  const handleCheckResume = useCallback(
    async (dispatchId: string) => {
      if (!runId) return;
      setResumeLoading(true);
      setActionError(null);
      setResumeReceipt(null);
      setResumePickedSession("");
      try {
        const preview = await fetchResumePreview(runId, dispatchId);
        setResumePreview(preview);
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setResumeLoading(false);
      }
    },
    [runId],
  );

  const handleExecuteResume = useCallback(
    async (dispatchId: string, preview: NativeResumePreviewView) => {
      if (!runId) return;
      const sessionId = preview.sessionId ?? (resumePickedSession || null);
      if (!sessionId) return;
      const confirmed = await dialog.confirm({
        title: t("worker.resumeConfirmTitle"),
        message: t("worker.resumeConfirmMessage", {
          id: dispatchId,
          harness: preview.harness ?? t("worker.unknown"),
          session: sessionId,
        }),
        confirmLabel: t("worker.resumeConfirm"),
      });
      if (!confirmed) return;
      setBusyKey(`resume:${dispatchId}`);
      setActionError(null);
      try {
        const receipt = await withControl(runId, (coordinatorControl) =>
          resumeWorkerSession(runId, dispatchId, { sessionId, coordinatorControl }),
        );
        setResumeReceipt(receipt);
        setResumePreview(null);
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [dialog, refreshAll, resumePickedSession, runId, t, withControl],
  );

  const handleResolveGate = useCallback(
    async (gateId: string, resolution: string) => {
      if (!runId) return;
      setBusyKey(`gate:${gateId}`);
      setActionError(null);
      try {
        await withControl(runId, (coordinatorControl) =>
          resolveGate(gateId, resolution, runId, coordinatorControl),
        );
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId, withControl],
  );

  const handleReplyInbox = useCallback(
    async (messageId: string) => {
      if (!runId) return;
      const body = (replyDrafts[messageId] ?? "").trim();
      if (!body) return;
      setBusyKey(`reply:${messageId}`);
      setActionError(null);
      try {
        await withControl(runId, (coordinatorControl) =>
          replyToMessage(messageId, body, runId, coordinatorControl),
        );
        setReplyDrafts((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, replyDrafts, runId, withControl],
  );

  const handlePermissionDecision = useCallback(
    async (dispatchId: string, promptId: string, decision: "approve" | "deny") => {
      if (!runId) return;
      setBusyKey(`perm:${promptId}`);
      setActionError(null);
      try {
        const reason =
          decision === "approve"
            ? t("permission.approveDefaultReason")
            : "Denied by operator from Orchestration Panel sidebar";
        await withControl(runId, (coordinatorControl) =>
          decideWorkerPermission(runId, dispatchId, promptId, decision, reason, coordinatorControl),
        );
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId, t, withControl],
  );

  const handleAckStop = useCallback(
    async (messageId: string, dispatchId: string) => {
      if (!runId) return;
      setBusyKey(`ack:${messageId}`);
      setActionError(null);
      try {
        await acknowledgeStopEvent(runId, messageId, dispatchId);
        void refreshAll({ force: true });
      } catch (e) {
        setActionError(String((e as Error)?.message ?? e));
      } finally {
        setBusyKey(null);
      }
    },
    [refreshAll, runId],
  );

  const effectiveActivity: ActivitySnapshot = useMemo(
    () =>
      activity ?? {
        runId,
        events: [],
        presence: [],
        checks: [],
        pendingCount: 0,
        truncated: false,
        inboxWindow: null,
        generatedAt: 0,
      },
    [activity, runId],
  );

  const chatTaskSelection = useMemo(
    () => (selectedTask ? { taskId: selectedTask.id } : null),
    [selectedTask?.id],
  );

  const recentActivity: ActivityEvent[] = useMemo(() => {
    if (!activity) return [];
    return [...activity.events].reverse().slice(0, 80);
  }, [activity]);

  const taskSubtitle = (node: DagNode): string => {
    if (node.result) {
      const trimmed = node.result.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          for (const key of ["summary", "message", "detail", "reason"]) {
            if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim();
          }
          if (parsed.outcome === "succeeded") return t("report.outcome.succeeded");
          if (parsed.outcome === "failed") return t("report.outcome.failed");
        } catch {
          // Fall back to verbatim result text.
        }
      }
      return trimmed;
    }
    const taskW = workersByTask.get(node.id) ?? [];
    const live = taskW.find((w) => w.projection?.liveness?.verdict === "live");
    if (live) {
      const latestSummary = latestSummaryByTask.get(node.id);
      if (latestSummary) return latestSummary;
      return `${live.workerState || t("status.dispatched")} · ${live.dispatchId.slice(0, 12)}`;
    }
    const readInfo = dag?.readiness?.[node.id];
    if (readInfo?.reasons?.[0]) return readInfo.reasons[0];
    return t(`status.${node.status}` as Parameters<typeof t>[0]);
  };

  const progressAria = t("topbar.progressAria", { done: counts.done, total: counts.total });
  const totalForBar = Math.max(1, counts.total);
  const donePct = (counts.done / totalForBar) * 100;
  const runningPct = (counts.running / totalForBar) * 100;
  const blockedPct = (counts.blocked / totalForBar) * 100;
  const failedPct = (counts.failed / totalForBar) * 100;

  const filterChips = useMemo(() => {
    const allItems = [
      { key: "all" as const, label: t("sb.filterAll"), count: counts.total, color: null },
      { key: "dispatched" as const, label: t("sb.filterRunning"), count: counts.running, color: "var(--st-dispatched)" },
      { key: "blocked" as const, label: t("sb.filterBlocked"), count: counts.blocked, color: "var(--st-blocked)" },
      { key: "failed" as const, label: t("sb.filterFailed"), count: counts.failed, color: "var(--st-failed)" },
      { key: "completed" as const, label: t("sb.filterDone"), count: counts.done, color: "var(--st-completed)" },
    ];
    return allItems.filter((item) => item.key === "all" || item.count > 0 || filter === item.key);
  }, [counts, filter, t]);

  return (
    <div className="odag-sb">
      {/* Hidden ExecControls instance so ONLY its primary Run/Stop button portals into Row 1 */}
      <div hidden aria-hidden="true">
        <ExecControls
          runId={runId}
          labelsById={labelsById}
          taskIds={taskIds}
          edges={edges}
          readyCount={counts.ready}
          startingRunId={startingRunId}
          status={status}
          runHealth={runHealth}
          workerHistoryLoading={workersLoading}
          workerHistoryError={workersError}
          onRunStarting={(id) => setStartingRunId(id)}
          onRunStartFinished={(_id, next) => {
            setStartingRunId(null);
            if (next) setStatus(next);
            void refreshAll({ force: true });
            void refreshRunHealth();
          }}
          onRunStopped={() => {
            void refreshAll({ force: true });
            void refreshRunHealth();
          }}
          actionHost={execActionHost}
          launchHost={execActionHost}
        />
      </div>

      {/* 1. Compact Header: Run picker + Run/Stop + Tab + Overflow Menu + Segmented Progress */}
      <header className="odag-sb__header">
        <div className="odag-sb__header-row">
          <div className="odag-sb__run">
            <RunPicker
              runId={runId}
              onPick={pickRun}
              autoPick={hydrated}
              onReadStateChange={setRunListRead}
            />
          </div>
          <div
            className="odag-sb__exec-host"
            ref={setExecActionHost}
            hidden={!runId && !status?.running}
          />
          <button
            type="button"
            className="odag-sb__tab-btn"
            onClick={() =>
              void handleOpenTab(
                selectedTask
                  ? `#section=chat&task=${encodeURIComponent(selectedTask.id)}`
                  : tab === "activity"
                    ? "#section=activity"
                    : undefined,
              )
            }
            title={t("sb.openTabTitle")}
          >
            <ExternalLink size={12} aria-hidden="true" />
            <span className="odag-sb__tab-btn-label">{t("sb.openTab")}</span>
          </button>
          <SidebarOverflowMenu
            inPlugin={inPlugin}
            refreshing={manualRefreshing}
            reconnecting={reconnecting}
            installingSkill={installingSkill}
            onRefresh={() => void handleManualRefresh()}
            onReconnect={() => void handleReconnect()}
            onInstallSkill={() => void handleInstallSkill()}
            onOpenSettings={() => void handleOpenTab("#section=settings")}
          />
        </div>

        {runId && (
          <div className="odag-sb__progress-meta">
            <div
              className="odag-sb__segbar"
              role="progressbar"
              aria-label={progressAria}
              aria-valuemin={0}
              aria-valuemax={totalForBar}
              aria-valuenow={counts.done}
              title={`${t("sb.filterDone")} ${counts.done} · ${t("sb.filterRunning")} ${counts.running} · ${t("sb.filterBlocked")} ${counts.blocked} · ${t("sb.filterFailed")} ${counts.failed}`}
            >
              {donePct > 0 && (
                <span
                  className="odag-sb__seg odag-sb__seg--done"
                  style={{ inlineSize: `${donePct}%` }}
                  aria-hidden="true"
                />
              )}
              {runningPct > 0 && (
                <span
                  className="odag-sb__seg odag-sb__seg--running"
                  style={{ inlineSize: `${runningPct}%` }}
                  aria-hidden="true"
                />
              )}
              {blockedPct > 0 && (
                <span
                  className="odag-sb__seg odag-sb__seg--blocked"
                  style={{ inlineSize: `${blockedPct}%` }}
                  aria-hidden="true"
                />
              )}
              {failedPct > 0 && (
                <span
                  className="odag-sb__seg odag-sb__seg--failed"
                  style={{ inlineSize: `${failedPct}%` }}
                  aria-hidden="true"
                />
              )}
            </div>
            <span className="odag-sb__progress-count">
              {counts.done}/{counts.total}
            </span>
          </div>
        )}
      </header>

      {actionError && (
        <div className="odag-sb__alerts">
          <div className="odag-sb__error" role="alert">
            <span className="odag-sb__error-text">{actionError}</span>
            <div className="odag-sb__error-actions">
              {inPlugin && (
                <button
                  type="button"
                  className="odag-sb__error-link"
                  disabled={reconnecting}
                  onClick={() => void handleReconnect()}
                >
                  {reconnecting ? t("sb.reconnecting") : t("sb.reconnect")}
                </button>
              )}
              <button
                type="button"
                className="odag-sb__error-close"
                aria-label={t("sb.dismissError")}
                onClick={() => setActionError(null)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {workersError && !actionError && (
        <div className="odag-sb__alerts">
          <div className="odag-sb__warn" role="status">
            <span className="odag-sb__error-text">
              {t("sb.workersReadWarning", { error: workersError })}
            </span>
            <button
              type="button"
              className="odag-sb__error-close"
              aria-label={t("sb.dismissError")}
              onClick={() => setWorkersError(null)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* 2. Either Drill-in Task Detail OR 3-Tab Main Surface */}
      {!runId ? (
        <EmptyRunState
          compact
          hasRuns={(runListRead.count ?? 0) > 0}
          cli={readiness?.cli ?? "orca"}
        />
      ) : selectedTask ? (
        <section className="odag-sb__detail" aria-label={selectedTask.label || selectedTask.id}>
          <div className="odag-sb__detail-head">
            <div className="odag-sb__detail-top">
              <button
                type="button"
                className="odag-sb__back"
                onClick={() => setSelectedTaskId(null)}
              >
                <ArrowLeft size={12} aria-hidden="true" />
                <span>{t("sb.back")}</span>
              </button>
              <span
                className="odag-sb__dot"
                style={{ background: statusTokenVars(selectedTask.status).fg }}
              />
              <span className="odag-sb__detail-title" title={selectedTask.label || selectedTask.id}>
                {selectedTask.label || selectedTask.id}
              </span>
            </div>

            {(liveSelectedWorker || stoppableSelectedWorker || resumableWorker) && (
              <div className="odag-sb__detail-actions">
                {liveSelectedWorker && (
                  <button
                    type="button"
                    className="odag-sb__mini-btn"
                    disabled={busyKey === `focus:${liveSelectedWorker.dispatchId}`}
                    onClick={() => void handleFocusTerminal(liveSelectedWorker.dispatchId)}
                  >
                    <Crosshair size={12} aria-hidden="true" />
                    <span>{t("sb.focusTerminal")}</span>
                  </button>
                )}
                {stoppableSelectedWorker && (
                  <button
                    type="button"
                    className="odag-sb__mini-btn odag-sb__mini-btn--danger"
                    disabled={busyKey === `stop:${stoppableSelectedWorker.dispatchId}`}
                    onClick={() => void handleStopWorker(stoppableSelectedWorker)}
                  >
                    <Square size={11} aria-hidden="true" />
                    <span>{t("sb.stopWorker")}</span>
                  </button>
                )}
                {resumableWorker && (
                  <button
                    type="button"
                    className="odag-sb__mini-btn"
                    disabled={resumeLoading || busyKey === `resume:${resumableWorker.dispatchId}`}
                    onClick={() => void handleCheckResume(resumableWorker.dispatchId)}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    <span>{resumeLoading ? t("sb.resumeLoading") : t("sb.resumeAction")}</span>
                  </button>
                )}
                {selectedTask.status === "failed" && resumableWorker && (
                  <button
                    type="button"
                    className="odag-sb__mini-btn"
                    disabled={busyKey === `retry:${resumableWorker.dispatchId}`}
                    onClick={() => void handleRetryWorker(selectedTask, resumableWorker)}
                  >
                    <RefreshCw size={11} aria-hidden="true" />
                    <span>{t("sb.retryWorker")}</span>
                  </button>
                )}
              </div>
            )}

            {resumeReceipt && (
              <div className="odag-sb__resume-box" role="status">
                {t("worker.resumeReceipt", {
                  dispatch: resumeReceipt.dispatchId,
                  terminal: resumeReceipt.resumedTerminalId,
                  session: resumeReceipt.sessionId,
                })}
              </div>
            )}

            {resumePreview && resumableWorker && (
              <div className="odag-sb__resume-box">
                {resumePreview.eligible ? (
                  <>
                    <span>
                      {t("worker.resumeReady", {
                        harness: resumePreview.harness ?? t("worker.unknown"),
                        session: resumePreview.sessionId ?? "",
                      })}
                    </span>
                    <button
                      type="button"
                      className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                      disabled={busyKey === `resume:${resumableWorker.dispatchId}`}
                      onClick={() => void handleExecuteResume(resumableWorker.dispatchId, resumePreview)}
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                      <span>{t("worker.resumeButton")}</span>
                    </button>
                  </>
                ) : resumePreview.code === "session_id_required" &&
                  resumePreview.candidateSessions.some((s) => !s.running) ? (
                  <>
                    <label htmlFor={`${idPrefix}-resume-pick`}>{t("worker.resumePickSession")}</label>
                    <select
                      id={`${idPrefix}-resume-pick`}
                      className="odag-sb__select"
                      value={resumePickedSession}
                      onChange={(e) => setResumePickedSession(e.target.value)}
                    >
                      <option value="">{t("worker.resumePickPlaceholder")}</option>
                      {resumePreview.candidateSessions
                        .filter((s) => !s.running)
                        .map((s) => (
                          <option key={s.sessionId} value={s.sessionId}>
                            {s.title ? `${s.title.slice(0, 36)} · ` : ""}
                            {s.sessionId.slice(0, 14)}
                          </option>
                        ))}
                    </select>
                    {resumePickedSession && (
                      <button
                        type="button"
                        className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                        disabled={busyKey === `resume:${resumableWorker.dispatchId}`}
                        onClick={() => void handleExecuteResume(resumableWorker.dispatchId, resumePreview)}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                        <span>{t("worker.resumeButton")}</span>
                      </button>
                    )}
                  </>
                ) : (
                  <span>
                    {t("worker.resumeUnavailable", {
                      reason: resumePreview.reason ?? t("worker.unknown"),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Detail Sub-Tabs: Messages / Session / Output (aligned with full workbench naming) */}
          <div
            className="odag-sb__tablist"
            role="tablist"
            aria-label={t("chat.view.label")}
            {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
            onKeyDown={(e) => handleTablistKeyDown(e, DETAIL_TABS, detailTab, setDetailTab)}
          >
            {(
              [
                { id: "messages", label: t("chat.view.messages") },
                { id: "session", label: t("ide.inspector.tabSession") },
                { id: "output", label: t("sb.detailOutput") },
              ] as const
            ).map((item) => {
              const selected = detailTab === item.id;
              return (
                <button
                  key={item.id}
                  id={`${idPrefix}-dtab-${item.id}`}
                  type="button"
                  role="tab"
                  className="odag-sb__tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  {...(selected ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
                  onClick={() => setDetailTab(item.id)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div
            className="odag-sb__detail-body"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-dtab-${detailTab}`}
          >
            {detailTab === "messages" && (
              <div className="odag-inspector--compact-chat odag-sb__chat-host">
                <ChatPanel
                  embeddedMessagesOnly
                  active={visible && detailTab === "messages"}
                  runId={runId}
                  snapshot={effectiveActivity}
                  tasks={nodes}
                  taskSelection={chatTaskSelection}
                  leadTaskId={config.leadTaskByRun[runId] ?? null}
                  onSelectTask={(id) => {
                    if (id) openTaskDetail(id, "messages");
                  }}
                  onSelectWorker={(dispatchId) => {
                    setSelectedOutputDispatchId(dispatchId);
                    setDetailTab("output");
                  }}
                  onResolved={() => {
                    void refreshAll({ force: true });
                  }}
                  coordinatorActive={Boolean(status?.running && status.runId === runId)}
                  disabled={readiness !== null && !readiness.executionEnabled}
                  disabledReason={readiness?.reason}
                  renderTask={() => null}
                />
              </div>
            )}
            {detailTab === "session" && (
              <NodeSessionPanel
                runId={runId}
                task={selectedTask}
                workerRows={selectedTaskWorkers}
                active={visible && detailTab === "session"}
                onOpenOutput={(dispatchId) => {
                  setSelectedOutputDispatchId(dispatchId);
                  setDetailTab("output");
                }}
              />
            )}
            {detailTab === "output" && (
              <WorkerOutputDockView
                runId={runId}
                workerRows={selectedTaskWorkers}
                labelsById={labelsById}
                selectedDispatchId={selectedOutputDispatchId}
                onSelectDispatchId={setSelectedOutputDispatchId}
                active={visible && detailTab === "output"}
              />
            )}
          </div>
        </section>
      ) : (
        <>
          {/* Primary 3-Tab Navigation: Tasks / Pending / Live */}
          <div
            className="odag-sb__tablist"
            role="tablist"
            aria-label={t("sb.tabsAria")}
            {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
            onKeyDown={(e) => handleTablistKeyDown(e, PRIMARY_TABS, tab, setTab)}
          >
            <button
              id={`${idPrefix}-ptab-tasks`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "tasks"}
              tabIndex={tab === "tasks" ? 0 : -1}
              {...(tab === "tasks" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("tasks")}
            >
              <span>{t("sb.tabTasks")}</span>
              <span className="odag-sb__tab-badge">{counts.total}</span>
            </button>
            <button
              id={`${idPrefix}-ptab-inbox`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "inbox"}
              tabIndex={tab === "inbox" ? 0 : -1}
              {...(tab === "inbox" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("inbox")}
            >
              <span>{t("sb.tabInbox")}</span>
              {pendingCount > 0 && (
                <span className="odag-sb__tab-badge odag-sb__tab-badge--warn">{pendingCount}</span>
              )}
            </button>
            <button
              id={`${idPrefix}-ptab-activity`}
              type="button"
              role="tab"
              className="odag-sb__tab"
              aria-selected={tab === "activity"}
              tabIndex={tab === "activity" ? 0 : -1}
              {...(tab === "activity" ? ({ focusgroupstart: "" } as Record<string, string>) : {})}
              onClick={() => setTab("activity")}
            >
              <span>{t("sb.tabActivity")}</span>
            </button>
          </div>

          <div
            className="odag-sb__panel"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-ptab-${tab}`}
          >
            {tab === "tasks" && (
              <div className="odag-sb__scroll">
                {filterChips.length > 1 && (
                  <div className="odag-sb__filters" role="group" aria-label={t("sb.tabTasks")}>
                    {filterChips.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="odag-sb__chip"
                        aria-pressed={filter === item.key}
                        onClick={() => setFilter(item.key)}
                      >
                        {item.color && <span className="odag-sb__dot" style={{ background: item.color }} />}
                        <span>{item.label}</span>
                        <span>{item.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {pendingCount > 0 && (
                  <div className="odag-sb__banner">
                    <span>{t("sb.pendingBanner", { n: pendingCount })}</span>
                    <button
                      type="button"
                      className="odag-sb__banner-btn"
                      onClick={() => setTab("inbox")}
                    >
                      {t("sb.pendingBannerAction")} →
                    </button>
                  </div>
                )}

                {filteredNodes.length === 0 ? (
                  <div className="odag-sb__empty">{t("sb.noTasks")}</div>
                ) : (
                  filteredNodes.map((node) => {
                    const harness = effectiveHarness(node.id);
                    const tokens = statusTokenVars(node.status);
                    const taskWorkers = workersByTask.get(node.id) ?? [];
                    const isLive = taskWorkers.some((w) => w.projection?.liveness?.verdict === "live");
                    const focusable = taskWorkers.find(isFocusableLocalWorker) ?? null;
                    const cardToneClass =
                      node.status === "dispatched"
                        ? " odag-sb__card-row--running"
                        : node.status === "failed"
                          ? " odag-sb__card-row--failed"
                          : node.status === "blocked"
                            ? " odag-sb__card-row--blocked"
                            : "";
                    const title = node.label || node.id;
                    return (
                      <div key={node.id} className={`odag-sb__card-row${cardToneClass}`}>
                        <button
                          type="button"
                          className="odag-sb__card"
                          onClick={() => openTaskDetail(node.id, "messages")}
                        >
                          <div className="odag-sb__card-top">
                            <span style={{ color: tokens.fg, display: "inline-flex", flex: "none" }}>
                              <StatusGlyph status={node.status} executing={isLive} size={13} />
                            </span>
                            <span className="odag-sb__card-title" title={title}>
                              {title}
                            </span>
                            <span className="odag-sb__card-harness">
                              <HarnessAvatar harness={harness} size={11} />
                              <span>{harness}</span>
                            </span>
                          </div>
                          <div className="odag-sb__card-sub">
                            <span className="odag-sb__card-summary">{taskSubtitle(node)}</span>
                            <ChevronRight size={13} className="odag-sb__card-chevron" aria-hidden="true" />
                          </div>
                        </button>
                        {focusable && (
                          <button
                            type="button"
                            className="odag-sb__card-focus"
                            aria-label={t("sb.focusWorkerAria", { task: title })}
                            title={t("sb.focusTerminal")}
                            disabled={busyKey === `focus:${focusable.dispatchId}`}
                            onClick={() => void handleFocusTerminal(focusable.dispatchId)}
                          >
                            <Crosshair size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {tab === "inbox" && (
              <div className="odag-sb__scroll">
                {pendingCount === 0 && <div className="odag-sb__empty">{t("sb.noPending")}</div>}

                {pendingGates.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.gateSection")}</div>
                    {pendingGates.map((gate) => (
                      <div key={gate.id} className="odag-sb__item-card">
                        <div className="odag-sb__item-head">
                          <span>{gate.taskId ? labelsById[gate.taskId] ?? gate.taskId : gate.id}</span>
                          <span className="odag-sb__wide-only">{gate.id}</span>
                        </div>
                        <div className="odag-sb__item-title">{gate.question || gate.id}</div>
                        <div className="odag-sb__detail-actions">
                          {(gate.options.length > 0 ? gate.options : ["approved", "rejected"]).map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              className={`odag-sb__mini-btn${
                                opt.toLowerCase().includes("approve")
                                  ? " odag-sb__mini-btn--primary"
                                  : opt.toLowerCase().includes("reject")
                                    ? " odag-sb__mini-btn--danger"
                                    : ""
                              }`}
                              disabled={busyKey === `gate:${gate.id}`}
                              onClick={() => void handleResolveGate(gate.id, opt)}
                            >
                              {opt === "approved"
                                ? t("sb.approve")
                                : opt === "rejected"
                                  ? t("sb.reject")
                                  : opt}
                            </button>
                          ))}
                          {gate.taskId && nodeById.has(gate.taskId) && (
                            <button
                              type="button"
                              className="odag-sb__mini-btn odag-sb__mini-btn--ghost"
                              onClick={() => openTaskDetail(gate.taskId!, "session")}
                            >
                              {t("sb.viewTask")}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {pendingInbox.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.inboxSection")}</div>
                    {pendingInbox.map((item) => {
                      const perm = item.permissionPrompt;
                      const draft = replyDrafts[item.messageId] ?? "";
                      return (
                        <div key={item.messageId} className="odag-sb__item-card">
                          <div className="odag-sb__item-head">
                            <span>{item.taskId ? labelsById[item.taskId] ?? item.taskId : item.from}</span>
                            <span className="odag-sb__item-head-right">
                              {item.taskId && nodeById.has(item.taskId) && (
                                <button
                                  type="button"
                                  className="odag-sb__inline-link"
                                  onClick={() => openTaskDetail(item.taskId!, "session")}
                                >
                                  {t("sb.viewTask")}
                                </button>
                              )}
                              <span>{formatShortTime(item.createdAt)}</span>
                            </span>
                          </div>
                          <div className="odag-sb__item-title">
                            {item.subject || item.stopReason || item.kind}
                          </div>
                          {item.body && <p className="odag-sb__item-body">{item.body}</p>}
                          {perm && item.dispatchId ? (
                            <div className="odag-sb__detail-actions">
                              <button
                                type="button"
                                className="odag-sb__mini-btn odag-sb__mini-btn--primary"
                                disabled={perm.allowSupported === false || busyKey === `perm:${perm.id}`}
                                title={perm.allowSupported === false ? t("permission.allowDisabledTitle") : undefined}
                                onClick={() =>
                                  void handlePermissionDecision(item.dispatchId!, perm.id, "approve")
                                }
                              >
                                {t("permission.allowOnce")}
                              </button>
                              <button
                                type="button"
                                className="odag-sb__mini-btn odag-sb__mini-btn--danger"
                                disabled={busyKey === `perm:${perm.id}`}
                                onClick={() =>
                                  void handlePermissionDecision(item.dispatchId!, perm.id, "deny")
                                }
                              >
                                {t("sb.reject")}
                              </button>
                            </div>
                          ) : item.kind === "stop_event" && item.dispatchId ? (
                            <div className="odag-sb__detail-actions">
                              <button
                                type="button"
                                className="odag-sb__mini-btn"
                                disabled={busyKey === `ack:${item.messageId}`}
                                onClick={() => void handleAckStop(item.messageId, item.dispatchId!)}
                              >
                                {t("sb.acknowledge")}
                              </button>
                              {item.taskId && (
                                <button
                                  type="button"
                                  className="odag-sb__mini-btn"
                                  onClick={() => openTaskDetail(item.taskId!, "session")}
                                >
                                  {t("sb.inspect")}
                                </button>
                              )}
                            </div>
                          ) : (
                            <form
                              className="odag-sb__reply-row"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleReplyInbox(item.messageId);
                              }}
                            >
                              <textarea
                                className="odag-sb__textarea"
                                rows={1}
                                value={draft}
                                title={t("sb.replyHint")}
                                aria-label={t("sb.replyPlaceholder")}
                                onChange={(e) =>
                                  setReplyDrafts((prev) => ({ ...prev, [item.messageId]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (
                                    e.key === "Enter" &&
                                    !e.shiftKey &&
                                    !e.nativeEvent.isComposing &&
                                    draft.trim() &&
                                    busyKey !== `reply:${item.messageId}`
                                  ) {
                                    e.preventDefault();
                                    void handleReplyInbox(item.messageId);
                                  }
                                }}
                                placeholder={t("sb.replyPlaceholder")}
                              />
                              <button
                                type="submit"
                                className="odag-sb__mini-btn odag-sb__mini-btn--primary odag-sb__reply-send"
                                disabled={!draft.trim() || busyKey === `reply:${item.messageId}`}
                              >
                                {t("sb.send")}
                              </button>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}

                {failedWorkers.length > 0 && (
                  <>
                    <div className="odag-sb__section-label">{t("sb.failedSection")}</div>
                    {failedWorkers.map((w) => (
                      <div key={w.dispatchId} className="odag-sb__item-card">
                        <div className="odag-sb__item-head">
                          <span>{labelsById[w.taskId] ?? w.taskId}</span>
                          <span>{w.dispatchId.slice(0, 14)}</span>
                        </div>
                        <div className="odag-sb__item-body">
                          {w.workerState || w.dispatchStatus}
                        </div>
                        <div className="odag-sb__detail-actions">
                          <button
                            type="button"
                            className="odag-sb__mini-btn"
                            onClick={() => openTaskDetail(w.taskId, "session")}
                          >
                            <RotateCcw size={12} aria-hidden="true" />
                            <span>{t("sb.inspect")} / {t("sb.resumeAction")}</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {tab === "activity" && (
              <div className="odag-sb__scroll odag-sb__scroll--timeline">
                {recentActivity.length === 0 ? (
                  <div className="odag-sb__empty">{t("sb.noActivity")}</div>
                ) : (
                  <div className="odag-sb__timeline">
                    {recentActivity.map((ev) => {
                      const statusTone: TaskStatus =
                        ev.severity === "error"
                          ? "failed"
                          : ev.severity === "success"
                            ? "completed"
                            : ev.severity === "warning"
                              ? "dispatched"
                              : "pending";
                      const label = ev.taskId ? labelsById[ev.taskId] ?? ev.taskId : ev.actor.label;
                      const body = (
                        <>
                          <span
                            className="odag-sb__tl-dot"
                            style={{ background: statusTokenVars(statusTone).fg }}
                            aria-hidden="true"
                          />
                          <div className="odag-sb__tl-body">
                            <div className="odag-sb__activity-meta">
                              <span className="odag-sb__tl-actor" title={label}>{label}</span>
                              <span className="odag-sb__tl-time">{formatShortTime(ev.createdAt)}</span>
                            </div>
                            <div className="odag-sb__activity-text">{ev.summary || ev.title}</div>
                          </div>
                        </>
                      );
                      return ev.taskId ? (
                        <button
                          key={ev.id}
                          type="button"
                          className="odag-sb__tl-row odag-sb__tl-row--interactive"
                          onClick={() => openTaskDetail(ev.taskId!, "session")}
                        >
                          {body}
                        </button>
                      ) : (
                        <div key={ev.id} className="odag-sb__tl-row">
                          {body}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* 3. Docked IDE Footer: Coordination Mode + Live Stream Status + Quick Refresh */}
      {runId && (
        <footer className="odag-sb__footer">
          <div className="odag-sb__footer-left">
            {runHealth && <RunHealthBadge runId={runId} health={runHealth} sidebar />}
          </div>
          <div className="odag-sb__footer-right">
            {streamState === "error" && inPlugin ? (
              <button
                type="button"
                className="odag-sb__stream-pill odag-sb__stream-pill--error"
                disabled={reconnecting}
                onClick={() => void handleReconnect()}
                title={t("sb.reconnect")}
              >
                <span className="odag-sb__stream-dot" aria-hidden="true" />
                <span>{reconnecting ? t("sb.reconnecting") : t("sb.streamError")}</span>
              </button>
            ) : (
              <span
                className={`odag-sb__stream-pill odag-sb__stream-pill--${streamState}`}
                role="status"
              >
                <span className="odag-sb__stream-dot" aria-hidden="true" />
                <span>
                  {streamState === "live"
                    ? t("sb.streamLive")
                    : streamState === "error"
                      ? t("sb.streamError")
                      : t("sb.streamConnecting")}
                </span>
              </span>
            )}
            <button
              type="button"
              className="odag-sb__footer-btn"
              aria-label={t("sb.refresh")}
              title={t("sb.refresh")}
              disabled={manualRefreshing}
              onClick={() => void handleManualRefresh()}
            >
              <RefreshCw size={11} className={manualRefreshing ? "odag-sb__spin" : undefined} aria-hidden="true" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
