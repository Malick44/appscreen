import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat, zodResponsesFunction } from 'openai/helpers/zod';
import sharp from 'sharp';
import { createSpendGuard } from './spend-guard.mjs';
import { createOpenAIProvider } from './provider.mjs';

// Explicit fixture rates; every test below uses an in-memory client or mocked
// fetch. No keys, environment, live endpoint, database or provider is consulted.
const rates = () => ({ model: 'gpt-6-astra', serviceTier: 'default', verified: true, verifiedAt: '2026-09-07', inputMicroUsdPerMillion: 10_000_000, cachedInputMicroUsdPerMillion: 1_000_000, cacheWriteMicroUsdPerMillion: 12_500_000, outputMicroUsdPerMillion: 50_000_000 });
const schema = z.object({ answer: z.string() }).strict();
const request = () => ({ model: 'gpt-6-astra', store: false, max_output_tokens: 100, instructions: 'Analyze only the supplied synthetic content.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Synthetic screenshot evaluation' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'high' }] }], text: { format: zodTextFormat(schema, 'fixture') } });
const usage = () => ({ input_tokens: 100, output_tokens: 40, total_tokens: 140, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }, output_tokens_details: { reasoning_tokens: 10 } });
const response = () => ({ id: 'response-fixture', model: 'gpt-6-astra', service_tier: 'default', status: 'completed', usage: usage(), output: [], output_parsed: { answer: 'Fixture' } });
const wire = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  const calls = { count: [], parse: [] };
  const client = { maxRetries: 0, baseURL: 'https://api.openai.com/v1', responses: {
    inputTokens: { count: async (payload, options) => { calls.count.push({ payload, options }); return { object: 'response.input_tokens', input_tokens: 100 }; } },
    parse: async (payload, options) => { calls.parse.push({ payload, options }); return response(); },
  } };
  const config = { client, rateCard: rates(), budgetMicroUsd: 100_000, maxCalls: 7, maxInputTokens: 40_000, maxOutputTokens: 100, timeoutMs: 1000, ...options };
  return { client, calls, config, guard: () => createSpendGuard(config) };
}
async function stopped(guard, code) {
  assert.equal(guard.snapshot().stopped, true); if (code) assert.equal(guard.snapshot().stopCode, code);
  await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_STOPPED' });
}

test('guard counts the exact immutable image/instruction/schema fields, forces retries0/default tier and keeps full holds', async () => {
  const f = fixture(), guard = f.guard(), payload = request(), before = wire(payload);
  await guard.client.responses.parse(payload);
  const counted = f.calls.count[0], sent = f.calls.parse[0];
  assert.deepEqual(wire(counted.payload), Object.fromEntries(Object.entries(before).filter(([key]) => !['store', 'max_output_tokens'].includes(key))));
  for (const key of Object.keys(counted.payload)) assert.deepEqual(wire(sent.payload[key]), wire(counted.payload[key]));
  assert.equal(sent.payload.store, false); assert.equal(sent.payload.service_tier, 'default');
  assert.equal(counted.options.maxRetries, 0); assert.equal(sent.options.maxRetries, 0); assert.equal(sent.options.timeout, 1000);
  assert.ok(Object.isFrozen(sent.payload.input[0].content)); assert.notEqual(sent.payload.input, payload.input);
  assert.equal(Object.getOwnPropertyDescriptor(sent.payload.text.format, '$parseRaw').enumerable, false);
  const state = guard.snapshot();
  assert.equal(state.reservedUpperBoundMicroUsd, 6250); assert.equal(state.remainingUnreservedMicroUsd, 93750);
  assert.equal(state.measuredCostPicoUsd, '2895000000'); assert.equal(state.measuredCostMicroUsdCeiling, 2895);
  assert.equal(state.callsMeasured, 1); assert.equal(state.callsSubmitted, 1); assert.equal(state.costEvidenceComplete, true);
  assert.equal(state.reservations[0].tokens.output, 40, 'reasoning is already included in output and must not be charged twice');
  state.reservations[0].reservedUpperBoundMicroUsd = 0; assert.equal(guard.snapshot().reservations[0].reservedUpperBoundMicroUsd, 6250);
});

