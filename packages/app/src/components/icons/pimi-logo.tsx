import { useUnistyles } from "react-native-unistyles";
import { PimiMark } from "./pimi-mark";

interface PimiLogoProps {
  size?: number;
  color?: string;
}

export function PimiLogo({ size = 64, color }: PimiLogoProps) {
  const { theme } = useUnistyles();
  return <PimiMark size={size} color={color ?? theme.colors.foreground} />;
}
