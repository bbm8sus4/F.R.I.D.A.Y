// AI Provider — Gemini with tool/function calling support

export function createProvider(env) {
  return new GeminiProvider(env);
}

class GeminiProvider {
  constructor(env) {
    this.apiKey = env.GEMINI_API_KEY;
    this.model = env.GEMINI_MODEL || 'gemini-2.5-pro';
    this.fallbackModel = env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-pro';
    this.temperature = parseFloat(env.GEMINI_TEMPERATURE || '0.2');
    this.maxRetries = parseInt(env.GEMINI_MAX_RETRIES || '2');
  }

  async complete({ systemPrompt, messages, tools, generationConfig }) {
    const model = this.model;
    const result = await this._call(model, { systemPrompt, messages, tools, generationConfig });
    if (result.error && result.retryable) {
      // Try fallback model
      const fallback = await this._call(this.fallbackModel, { systemPrompt, messages, tools, generationConfig });
      return { ...fallback, model: this.fallbackModel };
    }
    return { ...result, model };
  }

  async _call(model, { systemPrompt, messages, tools, generationConfig }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const contents = messages.map(m => {
      if (m.role === 'user') {
        return { role: 'user', parts: m.parts || [{ text: m.content }] };
      }
      if (m.role === 'model') {
        return { role: 'model', parts: m.parts || [{ text: m.content }] };
      }
      return m;
    });

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: generationConfig?.maxOutputTokens || 4096,
        ...(generationConfig?.thinkingConfig ? { thinkingConfig: generationConfig.thinkingConfig } : {}),
      },
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      body.tools = [{ function_declarations: tools }, { google_search: {} }];
    } else {
      body.tools = [{ google_search: {} }];
    }

    let response;
    let lastError;
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) break;
        lastError = await response.text();
        const status = response.status;
        console.error(`Secretary Gemini error (attempt ${attempt + 1}/${maxAttempts}):`, status, lastError.substring(0, 300));
        if (status === 429 || status >= 500) continue;
        break; // 4xx non-429 — don't retry
      } catch (e) {
        clearTimeout(timeout);
        lastError = e.message;
        console.error(`Secretary Gemini fetch error (attempt ${attempt + 1}/${maxAttempts}):`, e.message);
        if (attempt === maxAttempts - 1) break;
      }
    }

    if (!response?.ok) {
      return { error: true, retryable: true, errorMessage: lastError || 'API call failed' };
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      return { error: true, retryable: false, errorMessage: 'JSON parse error' };
    }

    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      return { error: true, retryable: false, errorMessage: 'Safety block' };
    }

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Extract text (skip thinking parts)
    let text = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].text && !parts[i].thought) {
        text = parts[i].text;
        break;
      }
    }

    // Extract function calls
    const toolCalls = parts
      .filter(p => p.functionCall)
      .map(p => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));

    // Build usage info
    const usage = data.usageMetadata || {};

    return {
      text,
      toolCalls,
      parts, // raw parts for multi-turn continuation
      finishReason: candidate?.finishReason,
      usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
      },
    };
  }
}