test('mutation after token counting starts cannot change generated inputs or schemas', async () => {
  const f = fixture(); let unblock, started;
  const pause = new Promise(resolve => { unblock = resolve; }), counted = new Promise(resolve => { started = resolve; });
  f.client.responses.inputTokens.count = async payload => { f.calls.count.push({ payload }); started(); await pause; return { object: 'response.input_tokens', input_tokens: 100 }; };
  const guard = f.guard(), payload = request(), pending = guard.client.responses.parse(payload), original = wire(payload);
  await counted; payload.model = 'a-cheaper-looking-alias'; payload.input[0].content[0].text = 'Changed after counting'; payload.text.format.schema.properties.answer.type = 'number'; payload.max_output_tokens = 99999;
  unblock(); await pending;
  assert.deepEqual(wire(f.calls.parse[0].payload), { ...original, service_tier: 'default' });
});

test('optional durable hook is awaited after counting and reserving, with frozen numeric facts only', async () => {
  let release, entered, guard;
  const pendingHook = new Promise(resolve => { release = resolve; }), hookEntered = new Promise(resolve => { entered = resolve; });
  const facts = [], f = fixture({ reserveBeforeSubmit: async details => {
    facts.push(details);
    assert.equal(f.calls.count.length, 1); assert.equal(f.calls.parse.length, 0);
    assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); assert.equal(guard.snapshot().callsSubmitted, 0);
    assert.deepEqual(details, { call: 1, reservedUpperBoundMicroUsd: 6250, inputTokensCounted: 100, maxOutputTokens: 100 });
    assert.deepEqual(Reflect.ownKeys(details).sort(), ['call', 'inputTokensCounted', 'maxOutputTokens', 'reservedUpperBoundMicroUsd']);
    assert.ok(Object.values(details).every(Number.isSafeInteger)); assert.ok(Object.isFrozen(details));
    assert.throws(() => { details.reservedUpperBoundMicroUsd = 0; }, TypeError);
    entered(); await pendingHook;
  } });
  guard = f.guard(); const payload = request(), original = wire(payload), pending = guard.client.responses.parse(payload);
  await hookEntered;
  assert.equal(f.calls.parse.length, 0);
  payload.input[0].content[0].text = 'Changed during durable reservation';
  release(); await pending;
  assert.equal(facts.length, 1); assert.equal(f.calls.parse.length, 1);
  assert.deepEqual(wire(f.calls.parse[0].payload), { ...original, service_tier: 'default' });
  assert.equal(guard.snapshot().callsSubmitted, 1); assert.equal(guard.snapshot().reservations[0].status, 'measured');
});

test('durable reservation failures stop permanently without sending, retrying, releasing or leaking errors', async t => {
  for (const failure of ['throw', 'reject', 'timeout', 'abort']) await t.test(failure, async () => {
    const controller = new AbortController(); let hookCalls = 0, finishLate;
    const f = fixture({ timeoutMs: failure === 'timeout' ? 10 : 1000, reserveBeforeSubmit: () => {
      hookCalls++;
      if (failure === 'throw') throw new Error('private storage path and credential detail');
      if (failure === 'reject') return Promise.reject(new Error('private storage path and credential detail'));
      if (failure === 'abort') controller.abort();
      return new Promise(resolve => { finishLate = resolve; });
    } }), guard = f.guard();
    const results = await Promise.allSettled([guard.client.responses.parse(request(), { signal: controller.signal }), guard.client.responses.parse(request())]);
    assert.equal(results[0].reason.code, 'SPEND_RESERVATION_FAILED'); assert.doesNotMatch(results[0].reason.message, /private storage|credential detail/);
    assert.equal(results[1].reason.code, 'SPEND_STOPPED'); assert.equal(hookCalls, 1);
    assert.equal(f.calls.count.length, 1); assert.equal(f.calls.parse.length, 0);
    assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); assert.equal(guard.snapshot().remainingUnreservedMicroUsd, 93750);
    assert.equal(guard.snapshot().callsSubmitted, 0); assert.equal(guard.snapshot().callsMeasured, 0);
    assert.equal(guard.snapshot().reservations[0].status, 'not-submitted');
    finishLate?.(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.parse.length, 0, 'Late durable completion must not dispatch a model request');
    await stopped(guard, 'SPEND_RESERVATION_FAILED'); assert.equal(hookCalls, 1);
  });
});

