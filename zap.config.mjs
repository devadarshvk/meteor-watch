export default {
  environment: "stage",        // only stage is supported right now
  widgets: "../zap-widgets",
  sources: {
    localDomains: [
      { path: "./zap", openApiUrl: "http://localhost:9001/openapi.json" },
    ],
  },
};