import type { SourceFile } from "./sources";
import { detectLanguage } from "./languages";

export interface ApiEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface RepoMap {
  fileCount: number;
  languages: Array<{ language: string; files: number; share: number }>;
  tree: string;
  dependencies: Array<{ manifest: string; runtime: string[]; dev: string[] }>;
  entryPoints: string[];
  endpoints: ApiEndpoint[];
  readmeExcerpt: string | null;
  configFiles: string[];
}

/**
 * A structural digest of the repository, computed once at ingestion and
 * injected into *every* answer prompt.
 *
 * ## Why this exists
 * Pure similarity search is bad at whole-repo questions. "What API endpoints
 * does this expose?" has no single chunk that answers it — the answer is
 * spread across twenty route files, and top-12 retrieval sees a fraction of
 * them. "What are the dependencies?" retrieves an import statement rather than
 * the manifest. "How does this work?" matches nothing in particular.
 *
 * Precomputing the answers to that class of question and always including them
 * turned out to be the single largest quality improvement in this project, and
 * it costs one cheap pass over files we have already read. Retrieval then
 * handles what it is genuinely good at: specific, local questions.
 */
export function buildRepoMap(files: SourceFile[]): RepoMap {
  return {
    fileCount: files.length,
    languages: summariseLanguages(files),
    tree: buildTree(files),
    dependencies: extractDependencies(files),
    entryPoints: detectEntryPoints(files),
    endpoints: detectEndpoints(files),
    readmeExcerpt: extractReadme(files),
    configFiles: files
      .filter((f) => detectLanguage(f.path)?.kind === "config")
      .map((f) => f.path)
      .slice(0, 40),
  };
}

function summariseLanguages(files: SourceFile[]) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const spec = detectLanguage(file.path);
    if (!spec) continue;
    counts.set(spec.language, (counts.get(spec.language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({
      language,
      files: count,
      share: Math.round((count / files.length) * 100),
    }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10);
}

/**
 * A directory tree, pruned to stay useful inside a prompt.
 *
 * Full trees of a real repo run to thousands of lines and would dominate the
 * context budget. Depth 3 with per-directory file counts keeps the shape of
 * the project legible in ~40 lines.
 */
function buildTree(files: SourceFile[], maxDepth = 3, maxEntries = 60): string {
  const directories = new Map<string, number>();

  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 1; depth <= Math.min(parts.length - 1, maxDepth); depth++) {
      const dir = parts.slice(0, depth).join("/");
      directories.set(dir, (directories.get(dir) ?? 0) + 1);
    }
  }

  const rootFiles = files.filter((f) => !f.path.includes("/")).map((f) => f.path);

  const lines = [...directories.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxEntries)
    .map(([dir, count]) => {
      const depth = dir.split("/").length - 1;
      return `${"  ".repeat(depth)}${dir.split("/").pop()}/  (${count} files)`;
    });

  return [...rootFiles.slice(0, 20).map((f) => f), ...lines].join("\n");
}

const MANIFEST_HANDLERS: Array<{
  match: RegExp;
  parse: (content: string) => { runtime: string[]; dev: string[] };
}> = [
  {
    match: /(^|\/)package\.json$/,
    parse: (content) => {
      try {
        const json = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return {
          runtime: Object.keys(json.dependencies ?? {}),
          dev: Object.keys(json.devDependencies ?? {}),
        };
      } catch {
        return { runtime: [], dev: [] };
      }
    },
  },
  {
    match: /(^|\/)requirements(-dev)?\.txt$/,
    parse: (content) => ({
      runtime: content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(/[=<>!~[\s]/)[0])
        .filter(Boolean),
      dev: [],
    }),
  },
  {
    match: /(^|\/)go\.mod$/,
    parse: (content) => ({
      runtime: [...content.matchAll(/^\s+([\w.\-/]+)\s+v[\d.]/gm)].map((m) => m[1]),
      dev: [],
    }),
  },
  {
    match: /(^|\/)(pyproject\.toml|Cargo\.toml)$/,
    parse: (content) => {
      const section = content.match(/\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?:\n\[|$)/);
      if (!section) return { runtime: [], dev: [] };
      return {
        runtime: [...section[1].matchAll(/^\s*([\w.-]+)\s*=/gm)].map((m) => m[1]),
        dev: [],
      };
    },
  },
  {
    match: /(^|\/)Gemfile$/,
    parse: (content) => ({
      runtime: [...content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      dev: [],
    }),
  },
  {
    match: /(^|\/)pom\.xml$/,
    parse: (content) => ({
      runtime: [...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)]
        .map((m) => m[1])
        .slice(1, 60),
      dev: [],
    }),
  },
];

function extractDependencies(files: SourceFile[]): RepoMap["dependencies"] {
  const out: RepoMap["dependencies"] = [];
  for (const file of files) {
    const handler = MANIFEST_HANDLERS.find((h) => h.match.test(file.path));
    if (!handler) continue;
    const { runtime, dev } = handler.parse(file.content);
    if (runtime.length || dev.length) {
      out.push({ manifest: file.path, runtime: runtime.slice(0, 80), dev: dev.slice(0, 40) });
    }
  }
  return out.slice(0, 6);
}

