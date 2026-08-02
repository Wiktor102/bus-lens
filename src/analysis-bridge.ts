import { createExternalStore } from "./external-store.ts";
import { EMPTY_ANALYSIS_SNAPSHOT, type AnalysisSnapshot } from "./analysis.ts";

const analysisStore = createExternalStore<AnalysisSnapshot, Record<string, never>>(EMPTY_ANALYSIS_SNAPSHOT, {});

export const getAnalysisSnapshot = analysisStore.getSnapshot;
export const subscribeToAnalysis = analysisStore.subscribe;
export const publishAnalysisSnapshot = analysisStore.publish;
