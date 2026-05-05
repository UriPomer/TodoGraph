import { buildAdj } from '@todograph/core';
import type { PageData, PageInfo, Task } from '@todograph/shared';

export function generateWorkspaceMarkdown(pages: PageInfo[], loadPage: (id: string) => Promise<PageData>): Promise<string> {
  return generateWorkspaceMarkdownWithRepo(pages, loadPage);
}

async function generateWorkspaceMarkdownWithRepo(
  pages: PageInfo[],
  loadPage: (id: string) => Promise<PageData>,
): Promise<string> {
  const lines: string[] = ['# TodoGraph', ''];

  for (const page of pages) {
    lines.push(`## ${page.title}`);
    lines.push('');

    let pd: PageData;
    try {
      pd = await loadPage(page.id);
    } catch {
      lines.push('*(无法加载)*');
      lines.push('');
      continue;
    }

    const { parents } = buildAdj(pd);
    const byId = new Map<string, Task>(pd.nodes.map((n) => [n.id, n]));
    const children = new Map<string, Task[]>();
    for (const n of pd.nodes) {
      if (n.parentId) {
        const arr = children.get(n.parentId);
        if (arr) arr.push(n);
        else children.set(n.parentId, [n]);
      }
    }

    function ready(n: Task): boolean {
      if (n.status === 'done') return false;
      const ps = parents.get(n.id);
      if (!ps || ps.size === 0) return true;
      return [...ps].every((pid) => byId.get(pid)?.status === 'done');
    }

    const sections: [string, (n: Task) => boolean][] = [
      ['### Ready', (n) => ready(n)],
      ['### Blocked', (n) => n.status !== 'done' && !ready(n)],
      ['### Done', (n) => n.status === 'done'],
    ];

    for (const [heading, predicate] of sections) {
      const matching = pd.nodes.filter((n) => !n.parentId && predicate(n));
      if (matching.length === 0) continue;
      lines.push(heading);
      for (const n of matching) {
        renderTask(n, 0, children, byId, parents, lines);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderTask(
  task: Task,
  depth: number,
  children: Map<string, Task[]>,
  byId: Map<string, Task>,
  parents: Map<string, Set<string>>,
  lines: string[],
) {
  const indent = '  '.repeat(depth);
  const done = task.status === 'done' ? 'x' : ' ';
  const priority = task.priority === 3 ? ' 🔴' : task.priority === 1 ? ' 🟢' : '';
  const title = done === 'x' ? `~~${task.title}~~` : task.title;
  lines.push(`${indent}- [${done}]${priority} ${title}`);

  // Dependencies
  const ps = parents.get(task.id);
  if (ps && ps.size > 0) {
    const deps = [...ps].map((pid) => {
      const p = byId.get(pid);
      const name = p?.title ?? pid;
      return p?.status === 'done' ? `${name} ✓` : name;
    });
    lines.push(`${indent}  - 依赖: ${deps.join(', ')}`);
  }

  // Description
  if (task.description) {
    const desc = task.description.split('\n').slice(0, 2).join(' ').trim();
    if (desc) lines.push(`${indent}  - ${desc}`);
  }

  // Children
  const kids = children.get(task.id);
  if (kids) {
    for (const child of kids) {
      renderTask(child, depth + 1, children, byId, parents, lines);
    }
  }
}
