/**
 * Lane layout for a page of commit history (Source Control → History).
 *
 * Commits arrive newest first. Each lane "expects" the commit it will reach
 * next; a commit takes the lane that expects it (or a free one), its first
 * parent continues in that lane, and further parents open or join lanes.
 * Only the loaded page is laid out, so lanes never need the whole history.
 */

export interface GraphInput {
  sha: string;
  parents: string[];
}

export interface GraphEdge {
  /** Lane at the top of the row (for incoming edges) or at the commit (outgoing). */
  from: number;
  /** Lane at the bottom of the row. */
  to: number;
}

export interface GraphRow {
  sha: string;
  /** Lane the commit's node sits in. */
  lane: number;
  /** Lanes that pass straight through this row without touching the node. */
  through: number[];
  /** Lanes arriving from above into the node (the node's own lane and merging lanes). */
  incoming: number[];
  /** Edges leaving the node downwards, one per parent. */
  outgoing: GraphEdge[];
  /** Number of lanes needed to draw this row. */
  width: number;
}

export function layoutGraph(commits: GraphInput[], maxLanes = 64): GraphRow[] {
  // lanes[i] = sha that lane i expects next, or null when free.
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];
  const freeLane = () => {
    const index = lanes.indexOf(null);
    if (index !== -1) return index;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const expecting = lanes.flatMap((sha, i) => (sha === commit.sha ? [i] : []));
    const lane = expecting[0] ?? freeLane();
    const through = lanes.flatMap((sha, i) => (sha !== null && sha !== commit.sha ? [i] : []));
    const incoming = expecting;
    // Every lane that expected this commit ends here; the node's lane continues with the first parent.
    for (const i of expecting) lanes[i] = null;

    const outgoing: GraphEdge[] = [];
    commit.parents.forEach((parent, index) => {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        // Another lane already leads to this parent: join it.
        outgoing.push({ from: lane, to: existing });
        return;
      }
      const target = index === 0 && lanes[lane] === null ? lane : freeLane();
      if (target >= maxLanes) return;
      lanes[target] = parent;
      outgoing.push({ from: lane, to: target });
    });

    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    const width = Math.max(lane + 1, ...through.map((i) => i + 1), ...outgoing.map((e) => e.to + 1), lanes.length, 1);
    rows.push({ sha: commit.sha, lane, through, incoming, outgoing, width });
  }
  return rows;
}
