import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  Plus,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { IMAGE_MAX_PIXELS } from "./utils";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type Props = {
  blob: Blob;
  labels: {
    failed: string;
    encrypted: string;
    previous: string;
    next: string;
    zoomIn: string;
    zoomOut: string;
    fit: string;
    page: string;
  };
};

export function PdfPreview({ blob, labels }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.15);
  const [fitWidth, setFitWidth] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setDocument(null);
    setPage(1);
    setError("");
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    const timer = window.setTimeout(() => {
      setError(labels.failed);
      void task?.destroy();
    }, 15_000);
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (!live) return;
        const options: Parameters<typeof pdfjs.getDocument>[0] & {
          isEvalSupported: false;
        } = {
          data: new Uint8Array(buffer),
          isEvalSupported: false,
          enableXfa: false,
          useWasm: false,
          maxImageSize: IMAGE_MAX_PIXELS,
          cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"),
          cMapPacked: true,
          standardFontDataUrl: chrome.runtime.getURL("pdfjs/standard_fonts/"),
        };
        task = pdfjs.getDocument(options);
        return task.promise;
      })
      .then((pdf) => {
        if (!pdf || !live) return;
        window.clearTimeout(timer);
        if (pdf.numPages > 500) {
          setError(labels.failed);
          void task?.destroy();
          return;
        }
        setDocument(pdf);
      })
      .catch((reason) => {
        window.clearTimeout(timer);
        if (!live) return;
        const named =
          reason && typeof reason === "object" && "name" in reason
            ? String(reason.name)
            : "";
        setError(
          named === "PasswordException" ? labels.encrypted : labels.failed,
        );
      });
    return () => {
      live = false;
      window.clearTimeout(timer);
      void task?.destroy();
    };
  }, [blob]);
  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        renderTask?.cancel();
        setError(labels.failed);
      }
    }, 15_000);
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled || !canvasRef.current) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const width = canvasRef.current.parentElement?.clientWidth || 400;
        const fittedScale = Math.max(0.05, (width - 24) / natural.width);
        const viewport = pdfPage.getViewport({
          scale: fitWidth ? fittedScale : scale,
        });
        const canvas = canvasRef.current;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        if (
          viewport.width <= 0 ||
          viewport.height <= 0 ||
          viewport.width * ratio >
            Math.floor(IMAGE_MAX_PIXELS / (viewport.height * ratio))
        ) {
          setError(labels.failed);
          return;
        }
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        return renderTask.promise;
      })
      .catch(() => {
        if (!cancelled) setError(labels.failed);
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      renderTask?.cancel();
    };
  }, [document, page, scale, fitWidth]);
  if (error)
    return (
      <div className="preview-message" role="status">
        {error}
      </div>
    );
  return (
    <div className="pdf-preview">
      <div className="preview-tools" aria-label="PDF controls">
        <button
          className="icon-button"
          aria-label={labels.previous}
          disabled={!document || page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {labels.page} {page}
          {document ? ` / ${document.numPages}` : ""}
        </span>
        <button
          className="icon-button"
          aria-label={labels.next}
          disabled={!document || page >= document.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight size={17} />
        </button>
        <span className="tool-spacer" />
        <button
          className="icon-button"
          aria-label={labels.zoomOut}
          onClick={() => {
            setFitWidth(false);
            setScale((value) => Math.max(0.5, value - 0.15));
          }}
        >
          <Minus size={17} />
        </button>
        <button
          className="icon-button"
          aria-label={labels.fit}
          onClick={() => setFitWidth(true)}
        >
          <Maximize2 size={16} />
        </button>
        <button
          className="icon-button"
          aria-label={labels.zoomIn}
          onClick={() => {
            setFitWidth(false);
            setScale((value) => Math.min(2.5, value + 0.15));
          }}
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="pdf-canvas">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
