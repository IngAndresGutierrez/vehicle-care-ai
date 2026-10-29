import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "vehicle-care-web";
export default defineRailway(() => {
  const vehicleCareWeb = service("vehicle-care-web", {
    source: github("IngAndresGutierrez/vehicle-care-ai"),
    build: { buildCommand: "pnpm build", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["src/**", "prisma/**", "public/**", "package.json", "pnpm-lock.yaml", "next.config.ts", "prisma.config.ts", ".railway/**"] },
    start: "pnpm exec next start --hostname 0.0.0.0",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    preDeploy: "pnpm db:migrate:deploy",
    replicas: { "us-east4-eqdc4a": 1 },
  });

  return project("vehicle-care-ai", {
    variables: { managed: false },
    resources: [vehicleCareWeb],
  });
});
