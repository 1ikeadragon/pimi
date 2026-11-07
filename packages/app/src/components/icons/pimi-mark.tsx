// Pimi addition to the Paseo fork. Apache-2.0.
import Svg, { Ellipse, G, Path } from "react-native-svg";

export function PimiMark({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill={color}>
      <G transform="translate(30 6) rotate(20 17.5 17) scale(.91)">
        <Path d="M1.8 10.2 5.4 8.7 8.3 10.4 10 14.7 8.2 17.3 4.5 18.8 1.8 16.8 .4 12.8Z M9.4 3.8 11.6 1.8 15.3 1.8 17.4 4V9.7L15.5 11.7H11.5L9.4 9.6Z M20.2 1.8H24.1L26.1 4V9.7L24.1 11.7H20.3L18.3 9.7V4Z M29.6 8.7 33.2 10.2 34.7 12.8 33.3 16.8 30.6 18.8 27 17.3 25.2 14.7 27 10.4Z" />
        <Path
          fillRule="evenodd"
          d="M10.4 18 13.7 15.5H21.4L24.7 18 30.1 24.6V29.2L27.3 32H7.8L5 29.2V24.6Z M17.55 19.65a4.65 4.65 0 1 0 0 9.3 4.65 4.65 0 0 0 0-9.3Z M17.55 22.4a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z"
        />
      </G>
      <G transform="translate(4 27) rotate(-22 16 17) scale(.9)">
        <Ellipse cx={4.9} cy={12.8} rx={3.05} ry={4.15} transform="rotate(-24 4.9 12.8)" />
        <Ellipse cx={12} cy={6.6} rx={3.35} ry={4.65} transform="rotate(-9 12 6.6)" />
        <Ellipse cx={20.4} cy={6.6} rx={3.35} ry={4.65} transform="rotate(9 20.4 6.6)" />
        <Ellipse cx={27.5} cy={12.8} rx={3.05} ry={4.15} transform="rotate(24 27.5 12.8)" />
        <Path d="M8.7 19.5C11.7 15.1 14.4 16 16.2 16.6C18 16 20.7 15.1 23.7 19.5L27.4 24.9C30.1 28.9 27.1 33 22.8 31.8C17.7 30.3 14.7 30.3 9.6 31.8C5.3 33 2.3 28.9 5 24.9Z" />
      </G>
    </Svg>
  );
}
