import test from 'node:test';
import assert from 'node:assert/strict';
import { zodTextFormat } from 'openai/helpers/zod';
import { createCampaign, applyOperations, resolveDevice, assertDocumentEditAllowed } from '../../core/campaign.mjs';
import { createAgentEngine, editsToOperations } from './engine.mjs';
import { createOpenAIProvider } from './provider.mjs';
import { assertEvidence, AnalysisSchema, AnalysisObservationsSchema, EditSchema } from './contracts.mjs';

function fixture({ mode = 'exact', count = 5, templateId = 'tidal-relay', locks } = {}) {
  const assets = Array.from({ length: count }, (_, index) => ({ id: `asset_${index}`, sourceId: `source_${index}`, name: `capture-${index}.png`, width: 1320, height: 2868, mimeType: 'image/png' }));
  let document = createCampaign({ id: 'project_1', assets, templateId, templateMode: mode, screenCount: count });
  if (locks) document = applyOperations(document, [{ op: 'set_locks', patch: locks }]);
  const brief = { appName: 'Focus', promise: 'Organize your tasks', audience: 'Busy people', confirmedFacts: ['Organize tasks into lists'], style: 'elegant', brandColors: [] };
  const checkpoints = new Map(), calls = [], saved = [], usage = [];
  let cancelled = false;
  const host = {
    getDocument: async () => document,
    getAssets: async ids => assets.filter(asset => ids.includes(asset.id)),
    getAssetBytes: async () => Buffer.from('real-fixture-bytes'),
    checkpoint: async (stage, output) => checkpoints.set(stage, structuredClone(output)),
    loadCheckpoint: async stage => checkpoints.get(stage) ?? null,
    isCancelled: async () => cancelled,
    render: async doc => ({ scenes: doc.scenes.map(scene => ({ sceneId: scene.id, png: Buffer.from('png'), width: 1320, height: 2868 })), contactSheet: Buffer.from('sheet'), issues: [] }),
    saveDraft: async (doc, qa) => { saved.push({ document: doc, qa }); return { revisionId: 'draft_1' }; },
    recordUsage: async entry => usage.push(entry),
  };
  const provider = { generate: async request => {
    calls.push(request.stage);
    await request.onUsage({ responseId: `response_${request.stage}`, input_tokens: 10, output_tokens: 10 });
    if (request.stage === 'analyzing') return { sources: assets.map(asset => ({ sourceId: asset.sourceId, summary: 'Task lists', facts: [{ statement: 'Organize tasks into lists' }], dominantColors: ['#252525'], focalPoint: { x: 50, y: 50 }, quality: 'usable', containsPrivateData: false, warnings: [] })), missingFacts: [] };
    if (request.stage === 'planning') return { templateId, direction: 'Elegant task campaign', backgroundColor: '#E9E8F7', accentColor: '#53449F', textColor: '#16141C', scenes: assets.map(asset => ({ sourceId: asset.sourceId, purpose: 'Show task organization', headline: 'Organize your tasks', subheadline: 'Keep your lists together', evidenceIds: [`${asset.sourceId}:fact-1`] })) };
    if (request.stage.startsWith('checking')) return { summary: 'Readable and coherent', issues: [] };
    return { explanation: 'Keep the chosen composition', edits: [] };
  } };
  const job = { id: 'job_1', kind: 'design', projectId: 'project_1', workspaceId: 'workspace_1', input: { revisionId: 'revision_1', brief, screenCount: count, template: { id: templateId, mode } } };
  return { assets, document, brief, checkpoints, calls, saved, usage, host, provider, job, setCancelled: value => { cancelled = value; } };
}

const edit = values => EditSchema.parse({ explanation: 'Requested change', edits: [{ type: 'device-transform', sceneId: 'scene', deviceId: null, headline: null, subheadline: null, color: null, centerX: null, centerY: null, scale: null, rotation: null, opacity: null, borderWidth: null, cornerRadius: null, evidenceIds: [], ...values }] }).edits[0];

function renameFixtureSources(f, ids) {
  const mapping = new Map(f.document.sources.map((source, index) => [source.id, ids[index]]));
  f.document.sources.forEach(source => { source.id = mapping.get(source.id); });
  f.document.scenes.forEach(scene => { scene.sourceId = mapping.get(scene.sourceId); });
  f.document.deviceGroups.forEach(group => { group.sourceId = mapping.get(group.sourceId); });
  f.assets.forEach(asset => { asset.sourceId = mapping.get(asset.sourceId); });
}

