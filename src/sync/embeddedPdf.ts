import pako from "pako";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFNull,
  type PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib";
import { sha256Hex, uuid4 } from "../remarkable/hash";
import {
  type EditableMark,
  PAGE_BASE_VERSION,
  type PageBaselineVersion,
  roundMark,
  validEditableMark,
} from "./editableMarks";

const name = PDFName.of;
export const EDITABLE_PDF_LIMIT = 128 * 1024 * 1024;

function decodeFlate(bytes: Uint8Array, limit: number) {
  const inflater = new pako.Inflate({ windowBits: 15, chunkSize: 64 * 1024 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  inflater.onData = (chunk) => {
    size += chunk.length;
    if (size > limit)
      throw new Error("Expanded PDF streams exceed the sync limit");
    chunks.push(chunk);
  };
  // With finish=false, ended only indicates a decoder error or a verified zlib end.
  if (
    !inflater.push(bytes, false) ||
    !inflater.ended ||
    inflater.err ||
    inflater.strm.avail_in
  )
    throw new Error("Incomplete or invalid compressed PDF stream");
  const decoded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.length;
  }
  return decoded;
}

interface Embedded {
  mark: EditableMark;
  id?: string;
  index: number;
  dict: PDFDict;
}

function numberArray(array: PDFArray | undefined) {
  if (!array) throw new Error("PDF annotation coordinates are missing");
  return Array.from({ length: array.size() }, (_, i) =>
    array.lookup(i, PDFNumber).asNumber(),
  );
}

function readMark(
  dict: PDFDict,
  page: number,
  index: number,
): Embedded | undefined {
  const kind = dict.lookupMaybe(name("Subtype"), PDFName)?.decodeText();
  if (kind !== "Ink" && kind !== "Highlight") return;
  const id = dict
    .lookupMaybe(name("NM"), PDFString, PDFHexString)
    ?.decodeText();
  const rgb = dict.lookupMaybe(name("C"), PDFArray);
  const fallback = kind === "Ink" ? [0, 0, 0] : [1, 0.83, 0];
  const colorValues = rgb ? numberArray(rgb) : fallback;
  if (colorValues.length !== 3 || colorValues.some((c) => c < 0 || c > 1))
    throw new Error("Unsupported PDF annotation color");
  const color =
    "#" +
    colorValues
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const mark: EditableMark = {
    page,
    kind: kind === "Ink" ? "ink" : "highlight",
    color,
    paths: [],
    width: 0,
    comment: dict
      .lookupMaybe(name("Contents"), PDFString, PDFHexString)
      ?.decodeText(),
    author: dict.lookupMaybe(name("T"), PDFString, PDFHexString)?.decodeText(),
  };
  if (kind === "Ink") {
    const paths = dict.lookup(name("InkList"), PDFArray);
    mark.paths = Array.from({ length: paths.size() }, (_, i) =>
      numberArray(paths.lookup(i, PDFArray)),
    );
    mark.width = roundMark(
      dict
        .lookupMaybe(name("BS"), PDFDict)
        ?.lookupMaybe(name("W"), PDFNumber)
        ?.asNumber() ??
        dict
          .lookupMaybe(name("Border"), PDFArray)
          ?.lookupMaybe(2, PDFNumber)
          ?.asNumber() ??
        1,
    );
  } else {
    const quads = numberArray(dict.lookupMaybe(name("QuadPoints"), PDFArray));
    if (quads.length % 8) throw new Error("Invalid highlight quadrilaterals");
    for (let i = 0; i < quads.length; i += 8) {
      const xs = quads.slice(i, i + 8).filter((_, j) => j % 2 === 0);
      const ys = quads.slice(i, i + 8).filter((_, j) => j % 2 === 1);
      if (
        new Set(xs.map(roundMark)).size !== 2 ||
        new Set(ys.map(roundMark)).size !== 2
      )
        throw new Error("Angled highlight needs review");
      mark.paths.push([
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ]);
    }
  }
  if (!validEditableMark(mark))
    throw new Error("Unsupported PDF ink or highlight");
  return { id, mark, index, dict };
}

/** Hash the page tree's effective geometry and drawing data independently of Annots and object numbering. */
async function baseFingerprint(
  doc: PDFDocument,
  count: number,
  version: PageBaselineVersion,
) {
  const normalized = version >= 2;
  const cached = new Map<PDFObject, string>();
  const active = new Set<PDFObject>();
  let remaining = 256 * 1024 * 1024;
  async function hash(
    input: PDFObject | undefined,
    depth = 0,
  ): Promise<string> {
    if (depth > 96) throw new Error("PDF resource nesting exceeds limits");
    if (!input || input === PDFNull) return "";
    const object = input instanceof PDFRef ? doc.context.lookup(input) : input;
    if (!object) throw new Error("Missing PDF resource");
    const prior = cached.get(object);
    if (prior !== undefined) return prior;
    if (active.has(object)) throw new Error("Cyclic PDF resource");
    active.add(object);
    let value: unknown;
    if (object instanceof PDFStream) {
      let payload = object.getContents();
      const filter = object.dict.lookup(name("Filter"));
      const params = object.dict.lookup(name("DecodeParms"));
      const flate =
        normalized &&
        (filter === name("FlateDecode") ||
          (filter instanceof PDFArray &&
            filter.size() === 1 &&
            filter.lookup(0) === name("FlateDecode"))) &&
        (!params ||
          params === PDFNull ||
          (params instanceof PDFArray &&
            params.size() === 1 &&
            params.lookup(0) === PDFNull));
      if (flate) {
        payload = decodeFlate(payload, Math.min(64 * 1024 * 1024, remaining));
        remaining -= payload.length;
      }
      const fields: string[][] = [];
      for (const [key, child] of object.dict
        .entries()
        .sort(([a], [b]) => a.toString().localeCompare(b.toString()))) {
        if (
          key === name("Length") ||
          (normalized && key === name("DL")) ||
          (flate && (key === name("Filter") || key === name("DecodeParms")))
        )
          continue;
        fields.push([key.toString(), await hash(child, depth + 1)]);
      }
      value = [fields, await sha256Hex(payload)];
    } else if (object instanceof PDFDict) {
      const fields: string[][] = [];
      for (const [key, child] of object
        .entries()
        .sort(([a], [b]) => a.toString().localeCompare(b.toString())))
        fields.push([key.toString(), await hash(child, depth + 1)]);
      value = fields;
    } else if (object instanceof PDFArray) {
      const elements: string[] = [];
      for (const child of object.asArray())
        elements.push(await hash(child, depth + 1));
      value = elements;
    } else if (
      version >= 3 &&
      (object instanceof PDFString || object instanceof PDFHexString)
    ) {
      // Literal escapes and hex notation can encode the same resource bytes.
      value = ["pdf-string", await sha256Hex(object.asBytes())];
    } else {
      value = object.toString();
    }
    active.delete(object);
    const result = await sha256Hex(
      new TextEncoder().encode(JSON.stringify(value)),
    );
    cached.set(object, result);
    return result;
  }
  const pages = [];
  for (const page of doc.getPages().slice(0, count)) {
    const rawContents = page.node.get(name("Contents"));
    const resolved = normalized ? doc.context.lookup(rawContents) : undefined;
    const contents =
      resolved instanceof PDFArray && resolved.size() === 1
        ? resolved.get(0)
        : rawContents;
    pages.push([
      page.getMediaBox(),
      page.getCropBox(),
      page.getRotation().angle,
      await hash(page.node.getInheritableAttribute(name("Resources"))),
      await hash(contents),
      await hash(page.node.get(name("UserUnit"))),
      ...(normalized ? [await hash(page.node.get(name("Group")))] : []),
    ]);
  }
  return sha256Hex(new TextEncoder().encode(JSON.stringify(pages)));
}

async function loadEditablePdf(bytes: Uint8Array) {
  if (bytes.length > EDITABLE_PDF_LIMIT)
    throw new Error("PDF exceeds the editable sync size limit");
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  // Modifying a signed PDF would invalidate the signature.
  if (
    doc.context
      .enumerateIndirectObjects()
      .some(
        ([, o]) =>
          o instanceof PDFDict &&
          (o.get(name("Type")) === name("Sig") || o.has(name("ByteRange"))),
      )
  )
    throw new Error("This PDF is digitally signed");
  const pages = doc.getPages();
  if (
    !pages.length ||
    pages.some(
      (page) =>
        page.getRotation().angle % 360 || page.node.has(name("UserUnit")),
    )
  )
    throw new Error("Unsupported PDF page geometry");
  return doc;
}

export async function referencePageFingerprint(
  bytes: Uint8Array,
  count: number,
  appended: number,
) {
  const doc = await loadEditablePdf(bytes);
  if (doc.getPageCount() !== count + appended)
    throw new Error("The reference PDF page count differs");
  return (version: PageBaselineVersion) => baseFingerprint(doc, count, version);
}

export async function openEmbeddedPdf(bytes: Uint8Array) {
  const doc = await loadEditablePdf(bytes);
  const pages = doc.getPages();
  const marks = new Map<string, Embedded>();
  const seen = new Set<string>();
  for (const [index, page] of pages.entries()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i, PDFDict);
      const record = readMark(dict, index, i);
      if (!record) continue;
      if (record.id) {
        if (seen.has(record.id))
          throw new Error("Duplicate PDF annotation IDs");
        seen.add(record.id);
      }
      marks.set(record.id || uuid4(), record);
    }
  }
  return {
    doc,
    marks,
    base: await baseFingerprint(doc, pages.length, PAGE_BASE_VERSION),
    baseAtVersion: (version: PageBaselineVersion) =>
      baseFingerprint(doc, pages.length, version),
    boxes: pages.map((page) => page.getCropBox()),
  };
}

