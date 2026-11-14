import * as Y from "yjs";

/** Surface elements are stored outside the block tree rendered to Markdown. */
export function canvasMarkdownOmissions(doc: Y.Doc): { surfaceId: string; count: number }[] {
  const omissions: { surfaceId: string; count: number }[] = [];
  for (const [id, block] of doc.getMap("blocks")) {
    if (!(block instanceof Y.Map) || block.get("sys:flavour") !== "affine:surface") continue;
    const wrapper = block.get("prop:elements");
    const elements = wrapper instanceof Y.Map ? wrapper.get("value") : undefined;
    if (elements instanceof Y.Map && elements.size > 0) {
      omissions.push({ surfaceId: String(id), count: elements.size });
    }
  }
  return omissions;
}
