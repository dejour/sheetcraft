// Consume only complete JSON lines; never apply a partially received measure.
export async function readGenerationLines(
  chunks: AsyncIterable<string>,
  onOperation: (value: unknown) => void
): Promise<void> {
  let pending = "";
  let done = false;
  function consume(line: string) {
    if (!line.trim()) return;
    if (done) throw new Error("Unexpected content after generation completed.");
    const value = JSON.parse(line);
    if (value?.done === true) done = true;
    else onOperation(value);
  }
  for await (const chunk of chunks) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  if (pending.trim()) consume(pending);
  if (!done) throw new Error("The model stream ended before completing the piece.");
}