test('fresh provider schema contains strict observations without fact IDs while saved analysis remains unchanged', async () => {
  const fresh = zodTextFormat(AnalysisObservationsSchema, 'analyzing').schema;
  const canonical = zodTextFormat(AnalysisSchema, 'canonical_analysis').schema;
  const freshSource = fresh.properties.sources.items;
  assert.equal(fresh.additionalProperties, false);
  assert.equal(freshSource.additionalProperties, false);
  assert.equal(freshSource.properties.facts.items.additionalProperties, false);
  assert.deepEqual(Object.keys(freshSource.properties.facts.items.properties), ['statement']);
  assert.deepEqual(freshSource.properties.facts.items.required, ['statement']);
  assert.deepEqual(Object.keys(canonical.properties.sources.items.properties.facts.items.properties), ['id', 'statement']);
  assert.equal(freshSource.properties.facts.maxItems, 12);
  assert.ok(freshSource.required.includes('containsPrivateData'));
  assert.ok(freshSource.required.includes('quality'));

  const f = fixture({ count: 1 });
  const observations = await f.provider.generate({ stage: 'analyzing', onUsage: async () => {} });
  let payload;
  const provider = createOpenAIProvider({ client: { responses: { parse: async request => {
    payload = request;
    return { id: 'offline-observations', status: 'completed', output: [], output_parsed: observations };
  } } } });
  assert.deepEqual(await provider.generate({ stage: 'analyzing', schema: AnalysisObservationsSchema, instructions: 'Observe only', data: {} }), observations);
  assert.deepEqual(Object.keys(payload.text.format.schema.properties.sources.items.properties.facts.items.properties), ['statement']);
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.store, false);
});

test('fresh analysis assigns deterministic IDs by literal source, preserving shuffled observations and statement text', async () => {
  const f = fixture(), original = f.provider.generate;
  let observations;
  f.provider.generate = async request => {
    if (request.stage === 'analyzing') {
      assert.equal(request.schema, AnalysisObservationsSchema);
      const output = await original(request);
      output.sources.reverse();
      output.sources.forEach(source => {
        source.facts.push({ statement: `  Literal text for ${source.sourceId}: {} "quoted"\n日本語  ` });
        source.warnings = ['Visible sample only'];
      });
      observations = structuredClone(output);
      return output;
    }
    if (request.stage === 'planning') {
      for (const source of observations.sources) {
        const normalized = request.data.analysis.sources.find(item => item.sourceId === source.sourceId);
        assert.deepEqual(normalized.facts, source.facts.map((fact, index) => ({ id: `${source.sourceId}:fact-${index + 1}`, statement: fact.statement })));
        assert.equal(request.data.evidence[`${source.sourceId}:fact-2`], source.facts[1].statement);
      }
    }
    return original(request);
  };
  const engine = createAgentEngine({ provider: f.provider });
  await engine(f.job, f.host);
  const saved = f.checkpoints.get('analyzing');
  assert.deepEqual(saved.sources.map(source => ({ ...source, facts: source.facts.map(({ statement }) => ({ statement })) })), observations.sources);
  assert.deepEqual(saved.missingFacts, observations.missingFacts);
  assert.equal(new Set(saved.sources.flatMap(source => source.facts.map(fact => fact.id))).size, 10);
  const calls = [...f.calls];
  await engine(f.job, f.host);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.checkpoints.get('analyzing'), saved);
});

test('fresh observations reject missing, extra, duplicate, coerced and unselected source identities before checkpointing', async () => {
  for (const variant of ['missing', 'extra', 'duplicate', 'unselected', 'whitespace', 'numeric']) {
    const f = fixture(), original = f.provider.generate;
    f.provider.generate = async request => {
      const output = await original(request);
      assert.equal(request.stage, 'analyzing', 'Invalid source identities must not reach planning.');
      if (variant === 'missing') output.sources.pop();
      if (variant === 'extra') output.sources.push({ ...output.sources[0], sourceId: 'unselected-source' });
      if (variant === 'duplicate') output.sources[1].sourceId = output.sources[0].sourceId;
      if (variant === 'unselected') output.sources[0].sourceId = 'unselected-source';
      if (variant === 'whitespace') output.sources[0].sourceId += ' ';
      if (variant === 'numeric') output.sources[0].sourceId = 1;
      return output;
    };
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), variant === 'numeric' ? { name: 'ZodError' } : { code: 'SOURCE_MISMATCH' });
    assert.equal(f.checkpoints.has('analyzing'), false);
    assert.deepEqual(f.calls, ['analyzing']);
    assert.equal(f.usage.length, 1);
    assert.equal(f.saved.length, 0);
  }
});

