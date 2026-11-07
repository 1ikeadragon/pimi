// Pimi addition to the Paseo fork. Apache-2.0.
import Svg, { Ellipse, G, Path } from "react-native-svg";

function Paw({ transform }: { transform: string }) {
  return (
    <G transform={transform}>
      <Ellipse cx={25} cy={76} rx={19} ry={27} transform="rotate(-27 25 76)" />
      <Ellipse cx={72} cy={35} rx={21} ry={30} transform="rotate(-10 72 35)" />
      <Ellipse cx={128} cy={35} rx={21} ry={30} transform="rotate(10 128 35)" />
      <Ellipse cx={175} cy={76} rx={19} ry={27} transform="rotate(27 175 76)" />
      <Path d="M58 117C74 92 91 102 100 104C109 102 126 92 142 117L170 157C190 187 166 211 141 201C111 190 89 190 59 201C34 211 10 187 30 157Z" />
    </G>
  );
}

export function PimiMark({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="36 51 440 399" fill={color}>
      <Paw transform="translate(59 218) rotate(-24 100 100)" />
      <Paw transform="translate(253 73) rotate(20 100 100)" />
    </Svg>
  );
}
