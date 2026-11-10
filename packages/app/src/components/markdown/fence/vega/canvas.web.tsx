import { useEffect, useRef, useState } from "react";
import { ScenePopover, type InteractionTarget } from "../view/interaction";
import type { TooltipRow, VegaChartInput } from "./runtime";
import type { VegaTheme } from "./theme";
import { VegaTooltipRows } from "./tooltip";

type Runtime = typeof import("./runtime");

interface Tip {
  target: InteractionTarget;
  rows: TooltipRow[];
}

const WRAPPER_STYLE = { position: "relative", width: "100%" } as const;
// A multi-plot chart keeps its own width and scrolls here, not the conversation.
const SCROLLER_STYLE = { overflowX: "auto", overflowY: "hidden", width: "100%" } as const;

function tipAt(x: number, y: number, rows: TooltipRow[]): Tip {
  return {
    target: {
      key: "tooltip",
      description: "",
      anchor: { x, y },
      box: { x, y, width: 0, height: 0 },
    },
    rows,
  };
}

/** Vega's own SVG renderer in the DOM, so hover, selections and transitions work as written. */
export function VegaCanvas({
  runtime,
  spec,
  width,
  theme,
  onFailed,
}: {
  runtime: Runtime;
  spec: VegaChartInput["spec"];
  width: number;
  theme: VegaTheme;
  onFailed: () => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [bounds, setBounds] = useState({ width, height: 0 });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let current = true;
    let view: ReturnType<Runtime["createVegaView"]>;
    try {
      view = runtime.createVegaView(
        { spec, config: theme.config, width },
        { renderer: "svg", container: element },
      );
    } catch {
      onFailed();
      return;
    }
    // Vega calls this with a null value when the pointer leaves a mark.
    view.tooltip((_handler, event, _item, value) => {
      const rows = runtime.tooltipRows(value);
      const frame = wrapper.current?.getBoundingClientRect();
      if (rows.length === 0 || !frame || !("clientX" in event)) {
        setTip(null);
        return;
      }
      setBounds({ width: frame.width, height: frame.height });
      setTip(tipAt(event.clientX - frame.left, event.clientY - frame.top, rows));
    });
    view
      .runAsync()
      .then(() => {
        if (!current) return;
        if (runtime.countMarkItems(view) === 0) {
          onFailed();
          return;
        }
        // A spec with a link or an image never gets this far, and the loader gives either one
        // an empty address. This keeps the drawing free of both regardless.
        for (const anchor of element.querySelectorAll("a"))
          anchor.replaceWith(...anchor.childNodes);
        for (const image of element.querySelectorAll("image")) image.remove();
        return;
      })
      .catch(() => {
        if (current) onFailed();
      });
    return () => {
      current = false;
      setTip(null);
      view.finalize();
      element.replaceChildren();
    };
  }, [runtime, spec, theme, width, onFailed]);

  return (
    <div ref={wrapper} style={WRAPPER_STYLE} data-testid="chat-vega-canvas">
      <div ref={container} style={SCROLLER_STYLE} />
      {tip ? (
        <ScenePopover target={tip.target} bounds={bounds} clearBox={false}>
          <VegaTooltipRows rows={tip.rows} />
        </ScenePopover>
      ) : null}
    </div>
  );
}