test('provider fact IDs, malformed facts and missing privacy flags are not stripped or coerced', async () => {
  for (const variant of ['model-id', 'string-fact', 'numeric-statement', 'missing-private', 'invalid-quality', 'too-many-facts']) {
    const f = fixture(), original = f.provider.generate;
    f.provider.generate = async request => {
      const output = await original(request), source = output.sources[0];
      if (variant === 'model-id') source.facts[0].id = 'invented-wrong-namespace';
      if (variant === 'string-fact') source.facts = ['Organize tasks'];
      if (variant === 'numeric-statement') source.facts[0].statement = 123;
      if (variant === 'missing-private') delete source.containsPrivateData;
      if (variant === 'invalid-quality') source.quality = 'probably-usable';
      if (variant === 'too-many-facts') source.facts = Array.from({ length: 13 }, () => ({ statement: 'Observed fact' }));
      return output;
    };
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { name: 'ZodError' });
    assert.equal(f.checkpoints.has('analyzing'), false);
    assert.deepEqual(f.calls, ['analyzing']);
    assert.equal(f.saved.length, 0);
  }
});

test('canonical assignment retains private and unusable observations without authorizing another preview', async () => {
  const f = fixture(), original = f.provider.generate;
  f.job.kind = 'revision'; f.job.input.instruction = 'Improve the captions';
  let observed;
  f.provider.generate = async request => {
    const output = await original(request);
    output.sources[0].containsPrivateData = true;
    output.sources[0].quality = 'unreadable';
    output.sources[0].warnings = ['  Private account text "do not share"  '];
    output.missingFacts = ['App purpose is not visible'];
    observed = structuredClone(output);
    return output;
  };
  f.host.render = async () => assert.fail('Private/unusable captures must not authorize rendering.');
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'NEEDS_INPUT' });
  const saved = f.checkpoints.get('analyzing');
  assert.deepEqual(saved.sources[0], { ...observed.sources[0], facts: [{ id: `${observed.sources[0].sourceId}:fact-1`, statement: observed.sources[0].facts[0].statement }] });
  assert.deepEqual(saved.missingFacts, observed.missingFacts);
  assert.deepEqual(f.calls, ['analyzing']);
});

test('fresh source IDs too long or reserved fail before image bytes and model dispatch', async () => {
  for (const sourceId of ['a'.repeat(153), 'a'.repeat(160), 'brief', 'brief:source']) {
    const f = fixture({ count: 1 }); renameFixtureSources(f, [sourceId]);
    f.host.getAssetBytes = async () => assert.fail('No image read for an unusable evidence namespace.');
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'INVALID_EVIDENCE' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.usage, []);
    assert.equal(f.checkpoints.has('analyzing'), false);
  }
  const f = fixture({ count: 1 }), original = f.provider.generate, sourceId = 'a'.repeat(152);
  renameFixtureSources(f, [sourceId]);
  f.provider.generate = async request => {
    const output = await original(request);
    if (request.stage === 'analyzing') output.sources[0].facts = Array.from({ length: 12 }, () => ({ statement: 'Organize tasks into lists' }));
    return output;
  };
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(f.checkpoints.get('analyzing').sources[0].facts[11].id, `${sourceId}:fact-12`);
  assert.equal(f.checkpoints.get('analyzing').sources[0].facts[11].id.length, 160);
});

test('valid legacy evidence IDs are reused verbatim and never reassigned on checkpoint replay', async () => {
  const f = fixture(), original = f.provider.generate;
  const observations = await original({ stage: 'analyzing', onUsage: async () => {} });
  const legacy = { ...observations, sources: observations.sources.map(source => ({ ...source, facts: source.facts.map(fact => ({ ...fact, id: `${source.sourceId}:legacy_tasks` })) })) };
  f.checkpoints.set('analyzing', legacy); f.calls.length = 0;
  f.provider.generate = async request => {
    assert.notEqual(request.stage, 'analyzing');
    const output = await original(request);
    if (request.stage === 'planning') {
      assert.deepEqual(request.data.analysis, legacy);
      output.scenes.forEach(scene => { scene.evidenceIds = [`${scene.sourceId}:legacy_tasks`]; });
    }
    return output;
  };
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.deepEqual(f.checkpoints.get('analyzing'), legacy);
  assert.deepEqual(f.calls, ['planning', 'checking_0']);
});

test('five real sources become an editable exact-template draft with checkpoints and no replaced source assets', async () => {
  const f = fixture();
  const result = await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(result.revisionId, 'draft_1');
  assert.equal(result.reviewNeeded, false);
  assert.equal(f.saved[0].document.scenes.length, 5);
  assert.deepEqual(f.saved[0].document.sources, f.document.sources);
  assert.equal(f.saved[0].document.template.mode, 'exact');
  assert.deepEqual(f.calls, ['analyzing', 'planning', 'checking_0']);
  assert.equal(f.saved[0].document.scenes[0].text.headlines.en, 'Organize your tasks');
  assert.ok(f.saved[0].document.deviceGroups.some(group => f.saved[0].document.scenes.filter(scene => scene.devices.some(device => device.groupId === group.id)).length > 1));
  assert.equal(f.usage.length, 3);
});

