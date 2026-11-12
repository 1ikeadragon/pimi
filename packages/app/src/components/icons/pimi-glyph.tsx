// Pimi addition to the Paseo fork. Apache-2.0.
import Svg, { Circle, Ellipse, Path } from "react-native-svg";

// Line-icon Pimi (a Pomeranian-spitz mix): two small pointed ears set apart on a smooth crown,
// and a ruff of seven even, shallow scallops around the face. Eyes and nose only: no mouth.
// Lucide's grid: 24 viewBox, stroke 2, round caps and joins, no fill.
// Ears and head are separate layers so the working animation can rotate each ear around its
// pivot without animating any SVG prop.
const VIEWBOX = "0 0 24 24";
const HEAD_PATH =
  "M19.37 10.22A2.44 2.44 0 0 1 20.14 14.05A2.51 2.51 0 0 1 18.26 17.6A2.78 2.78 0 0 1 14.34 19.72A2.92 2.92 0 0 1 9.66 19.72A2.78 2.78 0 0 1 5.74 17.6A2.51 2.51 0 0 1 3.86 14.05A2.44 2.44 0 0 1 4.63 10.22C5.43 7.6 9.4 6.4 12 6.4S18.57 7.6 19.37 10.22Z";
const LEFT_EAR_PATH = "M5.4 9.2 6.2 4 9.6 6.9";
const RIGHT_EAR_PATH = "M18.6 9.2 17.8 4 14.4 6.9";

export const PIMI_GLYPH_LEFT_EAR_PIVOT = { x: 7.5, y: 8.05 };
export const PIMI_GLYPH_RIGHT_EAR_PIVOT = { x: 16.5, y: 8.05 };

interface LayerProps {
  size: number;
  color: string;
}

export function PimiGlyphLeftEar({ size, color }: LayerProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      <Path
        d={LEFT_EAR_PATH}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PimiGlyphRightEar({ size, color }: LayerProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      <Path
        d={RIGHT_EAR_PATH}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PimiGlyphHead({ size, color }: LayerProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX}>
      <Path
        d={HEAD_PATH}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={9.3} cy={12.9} r={1} fill={color} />
      <Circle cx={14.7} cy={12.9} r={1} fill={color} />
      <Ellipse cx={12} cy={15.5} rx={1.3} ry={1} fill={color} />
    </Svg>
  );
}
