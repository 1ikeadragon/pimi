// Pimi. PolyForm-Noncommercial-1.0.0.
import Svg, { Circle, Ellipse, G, Path } from "react-native-svg";

// The Pimi mascot from the Pimi download site, the same art as the Ask Pimi button.
// Drawn with react-native-svg so it renders on native as well as web.
const INK = "#252326";
const FUR = "#fffefa";

export function PimiMascot({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="23 9 80 77">
      <Path
        d="M34 41c-2-7-1-20 3-29 7 3 14 9 17 15 6-2 12-2 18 0 5-7 11-12 18-14 4 9 4 20 1 29 7 5 11 12 9 20l-4-1 2 7-6-1-1 6-6-1c-6 8-14 11-22 9-10 2-18-1-24-8l-7 2-1-6-6 1 3-7-5 1c-1-9 4-17 11-23Z"
        fill={FUR}
        stroke={INK}
        strokeWidth={1.9}
        strokeLinejoin="round"
      />
      <Path
        d="M39 21c-1 6-1 12 1 17l10-6c-3-5-6-8-11-11Zm48 1c1 6 0 12-2 17l-9-6c3-5 7-9 11-11Z"
        fill="#ded0bf"
      />
      <Path
        d="M32 59c4-4 11-6 17-3 5 2 9 0 14-4 5 4 9 6 14 4 7-3 14 0 17 4l-5 9-6-1c-4 6-11 10-20 9-11 1-16-3-21-9l-6 1Z"
        fill="#f3ecdf"
      />
      <Path
        d="M48 40q6-4 12-4m6 0q7 0 12 4"
        fill="none"
        stroke="#e2d8c9"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <G fill={INK}>
        <Ellipse cx={47} cy={51} rx={3.3} ry={4} />
        <Ellipse cx={79} cy={51} rx={3.3} ry={4} />
      </G>
      <Circle cx={48} cy={50} r={1} fill={FUR} />
      <Circle cx={80} cy={50} r={1} fill={FUR} />
      <Path d="M58 59q5-3 10 0c1 3-2 6-5 6s-6-3-5-6Z" fill={INK} />
      <Path
        d="M54 65q4 5 9 1 5 4 9-1"
        fill="none"
        stroke="#383433"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}
