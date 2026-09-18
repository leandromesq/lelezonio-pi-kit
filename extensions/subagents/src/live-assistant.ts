/**
 * Incremental live-assistant buffer.
 *
 * Streaming emits one delta per token. The v1 manager appended each delta to
 * the live string and re-sliced the last 128 KiB (`(text + delta).slice(-MAX)`)
 * plus a fresh snapshot object per delta, so a chatty child allocated and
 * copied up to 128 KiB per token. Here the deltas stay in an append-only
 * chunk list; the retained text is pruned from the front in amortized O(1)
 * and only joined when someone reads `text`/`thinking`. The observable
 * semantics are unchanged: the live panel shows the last 128 KiB.
 */

/** Retained live text per channel; matches the v1 `LIVE_ASSISTANT_MAX_LENGTH`. */
export const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;

export interface LiveAssistant {
  readonly text: string;
  readonly thinking: string;
}

/** Diagnostics for tests: how often a channel had to rejoin its chunks. */
export interface LiveAssistantStats {
  textJoins: number;
  thinkingJoins: number;
}

/** One channel ("text" or "thinking") of the live buffer. */
class ChannelBuffer {
  private chunks: string[] = [];
  /** Index of the first live chunk; keeps front-pruning O(1) amortized. */
  private head = 0;
  /** Characters retained in `chunks[head..]`. */
  private buffered = 0;
  private cached = "";
  private dirty = false;
  private joins = 0;

  append(delta: string) {
    if (!delta) return;
    this.chunks.push(delta);
    this.buffered += delta.length;
    let excess = this.buffered - LIVE_ASSISTANT_MAX_LENGTH;
    while (excess > 0) {
      const first = this.chunks[this.head];
      if (first.length <= excess) {
        this.head++;
        this.buffered -= first.length;
        excess -= first.length;
      } else {
        this.chunks[this.head] = first.slice(excess);
        this.buffered -= excess;
        excess = 0;
      }
    }
    // Compact rarely, and only when at least half the array is dropped, so
    // pruning stays amortized O(1) per chunk.
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.dirty = true;
  }

  read(): string {
    if (!this.dirty) return this.cached;
    this.cached = this.chunks.slice(this.head).join("");
    this.dirty = false;
    this.joins++;
    return this.cached;
  }

  joinCount(): number {
    return this.joins;
  }
}

export interface LiveAssistantBuffer {
  /**
   * Stable view object handed to snapshots. Its `text`/`thinking` getters
   * materialize the joined string on read, so the streaming path never builds
   * a string unless a reader asks for one.
   */
  readonly view: LiveAssistant;
  append(kind: "text" | "thinking", delta: string): void;
  stats(): LiveAssistantStats;
}

export function createLiveAssistantBuffer(): LiveAssistantBuffer {
  const channels = {
    text: new ChannelBuffer(),
    thinking: new ChannelBuffer(),
  };
  const view: LiveAssistant = {
    get text() {
      return channels.text.read();
    },
    get thinking() {
      return channels.thinking.read();
    },
  };
  return {
    view,
    append: (kind, delta) => channels[kind].append(delta),
    stats: () => ({
      textJoins: channels.text.joinCount(),
      thinkingJoins: channels.thinking.joinCount(),
    }),
  };
}
