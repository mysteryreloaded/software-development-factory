import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lookAtImage, lookAtVideo, type LookDeps } from './look.ts';

// The look tool's MCP server (issue #122, part 1): two tools an agent can call to ask a vision model about an
// image or a video and get text back, so its own conversation never has to hold the image.

const LOOK_DESCRIPTION =
  'Another model looks for you and answers in text. For exact pixel positions, measure in the browser ' +
  '(browser_evaluate + getBoundingClientRect), then confirm with region + zoom.';

const REGION = z
  .object({
    x: z.number().describe('Left edge in pixels'),
    y: z.number().describe('Top edge in pixels'),
    width: z.number().positive().describe('Width in pixels'),
    height: z.number().positive().describe('Height in pixels'),
  })
  .describe('A pixel region to crop to before answering; a region past the edge is clamped, not an error.');

export function createLookServer(deps: LookDeps): McpServer {
  const server = new McpServer({ name: 'look', version: '1.0.0' });

  server.registerTool(
    'look_at_image',
    {
      description: LOOK_DESCRIPTION,
      inputSchema: {
        path: z.string().describe('Absolute path to a png, jpg, jpeg, webp or gif image, up to 20 MB'),
        question: z.string().describe('What to ask about the image'),
        region: REGION.optional(),
        zoom: z.number().min(1).max(8).optional().describe('Enlarge the (cropped) image by this factor, 1-8'),
      },
    },
    async (args) => {
      const result = await lookAtImage(deps, args);
      return toCallResult(result);
    },
  );

  server.registerTool(
    'look_at_video',
    {
      description: LOOK_DESCRIPTION,
      inputSchema: {
        path: z.string().describe('Absolute path to a video file'),
        question: z.string().describe('What to ask about the video'),
        everySeconds: z.number().positive().optional().describe('Seconds between sampled frames (default 2)'),
        maxFrames: z.number().int().positive().optional().describe('Most frames to sample (default 30)'),
      },
    },
    async (args) => {
      const result = await lookAtVideo(deps, args);
      return toCallResult(result);
    },
  );

  return server;
}

function toCallResult(result: { ok: boolean; text: string }) {
  return result.ok
    ? { content: [{ type: 'text' as const, text: result.text }] }
    : { content: [{ type: 'text' as const, text: result.text }], isError: true };
}
