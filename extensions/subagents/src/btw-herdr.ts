/**
 * By-the-way in a Herdr pane.
 *
 * When this pi session was launched by Herdr (HERDR_ENV=1), `/btw` opens the
 * side agent as a visible pane next to the current one instead of an
 * in-process headless subagent: split the current pane and run a headless
 * `pi -p <prompt>` there, so its work streams into the pane. Any failure
 * reports unavailability and the caller keeps the in-process path.
 *
 * The Herdr CLI dance lives in the shared module (extensions/shared/
 * herdr-pane.ts) so the takeover feature reuses the exact same split/run/
 * rollback logic; this file only keeps the by-the-way behavior and wording.
 */

import {
  createHerdrPaneApi,
  herdrEnvironment,
  shellQuote,
  tryOpenHerdrPane,
} from "../../shared/herdr-pane.ts";

export interface BtwHerdrPane {
  readonly paneId: string;
}

export { herdrEnvironment };

/**
 * Open the by-the-way agent as a Herdr pane next to the current one.
 * Returns undefined when Herdr is not available or the request fails, so
 * callers fall back to the in-process subagent.
 */
export async function tryOpenBtwHerdrPane(options: {
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
}): Promise<BtwHerdrPane | undefined> {
  if (!herdrEnvironment()) return undefined;
  try {
    const paneId = await tryOpenHerdrPane(createHerdrPaneApi(), {
      cwd: options.cwd,
      command: ["pi", "-p", shellQuote(options.prompt)],
    });
    return { paneId };
  } catch (error) {
    console.error(
      `by the way: herdr pane unavailable, falling back: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