test('client mutation during durable reservation cannot bypass reviewed transport configuration', async t => {
  for (const key of ['baseURL', 'maxRetries']) await t.test(key, async () => {
    const f = fixture({ reserveBeforeSubmit: async () => { f.client[key] = key === 'baseURL' ? 'https://example.invalid/v1' : 1; } }), guard = f.guard();
    await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_INVALID_CLIENT' });
    assert.equal(f.calls.parse.length, 0); assert.equal(guard.snapshot().callsSubmitted, 0);
    assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); assert.equal(guard.snapshot().reservations[0].status, 'not-submitted');
    await stopped(guard, 'SPEND_INVALID_CLIENT');
  });
});

test('a guard stopped while the durable hook is pending cannot later submit its reserved request', async () => {
  let release, entered;
  const pause = new Promise(resolve => { release = resolve; }), hookEntered = new Promise(resolve => { entered = resolve; });
  const f = fixture({ reserveBeforeSubmit: async () => { entered(); await pause; } }), guard = f.guard();
  const pending = guard.client.responses.parse(request()); await hookEntered;
  await assert.rejects(guard.client.responses.parse({ ...request(), store: true }), { code: 'SPEND_UNSUPPORTED_REQUEST' });
  release(); await assert.rejects(pending, { code: 'SPEND_STOPPED' });
  assert.equal(f.calls.parse.length, 0); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250);
  assert.equal(guard.snapshot().callsSubmitted, 0); assert.equal(guard.snapshot().reservations[0].status, 'not-submitted');
});

test('durable reservations serialize with the whole request and keep increasing call numbers', async () => {
  const events = [], f = fixture({ budgetMicroUsd: 12500, reserveBeforeSubmit: async details => {
    events.push(`reserve:${details.call}`); await new Promise(resolve => setImmediate(resolve)); events.push(`durable:${details.call}`);
  } });
  const parse = f.client.responses.parse;
  f.client.responses.parse = async (...args) => { events.push(`submit:${f.calls.parse.length + 1}`); return parse(...args); };
  const guard = f.guard(), results = await Promise.allSettled([1, 2, 3].map(() => guard.client.responses.parse(request())));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.deepEqual(events, ['reserve:1', 'durable:1', 'submit:1', 'reserve:2', 'durable:2', 'submit:2']);
  assert.equal(results[2].reason.code, 'SPEND_BUDGET_EXCEEDED'); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 12500);
});

test('invalid input or count and insufficient run allowance never invoke the durable hook', async t => {
  for (const failure of ['request', 'count', 'budget']) await t.test(failure, async () => {
    let calls = 0;
    const f = fixture({ reserveBeforeSubmit: async () => { calls++; }, ...(failure === 'budget' ? { budgetMicroUsd: 6249 } : {}) });
    if (failure === 'count') f.client.responses.inputTokens.count = async () => ({ object: 'response.input_tokens', input_tokens: -1 });
    const guard = f.guard(); await assert.rejects(guard.client.responses.parse({ ...request(), ...(failure === 'request' ? { store: true } : {}) }));
    assert.equal(calls, 0); assert.equal(f.calls.parse.length, 0); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 0);
  });
});

test('client configuration mutation while counting fails before any model request', async () => {
  const f = fixture(); f.client.responses.inputTokens.count = async () => { f.client.baseURL = 'https://example.invalid/v1'; return { object: 'response.input_tokens', input_tokens: 100 }; };
  const guard = f.guard(); await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_INVALID_CLIENT' });
  assert.equal(f.calls.parse.length, 0); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 0); await stopped(guard);
});

