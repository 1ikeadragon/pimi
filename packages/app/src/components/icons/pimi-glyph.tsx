// Pimi addition to the Paseo fork. Apache-2.0.
import Svg, { Circle, Ellipse, Path } from "react-native-svg";

// Line-icon Pimi (a Pomeranian-spitz mix): pointed upright ears, scalloped ruff. Lucide's grid:
// 24 viewBox, stroke 2, round caps and joins, no fill.
// Ears and head are separate layers so the working animation can rotate each ear around its
// pivot without animating any SVG prop.
const VIEWBOX = "0 0 24 24";
const HEAD_PATH =
  "M7.2 9.6C8.2 7.4 9.9 6.4 12 6.4s3.8 1 4.8 3.2L20 10.6 18.4 13l1.9 2.6-3 .2L16 19H8l-1.3-3.2-3-.2L5.6 13 4 10.6Z";
const LEFT_EAR_PATH = "M6.8 9.4 7.4 3 11.2 6.2";
const RIGHT_EAR_PATH = "M17.2 9.4 16.6 3 12.8 6.2";

export const PIMI_GLYPH_LEFT_EAR_PIVOT = { x: 9, y: 7.8 };
export const PIMI_GLYPH_RIGHT_EAR_PIVOT = { x: 15, y: 7.8 };

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
      <Circle cx={9.9} cy={12} r={0.8} fill={color} />
      <Circle cx={14.1} cy={12} r={0.8} fill={color} />
      <Ellipse cx={12} cy={14.8} rx={1.3} ry={1} fill={color} />
      <Path
        d="M10.4 16.3Q12 17.5 13.6 16.3"
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <Path
        d="M11 17.4h2v1.9a1 1 0 0 1-2 0Z"
        fill={color}
        stroke={color}
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
