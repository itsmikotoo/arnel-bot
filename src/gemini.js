const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = status => [408, 429, 500, 502, 503, 504].includes(status);
export class Gemini {
  constructor(config, logger, fetchFn = fetch) { this.config = config; this.logger = logger; this.fetch = fetchFn; }
  async generate({ system, history = [], parts, signal }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [...history, { role: 'user', parts }],
      generationConfig: { temperature: this.config.temperature, maxOutputTokens: this.config.outputTokens },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`;
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey },
          body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs),
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(`Gemini HTTP ${response.status}: ${String(json.error?.message || 'gagal').slice(0, 240)}`);
          if (!transient(response.status)) throw error;
          last = error;
          const wait = Math.min(8000, Number(response.headers?.get?.('retry-after')) * 1000 || 700 * 2 ** (attempt - 1) + Math.random() * 300);
          if (attempt < 3) { this.logger.warn({ attempt, status: response.status }, 'retry Gemini'); await sleep(wait); }
          continue;
        }
        const reply = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
        if (!reply) throw new Error(`Gemini tidak menghasilkan teks (finish=${json.candidates?.[0]?.finishReason || json.promptFeedback?.blockReason || '?'})`);
        return reply;
      } catch (error) {
        if (signal?.aborted) throw error;
        last = error;
        if (!['TimeoutError', 'TypeError'].includes(error.name) || attempt === 3) break;
        this.logger.warn({ attempt, error: error.message }, 'retry koneksi Gemini');
        await sleep(700 * 2 ** (attempt - 1));
      }
    }
    throw last;
  }
}
export function toGeminiHistory(items) {
  const result = [];
  for (const item of items) {
    const role = item.role === 'assistant' ? 'model' : 'user';
    if (result.at(-1)?.role === role) result.at(-1).parts[0].text += `\n${item.content}`;
    else result.push({ role, parts: [{ text: item.content }] });
  }
  while (result[0]?.role === 'model') result.shift();
  return result;
}
