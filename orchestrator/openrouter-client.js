/**
 * OpenRouter API Client
 * 다양한 AI 모델을 OpenRouter를 통해 호출하는 공통 모듈
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 모델별 대략적인 단가 (USD per 1M tokens) — 2026Q1 기준
const PRICING = {
  'openai/o3-mini':                     { input: 1.10,  output: 4.40 },
  'anthropic/claude-3.5-sonnet':        { input: 3.00,  output: 15.00 },
  'moonshot/kimi-v1-8k':                  { input: 0.14,  output: 0.59 },
  'google/gemini-2.5-pro':              { input: 1.25,  output: 5.00 },
  'qwen/qwen-2.5-coder-32b-instruct':  { input: 0.10,  output: 0.30 },
};

/**
 * OpenRouter에 채팅 요청을 보냅니다.
 * @param {string} model - OpenRouter 모델 ID (예: 'anthropic/claude-3.5-sonnet')
 * @param {Array} messages - [{role: 'system'|'user'|'assistant', content: '...'}]
 * @param {Object} options - { temperature, max_tokens, stream }
 * @returns {Object} { content, usage: { prompt_tokens, completion_tokens, total_tokens }, costUSD }
 */
async function chat(model, messages, options = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  }

  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 4096,
  };

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://agent-mission-control.local',
      'X-Title': 'Agent Mission Control',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API 오류 (${response.status}): ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // 비용 계산
  const pricing = PRICING[model] || { input: 1, output: 3 };
  const costUSD =
    (usage.prompt_tokens / 1_000_000) * pricing.input +
    (usage.completion_tokens / 1_000_000) * pricing.output;

  return { content, usage, costUSD: Math.round(costUSD * 10000) / 10000 };
}

/**
 * 에이전트 역할에 맞는 모델을 .env에서 읽어 호출합니다.
 * @param {string} role - 에이전트 역할 (architect, orchestrator, worker, designer, reviewer, integrator)
 * @param {Array} messages
 * @param {Object} options
 */
async function callAgent(role, messages, options = {}) {
  const envKey = `AGENT_${role.toUpperCase()}`;
  const model = process.env[envKey];
  if (!model) throw new Error(`환경변수 ${envKey}가 설정되지 않았습니다.`);
  return chat(model, messages, options);
}

module.exports = { chat, callAgent, PRICING };
