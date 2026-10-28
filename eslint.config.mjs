import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ARCHITECTURE.md §3: el dominio es puro. No puede depender de Next.js, React, Prisma,
// proveedores LLM ni de las capas externas (infra, integrations, agent, application, app).
const domainBoundary = {
  files: ["src/domain/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["next", "next/*", "react", "react-dom", "react/*"], message: "domain/ no depende de Next.js/React." },
          { group: ["@prisma/*", "prisma", "prisma/*", "@/generated/*"], message: "domain/ no depende de Prisma." },
          { group: ["@anthropic-ai/*", "openai", "ai", "@ai-sdk/*"], message: "domain/ no depende de LLMs." },
          {
            group: ["@/infra/*", "@/integrations/*", "@/agent/*", "@/application/*", "@/app/*"],
            message: "domain/ solo puede importar de domain/.",
          },
        ],
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  domainBoundary,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", "src/generated/**"]),
]);

export default eslintConfig;
