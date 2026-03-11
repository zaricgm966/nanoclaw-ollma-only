export interface SseClient {
  id: string;
  write: (chunk: string) => void;
  close: () => void;
}

export function writeJson(
  write: (chunk: string) => void,
  event: string,
  data: unknown,
): void {
  write(`event: ${event}\n`);
  write(`data: ${JSON.stringify(data)}\n\n`);
}
