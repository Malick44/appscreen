import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { z } from 'zod';
import { createOpenAIProvider } from './provider.mjs';
import { EditSchema } from './contracts.mjs';

test('Responses adapter uses private image inputs and strict output schemas with store disabled', async () => {
  let payload;
  const schema = z.object({ answer: z.string() }).strict();
  const provider = createOpenAIProvider({ client: { responses: { parse: async request => { payload = request; return { id: 'r1', status: 'completed', usage: { total_tokens: 25 }, output_parsed: { answer: 'Tasks' }, output: [] }; } } } });
  const png = await sharp({ create: { width: 3000, height: 6000, channels: 4, background: '#eeeeee' } }).png().toBuffer();
  const usage = [];
  const result = await provider.generate({ stage: 'analyzing', schema, instructions: 'Analyze the capture', data: { sourceId: 'owned-source' }, images: [{ label: 'owned-source', bytes: png }], onUsage: entry => usage.push(entry) });
  assert.equal(result.answer, 'Tasks');
  assert.equal(payload.store, false);
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.text.format.schema.additionalProperties, false);
  const image = payload.input[0].content.find(content => content.type === 'input_image');
  assert.match(image.image_url, /^data:image\/jpeg;base64,/);
  const metadata = await sharp(Buffer.from(image.image_url.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.height, 2048);
  assert.equal(metadata.hasAlpha, false);
  assert.equal(usage[0].responseId, 'r1');
});

test('editing stages expose exactly one strict application tool and reject unexpected tool calls', async () => {
  let payload;
  const result = { explanation: 'No change needed', edits: [] };
  let toolName = 'apply_campaign_edits';
  const provider = createOpenAIProvider({ client: { responses: { parse: async request => { payload = request; return { id: 'r2', status: 'completed', output: [{ type: 'function_call', name: toolName, arguments: JSON.stringify(result) }] }; } } } });
  assert.deepEqual(await provider.generate({ stage: 'refining', schema: EditSchema, instructions: '', data: {} }), result);
  assert.equal(payload.tools.length, 1);
  assert.equal(payload.tools[0].strict, true);
  assert.equal(payload.parallel_tool_calls, false);
  assert.deepEqual(payload.tool_choice, { type: 'function', name: 'apply_campaign_edits' });
  toolName = 'execute_shell';
  await assert.rejects(provider.generate({ stage: 'refining', schema: EditSchema, data: {} }), { code: 'INVALID_TOOL_CALL' });
});

test('incomplete and refused provider responses are explicit failures, with usage recorded first', async () => {
  let response = { id: 'r3', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { total_tokens: 50 }, output: [] };
  const provider = createOpenAIProvider({ client: { responses: { parse: async () => response } } });
  const usage = [];
  const request = { stage: 'analyzing', schema: z.object({ answer: z.string() }), data: {}, onUsage: entry => usage.push(entry) };
  await assert.rejects(provider.generate(request), { code: 'AI_INCOMPLETE' });
  assert.equal(usage.length, 1);
  response = { id: 'r4', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot process' }] }] };
  await assert.rejects(provider.generate(request), { code: 'AI_REFUSAL' });
});