test('exact drafts preserve canonical identities and satisfy the real revision lock validator', async () => {
  for (const count of [1, 5]) {
    const f = fixture({ count });
    f.document.scenes[0].text.headlineSize = 72;
    const original = f.provider.generate;
    f.provider.generate = async request => {
      const output = await original(request);
      if (request.stage === 'planning') output.scenes.reverse();
      return output;
    };
    const save = f.host.saveDraft;
    f.host.saveDraft = async (document, qa) => {
      assert.doesNotThrow(() => assertDocumentEditAllowed(f.document, document));
      assert.deepEqual(document.scenes.map(scene => ({ id: scene.id, devices: scene.devices, elements: scene.elements })), f.document.scenes.map(scene => ({ id: scene.id, devices: scene.devices, elements: scene.elements })));
      assert.deepEqual(document.deviceGroups.map(({ sourceId, ...group }) => group), f.document.deviceGroups.map(({ sourceId, ...group }) => group));
      assert.deepEqual(document.appearanceGroups, f.document.appearanceGroups);
      assert.equal(document.scenes[0].text.headlineSize, 72);
      assert.equal(document.scenes[0].sourceId, f.document.sources[count - 1].id);
      assert.equal(document.scenes[0].text.headlines.en, 'Organize your tasks');
      assert.notDeepEqual(document.scenes[0].background, f.document.scenes[0].background);
      return save(document, qa);
    };
    await createAgentEngine({ provider: f.provider })(f.job, f.host);
    assert.equal(f.saved.length, 1);
  }
});

test('exact composition renders the requested locale without replacing device identities', async () => {
  const f = fixture();
  f.job.input.locale = 'fr';
  const original = f.provider.generate;
  f.provider.generate = async request => {
    const output = await original(request);
    if (request.stage === 'planning') output.scenes.forEach(scene => { scene.headline = 'Organisez vos tâches'; scene.subheadline = ''; });
    return output;
  };
  const render = f.host.render;
  f.host.render = async document => { assert.equal(document.locale, 'fr'); return render(document); };
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(f.saved[0].document.scenes[0].text.headlines.fr, 'Organisez vos tâches');
  assert.deepEqual(f.saved[0].document.scenes[0].devices, f.document.scenes[0].devices);
});

test('replaying a completed job reuses stage checkpoints and never charges for new model calls or saves a second draft', async () => {
  const f = fixture();
  const run = createAgentEngine({ provider: f.provider });
  await run(f.job, f.host);
  const calls = f.calls.length;
  await run(f.job, f.host);
  assert.equal(f.calls.length, calls);
  assert.equal(f.saved.length, 1);
});

test('automatic repairs are bounded at two rounds and unresolved issues are not marked clean', async () => {
  const f = fixture();
  const original = f.provider.generate;
  f.provider.generate = async request => request.stage.startsWith('checking') ? { summary: 'Needs refinement', issues: [{ sceneId: null, deviceId: null, severity: 'warning', category: 'composition', description: 'The composition remains repetitive', suggestion: 'Try a different device placement' }] } : original(request);
  const result = await createAgentEngine({ provider: f.provider, maxRepairRounds: 100 })(f.job, f.host);
  assert.equal(result.reviewNeeded, true);
  assert.equal(result.qa.rounds, 2);
  assert.deepEqual(f.calls.filter(stage => stage.startsWith('repair')), ['repairing_1', 'repairing_2']);
});

test('delivery-only render issues survive a clean critique and checkpoint replay', async () => {
  const f = fixture(), issue = { severity: 'error', category: 'render', description: 'Final PNG headline clipped' };
  f.host.saveDraft = async (document, qa) => {
    f.saved.push({ document, qa });
    assert.deepEqual(qa.issues, []);
    return { revisionId: 'draft_1', previews: [{ assetId: 'preview_1' }], qa: { ...qa, issues: [issue], reviewNeeded: true, finalRenderChecked: true } };
  };
  const run = createAgentEngine({ provider: f.provider });
  const result = await run(f.job, f.host);
  assert.equal(result.reviewNeeded, true); assert.equal(result.qa.reviewNeeded, true);
  assert.deepEqual(result.qa.issues, [issue]); assert.equal(result.qa.finalRenderChecked, true);
  assert.deepEqual(result.previews, [{ assetId: 'preview_1' }]);
  const calls = [...f.calls];
  assert.deepEqual(await run(f.job, f.host), result);
  assert.deepEqual(f.calls, calls); assert.equal(f.saved.length, 1);
});

