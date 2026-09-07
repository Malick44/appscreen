import { z } from 'zod';

const id = z.string().min(1).max(160);
const short = z.string().max(500);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const BriefSchema = z.object({
  appName: z.string().min(1).max(100),
  promise: z.string().min(1).max(600),
  audience: z.string().max(300).default(''),
  style: z.string().max(300).default('Modern, elegant, readable'),
  confirmedFacts: z.array(z.string().min(1).max(400)).max(30).default([]),
  brandColors: z.array(color).max(5).default([]),
}).strict();

export const AgentInputSchema = z.object({
  revisionId: id,
  sourceIds: z.array(id).min(1).max(10).optional(),
  brief: BriefSchema.optional(),
  screenCount: z.number().int().min(1).max(10).default(5),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/).default('en'),
  template: z.object({ mode: z.enum(['auto', 'exact', 'inspiration']), id: id.optional() }).strict()
    .refine(v => v.mode === 'auto' || Boolean(v.id), 'Choose a template for exact or inspiration mode.')
    .default({ mode: 'auto' }),
  instruction: z.string().min(1).max(3000).optional(),
  scope: z.object({ sceneIds: z.array(id).max(10).optional(), deviceIds: z.array(id).max(50).optional() }).strict().optional(),
  maxCredits: z.number().nonnegative().optional(),
  idempotencyKey: z.string().max(200).optional(),
}).strict();

// Every field in provider response schemas is required: strict Structured Outputs
// cannot silently supply defaults or omit optional properties.
export const AnalysisSchema = z.object({
  sources: z.array(z.object({
    sourceId: id,
    summary: short,
    facts: z.array(z.object({ id, statement: short }).strict()).max(12),
    dominantColors: z.array(color).max(5),
    focalPoint: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).strict(),
    quality: z.enum(['usable', 'low-resolution', 'loading', 'empty', 'debug', 'unreadable']),
    containsPrivateData: z.boolean(),
    warnings: z.array(short).max(6),
  }).strict()).min(1).max(10),
  missingFacts: z.array(short).max(6),
}).strict();

// Provider observations contain facts, not storage/evidence identifiers. Keep
// AnalysisSchema unchanged for existing durable checkpoints; the engine assigns
// canonical IDs only after validating the exact source set of a fresh response.
export const AnalysisObservationsSchema = AnalysisSchema.extend({
  sources: z.array(AnalysisSchema.shape.sources.element.extend({
    facts: z.array(z.object({ statement: short }).strict()).max(12),
  })).min(1).max(10),
}).strict();

export const StoryboardSchema = z.object({
  templateId: id,
  direction: short,
  backgroundColor: color,
  accentColor: color,
  textColor: color,
  scenes: z.array(z.object({
    sourceId: id,
    purpose: short,
    headline: z.string().min(1).max(100),
    subheadline: z.string().max(180),
    evidenceIds: z.array(id).min(1).max(8),
  }).strict()).min(1).max(10),
}).strict();

export const EditSchema = z.object({
  explanation: short,
  edits: z.array(z.object({
    // Deliberately no arbitrary paths, HTML, URLs, executable code, or source synthesis.
    type: z.enum(['copy', 'background', 'device-transform', 'device-appearance']),
    sceneId: id,
    deviceId: id.nullable(),
    headline: z.string().max(100).nullable(),
    subheadline: z.string().max(180).nullable(),
    color: color.nullable(),
    centerX: z.number().min(-1.5).max(2.5).nullable(),
    centerY: z.number().min(-1.5).max(2.5).nullable(),
    scale: z.number().min(10).max(250).nullable(),
    rotation: z.number().min(-90).max(90).nullable(),
    opacity: z.number().min(0).max(100).nullable(),
    borderWidth: z.number().min(0).max(50).nullable(),
    cornerRadius: z.number().min(0).max(150).nullable(),
    evidenceIds: z.array(id).max(8),
  }).strict()).max(60),
}).strict();

export const CritiqueSchema = z.object({
  summary: short,
  issues: z.array(z.object({
    sceneId: id.nullable(),
    deviceId: id.nullable(),
    severity: z.enum(['warning', 'error']),
    category: z.enum(['readability', 'clipping', 'composition', 'repetition', 'source-fidelity', 'unsupported-claim', 'privacy', 'seam']),
    description: short,
    suggestion: short,
  }).strict()).max(30),
}).strict();

export class AgentError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

export function assertEvidence(copy, evidenceIds, evidence) {
  if (!evidenceIds.length || evidenceIds.some(key => !evidence.has(key))) {
    throw new AgentError('UNSUPPORTED_CLAIM', 'Copy must refer to known screenshot evidence or confirmed app facts.');
  }
  const supported = evidenceIds.map(key => evidence.get(key)).join(' ').toLowerCase();
  // Quantified and superlative marketing claims require literal backing. Vision QA
  // checks the remaining semantics; a JSON schema alone cannot prove truthfulness.
  const claims = copy.match(/\b\d[\d.,%+]*\b|\b(?:best|fastest|guaranteed|award-winning|number one|#1)\b/gi) || [];
  if (claims.some(claim => !supported.includes(claim.toLowerCase()))) {
    throw new AgentError('UNSUPPORTED_CLAIM', 'A numerical or superiority claim is not backed by the selected evidence.');
  }
}
