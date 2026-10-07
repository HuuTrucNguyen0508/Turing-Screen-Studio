import { useLayoutEffect, useRef, useState } from 'react';
import type { Widget } from './domain/layout';
import { resolveElements } from './domain/design';

const fonts = { mono: "'JetBrains Mono', 'DejaVu Sans Mono', monospace", sans: "'Roboto', 'DejaVu Sans', sans-serif" };
type Box = { x: number; y: number; width: number; height: number };

/** Text is measured in document pixels, including the smaller AM/PM suffix. */
export default function ElementTargets({ widget, active, scale }: { widget: Widget; active: string | null; scale: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const elements = resolveElements(widget).filter((element) => !element.hidden);
  useLayoutEffect(() => {
    let cancelled = false;
    function measure() {
      if (cancelled || !svg.current) return;
      const next: Record<string, Box> = {};
      svg.current.querySelectorAll<SVGTextElement>('text[data-measure-element]').forEach((text) => {
        const box = text.getBBox();
        if (box.width > 0 && box.height > 0) next[text.dataset.measureElement!] = { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      setBoxes(next);
    }
    measure();
    void window.document.fonts.ready.then(measure);
    return () => { cancelled = true; };
  }, [widget]);
  if (!elements.length) return null;
  const padding = 3 / (scale || 1);
  return <svg ref={svg} className="element-targets" width={widget.width} height={widget.height} aria-hidden="true">
    {elements.map((element) => <text key={`measure-${element.id}`} data-measure-element={element.id}
      x={element.x} y={element.y} textAnchor={element.align === 'center' ? 'middle' : element.align}
      fontFamily={fonts[element.family]} fontSize={element.size} fill="transparent" pointerEvents="none">
      <tspan>{element.text}</tspan>{element.suffix && <tspan fontFamily={fonts.sans} dx={element.gap} fontSize={element.suffixSize}>{element.suffix}</tspan>}
    </text>)}
    {[...elements].sort((a, b) => {
      const first = boxes[a.id], second = boxes[b.id];
      return (second ? second.width * second.height : 0) - (first ? first.width * first.height : 0);
    }).map((element) => {
      const box = boxes[element.id];
      return box && <rect key={element.id} data-element-target={element.id} data-active={active === element.id}
        x={box.x - padding} y={box.y - padding} width={box.width + padding * 2} height={box.height + padding * 2}
        vectorEffect="non-scaling-stroke" rx={padding}>
        <title>{active === element.id ? `Drag ${element.name.toLowerCase()}, or use arrow keys` : `Double-click to select ${element.name.toLowerCase()}`}</title>
      </rect>;
    })}
  </svg>;
}
