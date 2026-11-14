import assert from "node:assert/strict";
import * as Y from "yjs";
import { canvasMarkdownOmissions } from "../dist/util/canvasFidelity.js";

const doc = new Y.Doc();
const surface = new Y.Map();
const wrapper = new Y.Map();
const elements = new Y.Map();
doc.getMap("blocks").set("surface", surface);
surface.set("sys:flavour", "affine:surface");
surface.set("prop:elements", wrapper);
wrapper.set("value", elements);
assert.deepEqual(canvasMarkdownOmissions(doc), []);
elements.set("shape", new Y.Map());
elements.set("connector", new Y.Map());
assert.deepEqual(canvasMarkdownOmissions(doc), [{ surfaceId: "surface", count: 2 }]);
