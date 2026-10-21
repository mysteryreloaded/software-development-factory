// How long a manager's message to the CEO or an agent can be (#37): the client caps the box at this length and the
// server rejects anything over it outright, with the same words on both sides. No truncation.

/** The longest message the manager can send. */
export const MESSAGE_MAX = 60_000;

/** Why a message can't be sent, or null when it's fine. Checked before `.trim()`-ing the text for use. */
export function messageProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return 'Empty message';
  if (t.length > MESSAGE_MAX) return `Message too long: ${t.length.toLocaleString('en-US')} characters, the limit is ${MESSAGE_MAX.toLocaleString('en-US')}`;
  return null;
}
