/**
 * Idea Bank submissions — the pure core (validation + public shape), no DB.
 *
 * Anyone can submit an idea. It is stored as `pending`; an admin accepts or
 * rejects it, and only accepted ideas are served publicly. The contact field is
 * for the team to follow up and is never part of the public shape.
 */

export const IDEA_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_LIMITS = {
  title: { min: 4, max: 90 },
  goal: { min: 20, max: 400 },
  description: { min: 40, max: 5000 },
  alignment: { min: 0, max: 1500 },
  author: { min: 2, max: 80 },
  contact: { min: 3, max: 120 },
  link: { min: 0, max: 300 },
} as const;

export type IdeaFields = {
  title: string;
  goal: string;
  description: string;
  alignment: string;
  author: string;
  contact: string;
  link: string | null;
};

type Field = keyof typeof IDEA_LIMITS;

const labels: Record<Field, string> = {
  title: 'Title',
  goal: 'Goal',
  description: 'Description',
  alignment: 'Stellar alignment',
  author: 'Your name or team',
  contact: 'Contact',
  link: 'Link',
};

/** Trim, normalize line endings, and collapse runs of blank lines. */
function clean(value: unknown, multiline: boolean): string {
  const text = typeof value === 'string' ? value : '';
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return multiline
    ? normalized.replace(/\n{3,}/g, '\n\n').trim()
    : normalized.replace(/\s+/g, ' ').trim();
}

function validLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validate a submission body. `partial` is for admin edits on review: only the
 * fields present are checked and returned.
 */
export function validateIdea(
  body: Record<string, unknown> | undefined,
  { partial = false }: { partial?: boolean } = {},
): { ok: true; value: Partial<IdeaFields> } | { ok: false; error: string; field: Field } {
  const input = body ?? {};
  const value: Partial<IdeaFields> = {};
  const multiline = new Set<Field>(['goal', 'description', 'alignment']);

  for (const field of Object.keys(IDEA_LIMITS) as Field[]) {
    if (partial && !(field in input)) continue;
    const text = clean(input[field], multiline.has(field));
    const { min, max } = IDEA_LIMITS[field];
    if (text.length < min) {
      return {
        ok: false,
        field,
        error: min <= 1 ? `${labels[field]} is required.` : `${labels[field]} needs at least ${min} characters.`,
      };
    }
    if (text.length > max) {
      return { ok: false, field, error: `${labels[field]} can be at most ${max} characters.` };
    }
    if (field === 'link') {
      if (text && !validLink(text)) {
        return { ok: false, field, error: 'Link must be an http(s) URL.' };
      }
      value.link = text || null;
    } else {
      value[field] = text;
    }
  }

  return { ok: true, value };
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === 'string' && (IDEA_STATUSES as readonly string[]).includes(value);
}

type IdeaRow = IdeaFields & {
  id: string;
  status: string;
  reviewNote: string;
  reviewedAt: Date | null;
  createdAt: Date;
};

/** What the public Idea Bank sees for an accepted idea. No contact, no review data. */
export function publicIdea(row: IdeaRow) {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    description: row.description,
    alignment: row.alignment,
    author: row.author,
    link: row.link,
    acceptedAt: (row.reviewedAt ?? row.createdAt).toISOString(),
  };
}

/** What admins see in the review queue. */
export function adminIdea(row: IdeaRow) {
  return {
    ...publicIdea(row),
    contact: row.contact,
    status: row.status,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
