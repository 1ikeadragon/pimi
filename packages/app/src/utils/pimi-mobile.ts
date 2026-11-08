import Constants from "expo-constants";
import { Platform } from "react-native";
import { getDesktopHost } from "@/desktop/host";

export function isPimiAndroid(): boolean {
  return Platform.OS === "android" && Constants.expoConfig?.extra?.pimiAndroid === true;
}

export function isPimiProduct(): boolean {
  return isPimiAndroid() || Boolean(getDesktopHost()?.pimiAppearance);
}
