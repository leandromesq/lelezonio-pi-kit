/**
 * Extended prompt-cache retention for every pi process (parent + children).
 *
 * Why: provider prompt caches expire after ~5 minutes by default. Subagent
 * paced sessions are full of idle gaps (waiting on children), so every turn
 * after a gap re-read the entire context — 100K+ tokens of prefill that makes
 * long sessions feel really slow. "long" extends retention where the provider
 * supports it (Anthropic: 1h, OpenAI/Codex: 24h).
 *
 * pi-ai resolves PI_CACHE_RETENTION per request from process.env, so setting
 * it once at extension load time (before the first request) is enough. Each
 * Herdr worker pane is its own pi process and loads this extension too, so
 * children get the same behavior. `??=` keeps an explicit shell-level setting
 * in control.
 */
if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";

export default function cacheRetention() {}
