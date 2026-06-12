import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default {
  environment: "stage",        // only stage is supported right now
  widgets: resolve(rootDir, "../zap-widgets"),
  sources: {
    localDomains: [
      { path: resolve(rootDir, "zap"), openApiUrl: "http://localhost:9001/openapi.json" },
    ],
  },
};