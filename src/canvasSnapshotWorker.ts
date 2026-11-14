import { parentPort, workerData } from "node:worker_threads";
import * as Y from "yjs";
import { documentRevision } from "./util/documentRevision.js";

const doc = new Y.Doc();
try {
  Y.applyUpdate(doc, workerData);
  const blocks = doc.getMap("blocks");
  if (blocks.size > 50_000) throw new Error("Document too large");
  const hasRoot = [...blocks.values()].some(block => block instanceof Y.Map && block.get("sys:flavour") === "affine:page");
  if (!hasRoot) throw new Error("No document root");
  parentPort?.postMessage({ revision: documentRevision(doc), blocks: blocks.size });
} catch {
  parentPort?.postMessage({ error: "INVALID_DOCUMENT_SNAPSHOT" });
} finally { doc.destroy(); }
