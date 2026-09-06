import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedLineDiff,
  decodeUtf8,
  localDateBoundary,
  previewKind,
  safeDownloadName,
} from "../src/preview/utils";

test("UTF-8 decoding accepts BOM and rejects invalid and binary content", () => {
  assert.equal(
    decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69])),
    "hi",
  );
  assert.equal(decodeUtf8(Uint8Array.from([0xff, 0xfe])), null);
  assert.equal(decodeUtf8(Uint8Array.from([0x61, 0, 0x62])), null);
});

test("preview classifier keeps SVG and HTML as inert text", () => {
  assert.equal(
    previewKind({
      name: "art.svg",
      byteLength: 2,
      declaredMime: "image/svg+xml",
      lastModified: null,
    }),
    "text",
  );
  assert.equal(
    previewKind({
      name: "index.html",
      byteLength: 2,
      declaredMime: "text/html",
      lastModified: null,
    }),
    "text",
  );
  assert.equal(
    previewKind({
      name: "photo.png",
      byteLength: 2,
      declaredMime: "image/png",
      lastModified: null,
    }),
    "image",
  );
});

test("safe filename removes traversal, separators, controls and bidi controls", () => {
  const value = safeDownloadName("../evil\u202Egnp/secret?.txt\0");
  assert.equal(value, "evilgnp＿secret＿.txt");
  assert.equal(safeDownloadName("..."), "upload-ledger-file");
});

test("local date boundaries cover the complete device-local day", () => {
  const start = localDateBoundary("2026-09-06");
  const end = localDateBoundary("2026-09-06", true);
  assert.ok(start && end);
  assert.equal(
    new Date(end!).getTime() - new Date(start!).getTime(),
    86_400_000 - 1,
  );
  assert.equal(localDateBoundary("wrong"), undefined);
});

test("bounded line diff is deterministic and marks insertions and removals", () => {
  const result = boundedLineDiff("alpha\nbeta\ngamma\n", "alpha\nnew\ngamma\n");
  assert.equal(result.state, "different");
  assert.deepEqual(
    result.rows.map((row) => row.kind),
    ["same", "remove", "add", "same"],
  );
  assert.equal(boundedLineDiff("same", "same").state, "identical");
  assert.equal(boundedLineDiff("a".repeat(40), "b", 20).state, "limited");
});
