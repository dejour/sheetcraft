import type { Score } from "../shared";

export type SavedScore = {
  project: { id: string; title?: string; r2_key?: string | null };
  musicxml: string;
  score: Score;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
};

type QueueState = { tail: Promise<void>; generation: number; confirmed: SavedScore; pending: number };

export class ScoreSaveQueue {
  private states = new Map<string, QueueState>();

  constructor(private send: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  confirmed(projectId: string): SavedScore | undefined {
    return this.states.get(projectId)?.confirmed;
  }

  async flush(projectId: string): Promise<void> {
    const state = this.states.get(projectId);
    await state?.tail;
    if (state?.generation) throw new Error("The previous edit could not be saved. Reload the score before starting an AI edit.");
  }

  save(previous: SavedScore, musicxml: string): Promise<SavedScore> {
    const projectId = previous.project.id;
    let state = this.states.get(projectId);
    if (!state || state.pending === 0) {
      state = { tail: Promise.resolve(), generation: 0, confirmed: previous, pending: 0 };
      this.states.set(projectId, state);
    }
    const queue = state;
    const generation = queue.generation;
    queue.pending++;
    const result = queue.tail.then(async () => {
      if (generation !== queue.generation) throw new Error("Saving stopped after an earlier edit failed. Your last saved score has been restored.");
      try {
        const response = await this.send(`/api/projects/${projectId}/operations`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ musicxml, expectedR2Key: queue.confirmed.project.r2_key })
        });
        if (!response.ok) throw new Error(await response.text());
        const saved = await response.json() as SavedScore;
        queue.confirmed = saved;
        return saved;
      } catch (error) {
        queue.generation++;
        throw error;
      }
    });
    queue.tail = result.then(() => undefined, () => undefined).finally(() => { queue.pending--; });
    return result;
  }
}
