export async function readProjectStream<T extends { done?: boolean; error?: string }>(response: Response, onChunk: (chunk: T) => void) {
  if (!response.body) throw new Error("Streaming response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as T;
    if (chunk.error) throw new Error(chunk.error);
    if (completed) throw new Error("Received score data after stream completion.");
    onChunk(chunk);
    if (chunk.done) completed = true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) dispatch(line);
      if (done) break;
    }
    dispatch(buffer);
    if (!completed) throw new Error("The score stream was interrupted before saving was confirmed.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
