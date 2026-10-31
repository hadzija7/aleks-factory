import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

const PATCH = `diff --git a/src/app/page.tsx b/src/app/page.tsx
index 1111111..2222222 100644
--- a/src/app/page.tsx
+++ b/src/app/page.tsx
@@ -1,4 +1,4 @@
 export default function Home() {
-  return <h1>Hello</h1>;
+  return <h1>Hello world</h1>;
 }
 
diff --git a/src/lib/new.ts b/src/lib/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/lib/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.md b/docs/a.md
similarity index 100%
rename from a.md
rename to docs/a.md
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/logo.png differ
`;

describe("parseDiff", () => {
  const files = parseDiff(PATCH);

  it("parses every file with its status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/app/page.tsx", "modified"],
      ["src/lib/new.ts", "added"],
      ["old.txt", "deleted"],
      ["docs/a.md", "renamed"],
      ["logo.png", "added"],
    ]);
    expect(files[3].oldPath).toBe("a.md");
    expect(files[4].binary).toBe(true);
  });

  it("numbers lines and counts additions and deletions", () => {
    const [page] = files;
    expect(page).toMatchObject({ additions: 1, deletions: 1 });
    expect(page.hunks[0].lines.slice(0, 3)).toEqual([
      { type: "context", oldLine: 1, newLine: 1, text: "export default function Home() {" },
      { type: "del", oldLine: 2, text: "  return <h1>Hello</h1>;" },
      { type: "add", newLine: 2, text: "  return <h1>Hello world</h1>;" },
    ]);
    expect(files[1]).toMatchObject({ additions: 2, deletions: 0 });
    expect(files[2]).toMatchObject({ additions: 0, deletions: 1 });
  });
});
