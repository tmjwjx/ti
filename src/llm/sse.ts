/**
 * 通用 SSE 帧解析（Anthropic / OpenAI 两条协议共用）：逐帧吐出 data 载荷的 JSON。
 * SSE 协议：事件之间以空行(\n\n)分隔，数据行形如 "data: {json}"；
 * 一个事件可能跨多个 TCP 包，用 sse 缓冲区接住不完整的一帧，等下一轮拼齐。
 */
export async function* sseJson(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let sse = "";
  for await (const chunk of res.body as any) {
    sse += decoder.decode(chunk as Uint8Array, { stream: true });
    const events = sse.split("\n\n");
    sse = events.pop()!; // 最后一段是不完整事件，留到下次拼接
    for (const raw of events)
      for (const line of raw.split("\n"))
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") yield JSON.parse(data);
        }
  }
}
