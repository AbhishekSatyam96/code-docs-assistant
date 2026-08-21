import { describe, expect, it } from "vitest";

import { detectLanguage, looksBinary, shouldIndex } from "@/lib/ingest/languages";
import { buildRepoMap } from "@/lib/ingest/repo-map";
import { isSafePath, parseGitHubUrl } from "@/lib/ingest/sources";

describe("shouldIndex", () => {
  it("indexes ordinary source and docs", () => {
    for (const path of [
      "src/index.ts",
      "app/api/users/route.ts",
      "lib/auth.py",
      "cmd/server/main.go",
      "README.md",
      "Dockerfile",
      "docker-compose.yml",
      ".github/workflows/ci.yml",
    ]) {
      expect(shouldIndex(path), path).toBe(true);
    }
  });

  it("excludes dependency, build and lock artefacts", () => {
    for (const path of [
      "node_modules/react/index.js",
      "vendor/github.com/pkg/errors/errors.go",
      "dist/bundle.js",
      ".next/server/app/page.js",
      "target/classes/Main.class",
      "package-lock.json",
      "yarn.lock",
      "go.sum",
      "coverage/lcov-report/index.html",
      "__pycache__/module.cpython-311.pyc",
      "assets/logo.png",
      "src/types/generated.d.ts",
      "public/app.min.js",
    ]) {
      expect(shouldIndex(path), path).toBe(false);
    }
  });

  it("excludes hidden directories but keeps .github", () => {
    expect(shouldIndex(".git/config")).toBe(false);
    expect(shouldIndex(".idea/workspace.xml")).toBe(false);
    expect(shouldIndex(".github/dependabot.yml")).toBe(true);
  });
});

describe("detectLanguage", () => {
  it("maps extensions to a language and a chunk kind", () => {
    expect(detectLanguage("a.ts")?.language).toBe("typescript");
    expect(detectLanguage("a.py")?.kind).toBe("code");
    expect(detectLanguage("README.md")?.kind).toBe("doc");
    expect(detectLanguage("config.yaml")?.kind).toBe("config");
    expect(detectLanguage("Dockerfile")?.language).toBe("dockerfile");
    expect(detectLanguage("mystery.xyz")).toBeNull();
  });
});

describe("looksBinary", () => {
  it("flags NUL bytes and control-character soup", () => {
    expect(looksBinary("abc\u0000def")).toBe(true);
    expect(looksBinary("\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008".repeat(20))).toBe(true);
  });

  it("accepts ordinary source, including unicode and tabs", () => {
    expect(looksBinary("const x = 1;\n\tif (x) {}\n")).toBe(false);
    expect(looksBinary("// naïve — with em dash and 日本語\n")).toBe(false);
  });
});

describe("parseGitHubUrl", () => {
  it("accepts the URL shapes people actually paste", () => {
    expect(parseGitHubUrl("https://github.com/expressjs/express")).toMatchObject({
      owner: "expressjs",
      repo: "express",
      ref: null,
    });
    expect(parseGitHubUrl("https://github.com/owner/repo.git")).toMatchObject({
      repo: "repo",
    });
    expect(parseGitHubUrl("  https://www.github.com/owner/repo/  ")).toMatchObject({
      owner: "owner",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/develop")).toMatchObject({
      ref: "develop",
    });
  });

  it("rejects non-GitHub hosts — this is the SSRF boundary", () => {
    for (const url of [
      "https://gitlab.com/owner/repo",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "https://github.com.evil.test/owner/repo",
      "not a url",
    ]) {
      expect(() => parseGitHubUrl(url), url).toThrow();
    }
  });
});

describe("isSafePath", () => {
  it("rejects traversal, absolute paths and NUL injection", () => {
    expect(isSafePath("src/index.ts")).toBe(true);
    expect(isSafePath("../../etc/passwd")).toBe(false);
    expect(isSafePath("a/../../b")).toBe(false);
    expect(isSafePath("/etc/passwd")).toBe(false);
    expect(isSafePath("C:\\Windows\\System32")).toBe(false);
    expect(isSafePath("src/\u0000evil.ts")).toBe(false);
    expect(isSafePath("")).toBe(false);
  });
});

describe("buildRepoMap", () => {
  const files = [
    {
      path: "package.json",
      bytes: 120,
      content: JSON.stringify({
        dependencies: { express: "^4.18.0", zod: "^3.22.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
    },
    {
      path: "src/server.js",
      bytes: 200,
      content: [
        "const app = express();",
        "app.get('/health', (req, res) => res.send('ok'));",
        "app.post('/api/users', createUser);",
        "app.listen(3000);",
      ].join("\n"),
    },
    {
      path: "app/api/items/[id]/route.ts",
      bytes: 100,
      content: "export async function GET() {}\nexport async function DELETE() {}",
    },
    { path: "README.md", bytes: 40, content: "# Demo\n\nA demo project." },
  ];

  it("extracts dependencies from manifests", () => {
    const map = buildRepoMap(files);
    const pkg = map.dependencies.find((d) => d.manifest === "package.json")!;
    expect(pkg.runtime).toContain("express");
    expect(pkg.dev).toContain("vitest");
  });

  it("detects Express routes with their methods", () => {
    const map = buildRepoMap(files);
    expect(map.endpoints).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/health", file: "src/server.js" }),
    );
    expect(map.endpoints).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/api/users" }),
    );
  });

  it("derives Next.js App Router routes from the file path and exported verbs", () => {
    const map = buildRepoMap(files);
    const methods = map.endpoints
      .filter((e) => e.path === "/api/items/:id")
      .map((e) => e.method)
      .sort();
    expect(methods).toEqual(["DELETE", "GET"]);
  });

  it("summarises languages and captures the README", () => {
    const map = buildRepoMap(files);
    expect(map.languages.map((l) => l.language)).toContain("typescript");
    expect(map.readmeExcerpt).toContain("A demo project");
    expect(map.fileCount).toBe(4);
  });
});
