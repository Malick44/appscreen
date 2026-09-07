/** Single-process, single-invocation token-spend guard for an explicitly approved
 * synthetic evaluation. NOT durable accounting, a production quota or a final
 * invoice guarantee. No keys, network calls or prices are configured here.
 *
 * Reserve-before-call guidance, reviewed 2026-09-06:
 * https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 *
 * Reservations use the highest verified input/cache-write rate and the complete
 * output allowance (including reasoning). They are never released, even after
 * success. Uncertainty permanently stops this instance; do not recreate it to
 * retry the same approved run. Storage, tools, regional/account-specific charges,
 * other runs and other processes are outside this token-only guard. An optional
 * reserveBeforeSubmit hook can require separately owned durable approval
 * accounting; this guard never retries or releases that external reservation.
 */

const MILLION = 1_000_000n;
const REQUEST_KEYS = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'text', 'reasoning', 'max_output_tokens', 'store', 'service_tier']);
const COUNT_KEYS = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'text', 'reasoning'];
const plain = value => !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class SpendGuardError extends Error {
  constructor(code, message) { super(message); this.name = 'SpendGuardError'; this.code = code; }
}
function ensure(condition, code, message) { if (!condition) throw new SpendGuardError(code, message); }
function integer(value, minimum, maximum, label, code = 'SPEND_INVALID_CONFIG') {
  ensure(Number.isSafeInteger(value) && value >= minimum && value <= maximum, code, `${label} must be an integer within the approved limits.`); return value;
}
const ceilMicroUsd = picoUsd => Number((picoUsd + MILLION - 1n) / MILLION);
function keys(value, allowed, label) {
  ensure(plain(value) && Object.keys(value).every(key => allowed.includes(key)), 'SPEND_UNSUPPORTED_REQUEST', `${label} contains unsupported fields.`);
}

/** Clone without invoking getters/toJSON, and freeze before the first await.
 * SDK Zod helper parsers are non-enumerable and never sent on the wire. Preserve
 * only those helper descriptors so parse/schema failures stay inside the guard;
 * the counted and generated serializable schemas/images are the same snapshot. */