export type EmbeddedPdf = Awaited<ReturnType<typeof openEmbeddedPdf>>;

function writeAnnotation(
  pdf: EmbeddedPdf,
  mark: EditableMark,
  id: string,
  dict?: PDFDict,
  add = !dict,
) {
  const { context } = pdf.doc;
  const page = pdf.doc.getPage(mark.page);
  const ink = mark.kind === "ink";
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const path of mark.paths) {
    for (let i = 0; i < path.length; i += 2) {
      minX = Math.min(minX, path[i]);
      minY = Math.min(minY, path[i + 1]);
      maxX = Math.max(maxX, path[i]);
      maxY = Math.max(maxY, path[i + 1]);
    }
  }
  const pad = ink ? mark.width / 2 + 1 : 0;
  const bounds = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(mark.color.slice(i, i + 2), 16) / 255,
  );
  const [left, bottom, right, top] = bounds;
  const width = Math.max(1, right - left),
    height = Math.max(1, top - bottom);
  const operations = [`q /InkState gs ${r} ${g} ${b} ${ink ? "RG" : "rg"}`];
  if (ink) operations.push(`${Math.max(mark.width, 0.1)} w 1 J 1 j`);
  for (const path of mark.paths) {
    if (ink) {
      const coordinates = [];
      for (let i = 0; i < path.length; i += 2)
        coordinates.push(
          `${roundMark(path[i] - left)} ${roundMark(path[i + 1] - bottom)} ${i ? "l" : "m"}`,
        );
      if (path.length === 2)
        coordinates.push(
          `${roundMark(path[0] - left + 0.01)} ${roundMark(path[1] - bottom)} l`,
        );
      operations.push(coordinates.join(" "), "S");
    } else
      operations.push(
        `${path[0] - left} ${path[1] - bottom} ${path[2] - path[0]} ${path[3] - path[1]} re f`,
      );
  }
  operations.push("Q");
  const appearance = context.register(
    context.flateStream(operations.join("\n"), {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, width, height],
      Resources: {
        ExtGState: {
          InkState: {
            Type: "ExtGState",
            CA: 1,
            ca: ink ? 1 : 0.38,
            BM: ink ? "Normal" : "Multiply",
          },
        },
      },
    }),
  );
  const annotation = dict ?? context.obj({ Type: "Annot", F: 4 });
  annotation.set(name("Subtype"), name(ink ? "Ink" : "Highlight"));
  annotation.set(name("Rect"), context.obj(bounds));
  annotation.set(name("NM"), PDFHexString.fromText(id));
  annotation.set(name("P"), page.ref);
  annotation.set(name("C"), context.obj([r, g, b]));
  if (mark.comment !== undefined && !annotation.has(name("Contents")))
    annotation.set(name("Contents"), PDFHexString.fromText(mark.comment));
  if (mark.author !== undefined && !annotation.has(name("T")))
    annotation.set(name("T"), PDFHexString.fromText(mark.author));
  annotation.set(name("AP"), context.obj({ N: appearance }));
  if (ink) {
    annotation.set(name("InkList"), context.obj(mark.paths));
    annotation.set(name("BS"), context.obj({ W: mark.width, S: "S" }));
  } else {
    annotation.set(
      name("QuadPoints"),
      context.obj(
        mark.paths.flatMap(([x1, y1, x2, y2]) => [
          x1,
          y2,
          x2,
          y2,
          x1,
          y1,
          x2,
          y1,
        ]),
      ),
    );
  }
  if (add) {
    const existing = page.node.Annots();
    const annotations = existing ?? context.obj([]);
    annotations.push(context.register(annotation));
    if (!existing) page.node.set(name("Annots"), annotations);
  }
}

export async function patchEmbeddedPdf(
  pdf: EmbeddedPdf,
  changes: Map<string, EditableMark | undefined>,
) {
  const removed: Embedded[] = [];
  for (const [id, mark] of changes) {
    const old = pdf.marks.get(id);
    if (!mark || (old && old.mark.page !== mark.page)) {
      if (old) removed.push(old);
      if (!mark) continue;
      writeAnnotation(pdf, mark, id, old?.dict.clone(), true);
    } else writeAnnotation(pdf, mark, id, old?.dict);
  }
  for (const record of removed.sort((a, b) => b.index - a.index))
    pdf.doc.getPage(record.mark.page).node.Annots()!.remove(record.index);
  return pdf.doc.save({ useObjectStreams: false });
}

/** Only the tablet payload, built in memory, omits the paired annotation objects. */
export async function pdfWithoutSyncedMarks(bytes: Uint8Array) {
  const pdf = await openEmbeddedPdf(bytes);
  return patchEmbeddedPdf(
    pdf,
    new Map([...pdf.marks.keys()].map((id) => [id, undefined])),
  );
}