test('delivery QA merges with critique findings without discarding or duplicating them', async () => {
  for (const deliveryHasEarlierIssue of [false, true]) {
    const f = fixture();
    const issue = { sceneId: null, deviceId: null, severity: 'warning', category: 'composition', description: 'Composition remains repetitive', suggestion: 'Review hierarchy' };
    const finalIssue = { severity: 'error', category: 'render', description: 'Final export contrast is too low' };
    const generate = f.provider.generate;
    f.provider.generate = async request => request.stage.startsWith('checking') ? { summary: 'Needs refinement', issues: [issue] } : generate(request);
    f.host.saveDraft = async () => ({ revisionId: 'draft_1', qa: { issues: deliveryHasEarlierIssue ? [structuredClone(issue), finalIssue] : [finalIssue], reviewNeeded: false, finalRenderChecked: true } });
    const result = await createAgentEngine({ provider: f.provider, maxRepairRounds: 0 })(f.job, f.host);
    assert.deepEqual(result.qa.issues, [issue, finalIssue]);
    assert.equal(result.qa.summary, 'Needs refinement'); assert.equal(result.qa.rounds, 0);
    assert.equal(result.qa.finalRenderChecked, true); assert.equal(result.qa.reviewNeeded, true); assert.equal(result.reviewNeeded, true);
  }
});

test('an explicit delivery review requirement cannot be cleared by an empty issue list', async () => {
  for (const delivery of [{ qa: { issues: [], reviewNeeded: true } }, { reviewNeeded: true }]) {
    const f = fixture();
    f.host.saveDraft = async () => ({ revisionId: 'draft_1', ...delivery });
    const result = await createAgentEngine({ provider: f.provider })(f.job, f.host);
    assert.deepEqual(result.qa.issues, []);
    assert.equal(result.qa.reviewNeeded, true); assert.equal(result.reviewNeeded, true);
  }
});

test('selected templates cannot silently switch during planning', async () => {
  const f = fixture();
  const original = f.provider.generate;
  f.provider.generate = async request => { const output = await original(request); if (request.stage === 'planning') output.templateId = 'lavender-stage-top'; return output; };
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'TEMPLATE_CHANGED' });
  assert.equal(f.saved.length, 0);
});

test('local-only and missing explicit templates fail before asset reads or provider dispatch', async () => {
  for (const [id, code] of [['pulse-portrait', 'UNSUPPORTED_TEMPLATE'], ['missing-template', 'TEMPLATE_NOT_FOUND']]) {
    const f = fixture(); f.job.input.template.id = id;
    f.host.getAssets = async () => { throw new Error('Assets must not be read'); };
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.usage, []); assert.deepEqual(f.saved, []);
  }
});

test('revision and locked-design feature checks also protect resumed input checkpoints before AI calls', async () => {
  for (const kind of ['revision', 'design']) for (const cached of [false, true]) {
    const f = fixture({ locks: kind === 'design' ? { text: true } : undefined });
    f.document.scenes[0].background.photo = { enabled: true };
    if (cached) f.checkpoints.set('inputs', structuredClone(f.document));
    f.job.kind = kind;
    if (kind === 'revision') f.job.input.instruction = 'Shorten the headline';
    f.host.getAssets = async () => { throw new Error('Assets must not be read'); };
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'UNSUPPORTED_DESIGN' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.usage, []); assert.deepEqual(f.saved, []);
  }
});

test('automatic fresh design ignores a retained local-only selection and only offers supported templates', async () => {
  const f = fixture({ mode: 'auto' });
  f.job.input.template.id = 'pulse-portrait';
  // Without locks a fresh campaign can replace this old background.
  f.document.scenes[0].background.photo = { enabled: true };
  const generate = f.provider.generate;
  f.provider.generate = async request => {
    if (request.stage === 'planning') {
      assert.ok(request.data.templates.every(t => t.cloudCompatible === true));
      assert.ok(!request.data.templates.some(t => t.id === 'pulse-portrait'));
    }
    return generate(request);
  };
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].document.template.id, 'tidal-relay');
  assert.equal(f.saved[0].document.scenes[0].background.photo?.enabled, undefined);
});

test('historical composing checkpoints cannot trigger a new paid call with unsupported features', async () => {
  const f = fixture({ mode: 'auto' });
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  const composing = structuredClone(f.checkpoints.get('composing'));
  composing.scenes[0].background.photo = { enabled: true };
  f.checkpoints.set('composing', composing);
  for (const name of ['designing', 'checking_0', 'delivering']) f.checkpoints.delete(name);
  f.calls.length = 0; f.usage.length = 0; f.saved.length = 0;
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'UNSUPPORTED_DESIGN' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.usage, []); assert.deepEqual(f.saved, []);
});

