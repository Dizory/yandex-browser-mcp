import { z } from 'zod';

// Reference captures are plain snapshot data, never code. A caller can pass the
// result of browser_snapshot directly, so the stateless path needs no server
// memory and no JavaScript evaluation.
const baselineElement = z.strictObject({
  selector: z.string().min(1).max(10000).describe('CSS selector from browser_snapshot'),
  tag: z.string().max(100).optional(),
  role: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  type: z.string().max(100).optional(),
  value: z.string().max(300).optional(),
});

const baseline = z.strictObject({
  url: z.string().max(20000).optional(),
  title: z.string().max(2000).optional(),
  text: z.string().max(100000).optional(),
  elements: z.array(baselineElement).max(300).optional(),
  truncated: z.boolean().optional(),
  documentTime: z.number().finite().optional(),
});

const tabId = z.number().int().positive().describe('Tab ID from browser_tabs');

/**
 * [method, description, zod shape] for the browser_diff tool. tools.js maps it
 * to `browser_${method}` and wraps the shape with z.strictObject, so unknown
 * keys (including any expression/script field) are rejected.
 */
export const diffDefinition = [
  'diff',
  'Compare the visible main-document text and/or actionable elements of one tab against an earlier capture. Two reference modes: pass `snapshotId` returned by a previous browser_diff call (kept in browser memory only, bound to that tab, expires in minutes and is evicted when memory is capped), or pass a self-contained `baseline` snapshot object such as a browser_snapshot result (no shared state). Every call returns a new `snapshotId` when the capture fits the memory cap (`stored` says whether it does). Results contain added/removed text chunks and added/removed/changed actionable elements, are bounded by maxTextChunks/maxElementChanges/maxDiffChars, and flag `navigated` (URL/document changed), `clipped` (a capture was truncated) and `complete`. Diffs never mix tabs or documents. No JavaScript is accepted or executed.',
  {
    tabId,
    snapshotId: z.string().min(1).max(200).optional().describe('snapshotId from a previous browser_diff call for this tab'),
    baseline: baseline.optional().describe('Self-contained reference capture, for example a browser_snapshot result'),
    text: z.boolean().optional().describe('Diff visible text (default true)'),
    elements: z.boolean().optional().describe('Diff actionable elements (default true)'),
    maxChars: z.number().int().min(1).max(100000).optional().describe('Text characters captured per side (default 20000)'),
    maxTextChunks: z.number().int().min(1).max(200).optional().describe('Added/removed text chunks returned per list (default 40)'),
    maxElementChanges: z.number().int().min(1).max(300).optional().describe('Added/removed/changed elements returned per list (default 40)'),
    maxDiffChars: z.number().int().min(500).max(40000).optional().describe('Total characters of diff output (default 12000)'),
  },
];
