/** Structural host capability; Sky does not depend on Engine. */
export interface SkyComputeLease { readonly lanes: number; release(outcome?: "useful" | "stale" | "failed" | "retired"): void }
export interface SkyComputeAdmission { acquire(request?: { lanes?: number; signal?: AbortSignal }): Promise<SkyComputeLease> }