test('out-of-project source hallucinations and invalid response schema fail closed', async () => {
  const f = fixture();
  const original = f.provider.generate;
  f.provider.generate = async request => { const output = await original(request); if (request.stage === 'planning') output.scenes[0].sourceId = 'private_other_project'; return output; };
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'UNUSABLE_SOURCE' });
  f.checkpoints.clear();
  f.provider.generate = async () => ({ invented: 'not a valid analysis' });
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { name: 'ZodError' });
});

test('all-private screenshots need replacement before campaign generation', async () => {
  const f = fixture();
  const original = f.provider.generate;
  f.provider.generate = async request => { const output = await original(request); if (request.stage === 'analyzing') output.sources.forEach(source => { source.containsPrivateData = true; }); return output; };
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'NEEDS_INPUT' });
  assert.deepEqual(f.calls, ['analyzing']);
});

test('refinement refuses a preview containing unselected captures before provider dispatch', async () => {
  const f = fixture();
  f.job.kind = 'revision'; f.job.input.instruction = 'Shorten the first headline';
  f.job.input.sourceIds = [f.document.sources[0].id];
  f.host.getAssets = async () => assert.fail('No image bytes or metadata should be read');
  f.host.render = async () => assert.fail('The unselected captures must not be rendered for AI');
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'SOURCE_CONSENT_REQUIRED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
});

test('a locked campaign cannot widen selected-source consent through its existing preview', async () => {
  const f = fixture({ locks: { text: true } });
  f.job.input.sourceIds = [f.document.sources[0].id];
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'SOURCE_CONSENT_REQUIRED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
});

test('source captures used in background or image layers remain inside preview consent', async () => {
  for (const asBackground of [true, false]) {
    const f = fixture();
    const selected = f.document.sources[0].id, omittedAsset = f.document.sources[1].assetId;
    f.document.scenes.forEach(scene => { scene.sourceId = selected; });
    f.document.deviceGroups.forEach(group => { group.sourceId = selected; });
    if (asBackground) f.document.scenes[0].background = { type: 'image', assetId: omittedAsset };
    else f.document.scenes[0].elements = [{ id: 'capture-layer', type: 'image', assetId: omittedAsset }];
    f.job.kind = 'revision'; f.job.input.instruction = 'Improve the caption';
    f.job.input.sourceIds = [selected];
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'SOURCE_CONSENT_REQUIRED' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
  }
});

test('fresh unlocked design can still compose only a selected source subset', async () => {
  const f = fixture(), selected = f.document.sources[0].id;
  f.job.input.sourceIds = [selected];
  const original = f.provider.generate;
  f.provider.generate = async request => {
    const output = await original(request);
    if (request.stage === 'analyzing') output.sources = output.sources.filter(source => source.sourceId === selected);
    if (request.stage === 'planning') output.scenes = output.scenes.map(scene => ({ ...scene, sourceId: selected, evidenceIds: [`${selected}:fact-1`] }));
    return output;
  };
  const render = f.host.render;
  f.host.render = async document => {
    assert.ok(document.scenes.every(scene => scene.sourceId === selected));
    assert.ok(document.deviceGroups.every(group => group.sourceId === selected));
    return render(document);
  };
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(f.saved.length, 1);
});

test('preview consent follows actual localized pixels and rejects unselected decorative assets', async () => {
  for (const variant of ['locale-mismatch', 'localized-layer', 'unselected-logo']) {
    const f = fixture();
    f.job.kind = 'revision'; f.job.input.instruction = 'Improve the headline';
    f.document.sources[0].localizedAssets.fr = 'french-only-asset';
    if (variant === 'locale-mismatch') f.document.locale = 'fr';
    else f.document.scenes[0].elements = [{ id: 'layer', type: 'image', assetId: variant === 'localized-layer' ? 'french-only-asset' : 'owned-but-unselected-logo' }];
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'SOURCE_CONSENT_REQUIRED' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
  }
});

test('one private or unusable capture prevents a refinement preview even when other captures are usable', async () => {
  for (const privacy of [true, false]) {
    const f = fixture();
    f.job.kind = 'revision'; f.job.input.instruction = 'Improve the captions';
    const original = f.provider.generate;
    f.provider.generate = async request => {
      const output = await original(request);
      if (request.stage === 'analyzing') {
        output.sources[1].containsPrivateData = privacy;
        output.sources[1].quality = privacy ? 'usable' : 'empty';
      }
      return output;
    };
    f.host.render = async () => assert.fail('Flagged capture must not be rendered or sent again');
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'NEEDS_INPUT' });
    assert.deepEqual(f.calls, ['analyzing']); assert.deepEqual(f.saved, []);
  }
});

