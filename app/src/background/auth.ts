import { fail } from "../domain/rules";
import type { CallerBinding } from "../shared/model";

export interface Identity {
  caller: CallerBinding;
  path: string;
}
export function identify(sender: chrome.runtime.MessageSender): Identity {
  if (sender.id !== chrome.runtime.id || sender.tab?.incognito || !sender.url)
    fail("E_UNAUTHORISED");
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return fail("E_UNAUTHORISED");
  }
  if (
    url.protocol === "chrome-extension:" &&
    url.hostname === chrome.runtime.id &&
    !url.username &&
    !url.password &&
    (sender.frameId === undefined || sender.frameId === 0) &&
    !!sender.documentId &&
    ["/app.html", "/popup.html"].includes(url.pathname)
  ) {
    return {
      caller: {
        kind: "ui",
        tabId: sender.tab?.id ?? null,
        documentId: sender.documentId,
        frameId: 0,
        origin: `chrome-extension://${chrome.runtime.id}`,
      },
      path: url.pathname,
    };
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    sender.tab?.id === undefined ||
    sender.origin !== url.origin
  )
    fail("E_UNAUTHORISED");
  return {
    caller: {
      kind: "capture",
      tabId: sender.tab.id,
      documentId: sender.documentId,
      frameId: 0,
      origin: url.origin,
    },
    path: url.pathname,
  };
}
