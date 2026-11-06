// MCP tool definitions for the higher-level DOM tools.
//
// The bridge methods match the page actions in extension/lib/dom-tools.js:
// wait, read_region, read_table, read_form, fill_form, select, set_checked and
// inspect. Keeping this as a plain tuple array lets server/tools.js merge the
// definitions into its existing `browserTools` list without importing the
// extension bundle.

import { z } from 'zod';

const tabId = z.number().int().positive().describe('Tab ID from browser_tabs');
const frameId = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe('Optional opaque CDP frame id from browser_frames; omit for the main document');
const selector = z.string().min(1).max(10000).describe('Unique CSS selector from the latest snapshot');
const finite = z.number().finite();
const coordinate = z.number().finite().nonnegative();

const wait = {
  tabId,
  frameId,
  selector: selector.optional(),
  state: z
    .enum(['visible', 'attached', 'detached', 'hidden', 'enabled'])
    .optional()
    .describe('With selector: visible (default), attached, detached, hidden or enabled'),
  text: z.string().min(1).max(1000).optional().describe('Case-insensitive substring of visible text'),
  urlContains: z.string().min(1).max(2000).optional().describe('Case-insensitive substring of location.href'),
  caseSensitive: z.boolean().optional(),
  timeoutMs: z.number().int().min(50).max(25000).optional().describe('Default 5000 ms, maximum 25000 ms'),
  intervalMs: z.number().int().min(25).max(2000).optional().describe('Poll interval, default 120 ms'),
};

const readRegion = {
  tabId,
  frameId,
  selector: selector.optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: finite.positive().optional(),
  height: finite.positive().optional(),
  maxChars: z.number().int().min(1).max(40000).optional().describe('Default 8000 characters'),
  maxElements: z.number().int().min(1).max(100).optional().describe('Default 60 actionable elements'),
};

const readTable = {
  tabId,
  frameId,
  selector: selector.optional(),
  index: z.number().int().nonnegative().optional().describe('Table index when no selector is given; default 0'),
  maxRows: z.number().int().min(1).max(200).optional().describe('Default 50 rows'),
  maxCols: z.number().int().min(1).max(20).optional().describe('Default 20 columns'),
  maxCellChars: z.number().int().min(1).max(500).optional().describe('Default 500 characters per cell'),
};

const readForm = {
  tabId,
  frameId,
  selector: selector.optional(),
  formIndex: z.number().int().nonnegative().optional(),
  maxFields: z.number().int().min(1).max(100).optional().describe('Default 60 fields'),
  maxOptions: z.number().int().min(1).max(50).optional().describe('Default 30 options per select'),
};

const fillField = z.strictObject({
  selector: selector.optional(),
  name: z.string().trim().min(1).max(200).optional().describe('Accessible label, name attribute or id'),
  role: z.string().regex(/^[a-z]+$/).optional(),
  value: z.string().max(10000).optional().describe('Text, textarea, contenteditable or select option value'),
  checked: z.boolean().optional().describe('Checkbox/radio target state'),
});

const fillForm = {
  tabId,
  frameId,
  fields: z.array(fillField).min(1).max(50).describe('Each field uses selector or name plus value or checked'),
};

const select = {
  tabId,
  frameId,
  selector,
  values: z.array(z.string().max(1000)).min(1).max(50).optional().describe('Match option values'),
  labels: z.array(z.string().min(1).max(1000)).min(1).max(50).optional().describe('Match option labels'),
  indexes: z.array(z.number().int().nonnegative()).min(1).max(50).optional().describe('Match option indexes'),
  by: z.enum(['auto', 'value', 'label', 'index']).optional(),
  append: z.boolean().optional().describe('Keep the current selection on a multiple select'),
};

const setChecked = {
  tabId,
  frameId,
  selector,
  checked: z.boolean(),
};

const inspect = {
  tabId,
  frameId,
  selector: selector.optional(),
  maxElements: z.number().int().min(1).max(50).optional().describe('Page-mode element sample; default 20'),
};

/**
 * `[method, description, zodShape]` tuples for the higher-level DOM tools.
 * server/tools.js can map them exactly like its existing definitions.
 */
export const domDefinitions = [
  [
    'wait',
    'Wait until a selector state, visible text or URL condition becomes true. Polls at intervalMs while releasing the per-tab queue between probes, so other commands are not starved. Returns {ok,matched,timedOut,waitedMs,...}; it never mutates the page.',
    wait,
  ],
  [
    'read_region',
    'Read a bounded region of the main document (or the addressed frame): page text plus actionable elements with CSS selectors. Target by selector or by viewport x/y/width/height. Password, hidden and file input values are never returned. Defaults: 8000 characters, 60 elements.',
    readRegion,
  ],
  [
    'read_table',
    'Read an HTML table or ARIA table/grid as headers and rows. Uses native rows/cells, respects cellIndex/colspan gaps and caps rows, columns and cell length. Password, hidden and file input values are never returned.',
    readTable,
  ],
  [
    'read_form',
    'Read forms and their native controls with labels, types, required/disabled/read-only flags, checked state, selected values and options. Password and file values are never returned; hidden inputs are omitted. Use selector or formIndex to narrow the result.',
    readForm,
  ],
  [
    'fill_form',
    'Set form fields without submitting. Supports text inputs, textareas, contenteditable, native selects, checkboxes and radios using native setters plus React-compatible input/change events. Refuses file and hidden inputs. Returns per-field statuses; stops on navigation or debugger detachment and marks remaining fields skipped. Values are never echoed.',
    fillForm,
  ],
  [
    'select',
    'Select option(s) in a native select element by value, visible label or index. Dispatches React-compatible input/change events and never submits a form. Custom comboboxes are reported as unsupported; use click/type for those.',
    select,
  ],
  [
    'set_checked',
    'Set a native checkbox/radio or an ARIA checkbox/switch to checked:true|false. Uses a native click when possible, falls back to the native checked setter and dispatches input/change. Never submits a form.',
    setChecked,
  ],
  [
    'inspect',
    'Inspect one element for actionable details (selector, role, name, bounded attributes, value redaction, rect, visibility, obstruction, form/table associations) and tool capabilities, or inspect the page for element/form/table/frame coverage hints. Password, hidden and file values are never returned.',
    inspect,
  ],
];