const ENTRY_POINT_PATTERNS = [
  /^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/,
  /^(src\/)?app\/(layout|page)\.(tsx|jsx)$/,
  /^cmd\/[\w-]+\/main\.go$/,
  /^(src\/)?main\/java\/.*Application\.java$/,
  /^manage\.py$/,
  /^Dockerfile$/,
  /^docker-compose\.ya?ml$/,
];

function detectEntryPoints(files: SourceFile[]): string[] {
  return files
    .map((f) => f.path)
    .filter((path) => ENTRY_POINT_PATTERNS.some((p) => p.test(path)))
    .slice(0, 15);
}

/**
 * Route detection across the frameworks most likely to show up.
 *
 * Regexes over source text, not a parse — so this is a high-recall hint list
 * for the model, not a guaranteed-complete API reference. The prompt says as
 * much, so the model treats it as evidence to confirm against retrieved code
 * rather than as ground truth to recite.
 */
const ROUTE_PATTERNS: Array<{ regex: RegExp; method?: string }> = [
  // Express / Koa / Fastify / NestJS-style chained routers
  { regex: /\b(?:app|router|server|api)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*["'`]([^"'`]+)/gi },
  // FastAPI / Flask decorators
  { regex: /@(?:app|router|blueprint|bp)\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)/gi },
  // Spring
  { regex: /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)/g },
  // Go net/http and chi/gorilla
  { regex: /\b(?:http|mux|r|router)\.(HandleFunc|Get|Post|Put|Patch|Delete)\s*\(\s*["`]([^"`]+)/g },
  // Django
  { regex: /\bpath\s*\(\s*["']([^"']*)["']/g, method: "ANY" },
  // Rails
  { regex: /^\s*(get|post|put|patch|delete)\s+["']([^"']+)/gim },
];

function detectEndpoints(files: SourceFile[]): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();

  const push = (method: string, path: string, file: string, line: number) => {
    const key = `${method} ${path} ${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({ method: method.toUpperCase(), path, file, line });
  };

  for (const file of files) {
    // Next.js App Router: the file path *is* the route, and the exported HTTP
    // verbs are the supported methods.
    const appRoute = file.path.match(/(?:^|\/)app\/(.+)\/route\.(ts|js|tsx|jsx)$/);
    if (appRoute) {
      const routePath =
        "/" +
        appRoute[1]
          .replace(/\/?\(.*?\)/g, "") // route groups
          .replace(/\[\.\.\.(\w+)\]/g, ":$1*")
          .replace(/\[(\w+)\]/g, ":$1")
          .replace(/^\/+/, "");
      const methods = [
        ...file.content.matchAll(
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g,
        ),
      ].map((m) => m[1]);
      for (const method of methods.length ? methods : ["ANY"]) {
        push(method, routePath, file.path, 1);
      }
      continue;
    }

    // Next.js Pages Router
    const pagesRoute = file.path.match(/(?:^|\/)pages\/api\/(.+)\.(ts|js)$/);
    if (pagesRoute) {
      push("ANY", "/api/" + pagesRoute[1].replace(/\/index$/, ""), file.path, 1);
      continue;
    }

    if (file.content.length > 200_000) continue;

    for (const { regex, method: fixedMethod } of ROUTE_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) !== null) {
        const method = fixedMethod ?? (match.length > 2 ? match[1] : "ANY");
        const path = match.length > 2 ? match[2] : match[1];
        if (!path || !path.startsWith("/")) continue;
        const line = file.content.slice(0, match.index).split("\n").length;
        push(method === "route" ? "ANY" : method, path, file.path, line);
        if (endpoints.length > 200) break;
      }
    }
  }

  return endpoints.slice(0, 120);
}

function extractReadme(files: SourceFile[]): string | null {
  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f.path));
  if (!readme) return null;
  return readme.content.slice(0, 3_000);
}

/** Render the map for inclusion in the system prompt. */
export function renderRepoMap(map: RepoMap, repoName: string): string {
  const sections: string[] = [`# Repository: ${repoName}`, ""];

  sections.push(
    `## Composition`,
    `${map.fileCount} indexed files.`,
    map.languages.map((l) => `- ${l.language}: ${l.files} files (${l.share}%)`).join("\n"),
    "",
  );

  sections.push("## Directory structure", "```", map.tree, "```", "");

  if (map.entryPoints.length) {
    sections.push("## Likely entry points", map.entryPoints.map((e) => `- ${e}`).join("\n"), "");
  }

  if (map.dependencies.length) {
    sections.push("## Declared dependencies");
    for (const dep of map.dependencies) {
      sections.push(`From \`${dep.manifest}\`:`);
      if (dep.runtime.length) sections.push(`- runtime: ${dep.runtime.join(", ")}`);
      if (dep.dev.length) sections.push(`- dev: ${dep.dev.join(", ")}`);
    }
    sections.push("");
  }

  if (map.endpoints.length) {
    sections.push(
      "## Detected HTTP routes",
      "(Found by static pattern matching — treat as a lead to verify against retrieved code, not as a complete list.)",
      map.endpoints
        .slice(0, 60)
        .map((e) => `- ${e.method} ${e.path} — ${e.file}:${e.line}`)
        .join("\n"),
      "",
    );
  }

  if (map.readmeExcerpt) {
    sections.push("## README (excerpt)", map.readmeExcerpt, "");
  }

  return sections.join("\n");
}