function immutableSnapshot(value, path = '', seen = new Set(), depth = 0) {
  ensure(depth <= 60, 'SPEND_UNSUPPORTED_REQUEST', 'The request is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'SPEND_UNSUPPORTED_REQUEST', 'The request contains a non-finite number.'); return value; }
  ensure(typeof value === 'object' && (Array.isArray(value) || plain(value)) && !seen.has(value), 'SPEND_UNSUPPORTED_REQUEST', 'The request must contain plain serializable values.');
  seen.add(value); const result = Array.isArray(value) ? [] : {};
  const descriptors = Object.getOwnPropertyDescriptors(value), helper = path === 'text.format' ? 'auto-parseable-response-format' : /^tools\.\d+$/.test(path) ? 'auto-parseable-tool' : null;
  for (const key of Reflect.ownKeys(descriptors)) {
    ensure(typeof key === 'string' && !['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key), 'SPEND_UNSUPPORTED_REQUEST', 'The request contains an unsupported property.');
    const descriptor = descriptors[key];
    ensure(!descriptor.get && !descriptor.set, 'SPEND_UNSUPPORTED_REQUEST', 'Request accessors are not supported.');
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable) {
      ensure(helper && descriptors.$brand?.value === helper && (key === '$brand' && descriptor.value === helper || key === '$parseRaw' && typeof descriptor.value === 'function' || key === '$callback' && descriptor.value === undefined), 'SPEND_UNSUPPORTED_REQUEST', 'Only standard non-enumerable SDK parse helpers are supported.');
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: false }); continue;
    }
    if (descriptor.value === undefined) continue; // Same wire omission as the SDK.
    Object.defineProperty(result, key, { value: immutableSnapshot(descriptor.value, path ? `${path}.${key}` : key, seen, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value); return Object.freeze(result);
}

function validateRateCard(input) {
  const card = immutableSnapshot(input);
  ensure(plain(card) && card.verified === true && card.model === 'gpt-6-astra' && card.serviceTier === 'default', 'SPEND_UNVERIFIED_RATES', 'This evaluation requires explicitly verified GPT-6 Astra Standard pricing.');
  ensure(typeof card.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.verifiedAt) && new Date(`${card.verifiedAt}T00:00:00Z`).toISOString().slice(0, 10) === card.verifiedAt, 'SPEND_UNVERIFIED_RATES', 'Record the date when the explicit prices were verified.');
  for (const field of ['inputMicroUsdPerMillion', 'cachedInputMicroUsdPerMillion', 'cacheWriteMicroUsdPerMillion', 'outputMicroUsdPerMillion']) integer(card[field], 1, Number.MAX_SAFE_INTEGER, field);
  ensure(Object.keys(card).every(key => ['model', 'serviceTier', 'verified', 'verifiedAt', 'inputMicroUsdPerMillion', 'cachedInputMicroUsdPerMillion', 'cacheWriteMicroUsdPerMillion', 'outputMicroUsdPerMillion'].includes(key)), 'SPEND_UNVERIFIED_RATES', 'The rate card contains unreviewed pricing fields.');
  // Astra bills cache writes separately. A null/missing write rate is not a
  // supported way to disable that charge. No price is invented as a fallback.
  return card;
}

function validateRequest(request, card, maxOutputTokens) {
  ensure(plain(request) && Object.keys(request).every(key => REQUEST_KEYS.has(key)), 'SPEND_UNSUPPORTED_REQUEST', 'Only the reviewed synchronous evaluation request fields are supported.');
  ensure(request.model === card.model && request.store === false && (request.service_tier === undefined || request.service_tier === 'default'), 'SPEND_UNSUPPORTED_REQUEST', 'Use the reviewed model, store:false and default processing tier.');
  integer(request.max_output_tokens, 16, maxOutputTokens, 'Output allowance', 'SPEND_UNSUPPORTED_REQUEST');
  ensure(request.instructions === undefined || typeof request.instructions === 'string', 'SPEND_UNSUPPORTED_REQUEST', 'Instructions must be text.');
  if (typeof request.input === 'string') ensure(request.input.length > 0, 'SPEND_UNSUPPORTED_REQUEST', 'Input must not be empty.');
  else {
    ensure(Array.isArray(request.input) && request.input.length > 0 && request.input.length <= 20, 'SPEND_UNSUPPORTED_REQUEST', 'Use a bounded explicit text/image input.');
    for (const message of request.input) {
      keys(message, ['type', 'role', 'content'], 'Input message');
      ensure((message.type === undefined || message.type === 'message') && message.role === 'user' && Array.isArray(message.content) && message.content.length > 0 && message.content.length <= 100, 'SPEND_UNSUPPORTED_REQUEST', 'Only explicit user text/image messages are supported.');
      for (const content of message.content) {
        if (content.type === 'input_text') { keys(content, ['type', 'text'], 'Text input'); ensure(typeof content.text === 'string', 'SPEND_UNSUPPORTED_REQUEST', 'Text input must be a string.'); }
        else {
          keys(content, ['type', 'image_url', 'detail'], 'Image input');
          ensure(content.type === 'input_image' && typeof content.image_url === 'string' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(content.image_url) && ['low', 'high', 'auto'].includes(content.detail), 'SPEND_UNSUPPORTED_REQUEST', 'Only included PNG/JPEG images with explicit detail are supported.');
        }
      }
    }
  }
  if (request.tools !== undefined) {
    ensure(Array.isArray(request.tools) && request.tools.length === 1, 'SPEND_UNSUPPORTED_REQUEST', 'Only the single reviewed local design function is supported.');
    const tool = request.tools[0]; keys(tool, ['type', 'name', 'description', 'parameters', 'strict'], 'Tool');
    ensure(tool.type === 'function' && tool.name === 'apply_campaign_edits' && tool.strict === true && plain(tool.parameters) && (tool.description === undefined || typeof tool.description === 'string'), 'SPEND_UNSUPPORTED_REQUEST', 'Hosted, additional or non-strict tools are not allowed.');
    keys(request.tool_choice, ['type', 'name'], 'Tool choice');
    ensure(request.tool_choice.type === 'function' && request.tool_choice.name === tool.name && request.parallel_tool_calls === false && request.text === undefined, 'SPEND_UNSUPPORTED_REQUEST', 'Request one non-parallel local design function call.');
  } else {
    ensure(request.tool_choice === undefined && request.parallel_tool_calls === undefined, 'SPEND_UNSUPPORTED_REQUEST', 'Tool controls require the reviewed local function.');
    keys(request.text, ['format', 'verbosity'], 'Text output'); const format = request.text.format;
    keys(format, ['type', 'name', 'schema', 'description', 'strict'], 'Text schema');
    ensure(format.type === 'json_schema' && format.strict === true && plain(format.schema) && typeof format.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(format.name) && (format.description === undefined || typeof format.description === 'string') && (request.text.verbosity === undefined || ['low', 'medium', 'high'].includes(request.text.verbosity)), 'SPEND_UNSUPPORTED_REQUEST', 'Use a strict JSON output schema.');
  }
  if (request.reasoning !== undefined) {
    keys(request.reasoning, ['effort'], 'Reasoning options');
    ensure(['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning.effort), 'SPEND_UNSUPPORTED_REQUEST', 'This reasoning setting has not been reviewed.');
  }
  ensure(Buffer.byteLength(JSON.stringify(request)) <= 45 * 1024 * 1024, 'SPEND_UNSUPPORTED_REQUEST', 'The input exceeds the evaluation payload limit.');
}

function costFromUsage(usage, card, inputLimit, outputLimit) {
  const code = 'SPEND_UNCERTAIN_USAGE', token = (value, name) => integer(value, 0, Number.MAX_SAFE_INTEGER, name, code);
  ensure(plain(usage) && plain(usage.input_tokens_details), code, 'Complete input/output and cache-write usage is required.');
  const input = token(usage.input_tokens, 'Input tokens'), output = token(usage.output_tokens, 'Output tokens'), total = token(usage.total_tokens, 'Total tokens');
  const cached = token(usage.input_tokens_details.cached_tokens, 'Cached input tokens'), written = token(usage.input_tokens_details.cache_write_tokens, 'Cache-write tokens');
  ensure(input + output === total && cached + written <= input && input <= inputLimit && output <= outputLimit, code, 'Reported usage does not match the reserved request bounds.');
  if (usage.output_tokens_details !== undefined) { ensure(plain(usage.output_tokens_details), code, 'Output token details are invalid.'); ensure(token(usage.output_tokens_details.reasoning_tokens, 'Reasoning tokens') <= output, code, 'Reasoning tokens exceed total output tokens.'); }
  const cost = BigInt(input - cached - written) * BigInt(card.inputMicroUsdPerMillion) + BigInt(cached) * BigInt(card.cachedInputMicroUsdPerMillion) + BigInt(written) * BigInt(card.cacheWriteMicroUsdPerMillion) + BigInt(output) * BigInt(card.outputMicroUsdPerMillion);
  return { cost, tokens: { input, output, cached, cacheWrite: written, total } };
}

export function createSpendGuard({ client, rateCard, budgetMicroUsd, maxCalls, maxInputTokens, maxOutputTokens, timeoutMs, reserveBeforeSubmit } = {}) {
  const card = validateRateCard(rateCard);
  integer(budgetMicroUsd, 1, Number.MAX_SAFE_INTEGER, 'Budget'); integer(maxCalls, 1, 20, 'Maximum calls');
  integer(maxInputTokens, 1, 271_999, 'Maximum input tokens'); integer(maxOutputTokens, 16, 128_000, 'Maximum output tokens'); integer(timeoutMs, 1, 300_000, 'Request timeout');
  ensure(reserveBeforeSubmit === undefined || typeof reserveBeforeSubmit === 'function', 'SPEND_INVALID_CONFIG', 'The durable reservation hook must be a function when supplied.');
  ensure(client?.maxRetries === 0 && client?.baseURL === 'https://api.openai.com/v1' && typeof client?.responses?.parse === 'function' && typeof client?.responses?.inputTokens?.count === 'function', 'SPEND_INVALID_CLIENT', 'Use the official API base, explicit maxRetries:0 and a client with token counting and Responses parsing.');
  const count = client.responses.inputTokens.count.bind(client.responses.inputTokens), parse = client.responses.parse.bind(client.responses);
  const worstInputRate = [card.inputMicroUsdPerMillion, card.cachedInputMicroUsdPerMillion, card.cacheWriteMicroUsdPerMillion].reduce((a, b) => Math.max(a, b));
  let reserved = 0n, measured = 0n, submitted = 0, measuredCalls = 0, countCalls = 0, stopped = false, stopCode = null, tail = Promise.resolve();
  const reservations = [];
  const stop = error => { stopped = true; stopCode ??= error instanceof SpendGuardError ? error.code : 'SPEND_UNCERTAIN_REQUEST'; return error instanceof SpendGuardError ? error : new SpendGuardError(stopCode, 'The request outcome is uncertain. This run is stopped; its reserved allowance remains unavailable.'); };
  const assertActive = () => ensure(!stopped, 'SPEND_STOPPED', 'This run has stopped permanently. Do not recreate the guard to retry it.');
  function deadline(operation, callerSignal) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController(); let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { const error = new SpendGuardError('SPEND_ABORTED', 'The evaluation request was interrupted; the run cannot continue.'); controller.abort(error); finish(error); };
      const timer = setTimeout(() => { const error = new SpendGuardError('SPEND_TIMEOUT', 'The request timed out and may still incur a charge. Its reservation is retained.'); controller.abort(error); finish(error); }, timeoutMs);
      if (callerSignal?.aborted) return abort();
      callerSignal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { if (settled) return; return operation({ signal: controller.signal, maxRetries: 0, timeout: timeoutMs }); }).then(value => finish(null, value), error => finish(error));
    });
  }
  async function execute(request, signal) {
    let reservation;
    try {
      assertActive(); ensure(client.maxRetries === 0 && client.baseURL === 'https://api.openai.com/v1', 'SPEND_INVALID_CLIENT', 'The reviewed client configuration changed.');
      ensure(submitted < maxCalls, 'SPEND_CALL_LIMIT', 'This evaluation reached its approved model-call limit.');
      ensure(!signal?.aborted, 'SPEND_ABORTED', 'The evaluation was interrupted before submitting another request.');
      const outputReserve = BigInt(request.max_output_tokens) * BigInt(card.outputMicroUsdPerMillion);
      ensure(reserved + BigInt(ceilMicroUsd(outputReserve)) <= BigInt(budgetMicroUsd), 'SPEND_BUDGET_EXCEEDED', 'The remaining allowance cannot cover the next output allowance.');
      const countedRequest = Object.freeze(Object.fromEntries(COUNT_KEYS.filter(key => request[key] !== undefined).map(key => [key, request[key]])));
      countCalls++;
      const result = await deadline(options => count(countedRequest, options), signal);
      ensure(result?.object === 'response.input_tokens', 'SPEND_INVALID_COUNT', 'The token-count endpoint returned an unexpected result.');
      const inputTokens = integer(result.input_tokens, 0, maxInputTokens, 'Counted input tokens', 'SPEND_INVALID_COUNT');
      const amount = (BigInt(inputTokens) * BigInt(worstInputRate) + outputReserve + MILLION - 1n) / MILLION;
      ensure(client.maxRetries === 0 && client.baseURL === 'https://api.openai.com/v1', 'SPEND_INVALID_CLIENT', 'The reviewed client configuration changed while counting input.');
      assertActive(); ensure(reserved + amount <= BigInt(budgetMicroUsd), 'SPEND_BUDGET_EXCEEDED', 'The next request’s conservative reservation would exceed this run’s allowance.');
      reserved += amount;
      reservation = { call: submitted + 1, inputTokensCounted: inputTokens, maxOutputTokens: request.max_output_tokens, reservedUpperBoundMicroUsd: Number(amount), status: 'reserved', measuredCostPicoUsd: null };
      reservations.push(reservation);
      if (reserveBeforeSubmit) {
        // Only bounded numeric accounting facts cross this boundary. The caller
        // must durably reserve before resolving; errors may contain private
        // storage details, so never forward them. A late resolution after a
        // timeout cannot resume this sequence or release either reservation.
        const details = Object.freeze({ call: reservation.call, reservedUpperBoundMicroUsd: Number(amount), inputTokensCounted: inputTokens, maxOutputTokens: request.max_output_tokens });
        try { await deadline(() => reserveBeforeSubmit(details), signal); }
        catch { throw new SpendGuardError('SPEND_RESERVATION_FAILED', 'The durable approval reservation could not be confirmed. This run is stopped without submitting the model request; its allowance remains reserved.'); }
      }
      assertActive();
      ensure(!signal?.aborted, 'SPEND_ABORTED', 'The evaluation was interrupted before submitting another request.');
      ensure(client.maxRetries === 0 && client.baseURL === 'https://api.openai.com/v1', 'SPEND_INVALID_CLIENT', 'The reviewed client configuration changed before submission.');
      submitted++; reservation.status = 'submitted';
      const response = await deadline(options => parse(Object.freeze({ ...request, service_tier: 'default' }), options), signal);
      ensure(response?.model === card.model && response.service_tier === 'default', 'SPEND_UNEXPECTED_PRICING', 'The response model or processing tier differs from the verified rate card.');
      const actual = costFromUsage(response.usage, card, inputTokens, request.max_output_tokens);
      ensure(actual.cost <= amount * MILLION, 'SPEND_UNCERTAIN_USAGE', 'The measured token cost exceeds the reserved upper bound.');
      measured += actual.cost; measuredCalls++; reservation.measuredCostPicoUsd = actual.cost.toString(); reservation.tokens = actual.tokens;
      ensure(typeof response.id === 'string' && response.id.length > 0 && Array.isArray(response.output) && response.output.every(item => ['message', 'reasoning', 'function_call'].includes(item?.type)), 'SPEND_UNEXPECTED_RESPONSE', 'The response contains unsupported or missing output information.');
      const functions = response.output.filter(item => item.type === 'function_call');
      ensure(!functions.length || request.tools && functions.length === 1 && functions[0].name === request.tools[0].name, 'SPEND_UNEXPECTED_RESPONSE', 'The response contains an unexpected tool call.');
      ensure(response.status === 'completed', 'SPEND_INCOMPLETE', 'The response did not complete. This run is stopped with usage recorded.');
      reservation.status = 'measured'; return response;
    } catch (error) { if (reservation) reservation.status = reservation.status === 'reserved' ? 'not-submitted' : reservation.measuredCostPicoUsd === null ? 'uncertain' : 'measured-stopped'; throw stop(error); }
  }
  function guardedParse(input, options = {}) {
    let request, signal;
    try {
      assertActive(); request = immutableSnapshot(input); validateRequest(request, card, maxOutputTokens);
      keys(options, ['signal'], 'Request options');
      const signalDescriptor = Object.getOwnPropertyDescriptor(options, 'signal');
      ensure(!signalDescriptor?.get && !signalDescriptor?.set, 'SPEND_UNSUPPORTED_REQUEST', 'Request-option accessors are not supported.'); signal = signalDescriptor?.value;
      ensure(signal === undefined || signal instanceof AbortSignal, 'SPEND_UNSUPPORTED_REQUEST', 'Only a standard abort signal may be supplied.');
    } catch (error) { return Promise.reject(stop(error)); }
    // Queue the complete count/reserve/send/measure sequence. No concurrent call
    // can reserve the same remaining money or submit after another becomes unsure.
    const pending = tail.then(() => execute(request, signal)); tail = pending.catch(() => {}); return pending;
  }
  return Object.freeze({
    client: Object.freeze({ responses: Object.freeze({ parse: guardedParse }) }),
    snapshot() {
      return {
        scope: 'single-run-model-tokens-only', model: card.model, serviceTier: card.serviceTier, rateCardVerifiedAt: card.verifiedAt,
        budgetMicroUsd, reservedUpperBoundMicroUsd: Number(reserved), remainingUnreservedMicroUsd: Number(BigInt(budgetMicroUsd) - reserved),
        costEvidenceComplete: measuredCalls === submitted, knownMeasuredCostPicoUsd: measured.toString(),
        measuredCostPicoUsd: measuredCalls === submitted ? measured.toString() : null, measuredCostMicroUsdCeiling: measuredCalls === submitted ? ceilMicroUsd(measured) : null, callsSubmitted: submitted, callsMeasured: measuredCalls, countCalls,
        stopped, stopCode, reservations: structuredClone(reservations),
      };
    },
  });
}
