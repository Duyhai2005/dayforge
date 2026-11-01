import type { OwnerAccessContext } from "../storage/owner-gate";
export type OwnerLockNotice = Readonly<{ ownerId: string; source?: "recovery" }>;

type LockMessage = Readonly<{
  type: "owner-locked";
  ownerId: string;
}>;

export const OWNER_LOCK_EVENT = "dayforge:owner-locked";
const CHANNEL_NAME = "dayforge-owner-auth-v1";

export function notifyOwnerLockLocally(ownerId: string, source?: "recovery"): void {
  if (typeof window === "undefined" || !ownerId) return;
  window.dispatchEvent(
    new CustomEvent<OwnerLockNotice>(OWNER_LOCK_EVENT, { detail: source ? { ownerId, source } : { ownerId } })
  );
}

export function publishOwnerLocked(ownerId: string): void {
  if (typeof window === "undefined" || !ownerId) return;
  notifyOwnerLockLocally(ownerId);
  broadcastOwnerLocked(ownerId);
}

/** Notify other tabs when recovery newly locks an owner, without cancelling work in this tab. */
export function broadcastOwnerLocked(ownerId: string): void {
  if (typeof window === "undefined" || !ownerId) return;
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: "owner-locked", ownerId } satisfies LockMessage);
    channel.close();
  }
}

/** Subscribe to lock events in this tab; sync coordinators can use this hook. */
export function subscribeOwnerLock(
  listener: (notice: OwnerLockNotice) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const notice = (event as CustomEvent<OwnerLockNotice>).detail;
    if (notice && typeof notice.ownerId === "string") listener(notice);
  };
  window.addEventListener(OWNER_LOCK_EVENT, handle);
  return () => window.removeEventListener(OWNER_LOCK_EVENT, handle);
}

/** Listen for lock events raised by another tab. */
export function listenForRemoteOwnerLock(
  listener: (notice: OwnerLockNotice) => void
): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<LockMessage> | null;
    if (
      message?.type === "owner-locked" &&
      typeof message.ownerId === "string"
    ) {
      notifyOwnerLockLocally(message.ownerId);
      listener({ ownerId: message.ownerId });
    }
  };
  return () => channel.close();
}
let activeOwnerContext: OwnerAccessContext | null = null;

export function getActiveOwnerContext(): OwnerAccessContext | null {
  return activeOwnerContext;
}

export function setActiveOwnerContext(context: OwnerAccessContext | null): void {
  activeOwnerContext = context;
}

export function clearActiveOwnerContext(ownerId?: string): void {
  if (ownerId === undefined || activeOwnerContext?.ownerId === ownerId) {
    activeOwnerContext = null;
  }
}
