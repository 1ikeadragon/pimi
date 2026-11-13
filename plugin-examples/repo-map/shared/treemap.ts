import type { FileEntry } from "./contracts";

export interface TreeNode {
  /** Display name; a chain of single-child folders collapses into one name like `src/app`. */
  name: string;
  path: string;
  value: number;
  children: TreeNode[] | null;
  file: FileEntry | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed {
  node: TreeNode;
  rect: Rect;
  depth: number;
}

interface MutableNode {
  name: string;
  path: string;
  children: Map<string, MutableNode>;
  file: FileEntry | null;
}

/** Builds the folder tree for a file list. Area is bytes, with 1 as the floor for empty files. */
export function buildTree(files: readonly FileEntry[]): TreeNode {
  const root: MutableNode = { name: "", path: "", children: new Map(), file: null };
  for (const file of files) {
    let node = root;
    let path = "";
    for (const part of file.path.split("/")) {
      path = path ? `${path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), file: null };
        node.children.set(part, child);
      }
      node = child;
    }
    node.file = file;
  }
  return finish(root);
}

function finish(node: MutableNode): TreeNode {
  if (node.file) {
    return {
      name: node.name,
      path: node.path,
      value: Math.max(node.file.bytes, 1),
      children: null,
      file: node.file,
    };
  }
  let children = [...node.children.values()].map(finish);
  let name = node.name;
  let path = node.path;
  // `a/b/c` with nothing beside it reads better as one box than three nested ones.
  while (children.length === 1 && children[0].children && name !== "") {
    name = `${name}/${children[0].name}`;
    path = children[0].path;
    children = children[0].children;
  }
  children.sort((left, right) => right.value - left.value);
  return {
    name,
    path,
    value: children.reduce((sum, child) => sum + child.value, 0),
    children,
    file: null,
  };
}

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(row: readonly number[], side: number): number {
  const sum = row.reduce((total, area) => total + area, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const squared = side * side;
  return Math.max((squared * max) / (sum * sum), (sum * sum) / (squared * min));
}

/** Squarified treemap (Bruls, Huizing, van Wijk): rects for `values`, in order, inside `rect`. */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  const result: Rect[] = [];
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ ...rect, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((value) => value * scale);
  let free = { ...rect };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    let end = start + 1;
    while (
      end < areas.length &&
      worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)
    ) {
      end += 1;
    }
    const row = areas.slice(start, end);
    const rowArea = row.reduce((sum, area) => sum + area, 0);
    if (free.w >= free.h) {
      const width = rowArea / free.h;
      let y = free.y;
      for (const area of row) {
        const height = area / width;
        result.push({ x: free.x, y, w: width, h: height });
        y += height;
      }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      const height = rowArea / free.w;
      let x = free.x;
      for (const area of row) {
        const width = area / height;
        result.push({ x, y: free.y, w: width, h: height });
        x += width;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
    start = end;
  }
  return result;
}

export interface LayoutOptions {
  /** Space between a folder's edge and its children. */
  padding: number;
  /** Height reserved at the top of a folder for its label. */
  header: number;
  /** Boxes with a side below this are not drawn. */
  minSize: number;
  /** Stop adding boxes after this many. Larger boxes are placed first. */
  maxBoxes: number;
}

/** Lays out the tree breadth-first, so when `maxBoxes` cuts it off the large boxes are already placed. */
export function layoutTree(root: TreeNode, rect: Rect, options: LayoutOptions): Placed[] {
  const placed: Placed[] = [];
  const queue: Array<{ node: TreeNode; rect: Rect; depth: number }> = [
    { node: root, rect, depth: 0 },
  ];
  for (let index = 0; index < queue.length && placed.length < options.maxBoxes; index += 1) {
    const { node, rect: box, depth } = queue[index];
    if (depth > 0) placed.push({ node, rect: box, depth });
    if (!node.children) continue;
    const inset = depth === 0 ? 0 : options.padding;
    const header = depth === 0 ? 0 : options.header;
    const inner = {
      x: box.x + inset,
      y: box.y + inset + header,
      w: box.w - inset * 2,
      h: box.h - inset * 2 - header,
    };
    if (inner.w < options.minSize || inner.h < options.minSize) continue;
    const rects = squarify(
      node.children.map((child) => child.value),
      inner,
    );
    node.children.forEach((child, childIndex) => {
      const childRect = rects[childIndex];
      if (childRect.w >= options.minSize && childRect.h >= options.minSize) {
        queue.push({ node: child, rect: childRect, depth: depth + 1 });
      }
    });
  }
  return placed;
}
