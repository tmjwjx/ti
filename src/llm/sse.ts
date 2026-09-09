// 把 SSE 的 data: 行解析成 JSON
// 一帧可能跨多个 TCP 包，不完整的尾巴留在缓冲区等下次拼
export async function* sseJson(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let sse = "";
  for await (const chunk of res.body as any) {
    sse += decoder.decode(chunk as Uint8Array, { stream: true });
    const events = sse.split("\n\n");
    sse = events.pop()!;
    for (const raw of events)
      for (const line of raw.split("\n"))
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") yield JSON.parse(data);
        }
  }
}
