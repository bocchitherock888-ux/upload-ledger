import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// Keep the actual licence text for every installed production dependency.
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = [
  "# Third-party notices\n\nVersions are pinned in package-lock.json. These licences govern their respective dependencies.",
];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (!path || entry.dev) continue;
  let pkg, names;
  try {
    pkg = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
    names = await readdir(path);
  } catch {
    continue;
  } // Optional platform packages may be absent.
  const texts = [];
  for (const name of names
    .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
    .sort()) {
    try {
      texts.push(await readFile(resolve(path, name), "utf8"));
    } catch {
      /* directory */
    }
  }
  sections.push(
    `## ${pkg.name} ${pkg.version}\n\nDeclared licence: ${pkg.license ?? entry.license ?? "See package"}\n\n${texts.map((text) => "```text\n" + text.trim() + "\n```").join("\n\n")}`,
  );
}
await writeFile("THIRD_PARTY_NOTICES.md", sections.join("\n\n") + "\n");
