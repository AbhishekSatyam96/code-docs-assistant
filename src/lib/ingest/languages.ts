/**
 * Language detection and file-selection rules.
 *
 * Pure module (no Node built-ins, no `server-only`) so the unit tests can
 * import it directly.
 */

export type ChunkKind = "code" | "doc" | "config";

interface LanguageSpec {
  language: string;
  kind: ChunkKind;
  /** Line prefixes that begin a semantic unit (function, class, section…). */
  unitStart?: RegExp;
  /** Line comment marker, used to build the contextual chunk header. */
  comment: string;
}

const BY_EXTENSION: Record<string, LanguageSpec> = {};

function register(extensions: string[], spec: LanguageSpec) {
  for (const ext of extensions) BY_EXTENSION[ext] = spec;
}

/**
 * The `unitStart` patterns are intentionally shallow — they find declaration
 * boundaries, not a full parse. See `chunker.ts` for why a real parser was
 * considered and rejected for this scope.
 */
const C_FAMILY_UNIT =
  /^\s*(?:@[\w.]+|(?:export\s+)?(?:default\s+)?(?:public|private|protected|internal|static|final|abstract|async|declare|readonly)?\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|impl|trait|namespace|module|record|const\s+\w+\s*=\s*(?:async\s*)?\(|def|fn|func|var\s+\w+\s*=\s*function|sub|proc)\b)/;

register([".ts", ".tsx", ".mts", ".cts"], {
  language: "typescript",
  kind: "code",
  unitStart: C_FAMILY_UNIT,
  comment: "//",
});
register([".js", ".jsx", ".mjs", ".cjs"], {
  language: "javascript",
  kind: "code",
  unitStart: C_FAMILY_UNIT,
  comment: "//",
});
register([".py"], {
  language: "python",
  kind: "code",
  unitStart: /^\s*(?:@[\w.]+|(?:async\s+)?def\s|class\s)/,
  comment: "#",
});
register([".go"], {
  language: "go",
  kind: "code",
  unitStart: /^\s*(?:func|type|var|const)\s/,
  comment: "//",
});
register([".rs"], {
  language: "rust",
  kind: "code",
  unitStart: /^\s*(?:#\[|(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s)/,
  comment: "//",
});
register([".java"], { language: "java", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".kt", ".kts"], { language: "kotlin", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".rb"], {
  language: "ruby",
  kind: "code",
  unitStart: /^\s*(?:def|class|module)\s/,
  comment: "#",
});
register([".php"], { language: "php", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".cs"], { language: "csharp", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".c", ".h"], { language: "c", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".cpp", ".cc", ".hpp", ".hh", ".cxx"], {
  language: "cpp",
  kind: "code",
  unitStart: C_FAMILY_UNIT,
  comment: "//",
});
register([".swift"], { language: "swift", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".scala"], { language: "scala", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });
register([".sh", ".bash", ".zsh"], {
  language: "bash",
  kind: "code",
  unitStart: /^\s*(?:function\s+\w+|\w+\s*\(\s*\)\s*\{)/,
  comment: "#",
});
register([".sql"], {
  language: "sql",
  kind: "code",
  unitStart: /^\s*(?:CREATE|ALTER|DROP|INSERT|SELECT|WITH)\b/i,
  comment: "--",
});
register([".vue", ".svelte"], { language: "html", kind: "code", unitStart: C_FAMILY_UNIT, comment: "//" });

register([".md", ".mdx", ".markdown"], {
  language: "markdown",
  kind: "doc",
  unitStart: /^#{1,6}\s/,
  comment: "<!--",
});
register([".rst", ".txt", ".adoc"], { language: "text", kind: "doc", comment: "#" });

register([".json", ".jsonc"], { language: "json", kind: "config", comment: "//" });
register([".yaml", ".yml"], { language: "yaml", kind: "config", comment: "#" });
register([".toml"], { language: "toml", kind: "config", comment: "#" });
register([".ini", ".cfg", ".conf", ".env", ".properties"], {
  language: "ini",
  kind: "config",
  comment: "#",
});
register([".xml", ".gradle"], { language: "xml", kind: "config", comment: "<!--" });
register([".css", ".scss", ".less"], { language: "css", kind: "code", comment: "//" });
register([".html", ".htm"], { language: "html", kind: "code", comment: "<!--" });
register([".graphql", ".gql"], { language: "graphql", kind: "code", comment: "#" });
register([".proto"], { language: "protobuf", kind: "code", unitStart: /^\s*(?:message|service|rpc|enum)\s/, comment: "//" });

/** Extensionless files that are still worth indexing. */
const BY_BASENAME: Record<string, LanguageSpec> = {
  dockerfile: { language: "dockerfile", kind: "config", comment: "#" },
  makefile: { language: "makefile", kind: "config", comment: "#" },
  procfile: { language: "text", kind: "config", comment: "#" },
  license: { language: "text", kind: "doc", comment: "#" },
  readme: { language: "markdown", kind: "doc", unitStart: /^#{1,6}\s/, comment: "<!--" },
};

export function detectLanguage(filePath: string): LanguageSpec | null {
  const base = filePath.split("/").pop()!.toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const spec = BY_EXTENSION[base.slice(dot)];
    if (spec) return spec;
  }
  return BY_BASENAME[base] ?? null;
}

/**
 * Directories and files excluded from indexing.
 *
 * This is the highest-leverage quality control in the whole pipeline: a single
 * `node_modules` or `package-lock.json` slipping through buries the repo's
 * real code under tens of thousands of irrelevant chunks, and retrieval
 * quality collapses. Exclusion happens before anything is embedded, so it also
 * dominates ingestion cost.
 */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  ".next", ".nuxt", ".turbo", ".cache", "coverage", "vendor", "venv", ".venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", ".vscode",
  "bin", "obj", "Pods", ".terraform", "site-packages", ".yarn", "bower_components",
  "__snapshots__", ".husky", "migrations/versions",
]);

const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.d\.ts$/,          // generated type declarations, rarely the answer
  /\.(png|jpe?g|gif|svg|ico|webp|bmp|pdf|zip|gz|tar|jar|war|exe|dll|so|dylib|woff2?|ttf|eot|mp[34]|mov|wasm|bin|lock)$/i,
  /(^|\/)\.DS_Store$/,
];

export function shouldIndex(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(segment)) return false;
    // Hidden directories, except a few that carry real signal.
    if (segment.startsWith(".") && ![".github", ".claude"].includes(segment)) return false;
  }
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) return false;
  return detectLanguage(relativePath) !== null;
}

/**
 * Cheap binary sniff: NUL bytes, or a high proportion of non-printable
 * characters, mean this is not source we can usefully embed.
 */
export function looksBinary(sample: string): boolean {
  if (sample.includes("\u0000")) return true;
  let suspicious = 0;
  const limit = Math.min(sample.length, 2_000);
  for (let i = 0; i < limit; i++) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 65533) suspicious++;
  }
  return limit > 0 && suspicious / limit > 0.15;
}
