/** Zotero's serialized position limit. Adjacent chunks of one stroke share
 * the boundary point so the segment crossing that boundary is rendered. */
export const POSITION_MAX = 65000;
export function splitInk<P extends { paths: number[][] }>(
  position: P,
  max = POSITION_MAX,
): P[] {
  if (JSON.stringify(position).length <= max) return [position];
  const parts: P[] = [];
  const overhead = JSON.stringify({ ...position, paths: [] }).length;
  let paths: number[][] = [];
  let size = overhead;
  function flush() {
    if (paths.length) parts.push({ ...position, paths });
    paths = [];
    size = overhead;
  }
  for (const path of position.paths) {
    if (path.length % 2 || !path.every(Number.isFinite))
      throw new Error("Invalid stroke");
    let fragment: number[] = [];
    for (let i = 0; i < path.length; i += 2) {
      const point = path.slice(i, i + 2);
      const cost = JSON.stringify(point).length - 1;
      if (size + cost + 3 > max) {
        flush();
        fragment = i ? path.slice(i - 2, i) : [];
        if (fragment.length) size += JSON.stringify(fragment).length - 1;
      }
      if (size + cost + 3 > max)
        throw new Error("Ink point exceeds position limit");
      if (paths[paths.length - 1] !== fragment) {
        paths.push(fragment);
        size += 3;
      }
      fragment.push(...point);
      size += cost;
    }
  }
  flush();
  return parts;
}