test('an adverse image analysis vetoes a usable alias of the same asset', async () => {
  for (const privacy of [true, false]) {
    const f = fixture();
    f.document.sources[1].assetId = f.document.sources[0].assetId;
    f.document.sources[1].localizedAssets = structuredClone(f.document.sources[0].localizedAssets);
    const alias = f.document.sources[1].id;
    const original = f.provider.generate;
    f.provider.generate = async request => {
      const output = await original(request);
      if (request.stage === 'analyzing') {
        output.sources[0].containsPrivateData = privacy;
        output.sources[0].quality = privacy ? 'usable' : 'empty';
      }
      if (request.stage === 'planning') output.scenes = output.scenes.map(scene => ({ ...scene, sourceId: alias, evidenceIds: [`${alias}:fact-1`] }));
      return output;
    };
    f.host.render = async () => assert.fail('Flagged pixels cannot be sent again under an alias');
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'NEEDS_INPUT' });
    assert.deepEqual(f.calls, ['analyzing', 'planning']); assert.deepEqual(f.saved, []);
  }
});

test('cached analysis must still match the schema and current source selection', async () => {
  for (const variant of ['schema', 'source-identity', 'evidence-identity', 'wrong-prefix', 'duplicate-fact', 'missing-fact-id']) {
    const f = fixture();
    await createAgentEngine({ provider: f.provider })(f.job, f.host);
    const analysis = f.checkpoints.get('analyzing');
    if (variant === 'schema') delete analysis.sources[0].containsPrivateData;
    if (variant === 'source-identity') analysis.sources[0].sourceId = 'unselected-source';
    if (variant === 'evidence-identity') analysis.sources[0].facts[0].id = 'brief:promise';
    if (variant === 'wrong-prefix') analysis.sources[0].facts[0].id = `${analysis.sources[0].sourceId}-fact-1`;
    if (variant === 'duplicate-fact') analysis.sources[1].facts[0].id = analysis.sources[0].facts[0].id;
    if (variant === 'missing-fact-id') delete analysis.sources[0].facts[0].id;
    f.checkpoints.set('analyzing', analysis);
    f.calls.length = 0; f.saved.length = 0;
    f.host.render = async () => assert.fail('Invalid analysis must not authorize a preview');
    await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), ['schema', 'missing-fact-id'].includes(variant) ? { name: 'ZodError' } : { code: variant === 'source-identity' ? 'SOURCE_MISMATCH' : 'INVALID_EVIDENCE' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
  }
});

test('replayed composition checkpoints cannot disclose captures omitted by the current selection', async () => {
  const f = fixture();
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  const selected = f.document.sources[0].id;
  f.job.input.sourceIds = [selected];
  // Historical checkpoints may predate this privacy gate. Only the approved
  // source is analyzed, while a stale composition still contains the others.
  const analysis = f.checkpoints.get('analyzing');
  analysis.sources = analysis.sources.filter(source => source.sourceId === selected);
  f.checkpoints.set('analyzing', analysis);
  f.calls.length = 0; f.saved.length = 0;
  f.host.render = async () => assert.fail('Unconsented checkpoint must not be rendered');
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'SOURCE_CONSENT_REQUIRED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
});

test('cancellation never calls the model or saves a new draft', async () => {
  const f = fixture(); f.setCancelled(true);
  await assert.rejects(createAgentEngine({ provider: f.provider })(f.job, f.host), { code: 'CANCELLED' });
  assert.equal(f.calls.length, 0);
});

test('exact-template geometry changes fail through the same core operations as the editor', () => {
  const f = fixture(); const scene = f.document.scenes[0];
  const operations = editsToOperations(f.document, [edit({ sceneId: scene.id, deviceId: scene.devices[0].id, scale: 100 })]);
  assert.throws(() => applyOperations(f.document, operations), { code: 'LOCKED' });
});

test('refinement scope cannot quietly change linked devices in neighboring scenes', () => {
  const f = fixture({ mode: 'inspiration' }); const scene = f.document.scenes[0];
  assert.throws(() => editsToOperations(f.document, [edit({ sceneId: scene.id, deviceId: scene.devices[0].id, scale: 100 })], { scope: { sceneIds: [scene.id] } }), { code: 'LINKED_SCOPE_REQUIRED' });
});

