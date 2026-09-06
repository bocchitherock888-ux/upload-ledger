import { command, sendFiles } from "../shared/client";
import { cleanURL, excluded } from "../domain/rules";
import type { HelloResult } from "../shared/protocol";

interface CaptureScope {
  refresh: () => void;
  stop: () => void;
}
const scope = globalThis as typeof globalThis & {
  __uploadLedger?: CaptureScope;
};

if (scope.__uploadLedger) {
  scope.__uploadLedger.refresh();
} else {
  let enabled = false;
  let dropEnabled = false;
  let epoch: number | null = null;
  let generation = 0;
  let queue = Promise.resolve();
  let refreshing = false;
  let refreshPromise: Promise<void> = Promise.resolve();
  const batches = new Set<string>();
  const controllers = new Set<AbortController>();
  const dropped = new WeakMap<File, number>();
  const handledChanges = new WeakSet<Event>();
  const handledDrops = new WeakSet<Event>();
  const observedRoots = new WeakSet<Document | ShadowRoot>();
  const observers = new Set<MutationObserver>();

  async function refresh() {
    try {
      const hello = await command<HelloResult>("CAPTURE_HELLO", {});
      enabled = hello.allowed;
      dropEnabled = hello.dropEnabled;
      epoch = hello.vaultEpoch;
    } catch {
      stop();
    }
  }
  function startRefresh() {
    refreshing = true;
    refreshPromise = refresh().finally(() => {
      refreshing = false;
    });
  }
  function stop() {
    enabled = false;
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  scope.__uploadLedger = { refresh: startRefresh, stop };

  function page() {
    return {
      origin: location.origin,
      location: cleanURL(location.href),
      locationMode: "origin_path" as const,
      title: document.title.slice(0, 256),
    };
  }
  function schedule(files: File[], source: "standard_input" | "user_drop") {
    const safeFiles = files.filter((file) => !excluded(file.name));
    if (!safeFiles.length) return;
    const selectedGeneration = generation;
    const selectedEpoch = refreshing ? null : epoch;
    const selectedPage = page();
    const pendingRefresh = refreshPromise;
    const batchEventId = crypto.randomUUID();
    batches.add(batchEventId);
    const controller = new AbortController();
    controllers.add(controller);
    queue = queue
      .then(async () => {
        await pendingRefresh;
        const captureEpoch = selectedEpoch ?? epoch;
        if (
          !enabled ||
          selectedGeneration !== generation ||
          captureEpoch === null ||
          (source === "user_drop" && !dropEnabled)
        )
          return;
        await sendFiles(safeFiles, {
          source,
          page: selectedPage,
          vaultEpoch: captureEpoch,
          batchEventId,
          signal: controller.signal,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        batches.delete(batchEventId);
        controllers.delete(controller);
      });
  }
  function inputFrom(event: Event) {
    const path = event.composedPath();
    const candidate =
      path.find((item) => item instanceof HTMLInputElement) ?? event.target;
    return candidate instanceof HTMLInputElement ? candidate : null;
  }
  function onChange(event: Event) {
    if (handledChanges.has(event)) return;
    handledChanges.add(event);
    const input = inputFrom(event);
    if (
      (!enabled && !refreshing) ||
      !event.isTrusted ||
      !input ||
      input.type !== "file" ||
      input.webkitdirectory
    )
      return;
    const files = Array.from(input.files ?? []).filter(
      (file) => Date.now() - (dropped.get(file) ?? 0) > 2_000,
    );
    if (files.length) schedule(files, "standard_input");
  }
  function onDrop(event: DragEvent) {
    if (handledDrops.has(event)) return;
    handledDrops.add(event);
    if (
      (!enabled && !refreshing) ||
      (!dropEnabled && !refreshing) ||
      !event.isTrusted ||
      !event.dataTransfer
    )
      return;
    const items = Array.from(event.dataTransfer.items ?? []);
    if (
      items.some(
        (item) =>
          item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
      )
    )
      return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    for (const file of files) dropped.set(file, Date.now());
    schedule(files, "user_drop");
  }

  function installRoot(root: Document | ShadowRoot) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    root.addEventListener("change", onChange, true);
    root.addEventListener("drop", onDrop as EventListener, true);
    const observer = new MutationObserver((records) => {
      const added: Element[] = [];
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element) added.push(node);
      scanElements(added);
    });
    observer.observe(root, { childList: true, subtree: true });
    observers.add(observer);
    scanElements(Array.from(root.children));
  }
  function scanElements(seed: Element[]) {
    const pending = [...seed];
    const scan = (deadline?: IdleDeadline) => {
      let budget = 500;
      while (
        pending.length &&
        budget-- > 0 &&
        (!deadline || deadline.timeRemaining() > 1)
      ) {
        const element = pending.shift()!;
        if (element.shadowRoot) installRoot(element.shadowRoot);
        for (const child of element.children) pending.push(child);
      }
      if (pending.length) {
        if ("requestIdleCallback" in globalThis)
          globalThis.requestIdleCallback(scan, { timeout: 250 });
        else setTimeout(() => scan(), 0);
      }
    };
    scan();
  }

  installRoot(document);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "CAPTURE_STOP")
      stop();
  });
  window.addEventListener("pagehide", () => {
    stop();
    for (const observer of observers) observer.disconnect();
    void command(
      "CAPTURE_SOURCE_GONE",
      { batchEventIds: [...batches].slice(0, 100) },
      epoch,
    ).catch(() => undefined);
  });
  startRefresh();
}
