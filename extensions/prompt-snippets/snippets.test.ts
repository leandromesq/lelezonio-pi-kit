import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSnippets, parseSnippet } from "./snippets.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(extensionDir, "snippets");

const CATALOG = [
  "ask-questions.md",
  "delegate-exploration.md",
  "diagnose-report.md",
  "orchestrator-mode.md",
  "session-kickoff.md",
  "verify-not-assume.md",
];

test("catalog contains the six expected snippet files", () => {
  const files = readdirSync(snippetsDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  assert.deepEqual(files, CATALOG);
});

test("every catalog snippet parses with complete frontmatter and body", () => {
  for (const file of CATALOG) {
    const raw = readFileSync(join(snippetsDir, file), "utf8");
    const snippet = parseSnippet(file, raw);
    assert.ok(snippet, `${file} should parse`);
    assert.ok(snippet!.name.length > 0, `${file}: name`);
    assert.ok(snippet!.description.length > 0, `${file}: description`);
    assert.ok(snippet!.body.length > 0, `${file}: body`);
    assert.match(snippet!.name, /^[A-Za-z]/, `${file}: display name`);
  }
});

test("catalog placements and sort orders match the intended design", () => {
  const snippets = loadSnippets(snippetsDir);
  const byId = new Map(snippets.map((s) => [s.id, s]));

  const expected: Record<string, { placement: string; order: number }> = {
    "ask-questions.md": { placement: "append", order: 10 },
    "verify-not-assume.md": { placement: "append", order: 20 },
    "delegate-exploration.md": { placement: "append", order: 30 },
    "diagnose-report.md": { placement: "append", order: 40 },
    "session-kickoff.md": { placement: "prepend", order: 10 },
    "orchestrator-mode.md": { placement: "prepend", order: 30 },
  };
  for (const [file, want] of Object.entries(expected)) {
    const snippet = byId.get(file);
    assert.ok(snippet, `${file} loaded`);
    assert.equal(snippet!.placement, want.placement, `${file}: placement`);
    assert.equal(snippet!.order, want.order, `${file}: order`);
  }
});

test("loadSnippets sorts prepend group first, then append, by (order, name)", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-snippets-"));
  try {
    writeFileSync(
      join(dir, "z-append-low.md"),
      "---\nname: Z append low\nplacement: append\norder: 1\n---\nBody",
    );
    writeFileSync(
      join(dir, "a-prepend-high.md"),
      "---\nname: A prepend high\nplacement: prepend\norder: 99\n---\nBody",
    );
    writeFileSync(
      join(dir, "b-prepend-low.md"),
      "---\nname: B prepend low\nplacement: prepend\norder: 1\n---\nBody",
    );
    writeFileSync(
      join(dir, "c-append-tied.md"),
      "---\nname: C append tied\nplacement: append\norder: 1\n---\nBody",
    );

    assert.deepEqual(
      loadSnippets(dir).map((s) => s.id),
      [
        "b-prepend-low.md",
        "a-prepend-high.md",
        "c-append-tied.md",
        "z-append-low.md",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSnippet defaults placement, order, and name", () => {
  const snippet = parseSnippet(
    "concise.md",
    "---\ndescription: Short\n---\nKeep it short.",
  );
  assert.deepEqual(snippet, {
    id: "concise.md",
    name: "concise",
    description: "Short",
    placement: "append",
    order: 9999,
    body: "Keep it short.",
  });
});

test("parseSnippet accepts quoted values and prepend placement", () => {
  const snippet = parseSnippet(
    "x.md",
    '---\nname: "X"\nplacement: prepend\norder: 5\n---\nBody',
  );
  assert.equal(snippet!.name, "X");
  assert.equal(snippet!.placement, "prepend");
  assert.equal(snippet!.order, 5);
});

test("parseSnippet rejects files without frontmatter or body", () => {
  assert.equal(parseSnippet("a.md", "no frontmatter"), null);
  assert.equal(parseSnippet("b.md", "---\nname: Empty\n---\n   \n"), null);
  assert.equal(parseSnippet("c.md", ""), null);
});

test("loadSnippets ignores non-markdown files and unreadable entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-snippets-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "not a snippet");
    writeFileSync(
      join(dir, "valid.md"),
      "---\nname: Valid\nplacement: prepend\n---\nBody",
    );
    assert.deepEqual(
      loadSnippets(dir).map((s) => s.name),
      ["Valid"],
    );
    assert.deepEqual(loadSnippets(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