test('scoped refinement modifies only requested text and preserves source pixels and geometry', async () => {
  const f = fixture({ mode: 'inspiration' }); const scene = f.document.scenes[0];
  f.job.kind = 'revision'; f.job.input.instruction = 'Shorten the first headline'; f.job.input.scope = { sceneIds: [scene.id] };
  const original = f.provider.generate;
  f.provider.generate = async request => request.stage === 'refining' ? { explanation: 'Shortened headline only', edits: [edit({ type: 'copy', sceneId: scene.id, headline: 'Your tasks, organized', evidenceIds: ['brief:promise'] })] } : original(request);
  await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(f.saved[0].document.scenes[0].text.headlines.en, 'Your tasks, organized');
  assert.deepEqual(f.saved[0].document.deviceGroups, f.document.deviceGroups);
  assert.deepEqual(f.saved[0].document.sources, f.document.sources);
  assert.deepEqual(f.saved[0].document.scenes[1], f.document.scenes[1]);
});

test('refinement uses exact validated fact ownership when source namespaces overlap', async () => {
  for (const targetIndex of [0, 1]) {
    const f = fixture({ mode: 'inspiration', count: 2, templateId: 'lavender-stage-top' });
    renameFixtureSources(f, ['capture', 'capture:other']);
    const target = f.document.scenes[targetIndex], original = f.provider.generate;
    f.job.kind = 'revision'; f.job.input.instruction = 'Improve the selected caption';
    f.job.input.scope = { sceneIds: [target.id] };
    f.provider.generate = async request => request.stage === 'refining'
      ? { explanation: 'Use one screenshot fact', edits: [edit({ type: 'copy', sceneId: target.id, headline: 'Your tasks, organized', evidenceIds: ['capture:other:fact-1'] })] }
      : original(request);
    const engine = createAgentEngine({ provider: f.provider });
    if (targetIndex === 0) {
      await assert.rejects(engine(f.job, f.host), { code: 'SOURCE_EVIDENCE_MISMATCH' });
      assert.deepEqual(f.saved, []);
    } else {
      await engine(f.job, f.host);
      assert.equal(f.saved[0].document.scenes[1].text.headlines.en, 'Your tasks, organized');
      assert.deepEqual(f.saved[0].document.scenes[0], f.document.scenes[0]);
    }
  }
});

test('copy operations never infer screenshot fact ownership from an ID prefix or a missing map', () => {
  const f = fixture({ count: 1, templateId: 'lavender-stage-top' }), scene = f.document.scenes[0];
  const evidenceId = `${scene.sourceId}:other:fact-1`, evidence = new Map([[evidenceId, 'Organize tasks into lists'], ['brief:promise', 'Organize your tasks']]);
  const change = edit({ type: 'copy', sceneId: scene.id, headline: 'Organize your tasks', evidenceIds: [evidenceId] });
  assert.throws(() => editsToOperations(f.document, [change], { evidence }), { code: 'SOURCE_EVIDENCE_MISMATCH' });
  assert.throws(() => editsToOperations(f.document, [change], { evidence, evidenceSources: new Map([[evidenceId, `${scene.sourceId}:other`]]) }), { code: 'SOURCE_EVIDENCE_MISMATCH' });
  assert.equal(editsToOperations(f.document, [change], { evidence, evidenceSources: new Map([[evidenceId, scene.sourceId]]) }).length, 1);
  assert.equal(editsToOperations(f.document, [{ ...change, evidenceIds: ['brief:promise'] }], { evidence }).length, 1);
});

test('unsupported quantitative marketing claims require actual backing', () => {
  const evidence = new Map([['source:tasks', 'Organize tasks into lists']]);
  assert.throws(() => assertEvidence('Trusted by 10000 people', ['source:tasks'], evidence), { code: 'UNSUPPORTED_CLAIM' });
  assert.throws(() => assertEvidence('The fastest task app', ['source:tasks'], evidence), { code: 'UNSUPPORTED_CLAIM' });
});

test('unconfigured production provider fails explicitly rather than fabricating output', async () => {
  await assert.rejects(createOpenAIProvider().generate({}), { code: 'AI_NOT_CONFIGURED' });
});

test('locked copy and palette remain untouched while the agent designs around them', async () => {
  const f = fixture({ locks: { text: true, colors: true } });
  const result = await createAgentEngine({ provider: f.provider })(f.job, f.host);
  assert.equal(result.reviewNeeded, false);
  assert.equal(f.saved[0].document.scenes[0].text.headlines.en, f.document.scenes[0].text.headlines.en);
  assert.deepEqual(f.saved[0].document.scenes[0].background, f.document.scenes[0].background);
});

test('token usage checkpoint prevents further model dispatch once the budget is reached', async () => {
  const f = fixture();
  await assert.rejects(createAgentEngine({ provider: f.provider, maxTotalTokens: 10 })(f.job, f.host), { code: 'BUDGET_EXCEEDED' });
  assert.deepEqual(f.calls, ['analyzing']);
  assert.equal(f.usage.length, 1);
});
