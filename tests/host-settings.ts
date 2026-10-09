import type { ParameterSpec } from "@foss-earth/ui/settings";
export const HOST_MAP_PARAMETERS: readonly ParameterSpec[] = [
  { id: "map.imagery.concurrentRequests", label: "2D imagery requests at once", description: "Host request budget.", unit: "count", kind: "number", bounds: () => ({ min: 1, max: 32 }), step: 1, default: 6, defaultReason: "Host baseline.", home: { tab: "map", section: "loading", level: "main" }, appliesLive: true, source: "host/engine.ts" },
  { id: "map.retryDelay", label: "Retry delay", description: "Host retry range.", unit: "s", kind: "range", bounds: () => ({ min: 0.25, max: 600 }), default: { min: 2, max: 30 }, defaultReason: "Host baseline.", home: { tab: "map", section: "loading", level: "all" }, appliesLive: true, source: "host/engine.ts" },
];