test('exact reservation cap admits equality, rejects one microUSD less and never refunds unused output', async () => {
  for (const budget of [6249, 6250]) {
    const f = fixture({ budgetMicroUsd: budget }), guard = f.guard();
    if (budget === 6249) { await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_BUDGET_EXCEEDED' }); assert.equal(f.calls.parse.length, 0); }
    else { await guard.client.responses.parse(request()); assert.equal(guard.snapshot().remainingUnreservedMicroUsd, 0); await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_BUDGET_EXCEEDED' }); assert.equal(f.calls.count.length, 1); }
    await stopped(guard, 'SPEND_BUDGET_EXCEEDED');
  }
});

test('integer arithmetic conservatively rounds sub-microUSD reservations without rounding actual token cost', async () => {
  const f = fixture({ budgetMicroUsd: 2, rateCard: { ...rates(), inputMicroUsdPerMillion: 1, cachedInputMicroUsdPerMillion: 1, cacheWriteMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1 }, maxOutputTokens: 16 });
  f.client.responses.inputTokens.count = async () => ({ object: 'response.input_tokens', input_tokens: 1 });
  f.client.responses.parse = async () => ({ ...response(), usage: { input_tokens: 1, output_tokens: 16, total_tokens: 17, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
  const guard = f.guard(), input = { ...request(), max_output_tokens: 16 };
  await guard.client.responses.parse(input); await guard.client.responses.parse(input);
  assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 2); assert.equal(guard.snapshot().measuredCostPicoUsd, '34'); assert.equal(guard.snapshot().measuredCostMicroUsdCeiling, 1);
  await assert.rejects(guard.client.responses.parse(input), { code: 'SPEND_BUDGET_EXCEEDED' });
});

test('parallel callers serialize count/reserve/send and cannot spend the same remaining allowance', async () => {
  const f = fixture({ budgetMicroUsd: 12500 }); let active = 0, maximum = 0;
  f.client.responses.parse = async payload => { f.calls.parse.push({ payload }); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return response(); };
  const guard = f.guard(), results = await Promise.allSettled([1, 2, 3].map(() => guard.client.responses.parse(request())));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.code, 'SPEND_BUDGET_EXCEEDED'); assert.equal(maximum, 1); assert.equal(f.calls.parse.length, 2);
  assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 12500);
});

test('call limit blocks even a small affordable call before counting again', async () => {
  const f = fixture({ maxCalls: 1 }), guard = f.guard(); await guard.client.responses.parse(request());
  await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_CALL_LIMIT' }); assert.equal(f.calls.count.length, 1);
});

test('invalid and unverified rates/client/limits fail before any transport call', async t => {
  const cases = [
    ['unverified', c => { c.rateCard.verified = false; }], ['missing date', c => { delete c.rateCard.verifiedAt; }], ['invalid date', c => { c.rateCard.verifiedAt = 'not-a-date'; }],
    ['unsupported model', c => { c.rateCard.model = 'gpt-5.6-sol'; }], ['non-default tier', c => { c.rateCard.serviceTier = 'priority'; }],
    ['missing cache-write price', c => { delete c.rateCard.cacheWriteMicroUsdPerMillion; }], ['null Astra cache-write price', c => { c.rateCard.cacheWriteMicroUsdPerMillion = null; }],
    ['fractional price', c => { c.rateCard.inputMicroUsdPerMillion = 0.5; }], ['zero price', c => { c.rateCard.cachedInputMicroUsdPerMillion = 0; }], ['negative price', c => { c.rateCard.outputMicroUsdPerMillion = -1; }],
    ['unsafe price', c => { c.rateCard.outputMicroUsdPerMillion = Number.MAX_SAFE_INTEGER + 1; }], ['NaN price', c => { c.rateCard.inputMicroUsdPerMillion = NaN; }], ['string price', c => { c.rateCard.inputMicroUsdPerMillion = '10000000'; }],
    ['zero budget', c => { c.budgetMicroUsd = 0; }], ['fractional budget', c => { c.budgetMicroUsd = 2.5; }], ['input threshold', c => { c.maxInputTokens = 272000; }],
    ['excessive output', c => { c.maxOutputTokens = 128001; }], ['excessive calls', c => { c.maxCalls = 21; }], ['missing timeout', c => { delete c.timeoutMs; }],
    ['automatic retries', c => { c.client.maxRetries = 2; }], ['alternate API base', c => { c.client.baseURL = 'https://example.invalid/v1'; }],
    ...[null, false, 1, {}, 'reserve'].map(value => ['invalid durable hook', c => { c.reserveBeforeSubmit = value; }]),
  ];
  for (const [label, mutate] of cases) await t.test(label, () => { const f = fixture(); mutate(f.config); assert.throws(f.guard); assert.equal(f.calls.parse.length + f.calls.count.length, 0); });
});

test('unsupported fields, hosted tools and executable/mutable request shapes fail closed', async t => {
  const cases = [
    ['model mismatch', p => { p.model = 'gpt-5.6-sol'; }], ['priority tier', p => { p.service_tier = 'priority'; }], ['stored responses', p => { p.store = true; }],
    ...['conversation', 'previous_response_id', 'stream', 'background', 'metadata', 'prompt', 'prompt_cache_options', 'max_tool_calls'].map(field => [field, p => { p[field] = 'not-reviewed'; }]),
    ['remote image', p => { p.input[0].content[1].image_url = 'https://example.invalid/pixel.png'; }], ['file input', p => { p.input[0].content[1] = { type: 'input_file', file_id: 'file_123' }; }],
    ['hosted tool', p => { delete p.text; p.tools = [{ type: 'web_search' }]; }], ['unreviewed reasoning', p => { p.reasoning = { effort: 'none' }; }],
    ['output over cap', p => { p.max_output_tokens = 101; }], ['getter', p => { Object.defineProperty(p, 'instructions', { enumerable: true, get: () => { throw new Error('must never invoke'); } }); }],
    ['toJSON', p => { p.toJSON = () => ({ model: 'other' }); }], ['symbol field', p => { p[Symbol('hidden')] = 'unsafe'; }], ['cyclic schema', p => { p.text.format.schema.self = p.text.format.schema; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => { const f = fixture(), guard = f.guard(), p = request(); mutate(p); await assert.rejects(guard.client.responses.parse(p)); assert.equal(f.calls.count.length + f.calls.parse.length, 0); await stopped(guard); });
  await t.test('per-call retry/header/timeout overrides are refused', async () => { const f = fixture(), guard = f.guard(); await assert.rejects(guard.client.responses.parse(request(), { maxRetries: 5 })); assert.equal(f.calls.count.length, 0); });
});

test('missing, malformed and excessive token counts stop before model dispatch', async t => {
  for (const value of [undefined, -1, 0.25, true, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 40001]) await t.test(String(value), async () => {
    const f = fixture(); f.client.responses.inputTokens.count = async () => ({ object: 'response.input_tokens', input_tokens: value }); const guard = f.guard();
    await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_INVALID_COUNT' }); assert.equal(f.calls.parse.length, 0); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 0); await stopped(guard);
  });
});

test('missing or inconsistent usage blocks permanently and is unknown, never zero dollars', async t => {
  const cases = [
    ['missing usage', r => { delete r.usage; }], ['missing input details', r => { delete r.usage.input_tokens_details; }], ['missing cached tokens', r => { delete r.usage.input_tokens_details.cached_tokens; }],
    ['missing cache-write count', r => { delete r.usage.input_tokens_details.cache_write_tokens; }], ['negative cache-write count', r => { r.usage.input_tokens_details.cache_write_tokens = -1; }],
    ['cached plus writes exceed input', r => { r.usage.input_tokens_details.cached_tokens = 99; }], ['total mismatch', r => { r.usage.total_tokens = 141; }],
    ['actual input exceeds counted bound', r => { r.usage.input_tokens = 101; r.usage.total_tokens = 141; }], ['output exceeds allowance', r => { r.usage.output_tokens = 101; r.usage.total_tokens = 201; }],
    ['NaN output', r => { r.usage.output_tokens = NaN; }], ['boolean input', r => { r.usage.input_tokens = true; }], ['reasoning exceeds output', r => { r.usage.output_tokens_details.reasoning_tokens = 41; }],
    ['response model changed', r => { r.model = 'gpt-6-astra-other'; }], ['response tier changed', r => { r.service_tier = 'priority'; }], ['missing response tier', r => { delete r.service_tier; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const f = fixture(); f.client.responses.parse = async () => { const r = response(); mutate(r); return r; }; const guard = f.guard();
    await assert.rejects(guard.client.responses.parse(request())); const state = guard.snapshot();
    assert.equal(state.reservedUpperBoundMicroUsd, 6250); assert.equal(state.callsMeasured, 0); assert.equal(state.measuredCostPicoUsd, null); assert.equal(state.measuredCostMicroUsdCeiling, null); assert.equal(state.costEvidenceComplete, false); assert.equal(state.reservations[0].status, 'uncertain'); await stopped(guard);
  });
});

test('incomplete response with valid usage records measured cost but ends the run', async () => {
  const f = fixture(); f.client.responses.parse = async () => ({ ...response(), status: 'incomplete' }); const guard = f.guard();
  await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_INCOMPLETE' }); assert.equal(guard.snapshot().measuredCostPicoUsd, '2895000000'); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); await stopped(guard);
});

test('timeout/abort/network/parse failure retain reservations and stop queued calls', async t => {
  for (const failure of ['timeout', 'network', 'parse']) await t.test(failure, async () => {
    const f = fixture({ timeoutMs: 10 }); f.client.responses.parse = async () => { f.calls.parse.push({}); if (failure === 'timeout') return new Promise(() => {}); throw new Error(`sensitive upstream ${failure} detail`); }; const guard = f.guard();
    const results = await Promise.allSettled([guard.client.responses.parse(request()), guard.client.responses.parse(request())]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].reason.code, 'SPEND_STOPPED'); assert.doesNotMatch(results[0].reason.message, /sensitive/);
    assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); assert.equal(guard.snapshot().measuredCostPicoUsd, null); assert.equal(f.calls.parse.length, 1); await stopped(guard);
  });
  await t.test('abort after dispatch keeps its reservation', async () => {
    const f = fixture(), controller = new AbortController(); f.client.responses.parse = async () => { controller.abort(); return new Promise(() => {}); }; const guard = f.guard();
    await assert.rejects(guard.client.responses.parse(request(), { signal: controller.signal }), { code: 'SPEND_ABORTED' }); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); await stopped(guard);
  });
  await t.test('count timeout stops without a model reservation', async () => {
    const f = fixture({ timeoutMs: 10 }); f.client.responses.inputTokens.count = async () => new Promise(() => {}); const guard = f.guard();
    await assert.rejects(guard.client.responses.parse(request()), { code: 'SPEND_TIMEOUT' }); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 0); assert.equal(guard.snapshot().callsSubmitted, 0); await stopped(guard);
  });
});

test('real installed SDK plus provider preserve strict text/tool parsing and identical counted wire fields', async t => {
  for (const stage of ['analyzing', 'refining']) await t.test(stage, async () => {
    const seen = [], result = { answer: 'Synthetic evidence only' };
    const client = new OpenAI({ apiKey: 'offline-mock-not-a-key', baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 1000, fetch: async (url, options) => {
      const parsed = JSON.parse(options.body); seen.push({ url: String(url), body: parsed });
      if (String(url).endsWith('/responses/input_tokens')) return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const output = stage === 'refining' ? [{ type: 'function_call', id: 'fc1', call_id: 'call1', name: 'apply_campaign_edits', arguments: JSON.stringify(result) }] : [{ type: 'message', id: 'msg1', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result), annotations: [] }] }];
      return new Response(JSON.stringify({ ...response(), object: 'response', output }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const guard = createSpendGuard({ ...fixture().config, client }), provider = createOpenAIProvider({ client: guard.client, model: 'gpt-6-astra', maxOutputTokens: 100 });
    const png = await sharp({ create: { width: 64, height: 128, channels: 3, background: '#ccf0f1' } }).png().toBuffer();
    const answer = await provider.generate({ stage, schema, instructions: 'Use only this fixture', data: { synthetic: true }, images: [{ label: 'Synthetic marker', bytes: png }] });
    assert.deepEqual(answer, result); assert.equal(seen.length, 2);
    for (const [key, value] of Object.entries(seen[0].body)) assert.deepEqual(seen[1].body[key], value);
    assert.ok(seen[0].body.input[0].content.some(content => content.type === 'input_image')); assert.equal(seen[1].body.service_tier, 'default');
    assert.equal(JSON.stringify(seen).includes('$parseRaw'), false); assert.equal(guard.snapshot().callsMeasured, 1);
  });
  await t.test('SDK Zod parse failure is inside the reservation, not outside the guard', async () => {
    const client = new OpenAI({ apiKey: 'offline-mock-not-a-key', maxRetries: 0, fetch: async url => new Response(JSON.stringify(String(url).endsWith('/responses/input_tokens') ? { object: 'response.input_tokens', input_tokens: 100 } : { ...response(), object: 'response', output: [{ type: 'message', id: 'msg1', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":12}', annotations: [] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const guard = createSpendGuard({ ...fixture().config, client }), provider = createOpenAIProvider({ client: guard.client, maxOutputTokens: 100 });
    await assert.rejects(provider.generate({ stage: 'analyzing', schema, instructions: '', data: {} }), { code: 'SPEND_UNCERTAIN_REQUEST' });
    assert.equal(guard.snapshot().measuredCostPicoUsd, null); assert.equal(guard.snapshot().reservedUpperBoundMicroUsd, 6250); await stopped(guard);
  });
});
