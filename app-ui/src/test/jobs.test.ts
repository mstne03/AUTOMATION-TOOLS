import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import type { Job } from "../api/types";
import { esperarJob, reiniciarJobs, seguirJob, useJobs } from "../state/jobs";

const job = (status: Job["status"], progress: number): Job => ({
  id: "j1",
  kind: "transcribe",
  args: {},
  status,
  progress,
  result: null,
  error: null,
  created_at: "2026-10-23T10:00:00Z",
  updated_at: "2026-10-23T10:00:00Z",
});

describe("store de jobs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    reiniciarJobs();
  });

  it("sondea GET /jobs cada segundo mientras haya un job activo y se detiene al acabar", async () => {
    const listJobs = vi.fn().mockResolvedValueOnce([job("running", 0.5)]).mockResolvedValueOnce([job("done", 1)]);
    const client = { listJobs } as unknown as Client;
    seguirJob(client, job("running", 0.1));
    const fin = esperarJob("j1");

    await vi.advanceTimersByTimeAsync(1000);
    expect(useJobs.getState().jobs.j1.progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await fin).status).toBe("done");

    await vi.advanceTimersByTimeAsync(5000);
    expect(listJobs).toHaveBeenCalledTimes(2); // ya no hay jobs activos: no sigue sondeando
  });

  it("un job que ya está hecho no arranca el sondeo", async () => {
    const listJobs = vi.fn();
    seguirJob({ listJobs } as unknown as Client, job("done", 1));
    expect((await esperarJob("j1")).status).toBe("done");
    await vi.advanceTimersByTimeAsync(3000);
    expect(listJobs).not.toHaveBeenCalled();
  });
});
