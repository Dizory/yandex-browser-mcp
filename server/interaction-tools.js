import { z } from 'zod';

// Tool descriptions for the interaction command family. They use the same
// [method, description, zodShape] tuple format as the definitions in
// ./tools.js, so the two lists can simply be concatenated.

const tabId = z.number().int().positive().describe('Tab ID from browser_tabs');
const coordinate = z.number().finite().nonnegative();
const selector = z.string().min(1).describe('Unique CSS selector from the latest snapshot');
const point = z.union([
  z.strictObject({ selector }),
  z.strictObject({ x: coordinate, y: coordinate }),
]);

export const interactionDefinitions = [
  [
    'hover',
    'Move the mouse pointer over a unique CSS selector or viewport x/y coordinates using trusted browser input, without clicking. Use it to reveal hover menus, tooltips or hover-only styles. Provide either selector or both x and y.',
    {
      tabId,
      selector: selector.optional(),
      x: coordinate.optional(),
      y: coordinate.optional(),
    },
  ],
  [
    'drag',
    'Drag from one target to another with trusted mouse input. Each of from/to is {selector} or {x,y} viewport coordinates; steps controls intermediate moves (1-50, default 5). The left button is released if the drag fails. Prefer endpoints that are already visible.',
    {
      tabId,
      from: point.describe('Start target: {selector} or {x,y}'),
      to: point.describe('End target: {selector} or {x,y}'),
      steps: z.number().int().min(1).max(50).optional(),
    },
  ],
  [
    'frames',
    'List frames exposed by the tab debugger, including frameId and parentFrameId. Pass frameId to browser_snapshot, browser_find and the form/region tools.',
    { tabId },
  ],
  [
    'wait_download',
    'Wait for a browser download to finish without starting one. Pass downloadId for one exact download, or filenameContains/urlContains to track a recent download; ambiguous matches are rejected instead of guessing. lookbackMs limits how far back recent downloads are considered (default 30000). Returns id, filename, state and error; bounded by timeoutMs (default 15000, max 25000) and never initiates a download.',
    {
      downloadId: z.number().int().positive().optional(),
      filenameContains: z.string().trim().min(1).max(500).optional(),
      urlContains: z.string().trim().min(1).max(2000).optional(),
      timeoutMs: z.number().int().min(100).max(25000).optional(),
      lookbackMs: z.number().int().min(0).max(600000).optional(),
    },
  ],
  [
    'upload_file',
    'Set files on a unique enabled <input type="file"> via CDP DOM.setFileInputFiles, without opening a file picker. paths must be explicit absolute paths; the server checks that regular files exist. selector defaults to input[type="file"] and must match exactly one element.',
    {
      tabId,
      selector: selector.optional(),
      paths: z.array(z.string().min(1).max(32768)).min(1).max(20),
    },
  ],
  [
    'history',
    'Navigate the tab history: action "back" or "forward", or "reload". bypassCache applies to reload. Returns {action, tab} with the resulting tab summary.',
    {
      tabId,
      action: z.enum(['back', 'forward', 'reload']),
      bypassCache: z.boolean().optional(),
    },
  ],
];
