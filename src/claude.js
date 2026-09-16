// Chamadas ao Claude. Tres formas: `ask` (texto), `askJson` (saida estruturada
// por schema) e a conta de custo. Em recusa do classificador (stop_reason
// 'refusal') a mesma chamada roda de novo no modelo de fallback: o trabalho de
// auditoria em contest e autorizado pelo protocolo, mas o classificador nao sabe.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODEL, PRICES } from './config.js';

let client = null;
export function enabled() { return !!process.env.ANTHROPIC_API_KEY; }
function getClient() {
  if (!client) client = new Anthropic({ timeout: 20 * 60 * 1000, maxRetries: 3 });
  return client;
}

export function costUsd(model, usage) {
  const p = PRICES[model] || PRICES['claude-opus-5'];
  const inp = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0) * 0.1;
  return (inp * p.in + (usage?.output_tokens || 0) * p.out) / 1_000_000;
}

// Registro de uso: quem chama passa um `meter` para somar tokens e dolares.
function meter(target, model, usage) {
  if (!target) return;
  target.inputTokens = (target.inputTokens || 0) + (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  target.outputTokens = (target.outputTokens || 0) + (usage?.output_tokens || 0);
  target.usd = (target.usd || 0) + costUsd(model, usage);
}

// Texto livre, em streaming (respostas longas: testes e relatorios).
export async function ask({ system, messages, maxTokens = MODEL.maxTokensWrite, effort = MODEL.effort, meters = [] }) {
  const c = getClient();
  let model = MODEL.main;
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = c.messages.stream({
      model, max_tokens: maxTokens, system, messages,
      output_config: { effort },
    });
    const res = await stream.finalMessage();
    meters.forEach((m) => meter(m, model, res.usage));
    if (res.stop_reason === 'refusal') {
      if (model === MODEL.fallback) throw new Error(`refused by ${model}: ${res.stop_details?.category || '?'}`);
      model = MODEL.fallback;
      continue;
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (res.stop_reason === 'max_tokens' && !text.trim()) throw new Error(`model hit max_tokens (${maxTokens}) before answering; raise MAX_TOKENS_WRITE`);
    return { text, model, usage: res.usage, stop: res.stop_reason };
  }
  throw new Error('unreachable');
}

// Saida estruturada: o modelo devolve JSON que obedece ao schema (zod).
export async function askJson({ system, messages, schema, maxTokens = MODEL.maxTokensRead, effort = MODEL.effort, meters = [] }) {
  const c = getClient();
  let model = MODEL.main;
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = c.messages.stream({
      model, max_tokens: maxTokens, system, messages,
      output_config: { effort, format: zodOutputFormat(schema) },
    });
    const res = await stream.finalMessage();
    meters.forEach((m) => meter(m, model, res.usage));
    if (res.stop_reason === 'refusal') {
      if (model === MODEL.fallback) throw new Error(`refused by ${model}: ${res.stop_details?.category || '?'}`);
      model = MODEL.fallback;
      continue;
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (res.stop_reason === 'max_tokens' && !text.trim()) throw new Error(`model hit max_tokens (${maxTokens}) before answering; raise MAX_TOKENS_READ`);
    let parsed;
    try { parsed = schema.parse(JSON.parse(text)); }
    catch (e) { throw new Error(`structured output did not parse: ${e.message}; head=${text.slice(0, 200)}`); }
    return { data: parsed, model, usage: res.usage };
  }
  throw new Error('unreachable');
}
