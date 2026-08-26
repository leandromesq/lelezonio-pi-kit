/**
 * Takeover-pane wiring for remote agents — a leaf module with no TUI classes
 * so unit tests run under Node's strip-only TS mode (the dashboard classes use
 * constructor parameter properties, which strip-only cannot parse).
 *
 * Keeps one rule: the manager stays the sole owner; this module only reads
 * snapshots and relays send/cancel/refresh actions through the bridge host.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  takeoverHost,
  takeoverKey,
  type TakeoverTarget,
} from "../../../shared/takeover-host.ts";
import type { RemoteAgentSnapshot } from "../domain.ts";
import type { RemoteAgentReadModel } from "../manager.ts";

/** Normalized snapshot for the takeover bridge. */
export function remoteTarget(snap: RemoteAgentSnapshot): TakeoverTarget {
  return {
    kind: "remote",
    id: snap.id,
    title: snap.title,
    status: snap.status,
    since: snap.createdAt,
    text: snap.transcript,
  };
}

/**
 * Try to open this remote agent in a Herdr takeover pane (send/cancel/
 * refresh). Returns true when the pane took over; callers then keep the
 * in-session overlay behavior out. Never starts or restarts the remote job.
 */
export async function tryOpenRemoteTakeoverPane(
  ctx: ExtensionCommandContext,
  view: RemoteAgentReadModel,
  id: string,
): Promise<boolean> {
  const snap = view.get(id);
  if (!snap) return false;
  const host = takeoverHost();
  const key = takeoverKey("remote", id);
  const paneId = await host.open({
    target: () => {
      const current = view.get(id);
      return current ? remoteTarget(current) : undefined;
    },
    actions: {
      send: (text: string) => view.requestSend(id, text),
      cancel: () => view.requestCancel(id),
      refresh: () => view.requestRefresh(id),
    },
    cwd: snap.localCwd,
    subscribe: () => view.subscribeTo(id, () => host.refresh(key)),
  });
  if (!paneId) return false;
  ctx.ui.notify(
    `Remote agent ${id} taken over in Herdr pane ${paneId}`,
    "info",
  );
  return true;
}

/**
 * Full takeover flow: request a fresh transcript, try the Herdr pane, and
 * fall back to `openOverlay` (the in-session takeover view) when the pane is
 * unavailable or fails. The overlay callback keeps this module free of TUI
 * classes so it stays unit-testable under strip-only TypeScript.
 */
export async function openRemoteTakeoverPaneOr(
  ctx: ExtensionCommandContext,
  view: RemoteAgentReadModel,
  id: string,
  openOverlay: () => Promise<unknown>,
): Promise<boolean> {
  if (!view.get(id)) return false;
  view.requestRefresh(id);
  if (await tryOpenRemoteTakeoverPane(ctx, view, id)) return true;
  await openOverlay();
  return false;
}
