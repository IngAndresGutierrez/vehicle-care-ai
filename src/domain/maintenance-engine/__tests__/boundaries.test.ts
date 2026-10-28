import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const DOMAIN_DIR = join(__dirname, "..", "..");

// Refuerza en tests la regla de ESLint: el dominio no depende de LLM, Prisma, Next.js ni capas externas.
const FORBIDDEN = [
  /from ["'](next|react|react-dom)(\/[^"']*)?["']/,
  /from ["'](@prisma\/[^"']*|prisma(\/[^"']*)?)["']/,
  /from ["'](@anthropic-ai\/[^"']*|openai|ai|@ai-sdk\/[^"']*)["']/,
  /from ["']@\/(infra|integrations|agent|application|app|generated)(\/[^"']*)?["']/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("frontera del dominio", () => {
  it("ningún archivo de src/domain importa LLM, Prisma, Next.js ni capas externas", () => {
    const violations = sourceFiles(DOMAIN_DIR).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN.filter((re) => re.test(text)).map((re) => `${relative(DOMAIN_DIR, file)} ⟶ ${re}`);
    });
    expect(violations).toEqual([]);
  });
});
